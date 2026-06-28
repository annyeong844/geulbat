import {
  AGENT_WAIT_APPROVAL_BLOCKED_REASON,
  type AgentWaitBlockedReason,
} from '@geulbat/protocol/run-events';
import type { RunId, ThreadId } from '@geulbat/protocol/ids';
import { getErrorMessage } from '../utils/error.js';
import type {
  AgentChildTerminalReason,
  AgentChildTerminalState,
  ChildRunSnapshot,
} from '../subagent-runtime-contracts.js';
import { isAgentChildTerminalState } from '../subagent-runtime-contracts.js';

export const AGENT_WAIT_MODES = ['all', 'any'] as const;

export type AgentWaitMode = (typeof AGENT_WAIT_MODES)[number];

export interface AgentWaitResult {
  ok: true;
  completed: Array<{
    childRunId: RunId;
    terminalState: AgentChildTerminalState;
    ok: boolean;
    reason?: AgentChildTerminalReason;
    result: string;
  }>;
  pending: RunId[];
  blocked: Array<{
    childRunId: RunId;
    blockedReason: AgentWaitBlockedReason;
  }>;
}

export type AgentChildWaitOutcome =
  | {
      ok: true;
      result: AgentWaitResult;
    }
  | {
      ok: false;
      errorCode: 'invalid_args' | 'aborted' | 'execution_failed';
      message: string;
    };

export interface AgentChildWaitRegistry {
  getChildRuns(childRunIds: readonly RunId[]): {
    revision: number;
    records: ChildRunSnapshot[];
  };
  waitForRevisionChange(
    afterRevision: number,
    signal?: AbortSignal,
  ): Promise<number>;
}

function buildWaitResult(args: {
  childRunIds: readonly RunId[];
  recordsByChildRunId: ReadonlyMap<RunId, ChildRunSnapshot>;
}): AgentWaitResult {
  const byChildRunId = args.recordsByChildRunId;
  const completed: AgentWaitResult['completed'] = [];
  const pending: RunId[] = [];
  const blocked: AgentWaitResult['blocked'] = [];

  for (const childRunId of args.childRunIds) {
    const record = byChildRunId.get(childRunId);
    if (!record) {
      throw new Error(`unknown child run: ${childRunId}`);
    }

    if (record.status === 'approval_pending') {
      blocked.push({
        childRunId,
        blockedReason: AGENT_WAIT_APPROVAL_BLOCKED_REASON,
      });
      continue;
    }
    if (!isAgentChildTerminalState(record.status)) {
      pending.push(childRunId);
      continue;
    }
    completed.push({
      childRunId,
      terminalState: record.status,
      ok: record.status === 'completed',
      ...(record.reason ? { reason: record.reason } : {}),
      result: record.result ?? '',
    });
  }

  return {
    ok: true,
    completed,
    pending,
    blocked,
  };
}

export async function waitForAgentChildren(args: {
  registry: AgentChildWaitRegistry;
  ownerThreadId: ThreadId;
  childRunIds: readonly RunId[];
  waitMode: AgentWaitMode;
  signal?: AbortSignal;
}): Promise<AgentChildWaitOutcome> {
  let revision = -1;
  while (true) {
    const snapshot = args.registry.getChildRuns(args.childRunIds);
    revision = snapshot.revision;
    const recordsByChildRunId = new Map(
      snapshot.records.map((record) => [record.childRunId, record]),
    );

    for (const record of snapshot.records) {
      if (record.ownerThreadId !== args.ownerThreadId) {
        return {
          ok: false,
          errorCode: 'invalid_args',
          message: `child run does not belong to current owner thread: ${record.childRunId}`,
        };
      }
    }

    const missing = args.childRunIds.filter(
      (childRunId) => !recordsByChildRunId.has(childRunId),
    );
    if (missing.length > 0) {
      return {
        ok: false,
        errorCode: 'invalid_args',
        message: `unknown child run: ${missing[0]}`,
      };
    }

    const result = buildWaitResult({
      childRunIds: args.childRunIds,
      recordsByChildRunId,
    });

    if (args.waitMode === 'all') {
      if (result.pending.length === 0) {
        return { ok: true, result };
      }
    } else if (result.completed.length > 0 || result.pending.length === 0) {
      return { ok: true, result };
    }

    try {
      await args.registry.waitForRevisionChange(revision, args.signal);
    } catch (error: unknown) {
      if (args.signal?.aborted) {
        return {
          ok: false,
          errorCode: 'aborted',
          message: 'agent_wait aborted',
        };
      }
      return {
        ok: false,
        errorCode: 'execution_failed',
        message: `agent_wait failed: ${getErrorMessage(error)}`,
      };
    }
  }
}
