import type {
  AgentLaunchAckToolRaw,
  AgentLaunchQueuedToolRaw,
  AgentLaunchRejectedToolRaw,
  AgentLaunchToolRaw,
  RunUsageTotals,
  SubagentCapability,
  SubagentLaunchDeferReason,
  SubagentLaunchPriorityClass,
  SubagentLaunchRequestState,
  SubagentRetryDisposition,
  SubagentRuntimeDiagnostics,
  SubagentToolSurfaceProfile,
  SubagentType,
} from '@geulbat/protocol/run-events';
import type {
  AgentChildTerminalReason,
  AgentChildTerminalState,
  SubagentResultDeliveryState,
  SubagentResultReport,
} from '@geulbat/protocol/subagent-terminal';
import type { PermissionMode } from '@geulbat/protocol/run-approval';
import {
  isRunModelId,
  resolveMaximumReasoningEffort,
  resolveRunModelDescriptor,
} from '@geulbat/protocol/run-contract';
import type { RunId, ThreadId } from '@geulbat/protocol/ids';
import type {
  RunProviderId,
  RunReasoningEffort,
  RunServiceTier,
  RunSubagentModelChoice,
  RunSubagentModelRouting,
  SubagentModelSelectionSource,
} from '@geulbat/protocol/run-contract';

export {
  SUBAGENT_CAPABILITIES,
  SUBAGENT_LAUNCH_DEFER_REASONS,
  SUBAGENT_LAUNCH_PRIORITY_CLASSES,
  SUBAGENT_LAUNCH_REQUEST_STATES,
  SUBAGENT_TYPES,
  isAgentLaunchToolRaw,
  isSubagentLaunchDeferReason,
  isSubagentLaunchPriorityClass,
  isSubagentLaunchRequestState,
  isSubagentType,
} from '@geulbat/protocol/run-events';
export { isAgentChildTerminalState } from '@geulbat/protocol/subagent-terminal';
export type {
  AgentChildTerminalReason,
  AgentChildTerminalState,
} from '@geulbat/protocol/subagent-terminal';
export type {
  AgentLaunchAckToolRaw,
  AgentLaunchQueuedToolRaw,
  AgentLaunchRejectedToolRaw,
  AgentLaunchToolRaw,
  SubagentCapability,
  SubagentLaunchDeferReason,
  SubagentLaunchPriorityClass,
  SubagentLaunchRequestState,
  SubagentRuntimeDiagnostics,
  SubagentToolSurfaceProfile,
  SubagentType,
} from '@geulbat/protocol/run-events';
export type {
  RunSubagentModelChoice,
  RunSubagentModelRouting,
} from '@geulbat/protocol/run-contract';

export function resolveSubagentToolSurfaceProfile(args: {
  subagentType: SubagentType;
  capabilities: readonly SubagentCapability[];
}): SubagentToolSurfaceProfile {
  if (args.subagentType === 'worker') {
    return 'worker';
  }
  return args.capabilities.includes('ptc') ? 'explorer_ptc' : 'explorer';
}

export interface ProviderRunSelection {
  providerModel: {
    providerId: RunProviderId;
    model: string;
  };
  reasoningEffort: RunReasoningEffort;
  serviceTier?: RunServiceTier;
}

export interface ResolvedChildModelPin {
  modelId: string;
  providerRunSelection: ProviderRunSelection;
  selectionSource: SubagentModelSelectionSource;
}

export interface SubagentLaunchRequestInput {
  toolCallId: string;
  task: string;
  subagentType: SubagentType;
  capabilities: readonly SubagentCapability[];
  parentRunId: RunId;
  ownerThreadId: ThreadId;
  stateRoot: string;
  workingDirectory?: string;
  permissionMode?: PermissionMode;
  ultraReasoning?: boolean;
  modelPin: ResolvedChildModelPin;
  subagentModelRouting: RunSubagentModelRouting;
}

export interface DurableSubagentLaunchRequest {
  enqueueOrder: number;
  childRunId: RunId;
  childThreadId: ThreadId;
  previousChildRunId: RunId | null;
  parentRunId: RunId;
  ownerThreadId: ThreadId;
  toolCallId: string;
  batchId: string | null;
  batchPosition: number;
  launchState: SubagentLaunchRequestState;
  priorityClass: SubagentLaunchPriorityClass;
  deferReason: SubagentLaunchDeferReason | null;
  createdAt: string;
  updatedAt: string;
  failureReason: string | null;
  runtime: SubagentRuntimeDiagnostics;
}

export interface DurableSubagentLaunchRetry {
  disposition: SubagentRetryDisposition;
  request: DurableSubagentLaunchRequest;
  input: SubagentLaunchRequestInput;
}

