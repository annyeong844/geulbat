import type { RunId, ThreadId } from './contract.js';

import type { ChildRunRegistry } from './runtime/child-run-registry.js';
import type { AgentEvent } from '../runtime-contracts.js';
import {
  resolveSubagentToolSurfaceProfile,
  type AgentChildTerminalReason,
  type ChildRunSnapshot,
  type SubagentCapability,
  type SubagentLaunchRequestStore,
  type SubagentRuntimeDiagnostics,
  type SubagentType,
} from '../subagent-runtime-contracts.js';

interface ChildEventTerminalFailure {
  message: string;
  reason: AgentChildTerminalReason;
}

export function routeChildAgentEvent(args: {
  event: AgentEvent;
  parentRunId: RunId;
  childRunId: RunId;
  childThreadId: ThreadId;
  subagentType: SubagentType;
  capabilities: readonly SubagentCapability[];
  childRuns: Pick<
    ChildRunRegistry,
    | 'getChildRun'
    | 'markChildApprovalPending'
    | 'markChildRunning'
    | 'updateChildRuntime'
  >;
  subagentLaunchRequests?: Pick<
    SubagentLaunchRequestStore,
    'recordSubagentRuntimeObservation'
  >;
  emitAgentEvent?: (event: AgentEvent) => void;
  now?: () => Date;
}): ChildEventTerminalFailure | undefined {
  const {
    event,
    parentRunId,
    childRunId,
    subagentType,
    capabilities,
    childRuns,
    subagentLaunchRequests,
    emitAgentEvent,
  } = args;
  const observedAt = (args.now ?? (() => new Date()))().toISOString();
  const previousSnapshot = childRuns.getChildRun(childRunId);

  if (event.type === 'approval_required') {
    childRuns.markChildApprovalPending(childRunId);
    const runtime = observeChildRuntime(previousSnapshot, event, observedAt);
    if (runtime !== undefined) {
      subagentLaunchRequests?.recordSubagentRuntimeObservation({
        childRunId,
        runtime,
      });
      childRuns.updateChildRuntime({ childRunId, runtime });
    }
    emitAgentEvent?.({
      type: 'subagent_approval_required',
      payload: {
        parentRunId,
        childRunId,
        subagentType,
        capabilities,
        toolSurface: resolveSubagentToolSurfaceProfile({
          subagentType,
          capabilities,
        }),
        ...(runtime === undefined ? {} : { runtime }),
        approval: event.payload,
      },
    });
    emitAgentEvent?.(event);
    return undefined;
  }

  childRuns.markChildRunning(childRunId);
  const runtime = observeChildRuntime(previousSnapshot, event, observedAt);
  if (runtime !== undefined) {
    subagentLaunchRequests?.recordSubagentRuntimeObservation({
      childRunId,
      runtime,
    });
    childRuns.updateChildRuntime({ childRunId, runtime });
  }
  if (event.type === 'error') {
    return {
      message: event.payload.message,
      reason: classifyChildTerminalError(event.payload.code, previousSnapshot),
    };
  }
  return undefined;
}

function observeChildRuntime(
  snapshot: ChildRunSnapshot | undefined,
  event: AgentEvent,
  observedAt: string,
): SubagentRuntimeDiagnostics | undefined {
  if (snapshot === undefined) {
    return undefined;
  }
  const current = snapshot.runtime;
  switch (event.type) {
    case 'provider_status':
      return {
        ...current,
        phase: event.payload.phase,
        observedAt: event.payload.observedAt,
        ...(event.payload.request === undefined
          ? {}
          : {
              providerRequest: {
                ...event.payload.request,
                ...(event.payload.request.retry === undefined
                  ? {}
                  : { retry: { ...event.payload.request.retry } }),
              },
            }),
      };
    case 'run_ack':
      return current.phase === 'provider_waiting'
        ? undefined
        : { ...current, phase: 'provider_waiting', observedAt };
    case 'commentary_delta':
    case 'final_answer_delta':
    case 'artifact_stream_delta':
      if (
        current.phase === 'provider_streaming' &&
        current.partialOutputAvailable
      ) {
        return undefined;
      }
      return {
        ...current,
        phase: 'provider_streaming',
        observedAt,
        partialOutputAvailable: true,
      };
    case 'artifact_committed':
      return {
        ...current,
        phase: 'provider_streaming',
        observedAt,
        partialOutputAvailable: true,
      };
    case 'tool_call':
      return {
        ...current,
        phase: 'tool_running',
        observedAt,
        lastTool: {
          name: event.payload.tool,
          callId: event.payload.callId,
          state: 'running',
        },
      };
    case 'tool_result':
      return {
        ...current,
        phase: 'provider_waiting',
        observedAt,
        lastTool: {
          name: event.payload.tool,
          callId: event.payload.callId,
          state: event.payload.ok ? 'succeeded' : 'failed',
        },
        partialOutputAvailable: true,
      };
    case 'approval_required':
      return {
        ...current,
        phase: 'approval_pending',
        observedAt,
        lastTool: {
          name: event.payload.toolName,
          callId: event.payload.callId,
          state: 'running',
        },
      };
    case 'done':
    case 'error':
      return { ...current, observedAt };
    case 'tool_call_delta':
    case 'tool_output_delta':
    case 'subagent_spawned':
    case 'subagent_status':
    case 'subagent_terminal':
    case 'subagent_approval_required':
    case 'interject_applied':
    case 'usage_updated':
    case 'context_usage_updated':
    case 'thread_state_persisted':
    case 'thread_state_delta_persisted':
    case 'thread_state_persist_failed':
      return undefined;
  }
}

function classifyChildTerminalError(
  code: Extract<AgentEvent, { type: 'error' }>['payload']['code'],
  snapshot: ChildRunSnapshot | undefined,
): AgentChildTerminalReason {
  if (
    code.startsWith('llm_') ||
    code.startsWith('provider_') ||
    code === 'rate_limited' ||
    code === 'quota_exceeded'
  ) {
    return 'provider_error';
  }
  if (code.startsWith('persistence_') || code === 'artifact_commit_failed') {
    return 'persistence_error';
  }
  if (snapshot?.runtime.lastTool?.state === 'failed') {
    return 'tool_error';
  }
  return 'child_error';
}
