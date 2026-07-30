import type { RunId, ThreadId } from '@geulbat/protocol/ids';
import type { PermissionMode } from '@geulbat/protocol/run-approval';
import type { AgentEvent, ToolRunState } from '../../runtime-contracts.js';
import type {
  AgentRuntimeServices,
  SubagentRunLauncher,
} from '../../daemon-runtime-contract.js';
import {
  buildChildLaunchPayload,
  buildChildLaunchQueued,
  buildChildLaunchRejected,
  isAgentLaunchToolRaw,
  type ResolvedChildModelPin,
  type RunSubagentModelRouting,
  type SubagentCapability,
  type SubagentType,
} from '../../subagent-runtime-contracts.js';
import type { ExecuteResult } from '../types.js';
import { toolError } from '../result.js';

export function restoreQueuedSubagentLaunchesForParent(args: {
  parentRunId: RunId;
  ownerThreadId: ThreadId;
  stateRoot: string;
  parentRunState: ToolRunState | undefined;
  runtimeServices: AgentRuntimeServices;
  emitAgentEvent?: (event: AgentEvent) => void;
  computerSessionId?: string;
}): number {
  const launchRequestStore = args.runtimeServices.subagent.launchRequests;
  if (launchRequestStore === undefined) {
    return 0;
  }
  const queuedRequests = launchRequestStore
    .readQueuedSubagentLaunchRequests()
    .filter((request) => request.parentRunId === args.parentRunId);
  if (queuedRequests.length === 0) {
    return 0;
  }
  if (args.parentRunState === undefined) {
    throw new Error('queued subagent recovery requires the parent run state');
  }
  const parentRunState = args.parentRunState;
  const launchPromotions = args.runtimeServices.subagent.launchPromotions;
  if (launchPromotions === undefined) {
    throw new Error('queued subagent recovery promotion is unavailable');
  }

  const recoverableLaunches = queuedRequests.map((durableRequest) => {
    const input = launchRequestStore.readSubagentLaunchInput(
      durableRequest.childRunId,
    );
    if (
      input.parentRunId !== durableRequest.parentRunId ||
      input.ownerThreadId !== durableRequest.ownerThreadId ||
      input.toolCallId !== durableRequest.toolCallId ||
      input.parentRunId !== args.parentRunId ||
      input.ownerThreadId !== args.ownerThreadId ||
      input.stateRoot !== args.stateRoot
    ) {
      throw new Error(
        `queued subagent recovery identity conflicts: ${durableRequest.childRunId}`,
      );
    }
    return { durableRequest, input };
  });

  for (const { durableRequest, input } of recoverableLaunches) {
    launchPromotions.restoreQueuedLaunch({
      childRunId: durableRequest.childRunId,
      ultraReasoning: input.ultraReasoning ?? false,
      parentRunState,
      async start() {
        await runSubagentLaunchPipeline({
          task: input.task,
          subagentType: input.subagentType,
          capabilities: input.capabilities,
          parentRunId: input.parentRunId,
          ownerThreadId: input.ownerThreadId,
          stateRoot: input.stateRoot,
          ...(input.workingDirectory === undefined
            ? {}
            : { workingDirectory: input.workingDirectory }),
          parentRunState,
          runtimeServices: args.runtimeServices,
          ...(args.emitAgentEvent === undefined
            ? {}
            : { emitAgentEvent: args.emitAgentEvent }),
          ...(args.computerSessionId === undefined
            ? {}
            : { computerSessionId: args.computerSessionId }),
          ...(input.permissionMode === undefined
            ? {}
            : { permissionMode: input.permissionMode }),
          ultraReasoning: input.ultraReasoning ?? false,
          modelPin: input.modelPin,
          subagentModelRouting: input.subagentModelRouting,
          childRunId: durableRequest.childRunId,
          childThreadId: durableRequest.childThreadId,
          durableLaunchRecorded: true,
        });
      },
    });
  }
  return recoverableLaunches.length;
}

