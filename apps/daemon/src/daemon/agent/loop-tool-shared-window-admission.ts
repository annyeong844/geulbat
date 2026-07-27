import type { FunctionCall } from '../llm/index.js';
import {
  buildChildLaunchPayload,
  buildChildLaunchRejected,
  type AgentLaunchRejectedToolRaw,
  type DurableSubagentLaunchRequest,
  type SubagentLaunchRequestInput,
  type SubagentType,
} from '../subagent-runtime-contracts.js';
import { resolveAgentSpawnLaunchRequest } from '../tools/builtin/agent-spawn.js';
import { toolError } from '../tools/result.js';
import {
  buildAgentToolExecutionContext,
  type ExecuteResult,
  type ToolExecutionResourceSnapshotRef,
} from '../tools/types.js';
import {
  getToolRuntimeRunState,
  type AgentToolCallExecutionRuntime,
} from './loop-tool-runtime.js';

export type SharedToolWindowCallKind =
  | 'read_only'
  | 'subagent_launch'
  | 'ptc_cell';

export interface PreparedSharedToolWindowCall {
  functionCall: FunctionCall;
  toolArgs: Record<string, unknown>;
  sharedKind: SharedToolWindowCallKind;
}

export function admitSharedToolWindow(args: {
  preparedFunctionCalls: readonly PreparedSharedToolWindowCall[];
  runtime: AgentToolCallExecutionRuntime;
}): {
  stagedResults: readonly (ExecuteResult | undefined)[];
  resourceSnapshotRef?: ToolExecutionResourceSnapshotRef;
  release(): void;
} {
  const { preparedFunctionCalls, runtime } = args;
  const runState = getToolRuntimeRunState(runtime);
  const subagentLaunchCalls = preparedFunctionCalls.filter(
    isPreparedSubagentLaunchCall,
  );
  const builtinAgentSpawnCalls = subagentLaunchCalls.filter(
    ({ functionCall }) => functionCall.name === 'agent_spawn',
  );
  const ptcCellCalls = preparedFunctionCalls.filter(isPreparedPtcCellCall);
  const stagedResults: Array<ExecuteResult | undefined> = [];
  let subagentLaunchesRejected = false;
  const durableLaunchRequests: SubagentLaunchRequestInput[] = [];
  let invalidAgentSpawnBatch = false;

  for (const preparedFunctionCall of builtinAgentSpawnCalls) {
    const resolution = resolveAgentSpawnLaunchRequest(
      preparedFunctionCall.toolArgs,
      buildAgentToolExecutionContext({
        base: runtime.executionContextBase,
        callId: preparedFunctionCall.functionCall.callId,
        approvalGranted: true,
      }),
    );
    if (!resolution.ok) {
      stagedResults[preparedFunctionCalls.indexOf(preparedFunctionCall)] =
        resolution.result;
      invalidAgentSpawnBatch = true;
      continue;
    }
    durableLaunchRequests.push(resolution.value.request);
  }
  if (invalidAgentSpawnBatch) {
    for (const preparedFunctionCall of subagentLaunchCalls) {
      const preparedIndex = preparedFunctionCalls.indexOf(preparedFunctionCall);
      if (stagedResults[preparedIndex] !== undefined) {
        continue;
      }
      stagedResults[preparedIndex] = toolError(
        'invalid_args',
        'same-round agent_spawn batch contains an invalid request',
      );
    }
    subagentLaunchesRejected = true;
  }

  let resourceSnapshotRef: ToolExecutionResourceSnapshotRef | undefined;
  if (
    subagentLaunchCalls.length > 0 &&
    ptcCellCalls.length > 0 &&
    runState !== undefined
  ) {
    const resourceSnapshot =
      runtime.executionContextBase.runtimeServices?.agent.resourceBudgetProvider.captureSnapshot(
        { runState },
      );
    resourceSnapshotRef =
      resourceSnapshot === undefined
        ? undefined
        : {
            snapshotId: resourceSnapshot.snapshotId,
          };
  }
  if (
    subagentLaunchCalls.length > 0 &&
    runState !== undefined &&
    !runtime.executionContextBase.runtimeServices
  ) {
    for (const preparedFunctionCall of subagentLaunchCalls) {
      stagedResults[preparedFunctionCalls.indexOf(preparedFunctionCall)] =
        buildRejectedSubagentLaunchResult({
          preparedFunctionCall,
          errorCode: 'execution_failed',
          error: 'agent spawn runtime is required',
        });
    }
    subagentLaunchesRejected = true;
  }

  const launchRuntime = runtime.executionContextBase.runtimeServices;
  const launchRequestStore = launchRuntime?.subagent.launchRequests;
  let durableAcceptedRequests: readonly DurableSubagentLaunchRequest[] = [];
  if (durableLaunchRequests.length > 0 && !subagentLaunchesRejected) {
    let persistenceFailed = launchRequestStore === undefined;
    if (launchRequestStore !== undefined) {
      try {
        durableAcceptedRequests = launchRequestStore.enqueueSubagentLaunchBatch(
          durableLaunchRequests,
        );
      } catch {
        persistenceFailed = true;
      }
    }
    if (persistenceFailed) {
      for (const preparedFunctionCall of subagentLaunchCalls) {
        stagedResults[preparedFunctionCalls.indexOf(preparedFunctionCall)] =
          toolError(
            'persistence_unavailable',
            'agent launch batch could not be durably accepted',
          );
      }
      subagentLaunchesRejected = true;
    }
  }

  const batchAdmission =
    subagentLaunchCalls.length > 0 &&
    runState !== undefined &&
    launchRuntime &&
    !subagentLaunchesRejected
      ? launchRuntime.subagent.admission.reserveSubagentLaunchSlots({
          runState,
          requestedChildren: subagentLaunchCalls.length,
          ultraReasoning: runtime.executionContextBase.ultraReasoning ?? false,
          transferable: true,
        })
      : undefined;

  if (batchAdmission && !batchAdmission.ok) {
    const canDurablyDeferWholeBatch =
      launchRequestStore !== undefined &&
      launchRuntime?.subagent.launchPromotions !== undefined &&
      builtinAgentSpawnCalls.length === subagentLaunchCalls.length &&
      durableAcceptedRequests.length === subagentLaunchCalls.length;
    let deferred = false;
    if (canDurablyDeferWholeBatch) {
      try {
        launchRequestStore.markSubagentLaunchDeferredBatch({
          childRunIds: durableAcceptedRequests.map(
            (request) => request.childRunId,
          ),
          deferReason: 'batch_group_wait',
        });
        deferred = true;
      } catch {
        deferred = false;
      }
    }
    if (!deferred) {
      for (const durableRequest of durableAcceptedRequests) {
        try {
          launchRequestStore?.markSubagentLaunchFailedToStart({
            childRunId: durableRequest.childRunId,
            reason: batchAdmission.error,
          });
        } catch {
          // The tool result below remains an explicit rejection; the store
          // operation already reports its own persistence diagnostic.
        }
      }
      for (const preparedFunctionCall of subagentLaunchCalls) {
        stagedResults[preparedFunctionCalls.indexOf(preparedFunctionCall)] =
          buildRejectedSubagentLaunchResult({
            preparedFunctionCall,
            errorCode: batchAdmission.errorCode,
            error: batchAdmission.error,
            effectiveMax: batchAdmission.effectiveMax,
          });
      }
    }
  }

  return {
    stagedResults,
    ...(resourceSnapshotRef === undefined ? {} : { resourceSnapshotRef }),
    release() {
      if (batchAdmission?.ok) {
        batchAdmission.reservation.release();
      }
    },
  };
}