export interface SubagentLaunchRequestStore {
  enqueueSubagentLaunchBatch(
    requests: readonly SubagentLaunchRequestInput[],
  ): readonly DurableSubagentLaunchRequest[];
  readSubagentLaunchRequest(args: {
    parentRunId: RunId;
    toolCallId: string;
  }): DurableSubagentLaunchRequest | undefined;
  readSubagentLaunchRequestByChildRunId(
    childRunId: RunId,
  ): DurableSubagentLaunchRequest | undefined;
  readSubagentLaunchInput(childRunId: RunId): SubagentLaunchRequestInput;
  readQueuedSubagentLaunchRequests(): readonly DurableSubagentLaunchRequest[];
  markSubagentLaunchDeferredBatch(args: {
    childRunIds: readonly RunId[];
    deferReason: SubagentLaunchDeferReason;
  }): readonly DurableSubagentLaunchRequest[];
  cancelQueuedSubagentLaunchRequest(args: {
    childRunId: RunId;
    ownerThreadId: ThreadId;
  }): DurableSubagentLaunchRequest;
  updateQueuedSubagentLaunchPriority(args: {
    childRunId: RunId;
    ownerThreadId: ThreadId;
    priorityClass: SubagentLaunchPriorityClass;
  }): DurableSubagentLaunchRequest;
  retryInterruptedSubagentLaunch(args: {
    previousChildRunId: RunId;
    ownerThreadId: ThreadId;
    parentRunId: RunId;
    toolCallId: string;
    stateRoot: string;
    workingDirectory?: string;
    permissionMode?: PermissionMode;
  }): DurableSubagentLaunchRetry;
  markSubagentLaunchStarting(childRunId: RunId): void;
  markSubagentLaunchStarted(childRunId: RunId): void;
  recordSubagentRuntimeObservation(args: {
    childRunId: RunId;
    runtime: SubagentRuntimeDiagnostics;
  }): void;
  markSubagentLaunchFailedToStart(args: {
    childRunId: RunId;
    reason: string;
  }): void;
  reconcileSubagentLaunchesAfterRestart?(args: {
    recoverableChildRunIds: readonly RunId[];
    recoverableParentRunIds: readonly RunId[];
  }): void;
}

type ChildModelPinResolution =
  | { ok: true; pin: ResolvedChildModelPin }
  | {
      ok: false;
      errorCode: 'invalid_args' | 'execution_failed';
      error: string;
    };

export function resolveChildModelPin(args: {
  ultraReasoning?: boolean;
  routing: RunSubagentModelRouting;
  requestedChoice?: RunSubagentModelChoice;
  inheritedSelection?: ProviderRunSelection;
}): ChildModelPinResolution {
  const ultraReasoning = args.ultraReasoning ?? false;
  if (args.routing.mode === 'fixed') {
    const fixedChoice = args.routing.choice;
    if (
      args.requestedChoice !== undefined &&
      args.requestedChoice.modelId !== fixedChoice.modelId
    ) {
      return {
        ok: false,
        errorCode: 'invalid_args',
        error: `agent_spawn requested model '${args.requestedChoice.modelId}', but this run fixes all descendants to '${fixedChoice.modelId}'`,
      };
    }
    if (
      !ultraReasoning &&
      fixedChoice.reasoningEffort !== undefined &&
      args.requestedChoice?.reasoningEffort !== undefined &&
      args.requestedChoice.reasoningEffort !== fixedChoice.reasoningEffort
    ) {
      return {
        ok: false,
        errorCode: 'invalid_args',
        error: `agent_spawn requested reasoning effort '${args.requestedChoice.reasoningEffort}', but this run fixes all descendants to '${fixedChoice.reasoningEffort}'`,
      };
    }
    return resolveCatalogChildModelPin({
      choice: {
        modelId: fixedChoice.modelId,
        ...(fixedChoice.reasoningEffort !== undefined
          ? { reasoningEffort: fixedChoice.reasoningEffort }
          : args.requestedChoice?.reasoningEffort !== undefined
            ? { reasoningEffort: args.requestedChoice.reasoningEffort }
            : {}),
      },
      selectionSource: 'user_fixed',
      ultraReasoning,
      ...(args.inheritedSelection?.serviceTier === undefined
        ? {}
        : { serviceTier: args.inheritedSelection.serviceTier }),
    });
  }

  if (args.requestedChoice !== undefined) {
    return resolveCatalogChildModelPin({
      choice: args.requestedChoice,
      selectionSource: 'model_selected',
      ultraReasoning,
      ...(args.inheritedSelection?.serviceTier === undefined
        ? {}
        : { serviceTier: args.inheritedSelection.serviceTier }),
    });
  }

  if (args.inheritedSelection === undefined) {
    return {
      ok: false,
      errorCode: 'execution_failed',
      error:
        'child model selection is unavailable; the parent run did not provide an inheritable provider/model selection',
    };
  }

  if (ultraReasoning) {
    const inheritedModelId = args.inheritedSelection.providerModel.model;
    if (!isRunModelId(inheritedModelId)) {
      return {
        ok: false,
        errorCode: 'execution_failed',
        error: `ultra child model '${inheritedModelId}' is outside the run model catalog`,
      };
    }
    return resolveCatalogChildModelPin({
      choice: { modelId: inheritedModelId },
      selectionSource: 'inherited',
      ultraReasoning,
      ...(args.inheritedSelection.serviceTier === undefined
        ? {}
        : { serviceTier: args.inheritedSelection.serviceTier }),
    });
  }

  return {
    ok: true,
    pin: {
      modelId: args.inheritedSelection.providerModel.model,
      providerRunSelection: {
        providerModel: { ...args.inheritedSelection.providerModel },
        reasoningEffort: args.inheritedSelection.reasoningEffort,
        ...(args.inheritedSelection.serviceTier === undefined
          ? {}
          : { serviceTier: args.inheritedSelection.serviceTier }),
      },
      selectionSource: 'inherited',
    },
  };
}

