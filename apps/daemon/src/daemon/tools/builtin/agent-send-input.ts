import { z } from 'zod';
import { isRunId, type RunId } from '@geulbat/protocol/ids';
import { toolError } from '../result.js';
import { isAgentToolExecutionContext } from '../types.js';
import { defineZodTool } from '../zod-tool.js';
import {
  buildChildLaunchPayload,
  buildChildLaunchRejected,
  isAgentChildTerminalState,
} from '../../subagent-runtime-contracts.js';
import { isChildRunState } from '../../runtime-contracts.js';
import type { SubagentRunLauncher } from '../types.js';
import { runSubagentLaunchPipeline } from './subagent-launch-pipeline.js';

const agentSendInputArgsSchema = z.strictObject({
  child_run_id: z
    .string()
    .min(1, 'child_run_id is required.')
    .describe('Stable child handle returned by agent_spawn.'),
  task: z
    .string()
    .min(1, 'task is required.')
    .describe('Follow-up plain-text input for the same child thread.'),
});

function assertToolRunId(value: string): RunId {
  if (!isRunId(value)) {
    throw new Error(`invalid runId: ${value}`);
  }
  return value;
}

export function createAgentSendInputTool(
  options: {
    startBackgroundRun?: SubagentRunLauncher['startBackgroundRun'];
    timeoutMs?: number;
  } = {},
) {
  const timeoutMs = options.timeoutMs;

  return defineZodTool({
    name: 'agent_send_input',
    description:
      'Continue a completed child run on the same child thread using the existing child handle.',
    argsSchema: agentSendInputArgsSchema,
    sideEffectLevel: 'none',
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    requiresApproval: false,
    async executeParsed(args, ctx) {
      const task = args.task.trim();
      const childRunId = args.child_run_id.trim();

      if (!task) {
        return toolError('invalid_args', 'task is required.');
      }
      if (!ctx.threadId || !ctx.projectId || !ctx.runId || !ctx.runState) {
        return toolError(
          'execution_failed',
          'run context is required for agent_send_input',
        );
      }
      if (isChildRunState(ctx.runState)) {
        return toolError(
          'execution_failed',
          'agent_send_input is depth-1 only',
        );
      }
      if (!ctx.agentSpawnRuntime) {
        return toolError(
          'execution_failed',
          'agent_send_input requires agent runtime',
        );
      }

      const projectId = ctx.projectId;
      const parentRunId = assertToolRunId(ctx.runId);
      const ownerThreadId = ctx.threadId;
      const agentSpawnRuntime = ctx.agentSpawnRuntime;
      const agentCtx = isAgentToolExecutionContext(ctx) ? ctx : undefined;
      const childRunHandleId = assertToolRunId(childRunId);
      const childRecord =
        agentSpawnRuntime.childRuns.getChildRun(childRunHandleId);
      if (!childRecord) {
        return toolError('invalid_args', `unknown child run: ${childRunId}`);
      }
      if (childRecord.ownerThreadId !== ownerThreadId) {
        return toolError(
          'invalid_args',
          `child run does not belong to current owner thread: ${childRunId}`,
        );
      }
      const subagentType = childRecord.subagentType;
      if (!isAgentChildTerminalState(childRecord.status)) {
        return buildChildLaunchPayload(
          buildChildLaunchRejected({
            subagentType,
            errorCode: 'invalid_args',
            error:
              'child run is not terminal; wait for completion or stop it first',
          }),
        );
      }
      if (subagentType === 'worker' && !agentCtx) {
        return toolError(
          'execution_failed',
          'worker requires approval event routing',
        );
      }
      return await runSubagentLaunchPipeline({
        task,
        subagentType,
        parentRunId,
        ownerThreadId,
        projectId,
        workspaceRoot: ctx.workspaceRoot,
        childRunId: childRunHandleId,
        childThreadId: childRecord.childThreadId,
        parentRunState: ctx.runState,
        runtimeServices: agentSpawnRuntime,
        ...(options.startBackgroundRun !== undefined
          ? { startBackgroundRun: options.startBackgroundRun }
          : {}),
        ...(agentCtx ? { emitAgentEvent: agentCtx.emitAgentEvent } : {}),
        ...(ctx.approvalSessionId !== undefined
          ? { approvalSessionId: ctx.approvalSessionId }
          : {}),
        ...(agentCtx ? { permissionMode: agentCtx.permissionMode } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
    },
  });
}

export const agentSendInputTool = createAgentSendInputTool();
