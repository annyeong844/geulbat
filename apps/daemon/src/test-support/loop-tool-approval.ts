import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertRunId } from '@geulbat/protocol/ids';

import {
  createAgentEvent,
  type AgentEvent,
  type AgentEventEmitter,
} from '../daemon/agent/events.js';
import {
  buildAgentToolExecutionContextBase,
  buildToolCallExecutionRuntime,
} from '../daemon/agent/loop-tool-runtime.js';
import type { RunState } from '../daemon/agent/runtime/run-state.js';
import { createDaemonContext } from '../daemon/context.js';
import type {
  AnyTool,
  ExecuteResult,
  ToolExecutionContext,
  ToolParseResult,
} from '../daemon/tools/types.js';
import { makeApprovalContext } from './approval-runtime.js';
import { parseObjectArgs } from './run-agent-loop.js';
import { makeRunContext } from './run-context.js';
import { testThreadId } from './thread-id.js';

export function createTestDaemonContext(): ReturnType<
  typeof createDaemonContext
> {
  return createDaemonContext({
    homeStateRoot: join(tmpdir(), `geulbat-loop-approval-home-${randomUUID()}`),
  });
}

export async function startApprovalCheckpoint(
  daemonContext: ReturnType<typeof createDaemonContext>,
  threadId: ReturnType<typeof testThreadId>,
  runId: string,
): Promise<void> {
  const result = await daemonContext.runCheckpoints.startRun({
    runId: assertRunId(runId),
    threadId,
    request: { workingDirectory: 'stories', permissionMode: 'basic' },
  });
  assert.equal(result.ok, true);
}

export function makeTestTool<
  TArgs extends object = Record<string, unknown>,
>(args: {
  name: string;
  description: string;
  sideEffectLevel: AnyTool['sideEffectLevel'];
  requiresApproval: boolean;
  approvalClass?: AnyTool['approvalClass'];
  mayMutateComputerFiles?: boolean;
  exposure?: AnyTool['exposure'];
  parseArgs?: (raw: unknown) => ToolParseResult<TArgs>;
  executeParsed: (
    parsedArgs: TArgs,
    ctx: ToolExecutionContext,
  ) => Promise<ExecuteResult>;
}): AnyTool {
  return {
    name: args.name,
    description: args.description,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    strict: true,
    sideEffectLevel: args.sideEffectLevel,
    mayMutateComputerFiles: args.mayMutateComputerFiles ?? false,
    timeoutMs: 1_000,
    requiresApproval: args.requiresApproval,
    ...(args.approvalClass === undefined
      ? {}
      : { approvalClass: args.approvalClass }),
    ...(args.exposure === undefined ? {} : { exposure: args.exposure }),
    parseArgs: args.parseArgs ?? parseObjectArgs,
    executeParsed: args.executeParsed,
  };
}

export function makeEmitter(events: AgentEvent[]): AgentEventEmitter {
  return (type, payload) => {
    events.push(createAgentEvent(type, payload));
  };
}

export function makeExecutionRuntime(
  daemonContext: ReturnType<typeof createDaemonContext>,
  args: {
    threadId: ReturnType<typeof testThreadId>;
    stateRoot: string;
    computerFileRoot?: string;
    workingDirectory?: string;
    runId: string;
    approvalContext: ReturnType<typeof makeApprovalContext>;
    emit: ReturnType<typeof makeEmitter>;
    runtimeServices?: ReturnType<typeof createDaemonContext>;
    planningWorkflow?: { workflowId: string };
    signal?: AbortSignal;
    runState?: RunState;
  },
) {
  return buildToolCallExecutionRuntime({
    approvalContext: args.approvalContext,
    emit: args.emit,
    toolRegistry: daemonContext.toolRegistry,
    approvalGate: daemonContext.approvalGate,
    approvalGrants: daemonContext.approvalGrants,
    executionContextBase: buildAgentToolExecutionContextBase({
      runContext: makeRunContext({
        threadId: args.threadId,
        stateRoot: args.stateRoot,
        workingDirectory: args.workingDirectory ?? '',
      }),
      runId: args.runId,
      approvalContext: args.approvalContext,
      emit: args.emit,
      currentFile: undefined,
      selection: undefined,
      signal: args.signal,
      runState: args.runState,
      ...(args.computerFileRoot === undefined
        ? {}
        : { computerFileRoot: args.computerFileRoot }),
      memoryIndex: undefined,
      runtimeServices: args.runtimeServices ?? daemonContext,
      ...(args.planningWorkflow === undefined
        ? {}
        : { planningWorkflow: args.planningWorkflow }),
    }),
  });
}

// W2 helper: resolve the pending approval from the emitted event, like the
// web-shell would. Returns the emitter to pass into makeExecutionRuntime.
export function makeApprovalResolvingEmitter(
  events: AgentEvent[],
  daemonContext: ReturnType<typeof createDaemonContext>,
  decision: 'approved' | 'denied',
  onApprovalRequired?: () => void | Promise<void>,
  permissionMode?: 'basic' | 'full_access',
): AgentEventEmitter {
  return (type, payload) => {
    events.push(createAgentEvent(type, payload));
    if (type === 'approval_required') {
      const approval = payload as {
        callId: string;
        runId: string;
        threadId: string;
      };
      setTimeout(() => {
        void (async () => {
          await onApprovalRequired?.();
          void daemonContext.approvalGate.resolveApproval(
            approval.callId,
            approval.runId,
            approval.threadId,
            decision,
            'once',
            permissionMode,
          );
        })();
      }, 0);
    }
  };
}

export async function withWriteCallbackKnob<T>(
  value: string,
  run: () => Promise<T>,
): Promise<T> {
  const envName = 'GEULBAT_PTC_WRITE_CALLBACK_ENABLED';
  const previous = process.env[envName];
  process.env[envName] = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env[envName];
    } else {
      process.env[envName] = previous;
    }
  }
}

export function makePtcWriteCallbackSource(runtimeToolCallId: string) {
  return {
    kind: 'ptc_callback' as const,
    parentToolCallId: 'call-execute-code',
    runtimeToolCallId,
    hostCallId: `call-execute-code::${runtimeToolCallId}`,
  };
}
