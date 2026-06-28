import type {
  AgentChildTerminalReason,
  AgentChildTerminalState,
  AgentLaunchRejectedToolRaw,
  AgentLaunchToolRaw,
  SubagentType,
} from '@geulbat/protocol/run-events';
import type { RunId, ThreadId } from '@geulbat/protocol/ids';

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
  subagentType: SubagentType;
  terminalState: AgentChildTerminalState;
  reason?: AgentChildTerminalReason;
  result: string;
  completedAt: string;
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
