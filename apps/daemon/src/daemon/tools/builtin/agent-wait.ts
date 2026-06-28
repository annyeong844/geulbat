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
        'all returns when every listed child is terminal or blocked. any returns after the first terminal child, or when every listed child is blocked.',
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
  if (
    waitMode !== undefined &&
    !AGENT_WAIT_MODES.includes(waitMode as AgentWaitMode)
  ) {
    return failToolParse(
      `wait_mode must be one of: ${AGENT_WAIT_MODES.join(', ')}.`,
    );
  }

  return {
    ok: true as const,
    value: {
      child_run_ids: normalizedChildRunIds,
      ...(waitMode !== undefined
        ? { wait_mode: waitMode as AgentWaitMode }
        : {}),
    },
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
    mayMutateWorkspaceFiles: false,
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
      const outcome = await waitForAgentChildren({
        registry,
        ownerThreadId,
        childRunIds,
        waitMode,
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
