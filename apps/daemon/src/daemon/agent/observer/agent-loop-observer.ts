import type { ProviderRequestOptions } from '../../llm/provider/provider-options.js';
import type { RunContext } from '../../run-context.js';
import type { ToolLibraryProjectionPort } from '../../tools/tool-library-projection-port.js';
import type { ToolDefinition } from '../../tools/tool-registry-model.js';
import type { PermissionMode, ThreadId } from '../contract.js';
import type { AgentToolSurface } from '../loop-types.js';

type AgentLoopObserverRunStateKind = 'none' | 'root' | 'child';

type AgentLoopObserverToolAdmission =
  | { kind: 'registry_default' }
  | {
      kind: 'restricted';
      directRegistryNames: string[];
      allowedRegistryNames: string[];
    };

interface AgentLoopObserverToolLibraryProjectionSummary {
  sdkVersion: string;
  sdkProjectionHash: `sha256:${string}`;
  policyId: string;
}

export interface AgentLoopObserverSnapshot {
  schemaVersion: 4;
  runId: string;
  threadId: string;
  input: {
    currentFileProvided: boolean;
    selectionProvided: boolean;
    signalProvided: boolean;
    runStateKind: AgentLoopObserverRunStateKind;
    callModelPort: 'default_provider' | 'injected';
    promptPort: 'default_prompt_port' | 'injected';
    historyPort: 'default_history_port' | 'injected';
    lifecyclePort: 'default_lifecycle_port' | 'injected';
    memoryPort: 'default_memory_port' | 'injected';
    modelRoundPort: 'default_model_round_port' | 'injected';
    structuredOutputPort: 'default_structured_output_port' | 'injected';
    toolDefinitionPort: 'default_tool_definition_port' | 'injected';
    toolRuntimePort: 'default_tool_runtime_port' | 'injected';
    toolLibraryProjectionPort:
      | 'default_tool_library_projection_port'
      | 'injected';
  };
  approval: {
    permissionMode: PermissionMode;
    ownerKind: 'foreground' | 'delegated';
  };
  promptPorts: {
    prompt: 'AgentLoopPromptPort';
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
    toolLibraryProjection?: AgentLoopObserverToolLibraryProjectionSummary;
  };
  loopPorts: {
    prompt: 'AgentLoopPromptPort';
    history: 'AgentLoopHistoryPort';
    lifecycle: 'AgentLoopLifecyclePort';
    memory: 'AgentLoopMemoryPort';
    modelRound: 'ModelRoundPort';
    structuredOutputs: 'AgentLoopStructuredOutputPort';
    toolDefinitions: 'AgentLoopToolDefinitionPort';
    toolRuntime: 'AgentLoopToolRuntimePort';
    toolLibraryProjection: 'AgentLoopToolLibraryProjectionPort';
    toolExecution: 'processFunctionCalls';
    structuredOutputImplementations: [
      'ptc_fixed_probe_structured_output',
      'react_bundle_structured_output',
    ];
  };
}

