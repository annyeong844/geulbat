import type { ProjectId, RunId, ThreadId } from '@geulbat/protocol/ids';
import type { PermissionMode } from '@geulbat/protocol/run-approval';
import type { AgentEvent, ToolRunState } from '../../runtime-contracts.js';
import type { AgentRuntimeServices } from '../../daemon-runtime-contract.js';
import {
  buildChildLaunchPayload,
  buildChildLaunchRejected,
  type SubagentType,
} from '../../subagent-runtime-contracts.js';
import type { ExecuteResult, SubagentRunLauncher } from '../types.js';

export async function runSubagentLaunchPipeline(args: {
  task: string;
  subagentType: SubagentType;
  parentRunId: RunId;
  ownerThreadId: ThreadId;
  projectId: ProjectId;
  workspaceRoot: string;
  parentRunState: ToolRunState;
  runtimeServices: AgentRuntimeServices;
  startBackgroundRun?: SubagentRunLauncher['startBackgroundRun'];
  emitAgentEvent?: (event: AgentEvent) => void;
  approvalSessionId?: string;
  permissionMode?: PermissionMode;
  timeoutMs?: number;
  childRunId?: RunId;
  childThreadId?: ThreadId;
}): Promise<ExecuteResult> {
  const launchAdmission =
    args.runtimeServices.subagentAdmission.reserveSubagentLaunchSlots({
      runState: args.parentRunState,
      requestedChildren: 1,
      transferExistingReservation: true,
    });
  if (!launchAdmission.ok) {
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
    const startBackgroundRun =
      args.startBackgroundRun ??
      args.runtimeServices.subagentRuns.startBackgroundRun;
    return await startBackgroundRun({
      task: args.task,
      subagentType: args.subagentType,
      parentRunId: args.parentRunId,
      ownerThreadId: args.ownerThreadId,
      projectId: args.projectId,
      workspaceRoot: args.workspaceRoot,
      parentRunState: args.parentRunState,
      runtimeServices: args.runtimeServices,
      launchReservation: launchAdmission.reservation,
      ...(args.childRunId !== undefined ? { childRunId: args.childRunId } : {}),
      ...(args.childThreadId !== undefined
        ? { childThreadId: args.childThreadId }
        : {}),
      ...(args.emitAgentEvent !== undefined
        ? { emitAgentEvent: args.emitAgentEvent }
        : {}),
      ...(args.approvalSessionId !== undefined
        ? { approvalSessionId: args.approvalSessionId }
        : {}),
      ...(args.permissionMode !== undefined
        ? { permissionMode: args.permissionMode }
        : {}),
      ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    });
  } catch (error: unknown) {
    launchAdmission.reservation.release();
    throw error;
  }
}