export async function runSubagentLaunchPipeline(args: {
  task: string;
  subagentType: SubagentType;
  capabilities: readonly SubagentCapability[];
  parentRunId: RunId;
  ownerThreadId: ThreadId;
  stateRoot: string;
  workingDirectory?: string;
  parentRunState: ToolRunState;
  runtimeServices: AgentRuntimeServices;
  startBackgroundRun?: SubagentRunLauncher['startBackgroundRun'];
  emitAgentEvent?: (event: AgentEvent) => void;
  computerSessionId?: string;
  permissionMode?: PermissionMode;
  ultraReasoning: boolean;
  modelPin: ResolvedChildModelPin;
  subagentModelRouting: RunSubagentModelRouting;
  timeoutMs?: number;
  childRunId?: RunId;
  childThreadId?: ThreadId;
  childInputPersistence?: {
    entryId: string;
    timestamp: string;
  };
  durableLaunchRecorded?: true;
}): Promise<ExecuteResult> {
  const launchRequestStore = args.runtimeServices.subagent.launchRequests;
  if (
    args.durableLaunchRecorded === true &&
    (launchRequestStore === undefined ||
      args.childRunId === undefined ||
      args.childThreadId === undefined)
  ) {
    return toolError(
      'persistence_unavailable',
      'durable agent launch identity is unavailable',
    );
  }
  const launchAdmission =
    args.runtimeServices.subagent.admission.reserveSubagentLaunchSlots({
      runState: args.parentRunState,
      requestedChildren: 1,
      ultraReasoning: args.ultraReasoning,
      transferExistingReservation: true,
    });
  if (!launchAdmission.ok) {
    if (
      args.durableLaunchRecorded === true &&
      launchRequestStore !== undefined &&
      args.childRunId !== undefined &&
      args.childThreadId !== undefined &&
      args.runtimeServices.subagent.launchPromotions !== undefined
    ) {
      try {
        const deferred =
          args.runtimeServices.subagent.launchPromotions.deferLaunch({
            registration: {
              childRunId: args.childRunId,
              ultraReasoning: args.ultraReasoning,
              parentRunState: args.parentRunState,
              async start() {
                await runSubagentLaunchPipeline(args);
              },
            },
            deferReason: 'configured_capacity',
          });
        return buildChildLaunchPayload(
          buildChildLaunchQueued({
            childRunId: deferred.childRunId,
            childThreadId: deferred.childThreadId,
            subagentType: args.subagentType,
            deferReason: 'configured_capacity',
            modelPin: args.modelPin,
          }),
        );
      } catch {
        return toolError(
          'persistence_unavailable',
          'agent launch deferral could not be durably recorded',
        );
      }
    }
    if (
      args.durableLaunchRecorded === true &&
      launchRequestStore !== undefined &&
      args.childRunId !== undefined
    ) {
      try {
        launchRequestStore.markSubagentLaunchFailedToStart({
          childRunId: args.childRunId,
          reason: launchAdmission.error,
        });
      } catch {
        return toolError(
          'persistence_unavailable',
          'agent launch rejection could not be durably recorded',
        );
      }
    }
    return buildChildLaunchPayload(
      buildChildLaunchRejected({
        subagentType: args.subagentType,
        errorCode: launchAdmission.errorCode,
        error: launchAdmission.error,
        effectiveMax: launchAdmission.effectiveMax,
      }),
    );
  }

  try {
    if (
      args.durableLaunchRecorded === true &&
      launchRequestStore !== undefined &&
      args.childRunId !== undefined
    ) {
      try {
        launchRequestStore.markSubagentLaunchStarting(args.childRunId);
      } catch {
        launchAdmission.reservation.release();
        return toolError(
          'persistence_unavailable',
          'agent launch start could not be durably recorded',
        );
      }
    }
    const startBackgroundRun =
      args.startBackgroundRun ??
      args.runtimeServices.subagent.runs.startBackgroundRun;
    const result = await startBackgroundRun({
      task: args.task,
      subagentType: args.subagentType,
      capabilities: args.capabilities,
      parentRunId: args.parentRunId,
      ownerThreadId: args.ownerThreadId,
      stateRoot: args.stateRoot,
      ...(args.workingDirectory === undefined
        ? {}
        : { workingDirectory: args.workingDirectory }),
      parentRunState: args.parentRunState,
      runtimeServices: args.runtimeServices,
      launchReservation: launchAdmission.reservation,
      ...(args.childRunId !== undefined ? { childRunId: args.childRunId } : {}),
      ...(args.childThreadId !== undefined
        ? { childThreadId: args.childThreadId }
        : {}),
      ...(args.childInputPersistence === undefined
        ? {}
        : { childInputPersistence: args.childInputPersistence }),
      ...(args.emitAgentEvent !== undefined
        ? { emitAgentEvent: args.emitAgentEvent }
        : {}),
      ...(args.computerSessionId !== undefined
        ? { computerSessionId: args.computerSessionId }
        : {}),
      ...(args.permissionMode !== undefined
        ? { permissionMode: args.permissionMode }
        : {}),
      ultraReasoning: args.ultraReasoning,
      modelPin: args.modelPin,
      subagentModelRouting: args.subagentModelRouting,
      ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      ...(args.durableLaunchRecorded === true
        ? { durableLaunchRecorded: true }
        : {}),
    });
    const rejectionReason = readSubagentLaunchRejectionReason(result);
    if (
      rejectionReason !== undefined &&
      args.durableLaunchRecorded === true &&
      launchRequestStore !== undefined &&
      args.childRunId !== undefined
    ) {
      try {
        launchRequestStore.markSubagentLaunchFailedToStart({
          childRunId: args.childRunId,
          reason: rejectionReason,
        });
      } catch {
        return toolError(
          'persistence_unavailable',
          'agent launch failure could not be durably recorded',
        );
      }
    }
    return result;
  } catch (error: unknown) {
    launchAdmission.reservation.release();
    throw error;
  }
}

function readSubagentLaunchRejectionReason(
  result: ExecuteResult,
): string | undefined {
  if (!result.ok) {
    return undefined;
  }
  try {
    const raw: unknown = JSON.parse(result.output);
    return isAgentLaunchToolRaw(raw) && !raw.ok ? raw.error : undefined;
  } catch {
    return undefined;
  }
}
