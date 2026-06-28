import {
  defineParsedTool,
  failToolParse,
  readToolArgsRecord,
} from '../parsed-tool.js';
import { isRunId, type RunId } from '@geulbat/protocol/ids';
import { toolError } from '../result.js';
import { isAgentChildTerminalState } from '../../subagent-runtime-contracts.js';

interface AgentStopArgs {
  child_run_id: RunId;
}

interface AgentStopResult {
  ok: true;
  childRunId: RunId;
  stopState: 'stopping' | 'already_terminal';
}

const agentStopParameters = {
  type: 'object' as const,
  properties: {
    child_run_id: {
      type: 'string',
      description: 'Stable child handle returned by agent_spawn.',
    },
  },
  required: ['child_run_id'],
  additionalProperties: false as const,
};

function parseAgentStopArgs(raw: unknown) {
  const parsed = readToolArgsRecord(raw, ['child_run_id']);
  if (!parsed.ok) {
    return parsed;
  }

  const childRunId = parsed.value.child_run_id;
  if (typeof childRunId !== 'string' || childRunId.trim().length === 0) {
    return failToolParse('child_run_id is required.');
  }
  const normalizedChildRunId = childRunId.trim();
  if (!isRunId(normalizedChildRunId)) {
    return failToolParse('child_run_id must be a valid run id.');
  }

  return {
    ok: true as const,
    value: {
      child_run_id: normalizedChildRunId,
    },
  };
}

function buildStopResult(result: AgentStopResult) {
  return {
    ok: true as const,
    output: JSON.stringify(result),
  };
}

export const agentStopTool = defineParsedTool<AgentStopArgs>({
  name: 'agent_stop',
  description:
    'Request cancellation for a running child handle. Terminal children are returned as already_terminal.',
  parameters: agentStopParameters,
  strict: true,
  sideEffectLevel: 'none',
  mayMutateWorkspaceFiles: false,
  requiresApproval: false,
  parseArgs: parseAgentStopArgs,
  async executeParsed(args, ctx) {
    if (!ctx.threadId || !ctx.runId || !ctx.agentSpawnRuntime) {
      return toolError('execution_failed', 'agent_stop requires agent runtime');
    }

    const childRecord = ctx.agentSpawnRuntime.childRuns.getChildRun(
      args.child_run_id,
    );
    if (!childRecord) {
      return toolError(
        'invalid_args',
        `unknown child run: ${args.child_run_id}`,
      );
    }
    if (childRecord.ownerThreadId !== ctx.threadId) {
      return toolError(
        'invalid_args',
        `child run does not belong to current owner thread: ${args.child_run_id}`,
      );
    }
    if (isAgentChildTerminalState(childRecord.status)) {
      return buildStopResult({
        ok: true,
        childRunId: args.child_run_id,
        stopState: 'already_terminal',
      });
    }

    if (
      !ctx.agentSpawnRuntime.activeRuns.abortTrackedRun(
        args.child_run_id,
        'explicit_stop',
      )
    ) {
      return toolError(
        'execution_failed',
        `active child run missing: ${args.child_run_id}`,
      );
    }

    return buildStopResult({
      ok: true,
      childRunId: args.child_run_id,
      stopState: 'stopping',
    });
  },
});
