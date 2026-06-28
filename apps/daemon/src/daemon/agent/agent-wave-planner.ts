import type { ResourceBudgetSnapshot } from './resource-budget-provider.js';
import type { FunctionCall } from '../llm/index.js';
import type { SubagentType } from '../subagent-runtime-contracts.js';

const SERIAL_SAFETY_FLOOR_ITEM_COUNT = 1;
const AGENT_SPAWN_TOOL_NAME = 'agent_spawn';

export interface AgentWaveWorkItem {
  readonly itemId: string;
  readonly task: string;
  readonly subagentType: SubagentType;
}

export type AgentWaveExplicitPolicy =
  | {
      readonly source: 'user';
      readonly requestedItemCount: number;
      readonly policyRef: string;
    }
  | {
      readonly source: 'runtime';
      readonly requestedItemCount: number;
      readonly policyRef: string;
    };

export type AgentWaveSerialFloorAdmission =
  | {
      readonly kind: 'admitted';
      readonly evidenceRef: string;
    }
  | {
      readonly kind: 'rejected';
      readonly message: string;
      readonly evidenceRef: string;
    }
  | {
      readonly kind: 'unknown';
      readonly message: string;
      readonly evidenceRef?: string;
    };

export interface AgentWavePlanningInput {
  readonly phaseId: string;
  readonly waveIndex: number;
  readonly remainingItems: readonly AgentWaveWorkItem[];
  readonly resourceSnapshot: ResourceBudgetSnapshot;
  readonly serialFloorAdmission?: AgentWaveSerialFloorAdmission;
  readonly explicitPolicy?: AgentWaveExplicitPolicy;
  readonly admissionDownshiftFrom?: {
    readonly rejectedRequestedItemCount: number;
    readonly evidenceRef: string;
  };
  readonly previousWaveTelemetryRefs?: readonly string[];
}

export type AgentWaveCapacityReasonCode =
  | 'explicit_user_policy'
  | 'explicit_runtime_policy'
  | 'fresh_resource_snapshot'
  | 'serial_safety_floor'
  | 'admission_downshift'
  | 'telemetry_adjusted';

export type AgentWaveFailureReasonCode =
  | 'capacity_unknown'
  | 'admission_rejected'
  | 'policy_required'
  | 'no_remaining_items'
  | 'workflow_cancelled'
  | 'workflow_backstop_exceeded';

export type AgentWaveDecision =
  | {
      readonly ok: true;
      readonly phaseId: string;
      readonly waveIndex: number;
      readonly proposedItemIds: readonly string[];
      readonly requestedItemCount: number;
      readonly capacityReason: {
        readonly reasonCode: AgentWaveCapacityReasonCode;
        readonly message: string;
        readonly evidenceRefs: readonly string[];
      };
      readonly resourceSnapshotId: string;
    }
  | {
      readonly ok: false;
      readonly reasonCode: AgentWaveFailureReasonCode;
      readonly message: string;
      readonly evidenceRefs: readonly string[];
    };

export interface AgentWavePlanner {
  planNextWave(input: AgentWavePlanningInput): AgentWaveDecision;
}

export type AgentWaveFunctionCallMaterialization =
  | {
      readonly ok: true;
      readonly functionCalls: readonly FunctionCall[];
    }
  | {
      readonly ok: false;
      readonly reasonCode:
        | 'wave_not_launchable'
        | 'duplicate_work_item_id'
        | 'work_item_not_found'
        | 'empty_task';
      readonly message: string;
      readonly itemId: string | null;
    };

export function createAgentWavePlanner(): AgentWavePlanner {
  return {
    planNextWave,
  };
}

export function materializeAgentWaveSubagentFunctionCalls(args: {
  decision: AgentWaveDecision;
  workItems: readonly AgentWaveWorkItem[];
}): AgentWaveFunctionCallMaterialization {
  if (!args.decision.ok) {
    return materializationFailure({
      reasonCode: 'wave_not_launchable',
      message: `cannot materialize failed wave decision: ${args.decision.reasonCode}`,
      itemId: null,
    });
  }

  const indexedWorkItems = new Map<string, AgentWaveWorkItem>();
  for (const workItem of args.workItems) {
    if (indexedWorkItems.has(workItem.itemId)) {
      return materializationFailure({
        reasonCode: 'duplicate_work_item_id',
        message: `duplicate wave work item id: ${workItem.itemId}`,
        itemId: workItem.itemId,
      });
    }
    indexedWorkItems.set(workItem.itemId, workItem);
  }

  const functionCalls: FunctionCall[] = [];
  for (const [index, itemId] of args.decision.proposedItemIds.entries()) {
    const workItem = indexedWorkItems.get(itemId);
    if (workItem === undefined) {
      return materializationFailure({
        reasonCode: 'work_item_not_found',
        message: `wave proposal references missing work item: ${itemId}`,
        itemId,
      });
    }

    const task = workItem.task.trim();
    if (!task) {
      return materializationFailure({
        reasonCode: 'empty_task',
        message: `wave work item has empty task: ${itemId}`,
        itemId,
      });
    }

    functionCalls.push({
      id: `${args.decision.phaseId}:${args.decision.waveIndex}:${index}:${itemId}:agent_spawn`,
      callId: `${args.decision.phaseId}:${args.decision.waveIndex}:${index}:${itemId}:agent_spawn_call`,
      name: AGENT_SPAWN_TOOL_NAME,
      arguments: JSON.stringify({
        task,
        subagent_type: workItem.subagentType,
      }),
    });
  }

  return {
    ok: true,
    functionCalls,
  };
}

