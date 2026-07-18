import type {
  AgentChildTerminalReason,
  AgentChildTerminalState,
  AgentLaunchRejectedToolRaw,
  AgentLaunchToolRaw,
  RunUsageTotals,
  SubagentType,
} from '@geulbat/protocol/run-events';
import type { RunId, ThreadId } from '@geulbat/protocol/ids';
import type { ProviderAuthProviderId } from '@geulbat/protocol/provider-auth';
import {
  resolveRunModelDescriptor,
  type RunReasoningEffort,
  type RunSubagentModelChoice,
  type RunSubagentModelRouting,
  type SubagentModelSelectionSource,
} from '@geulbat/protocol/run-contract';

export {
  SUBAGENT_TYPES,
  isAgentChildTerminalState,
  isAgentLaunchToolRaw,
  isSubagentType,
} from '@geulbat/protocol/run-events';
export type {
  AgentChildTerminalReason,
  AgentChildTerminalState,
  AgentLaunchAckToolRaw,
  AgentLaunchRejectedToolRaw,
  AgentLaunchToolRaw,
  SubagentType,
} from '@geulbat/protocol/run-events';
export type {
  RunSubagentModelChoice,
  RunSubagentModelRouting,
} from '@geulbat/protocol/run-contract';

export interface ProviderRunSelection {
  providerModel: {
    providerId: ProviderAuthProviderId;
    model: string;
  };
  reasoningEffort: RunReasoningEffort;
}

export interface ResolvedChildModelPin {
  modelId: string;
  providerRunSelection: ProviderRunSelection;
  selectionSource: SubagentModelSelectionSource;
}

type ChildModelPinResolution =
  | { ok: true; pin: ResolvedChildModelPin }
  | {
      ok: false;
      errorCode: 'invalid_args' | 'execution_failed';
      error: string;
    };

export function resolveChildModelPin(args: {
  routing: RunSubagentModelRouting;
  requestedChoice?: RunSubagentModelChoice;
  inheritedSelection?: ProviderRunSelection;
}): ChildModelPinResolution {
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
    });
  }

  if (args.requestedChoice !== undefined) {
    return resolveCatalogChildModelPin({
      choice: args.requestedChoice,
      selectionSource: 'model_selected',
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

  return {
    ok: true,
    pin: {
      modelId: args.inheritedSelection.providerModel.model,
      providerRunSelection: {
        providerModel: { ...args.inheritedSelection.providerModel },
        reasoningEffort: args.inheritedSelection.reasoningEffort,
      },
      selectionSource: 'inherited',
    },
  };
}

function resolveCatalogChildModelPin(args: {
  choice: RunSubagentModelChoice;
  selectionSource: Exclude<SubagentModelSelectionSource, 'inherited'>;
}): ChildModelPinResolution {
  const descriptor = resolveRunModelDescriptor(args.choice.modelId);
  const reasoningEffort =
    args.choice.reasoningEffort ?? descriptor.defaultReasoningEffort;
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
      },
      selectionSource: args.selectionSource,
    },
  };
}

export type ChildRunStatus =
  | 'running'
  | 'approval_pending'
  | AgentChildTerminalState;

interface ChildRunSnapshotBase {
  childRunId: RunId;
  childThreadId: ThreadId;
  parentRunId: RunId;
  ownerThreadId: ThreadId;
  subagentType: SubagentType;
  modelPin: ResolvedChildModelPin;
  subagentModelRouting: RunSubagentModelRouting;
  updatedAt: string;
}

interface ChildRunActiveSnapshot extends ChildRunSnapshotBase {
  status: 'running' | 'approval_pending';
  result: null;
  completedAt: null;
  reason: null;
}

export interface ChildRunTerminalSnapshot extends ChildRunSnapshotBase {
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
  parentRunId: RunId;
  childRunId: RunId;
  // Optional only for legacy producers; the lifecycle always fills it so the
  // shell can drill into the child session.
  childThreadId?: ThreadId;
  subagentType: SubagentType;
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

export interface SubagentLaunchReservation {
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

export function buildChildLaunchPayload(result: AgentLaunchToolRaw): {
  ok: true;
  output: string;
} {
  return {
    ok: true,
    output: JSON.stringify(result),
  };
}