function resolveCatalogChildModelPin(args: {
  choice: RunSubagentModelChoice;
  selectionSource: SubagentModelSelectionSource;
  ultraReasoning: boolean;
  serviceTier?: RunServiceTier;
}): ChildModelPinResolution {
  const descriptor = resolveRunModelDescriptor(args.choice.modelId);
  const reasoningEffort = args.ultraReasoning
    ? resolveMaximumReasoningEffort(descriptor.id)
    : (args.choice.reasoningEffort ?? descriptor.defaultReasoningEffort);
  if (
    !(descriptor.reasoningEfforts as readonly RunReasoningEffort[]).includes(
      reasoningEffort,
    )
  ) {
    return {
      ok: false,
      errorCode: 'invalid_args',
      error: `reasoning effort '${reasoningEffort}' is not supported by model '${descriptor.id}'`,
    };
  }
  const serviceTier =
    args.serviceTier === undefined
      ? undefined
      : (descriptor.serviceTiers as readonly RunServiceTier[]).includes(
            args.serviceTier,
          )
        ? args.serviceTier
        : 'standard';
  return {
    ok: true,
    pin: {
      modelId: descriptor.id,
      providerRunSelection: {
        providerModel: {
          providerId: descriptor.providerId,
          model: descriptor.id,
        },
        reasoningEffort,
        ...(serviceTier === undefined ? {} : { serviceTier }),
      },
      selectionSource: args.selectionSource,
    },
  };
}

interface ChildRunSnapshotBase {
  childRunId: RunId;
  childThreadId: ThreadId;
  parentRunId: RunId;
  ownerThreadId: ThreadId;
  subagentType: SubagentType;
  capabilities?: readonly SubagentCapability[];
  modelPin: ResolvedChildModelPin;
  subagentModelRouting: RunSubagentModelRouting;
  runtime: SubagentRuntimeDiagnostics;
  updatedAt: string;
}

interface ChildRunActiveSnapshot extends ChildRunSnapshotBase {
  status: 'running' | 'approval_pending';
  result: null;
  completedAt: null;
  reason: null;
}

export interface ChildRunTerminalSnapshot extends ChildRunSnapshotBase {
  deliveryId: string;
  status: AgentChildTerminalState;
  result: string;
  completedAt: string;
  reason: AgentChildTerminalReason | null;
}

export type ChildRunSnapshot =
  | ChildRunActiveSnapshot
  | ChildRunTerminalSnapshot;

export interface BackgroundChildResult {
  deliveryId: string;
  // Queue projections derive this from the durable outbox acknowledgement.
  // The stored terminal body omits it because acknowledgement is mutable.
  resultDeliveryState?: SubagentResultDeliveryState;
  // Durable exact-result handle. Present after the runtime-state owner is
  // attached; legacy/in-memory producers remain valid without it.
  resultRef?: string;
  // Digest of the exact terminal result body behind resultRef. It is derived by
  // the durable store and projected to consumers; lifecycle producers do not
  // supply it.
  resultDigest?: `sha256:${string}`;
  // Supplemental model-authored report. The durable store supplies the source
  // address and digest; the exact result body remains canonical.
  resultReport?: SubagentResultReport;
  parentRunId: RunId;
  childRunId: RunId;
  // Optional only for legacy producers; the lifecycle always fills it so the
  // shell can drill into the child session.
  childThreadId?: ThreadId;
  subagentType: SubagentType;
  capabilities?: readonly SubagentCapability[];
  toolSurface?: SubagentToolSurfaceProfile;
  runtime?: SubagentRuntimeDiagnostics;
  terminalState: AgentChildTerminalState;
  reason?: AgentChildTerminalReason;
  result: string;
  completedAt: string;
  elapsedMs?: number;
  usage?: RunUsageTotals;
  // 차일드 런이 호출한 공개 모델 정체 — subagent_terminal로 셸에 전달
  modelId?: string;
  reasoningEffort?: RunReasoningEffort;
}