function planNextWave(input: AgentWavePlanningInput): AgentWaveDecision {
  if (input.remainingItems.length === 0) {
    return fail({
      reasonCode: 'no_remaining_items',
      message: `phase ${input.phaseId} has no remaining work items`,
      evidenceRefs: [input.resourceSnapshot.snapshotId],
    });
  }

  if (input.explicitPolicy !== undefined) {
    return planExplicitPolicyWave(input, input.explicitPolicy);
  }

  const floorAdmission = resolveSerialFloorAdmission(
    input.serialFloorAdmission,
  );
  if (!floorAdmission.ok) {
    return floorAdmission.decision;
  }

  if (input.admissionDownshiftFrom !== undefined) {
    return success({
      input,
      proposedItemCount: SERIAL_SAFETY_FLOOR_ITEM_COUNT,
      reasonCode: 'admission_downshift',
      message: `downshifted to the serial safety floor after admission rejected ${input.admissionDownshiftFrom.rejectedRequestedItemCount} item(s)`,
      evidenceRefs: [
        input.resourceSnapshot.snapshotId,
        floorAdmission.evidenceRef,
        input.admissionDownshiftFrom.evidenceRef,
      ],
    });
  }

  return success({
    input,
    proposedItemCount: SERIAL_SAFETY_FLOOR_ITEM_COUNT,
    reasonCode: 'serial_safety_floor',
    message:
      'proposed the serial safety floor because no explicit policy or trusted wider-wave evidence was provided',
    evidenceRefs: [
      input.resourceSnapshot.snapshotId,
      floorAdmission.evidenceRef,
    ],
  });
}

function planExplicitPolicyWave(
  input: AgentWavePlanningInput,
  policy: AgentWaveExplicitPolicy,
): AgentWaveDecision {
  if (!isPositiveSafeInteger(policy.requestedItemCount)) {
    return fail({
      reasonCode: 'policy_required',
      message: `${policy.source} wave policy ${policy.policyRef} must request a positive safe integer item count`,
      evidenceRefs: [input.resourceSnapshot.snapshotId, policy.policyRef],
    });
  }

  const proposedItemCount = Math.min(
    policy.requestedItemCount,
    input.remainingItems.length,
  );
  const reasonCode =
    policy.source === 'user'
      ? 'explicit_user_policy'
      : 'explicit_runtime_policy';
  const message =
    proposedItemCount < policy.requestedItemCount
      ? `${policy.source} policy ${policy.policyRef} requested ${policy.requestedItemCount} items; proposing all ${proposedItemCount} remaining item(s)`
      : `${policy.source} policy ${policy.policyRef} proposed ${proposedItemCount} item(s) for direct admission`;

  return success({
    input,
    proposedItemCount,
    reasonCode,
    message,
    evidenceRefs: [input.resourceSnapshot.snapshotId, policy.policyRef],
  });
}

function resolveSerialFloorAdmission(
  admission: AgentWaveSerialFloorAdmission | undefined,
):
  | {
      ok: true;
      evidenceRef: string;
    }
  | {
      ok: false;
      decision: AgentWaveDecision;
    } {
  if (admission === undefined) {
    return {
      ok: false,
      decision: fail({
        reasonCode: 'capacity_unknown',
        message: 'serial safety floor admission evidence unavailable',
        evidenceRefs: [],
      }),
    };
  }

  if (admission.kind === 'rejected') {
    return {
      ok: false,
      decision: fail({
        reasonCode: 'admission_rejected',
        message: admission.message,
        evidenceRefs: [admission.evidenceRef],
      }),
    };
  }

  if (admission.kind === 'unknown') {
    return {
      ok: false,
      decision: fail({
        reasonCode: 'capacity_unknown',
        message: admission.message,
        evidenceRefs:
          admission.evidenceRef === undefined ? [] : [admission.evidenceRef],
      }),
    };
  }

  return {
    ok: true,
    evidenceRef: admission.evidenceRef,
  };
}

function success(args: {
  input: AgentWavePlanningInput;
  proposedItemCount: number;
  reasonCode: AgentWaveCapacityReasonCode;
  message: string;
  evidenceRefs: readonly string[];
}): AgentWaveDecision {
  return {
    ok: true,
    phaseId: args.input.phaseId,
    waveIndex: args.input.waveIndex,
    proposedItemIds: args.input.remainingItems
      .slice(0, args.proposedItemCount)
      .map((item) => item.itemId),
    requestedItemCount: args.proposedItemCount,
    capacityReason: {
      reasonCode: args.reasonCode,
      message: args.message,
      evidenceRefs: [
        ...args.evidenceRefs,
        ...(args.input.previousWaveTelemetryRefs ?? []),
      ],
    },
    resourceSnapshotId: args.input.resourceSnapshot.snapshotId,
  };
}

function fail(args: {
  reasonCode: AgentWaveFailureReasonCode;
  message: string;
  evidenceRefs: readonly string[];
}): AgentWaveDecision {
  return {
    ok: false,
    reasonCode: args.reasonCode,
    message: args.message,
    evidenceRefs: args.evidenceRefs,
  };
}

function materializationFailure(args: {
  reasonCode: Extract<
    AgentWaveFunctionCallMaterialization,
    { ok: false }
  >['reasonCode'];
  message: string;
  itemId: string | null;
}): AgentWaveFunctionCallMaterialization {
  return {
    ok: false,
    reasonCode: args.reasonCode,
    message: args.message,
    itemId: args.itemId,
  };
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
