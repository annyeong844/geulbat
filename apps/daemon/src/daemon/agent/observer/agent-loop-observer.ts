import type { ProviderRequestOptions } from '../../llm/provider/provider-options.js';
import type { RunWorkspaceContext } from '../../run-workspace-context.js';
import type { ToolDefinition } from '../../tools/tool-registry-model.js';
import type { PermissionMode, ThreadId } from '../contract.js';

export type AgentLoopObserverRunStateKind = 'none' | 'root' | 'child';

export type AgentLoopObserverToolAdmission =
  | { kind: 'registry_default' }
  | { kind: 'allow_list'; names: string[] };

export interface AgentLoopObserverSnapshot {
  schemaVersion: 1;
  runId: string;
  threadId: string;
  projectId: string;
  input: {
    currentFileProvided: boolean;
    selectionProvided: boolean;
    signalProvided: boolean;
    runStateKind: AgentLoopObserverRunStateKind;
    callModelPort: 'default_provider' | 'injected';
  };
  approval: {
    permissionMode: PermissionMode;
    ownerKind: 'foreground' | 'delegated';
  };
  promptPorts: {
    systemPrompt: 'buildSystemPrompt';
    promptContext: 'buildPromptContext';
  };
  history: {
    initialItemCount: number;
    pendingBackgroundResultCount: number;
    midRunSteerEnabled: boolean;
  };
  model: {
    name: string;
    reasoningEffort: ProviderRequestOptions['reasoning']['effort'];
    textVerbosity: ProviderRequestOptions['text']['verbosity'];
    retryPolicy: {
      llmConnectionLostMaxRetries: number;
      llmOverloadedMaxRetries: number;
      llmRateLimitedMaxRetries: number;
    };
  };
  toolSurface: {
    admission: AgentLoopObserverToolAdmission;
    definitions: {
      count: number;
      names: string[];
    };
  };
  loopPorts: {
    modelRound: 'runModelRound';
    toolExecution: 'processFunctionCalls';
    structuredOutputs: [
      'ptc_fixed_probe_structured_output',
      'react_bundle_structured_output',
    ];
  };
}

export interface BuildAgentLoopObserverSnapshotArgs {
  runId: string;
  runContext: Pick<RunWorkspaceContext, 'projectId' | 'threadId'>;
  approvalContext: {
    permissionMode: PermissionMode;
    ownerRunId?: string;
    ownerThreadId?: ThreadId;
  };
  allowedToolNames?: readonly string[];
  toolDefs: readonly Pick<ToolDefinition, 'name'>[];
  providerRequestOptions: ProviderRequestOptions;
  callModelImplProvided: boolean;
  currentFileProvided: boolean;
  selectionProvided: boolean;
  signalProvided: boolean;
  runStateKind: AgentLoopObserverRunStateKind;
  initialHistoryItemCount: number;
  pendingBackgroundResultCount: number;
  midRunSteerEnabled: boolean;
}

export type AgentLoopObserverEvent =
  | {
      schemaVersion: 1;
      kind: 'round_started';
      runId: string;
      threadId: string;
      round: number;
      historyItemCount: number;
      sawFirstModelRequest: boolean;
    }
  | {
      schemaVersion: 1;
      kind: 'round_completed';
      runId: string;
      threadId: string;
      round: number;
      outcome: 'continue' | 'terminal';
      terminalOk?: boolean;
    };

export type AgentLoopObserverDeliveryOperation =
  | 'record_snapshot'
  | 'record_event';

export interface AgentLoopObserverDiagnostic {
  schemaVersion: 1;
  kind: 'observer_delivery_failed';
  operation: AgentLoopObserverDeliveryOperation;
  eventKind?: AgentLoopObserverEvent['kind'];
}

export interface AgentLoopObserver {
  recordSnapshot(snapshot: AgentLoopObserverSnapshot): void | Promise<void>;
  recordEvent(event: AgentLoopObserverEvent): void | Promise<void>;
  recordDiagnostic?(
    diagnostic: AgentLoopObserverDiagnostic,
  ): void | Promise<void>;
}

export function recordAgentLoopObserverSnapshot(
  observer: AgentLoopObserver | undefined,
  snapshot: AgentLoopObserverSnapshot,
): void {
  deliverObserverCall(observer, 'record_snapshot', () =>
    observer?.recordSnapshot(snapshot),
  );
}

export function recordAgentLoopObserverEvent(
  observer: AgentLoopObserver | undefined,
  event: AgentLoopObserverEvent,
): void {
  deliverObserverCall(
    observer,
    'record_event',
    () => observer?.recordEvent(event),
    event.kind,
  );
}

