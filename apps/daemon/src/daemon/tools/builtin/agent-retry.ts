import { isRunId, type RunId } from '@geulbat/protocol/ids';
import type { AgentRetryToolRaw } from '@geulbat/protocol/run-events';

import {
  defineParsedTool,
  failToolParse,
  readToolArgsRecord,
} from '../parsed-tool.js';
import { toolError } from '../result.js';
import { isAgentToolExecutionContext } from '../types.js';
import type { SubagentRunLauncher } from '../../daemon-runtime-contract.js';
import { runSubagentLaunchPipeline } from './subagent-launch-pipeline.js';

interface AgentRetryArgs {
  child_run_id: RunId;
}

const agentRetryParameters = {
  type: 'object' as const,
  properties: {
    child_run_id: {
      type: 'string',
      description:
        'Interrupted child handle to retry. The prior handle and its terminal diagnostics remain durable.',
    },
  },
  required: ['child_run_id'],
  additionalProperties: false as const,
};

function parseAgentRetryArgs(raw: unknown) {
  const parsed = readToolArgsRecord(raw, ['child_run_id']);
  if (!parsed.ok) {
    return parsed;
  }
  const childRunId = parsed.value.child_run_id;
  if (typeof childRunId !== 'string') {
    return failToolParse('child_run_id must be a valid run id.');
  }
  const normalizedChildRunId = childRunId.trim();
  if (!isRunId(normalizedChildRunId)) {
    return failToolParse('child_run_id must be a valid run id.');
  }
  return {
    ok: true as const,
    value: { child_run_id: normalizedChildRunId },
  };
}

export function createAgentRetryTool(
  options: {
    startBackgroundRun?: SubagentRunLauncher['startBackgroundRun'];
  } = {},
) {
  return defineParsedTool<AgentRetryArgs>({
    name: 'agent_retry',
    description:
      'Retry one daemon-interrupted child as a fresh durable attempt. This approval-gated action preserves the prior handle and diagnostics and never reuses its child identity.',
    parameters: agentRetryParameters,
    strict: true,
    sideEffectLevel: 'write',
    mayMutateComputerFiles: true,
    requiresApproval: true,
    recoveryStrategy: 'reconcile_then_replay',
    catalogSearchMetadata: {
      family: 'agent',
      searchHints: [
        'retry interrupted agent',
        'recover subagent',
        'restart failed child',
      ],
      tags: ['agent', 'subagent', 'retry', 'recovery'],
      whenToUse:
        'After inspecting an interrupted child, explicitly retry it with a fresh child handle.',
      notFor:
        'Automatically replaying a running or completed child, or hiding uncertain side effects.',
    },
    parseArgs: parseAgentRetryArgs,
    async executeParsed(args, ctx) {
      if (
        !ctx.threadId ||
        !ctx.runId ||
        !ctx.runState ||
        !ctx.stateRoot ||
        !ctx.runtimeServices ||
        !ctx.computerSessionId ||
        !isAgentToolExecutionContext(ctx)
      ) {
        return toolError(
          'execution_failed',
          'agent_retry requires an approval-connected agent runtime and run context',
        );
      }
      const launchRequests = ctx.runtimeServices.subagent.launchRequests;
      if (launchRequests === undefined) {
        return toolError(
          'persistence_unavailable',
          'durable agent retry state is unavailable',
        );
      }

      let retry;
      try {
        retry = launchRequests.retryInterruptedSubagentLaunch({
          previousChildRunId: args.child_run_id,
          ownerThreadId: ctx.threadId,
          parentRunId: ctx.runState.runId,
          toolCallId: ctx.callId,
          stateRoot: ctx.stateRoot,
          workingDirectory: ctx.workingDirectory ?? '',
          ...(ctx.permissionMode === undefined
            ? {}
            : { permissionMode: ctx.permissionMode }),
        });
      } catch (error: unknown) {
        return toolError(
          'invalid_args',
          error instanceof Error
            ? error.message
            : 'interrupted child could not be retried',
        );
      }

      if (
        retry.disposition !== 'already_retried' &&
        retry.request.launchState === 'queued'
      ) {
        const launch = await runSubagentLaunchPipeline({
          task: retry.input.task,
          subagentType: retry.input.subagentType,
          capabilities: retry.input.capabilities,
          parentRunId: retry.input.parentRunId,
          ownerThreadId: retry.input.ownerThreadId,
          stateRoot: retry.input.stateRoot,
          workingDirectory: retry.input.workingDirectory,
          parentRunState: ctx.runState,
          runtimeServices: ctx.runtimeServices,
          ...(options.startBackgroundRun === undefined
            ? {}
            : { startBackgroundRun: options.startBackgroundRun }),
          emitAgentEvent: ctx.emitAgentEvent,
          computerSessionId: ctx.computerSessionId,
          ...(retry.input.permissionMode === undefined
            ? {}
            : { permissionMode: retry.input.permissionMode }),
          ultraReasoning: retry.input.ultraReasoning ?? false,
          modelPin: retry.input.modelPin,
          subagentModelRouting: retry.input.subagentModelRouting,
          childRunId: retry.request.childRunId,
          childThreadId: retry.request.childThreadId,
          durableLaunchRecorded: true,
        });
        if (!launch.ok) {
          return launch;
        }
      }

      let current;
      try {
        current = launchRequests.readSubagentLaunchRequestByChildRunId(
          retry.request.childRunId,
        );
      } catch {
        return toolError(
          'persistence_unavailable',
          'retried agent launch status could not be read',
        );
      }
      if (current === undefined) {
        return toolError(
          'persistence_unavailable',
          'retried agent launch disappeared after durable admission',
        );
      }

      const raw: AgentRetryToolRaw = {
        ok: true,
        previousChildRunId: args.child_run_id,
        childRunId: current.childRunId,
        childThreadId: current.childThreadId,
        retryDisposition: retry.disposition,
        launchState: current.launchState,
        deferReason: current.deferReason,
        failureReason: current.failureReason,
        modelId: retry.input.modelPin.modelId,
        reasoningEffort:
          retry.input.modelPin.providerRunSelection.reasoningEffort,
        selectionSource: retry.input.modelPin.selectionSource,
      };
      return { ok: true, output: JSON.stringify(raw) };
    },
  });
}

export const agentRetryTool = createAgentRetryTool();