interface BuildAgentLoopObserverSnapshotArgs {
  runId: string;
  runContext: Pick<RunContext, 'threadId'>;
  approvalContext: {
    permissionMode: PermissionMode;
    ownerRunId?: string;
    ownerThreadId?: ThreadId;
  };
  toolSurface?: AgentToolSurface;
  toolLibraryProjection?: AgentLoopObserverToolLibraryProjectionSummary;
  toolDefs: readonly Pick<ToolDefinition, 'name'>[];
  providerRequestOptions: ProviderRequestOptions;
  callModelImplProvided: boolean;
  currentFileProvided: boolean;
  selectionProvided: boolean;
  signalProvided: boolean;
  promptPortProvided: boolean;
  historyPortProvided: boolean;
  lifecyclePortProvided: boolean;
  memoryPortProvided: boolean;
  modelRoundPortProvided: boolean;
  structuredOutputPortProvided: boolean;
  toolDefinitionPortProvided: boolean;
  toolRuntimePortProvided: boolean;
  toolLibraryProjectionPortProvided: boolean;
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

type AgentLoopObserverDeliveryOperation = 'record_snapshot' | 'record_event';

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

type AgentLoopObserverToolLibraryProjectionRehydrationResult =
  | Awaited<ReturnType<ToolLibraryProjectionPort['rehydrateProjectionMount']>>
  | {
      ok: false;
      reason: 'projection_identity_missing';
      message: string;
    };

export async function rehydrateToolLibraryProjectionFromObserverSnapshot(args: {
  snapshot: Pick<AgentLoopObserverSnapshot, 'threadId' | 'toolSurface'>;
  stateRoot: string;
  projectionPort: Pick<ToolLibraryProjectionPort, 'rehydrateProjectionMount'>;
}): Promise<AgentLoopObserverToolLibraryProjectionRehydrationResult> {
  const expectedIdentity = args.snapshot.toolSurface.toolLibraryProjection;
  if (expectedIdentity === undefined) {
    return {
      ok: false,
      reason: 'projection_identity_missing',
      message:
        'Agent loop observer snapshot has no tool library projection identity',
    };
  }

  return await args.projectionPort.rehydrateProjectionMount({
    stateRoot: args.stateRoot,
    threadId: args.snapshot.threadId,
    expectedIdentity,
  });
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
    schemaVersion: 4,
    runId: args.runId,
    threadId: args.runContext.threadId,
    input: {
      currentFileProvided: args.currentFileProvided,
      selectionProvided: args.selectionProvided,
      signalProvided: args.signalProvided,
      runStateKind: args.runStateKind,
      callModelPort: args.callModelImplProvided
        ? 'injected'
        : 'default_provider',
      promptPort: args.promptPortProvided ? 'injected' : 'default_prompt_port',
      historyPort: args.historyPortProvided
        ? 'injected'
        : 'default_history_port',
      lifecyclePort: args.lifecyclePortProvided
        ? 'injected'
        : 'default_lifecycle_port',
      memoryPort: args.memoryPortProvided ? 'injected' : 'default_memory_port',
      modelRoundPort: args.modelRoundPortProvided
        ? 'injected'
        : 'default_model_round_port',
      structuredOutputPort: args.structuredOutputPortProvided
        ? 'injected'
        : 'default_structured_output_port',
      toolDefinitionPort: args.toolDefinitionPortProvided
        ? 'injected'
        : 'default_tool_definition_port',
      toolRuntimePort: args.toolRuntimePortProvided
        ? 'injected'
        : 'default_tool_runtime_port',
      toolLibraryProjectionPort: args.toolLibraryProjectionPortProvided
        ? 'injected'
        : 'default_tool_library_projection_port',
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
      prompt: 'AgentLoopPromptPort',
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
        args.toolSurface === undefined
          ? { kind: 'registry_default' }
          : {
              kind: 'restricted',
              directRegistryNames: [...args.toolSurface.directRegistryNames],
              allowedRegistryNames: [...args.toolSurface.allowedRegistryNames],
            },
      definitions: {
        count: toolNames.length,
        names: toolNames,
      },
      ...(args.toolLibraryProjection === undefined
        ? {}
        : { toolLibraryProjection: args.toolLibraryProjection }),
    },
    loopPorts: {
      prompt: 'AgentLoopPromptPort',
      history: 'AgentLoopHistoryPort',
      lifecycle: 'AgentLoopLifecyclePort',
      memory: 'AgentLoopMemoryPort',
      modelRound: 'ModelRoundPort',
      structuredOutputs: 'AgentLoopStructuredOutputPort',
      toolDefinitions: 'AgentLoopToolDefinitionPort',
      toolRuntime: 'AgentLoopToolRuntimePort',
      toolLibraryProjection: 'AgentLoopToolLibraryProjectionPort',
      toolExecution: 'processFunctionCalls',
      structuredOutputImplementations: [
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