export function buildAgentLoopObserverSnapshot(
  args: BuildAgentLoopObserverSnapshotArgs,
): AgentLoopObserverSnapshot {
  const toolNames = args.toolDefs.map((toolDef) => toolDef.name);
  const retryPolicy = args.providerRequestOptions.modelRoundRetry;
  return {
    schemaVersion: 1,
    runId: args.runId,
    threadId: args.runContext.threadId,
    projectId: args.runContext.projectId,
    input: {
      currentFileProvided: args.currentFileProvided,
      selectionProvided: args.selectionProvided,
      signalProvided: args.signalProvided,
      runStateKind: args.runStateKind,
      callModelPort: args.callModelImplProvided
        ? 'injected'
        : 'default_provider',
    },
    approval: {
      permissionMode: args.approvalContext.permissionMode,
      ownerKind:
        args.approvalContext.ownerRunId !== undefined ||
        args.approvalContext.ownerThreadId !== undefined
          ? 'delegated'
          : 'foreground',
    },
    promptPorts: {
      systemPrompt: 'buildSystemPrompt',
      promptContext: 'buildPromptContext',
    },
    history: {
      initialItemCount: args.initialHistoryItemCount,
      pendingBackgroundResultCount: args.pendingBackgroundResultCount,
      midRunSteerEnabled: args.midRunSteerEnabled,
    },
    model: {
      name: args.providerRequestOptions.model,
      reasoningEffort: args.providerRequestOptions.reasoning.effort,
      textVerbosity: args.providerRequestOptions.text.verbosity,
      retryPolicy: {
        llmConnectionLostMaxRetries: retryPolicy.llmConnectionLost.maxRetries,
        llmOverloadedMaxRetries: retryPolicy.llmOverloaded.maxRetries,
        llmRateLimitedMaxRetries: retryPolicy.llmRateLimited.maxRetries,
      },
    },
    toolSurface: {
      admission:
        args.allowedToolNames === undefined
          ? { kind: 'registry_default' }
          : { kind: 'allow_list', names: [...args.allowedToolNames] },
      definitions: {
        count: toolNames.length,
        names: toolNames,
      },
    },
    loopPorts: {
      modelRound: 'runModelRound',
      toolExecution: 'processFunctionCalls',
      structuredOutputs: [
        'ptc_fixed_probe_structured_output',
        'react_bundle_structured_output',
      ],
    },
  };
}

export function buildAgentLoopObserverRoundStartedEvent(args: {
  runId: string;
  threadId: string;
  round: number;
  historyItemCount: number;
  sawFirstModelRequest: boolean;
}): AgentLoopObserverEvent {
  return {
    schemaVersion: 1,
    kind: 'round_started',
    runId: args.runId,
    threadId: args.threadId,
    round: args.round,
    historyItemCount: args.historyItemCount,
    sawFirstModelRequest: args.sawFirstModelRequest,
  };
}

export function buildAgentLoopObserverRoundCompletedEvent(args: {
  runId: string;
  threadId: string;
  round: number;
  outcome: 'continue' | 'terminal';
  terminalOk?: boolean;
}): AgentLoopObserverEvent {
  return {
    schemaVersion: 1,
    kind: 'round_completed',
    runId: args.runId,
    threadId: args.threadId,
    round: args.round,
    outcome: args.outcome,
    ...(args.terminalOk !== undefined ? { terminalOk: args.terminalOk } : {}),
  };
}

function deliverObserverCall(
  observer: AgentLoopObserver | undefined,
  operation: AgentLoopObserverDeliveryOperation,
  callback: () => void | Promise<void> | undefined,
  eventKind?: AgentLoopObserverEvent['kind'],
): void {
  if (observer === undefined) {
    return;
  }
  const diagnostic = buildObserverDeliveryFailureDiagnostic(
    operation,
    eventKind,
  );
  try {
    observeMaybeAsync(callback(), () =>
      recordObserverDiagnostic(observer, diagnostic),
    );
  } catch {
    recordObserverDiagnostic(observer, diagnostic);
  }
}

function buildObserverDeliveryFailureDiagnostic(
  operation: AgentLoopObserverDeliveryOperation,
  eventKind?: AgentLoopObserverEvent['kind'],
): AgentLoopObserverDiagnostic {
  return {
    schemaVersion: 1,
    kind: 'observer_delivery_failed',
    operation,
    ...(eventKind !== undefined ? { eventKind } : {}),
  };
}

function recordObserverDiagnostic(
  observer: AgentLoopObserver,
  diagnostic: AgentLoopObserverDiagnostic,
): void {
  if (observer.recordDiagnostic === undefined) {
    return;
  }
  try {
    observeMaybeAsync(observer.recordDiagnostic(diagnostic), () => undefined);
  } catch {
    // Observer diagnostics are non-authoritative and must not affect the run.
  }
}

function observeMaybeAsync(
  result: void | Promise<void> | undefined,
  onRejected: () => void,
): void {
  if (isPromiseLike(result)) {
    void Promise.resolve(result).catch(onRejected);
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
