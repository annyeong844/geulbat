import {
  defineParsedTool,
  failToolParse,
  readToolArgsRecord,
} from '../parsed-tool.js';
import { isRunId, type RunId } from '@geulbat/protocol/ids';
import { toolError } from '../result.js';
import type { AgentWaitMode } from '../agent-child-wait.js';
import { AGENT_WAIT_MODES, waitForAgentChildren } from '../agent-child-wait.js';

interface AgentWaitArgs {
  child_run_ids: RunId[];
  wait_mode?: AgentWaitMode;
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
        'snapshot returns the current completed, pending, and blocked state immediately and is the default. all waits for every listed child to become terminal. any returns after the first terminal child.',
      enum: [...AGENT_WAIT_MODES],
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
    !childRunIds.every(
      (value: unknown): value is string =>
        typeof value === 'string' && value.trim().length > 0,
    )
  ) {
    return failToolParse('child_run_ids must be a non-empty string array.');
  }

  const normalizedChildRunIds = childRunIds.map((value) => value.trim());
  if (!normalizedChildRunIds.every(isRunId)) {
    return failToolParse('child_run_ids must contain valid run ids.');
  }

  const waitMode = parsed.value.wait_mode;
  const normalizedWaitMode = AGENT_WAIT_MODES.find(
    (candidate) => candidate === waitMode,
  );
  if (waitMode !== undefined && normalizedWaitMode === undefined) {
    return failToolParse(
      `wait_mode must be one of: ${AGENT_WAIT_MODES.join(', ')}.`,
    );
  }

  return {
    ok: true as const,
    value: {
      child_run_ids: normalizedChildRunIds,
      ...(normalizedWaitMode !== undefined
        ? { wait_mode: normalizedWaitMode }
        : {}),
    },
  };
}

function createAgentWaitTool(options: { timeoutMs?: number } = {}) {
  const timeoutMs = options.timeoutMs;

  return defineParsedTool<AgentWaitArgs>({
    name: 'agent_wait',
    description:
      'Inspect one or more previously spawned child runs immediately, or explicitly join them at a dependency barrier.',
    parameters: agentWaitParameters,
    strict: true,
    sideEffectLevel: 'read',
    mayMutateComputerFiles: false,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    requiresApproval: false,
    catalogSearchMetadata: {
      family: 'agent',
      searchHints: ['wait for agent', 'join subagents', 'collect agent result'],
      tags: ['agent', 'subagent', 'wait'],
      whenToUse:
        'Check subagent progress without blocking, or explicitly join subagents when their results are required.',
      notFor: 'Launching new work or sending new input.',
    },
    parseArgs: parseAgentWaitArgs,
    async executeParsed(args, ctx) {
      if (!ctx.threadId || !ctx.agentSpawnRuntime) {
        return toolError(
          'execution_failed',
          'agent_wait requires agent runtime and thread context',
        );
      }

      const ownerThreadId = ctx.threadId;
      const waitMode = args.wait_mode ?? 'snapshot';
      const childRunIds = [...new Set(args.child_run_ids)];
      const registry = ctx.agentSpawnRuntime.childRuns;
      const outcome = await waitForAgentChildren({
        registry,
        ownerThreadId,
        childRunIds,
        waitMode,
        blockedBehavior: 'wait',
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      });
      if (!outcome.ok) {
        return toolError(outcome.errorCode, outcome.message);
      }
      registry.claimTerminalChildRuns({
        ownerThreadId,
        childRunIds: outcome.result.completed.map((entry) => entry.childRunId),
      });
      return {
        ok: true,
        output: JSON.stringify(outcome.result),
      };
    },
  });
}

export const agentWaitTool = createAgentWaitTool();
