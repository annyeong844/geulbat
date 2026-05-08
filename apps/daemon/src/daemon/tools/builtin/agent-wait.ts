import {
  defineParsedTool,
  failToolParse,
  readToolArgsRecord,
} from '../parsed-tool.js';
import { isRunId, type RunId } from '@geulbat/protocol/ids';
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
    blockedReason: 'approval_pending';
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
  snapshot: {
    records: ChildRunSnapshot[];
  };
}): AgentWaitResult {
  const byChildRunId = new Map(
    args.snapshot.records.map((record) => [record.childRunId, record]),
  );
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
        blockedReason: 'approval_pending',
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

      const waitMode = args.wait_mode ?? 'all';
      const childRunIds = [...new Set(args.child_run_ids)];
      const registry = ctx.agentSpawnRuntime.childRuns;
      let revision = -1;

      while (true) {
        const snapshot = registry.getChildRuns(childRunIds);
        revision = snapshot.revision;
        const recordsByChildRunId = new Map(
          snapshot.records.map((record) => [record.childRunId, record]),
        );
        for (const childRunId of childRunIds) {
          const record = recordsByChildRunId.get(childRunId);
          if (!record) {
            return toolError(
              'invalid_args',
              `unknown child run: ${childRunId}`,
            );
          }
          if (record.ownerThreadId !== ctx.threadId) {
            return toolError(
              'invalid_args',
              `child run does not belong to current owner thread: ${childRunId}`,
            );
          }
        }
        const result = buildWaitResult({
          childRunIds,
          snapshot,
        });

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
    },
  });
}

export const agentWaitTool = createAgentWaitTool();