function isPreparedSubagentLaunchCall(
  preparedFunctionCall: PreparedSharedToolWindowCall,
): boolean {
  return preparedFunctionCall.sharedKind === 'subagent_launch';
}

function isPreparedPtcCellCall(
  preparedFunctionCall: PreparedSharedToolWindowCall,
): boolean {
  return preparedFunctionCall.sharedKind === 'ptc_cell';
}

function buildRejectedSubagentLaunchResult(args: {
  preparedFunctionCall: PreparedSharedToolWindowCall;
  errorCode: AgentLaunchRejectedToolRaw['errorCode'];
  error: string;
  effectiveMax?: number;
}): ExecuteResult {
  const rejectionArgs: Parameters<typeof buildChildLaunchRejected>[0] = {
    subagentType: getPreparedSubagentType(args.preparedFunctionCall),
    errorCode: args.errorCode,
    error: args.error,
  };
  if (args.effectiveMax !== undefined) {
    rejectionArgs.effectiveMax = args.effectiveMax;
  }

  return buildChildLaunchPayload(buildChildLaunchRejected(rejectionArgs));
}

function getPreparedSubagentType(
  preparedFunctionCall: PreparedSharedToolWindowCall,
): SubagentType {
  return preparedFunctionCall.toolArgs.subagent_type === 'worker'
    ? 'worker'
    : 'explorer';
}