export type BackgroundChildResultInput = Omit<
  BackgroundChildResult,
  'resultDeliveryState' | 'resultReport'
> & {
  resultReportSummary?: string;
};

export interface DurableSubagentTerminalOutcome {
  ownerThreadId: ThreadId;
  resultDeliveryState: SubagentResultDeliveryState;
  resultRef: string;
  resultDigest: `sha256:${string}`;
  result: BackgroundChildResult;
}

export interface SubagentTerminalDeliveryRecord {
  inserted: boolean;
  outcome: DurableSubagentTerminalOutcome;
}

export interface SubagentTerminalDeliveryStore {
  recordSubagentTerminalDelivery(args: {
    ownerThreadId: ThreadId;
    result: BackgroundChildResultInput;
  }): SubagentTerminalDeliveryRecord;
  readPendingSubagentTerminalDeliveries(
    ownerThreadId: ThreadId,
  ): readonly DurableSubagentTerminalOutcome[];
  readSubagentTerminalDeliveries(
    ownerThreadId: ThreadId,
  ): readonly DurableSubagentTerminalOutcome[];
  acknowledgeSubagentTerminalDeliveries(args: {
    ownerThreadId: ThreadId;
    deliveryIds: readonly string[];
  }): void;
  clearSubagentTerminalDeliveries(ownerThreadId: ThreadId): void;
  readSubagentTerminalOutcomeByChildRunId(
    childRunId: RunId,
  ): DurableSubagentTerminalOutcome | undefined;
  readSubagentTerminalOutcomeByResultRef(
    resultRef: string,
  ): DurableSubagentTerminalOutcome | undefined;
  isSubagentResultReaderInOwnerScope(args: {
    ownerThreadId: ThreadId;
    parentRunId: RunId;
    readerThreadId: ThreadId;
  }): boolean;
}

export interface SubagentLaunchReservation {
  activate(childRunIdentity: object): void;
  release(): void;
}

export function buildChildLaunchRejected(args: {
  subagentType: SubagentType;
  errorCode: AgentLaunchRejectedToolRaw['errorCode'];
  error: string;
  effectiveMax?: number;
}): AgentLaunchRejectedToolRaw {
  return {
    ok: false,
    launchState: 'rejected',
    subagentType: args.subagentType,
    errorCode: args.errorCode,
    error: args.error,
    ...(args.effectiveMax !== undefined
      ? { effectiveMax: args.effectiveMax }
      : {}),
  };
}

export function buildChildLaunchStarted(args: {
  childRunId: RunId;
  childThreadId: ThreadId;
  subagentType: SubagentType;
  modelPin: ResolvedChildModelPin;
}): AgentLaunchAckToolRaw {
  return {
    ok: true,
    childRunId: args.childRunId,
    childThreadId: args.childThreadId,
    subagentType: args.subagentType,
    launchState: 'started',
    modelId: args.modelPin.modelId,
    reasoningEffort: args.modelPin.providerRunSelection.reasoningEffort,
    selectionSource: args.modelPin.selectionSource,
  };
}

export function buildChildLaunchQueued(args: {
  childRunId: RunId;
  childThreadId: ThreadId;
  subagentType: SubagentType;
  deferReason: SubagentLaunchDeferReason;
  modelPin: ResolvedChildModelPin;
}): AgentLaunchQueuedToolRaw {
  return {
    ok: true,
    childRunId: args.childRunId,
    childThreadId: args.childThreadId,
    subagentType: args.subagentType,
    launchState: 'queued',
    deferReason: args.deferReason,
    modelId: args.modelPin.modelId,
    reasoningEffort: args.modelPin.providerRunSelection.reasoningEffort,
    selectionSource: args.modelPin.selectionSource,
  };
}

export function buildChildLaunchPayload(result: AgentLaunchToolRaw): {
  ok: true;
  output: string;
} {
  return {
    ok: true,
    output: JSON.stringify(result),
  };
}
