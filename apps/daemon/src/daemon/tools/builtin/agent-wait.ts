import {
  defineParsedTool,
  failToolParse,
  readToolArgsRecord,
} from '../parsed-tool.js';
import { isRunId, type RunId } from '@geulbat/protocol/ids';
import {
  AGENT_WAIT_APPROVAL_BLOCKED_REASON,
  type AgentWaitBlockedReason,
} from '@geulbat/protocol/run-events';
import { toolError } from '../result.js';
import { getErrorMessage } from '../../utils/error.js';
import type {
  AgentChildTerminalReason,
  AgentChildTerminalState,
  ChildRunSnapshot,
} from '../../subagent-runtime-contracts.js';
import { isAgentChildTerminalState } from '../../subagent-runtime-contracts.js';

const WAIT_MODES = ['all', 'any'] as const;

type WaitMode = (typeof WAIT_MODES)[number];

interface AgentWaitArgs {
  child_run_ids: RunId[];
  wait_mode?: WaitMode;
}

interface AgentWaitResult {
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

const agentWaitParameters = {
  type: 'object' as const,
  properties: {
    child_run_ids: {
      type: 'array',
      description:
        'Child run handles returned by agent_spawn. Use one or more childRunId values.',
      items: {
        type: 'string',
      },
      minItems: 1,
    },
    wait_mode: {
      type: 'string',
      description:
        'all waits for every listed child to become terminal. any returns after the first terminal child.',
      enum: [...WAIT_MODES],
    },
  },
  required: ['child_run_ids'],
  additionalProperties: false as const,
};

function parseAgentWaitArgs(raw: unknown) {
  const parsed = readToolArgsRecord(raw, ['child_run_ids', 'wait_mode']);
  if (!parsed.ok) {
    return parsed;
  }

  const childRunIds = parsed.value.child_run_ids;
  if (
    !Array.isArray(childRunIds) ||
    childRunIds.length === 0 ||
    childRunIds.some(
      (value) => typeof value !== 'string' || value.trim().length === 0,
    )
  ) {
    return failToolParse('child_run_ids must be a non-empty string array.');
  }

  const normalizedChildRunIds = childRunIds.map((value) => value.trim());
  if (normalizedChildRunIds.some((value) => !isRunId(value))) {
    return failToolParse('child_run_ids must contain valid run ids.');
  }

  const waitMode = parsed.value.wait_mode;
  if (waitMode !== undefined && !WAIT_MODES.includes(waitMode as WaitMode)) {
    return failToolParse(`wait_mode must be one of: ${WAIT_MODES.join(', ')}.`);
  }

  return {
    ok: true as const,
    value: {
      child_run_ids: normalizedChildRunIds,
      ...(waitMode !== undefined ? { wait_mode: waitMode as WaitMode } : {}),
    },
  };
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

function createAgentWaitTool(options: { timeoutMs?: number } = {}) {
  const timeoutMs = options.timeoutMs;

  return defineParsedTool<AgentWaitArgs>({
    name: 'agent_wait',
    description:
      'Wait for one or more previously spawned child runs and return their current terminal results.',
    parameters: agentWaitParameters,
    strict: true,
    sideEffectLevel: 'read',
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    requiresApproval: false,
    parseArgs: parseAgentWaitArgs,
    async executeParsed(args, ctx) {
      if (!ctx.threadId || !ctx.agentSpawnRuntime) {
        return toolError(
          'execution_failed',
          'agent_wait requires agent runtime and thread context',
        );
      }

      const ownerThreadId = ctx.threadId;
      const waitMode = args.wait_mode ?? 'all';
      const childRunIds = [...new Set(args.child_run_ids)];
      const registry = ctx.agentSpawnRuntime.childRuns;

      // Owner-scoped lease pins these children's terminal records against
      // budget/TTL collection until this wait hands each off, so a fan-out join
      // never loses a result it is still waiting on (spec §7.2). Validation runs
      // before any pin is installed.
      const lease = registry.acquireWaitLease({ ownerThreadId, childRunIds });
      if (!lease.ok) {
        return toolError('invalid_args', lease.message);
      }

      // Terminal results observed during this wait are owned by the waiter so
      // they survive registry eviction after handoff (spec §7.1). getChildRuns
      // already returns cloned snapshots, so caching them is safe.
      const terminalById = new Map<RunId, ChildRunSnapshot>();
      try {
        let revision = -1;
        while (true) {
          const snapshot = registry.getChildRuns(childRunIds);
          revision = snapshot.revision;
          const presentById = new Map(
            snapshot.records.map((record) => [record.childRunId, record]),
          );

          for (const record of snapshot.records) {
            // Ownership is checked before any cache/ack so a non-owned record is
            // never cached or prematurely unpinned (spec §7.2.1).
            if (record.ownerThreadId !== ownerThreadId) {
              return toolError(
                'invalid_args',
                `child run does not belong to current owner thread: ${record.childRunId}`,
              );
            }
            if (isAgentChildTerminalState(record.status)) {
              terminalById.set(record.childRunId, record);
              registry.ackWaiterHandoff(lease.leaseId, record.childRunId);
            }
          }

          // `unknown` only for ids never observed as registered during this
          // wait; an observed-then-evicted id is served from the cache (§8 #2).
          const missingUncached = childRunIds.filter(
            (childRunId) =>
              !presentById.has(childRunId) && !terminalById.has(childRunId),
          );
          if (missingUncached.length > 0) {
            return toolError(
              'invalid_args',
              `unknown child run: ${missingUncached[0]}`,
            );
          }

          const recordsByChildRunId = new Map<RunId, ChildRunSnapshot>();
          for (const childRunId of childRunIds) {
            const record =
              presentById.get(childRunId) ?? terminalById.get(childRunId);
            if (record) {
              recordsByChildRunId.set(childRunId, record);
            }
          }
          const result = buildWaitResult({ childRunIds, recordsByChildRunId });

          if (waitMode === 'all') {
            if (result.pending.length === 0 && result.blocked.length === 0) {
              return {
                ok: true,
                output: JSON.stringify(result),
              };
            }
          } else if (result.completed.length > 0) {
            return {
              ok: true,
              output: JSON.stringify(result),
            };
          }

          try {
            await registry.waitForRevisionChange(revision, ctx.signal);
          } catch (error: unknown) {
            if (ctx.signal?.aborted) {
              return toolError('aborted', 'agent_wait aborted');
            }
            return toolError(
              'execution_failed',
              `agent_wait failed: ${getErrorMessage(error)}`,
            );
          }
        }
      } finally {
        registry.releaseWaitLease(lease.leaseId);
      }
    },
  });
}

export const agentWaitTool = createAgentWaitTool();
