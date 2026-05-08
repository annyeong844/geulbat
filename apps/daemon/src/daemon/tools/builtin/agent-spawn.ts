import { z } from 'zod';
import { isRunId, type RunId } from '@geulbat/protocol/ids';
import { toolError } from '../result.js';
import { defineZodTool } from '../zod-tool.js';
import { isAgentToolExecutionContext } from '../types.js';
import {
  buildChildLaunchPayload,
  buildChildLaunchRejected,
  SUBAGENT_TYPES,
  type SubagentType,
} from '../../subagent-runtime-contracts.js';
import type { SubagentRunLauncher } from '../types.js';
import { runSubagentLaunchPipeline } from './subagent-launch-pipeline.js';

const SPAWN_MODES = ['blocking', 'background'] as const;

const agentSpawnArgsSchema = z.strictObject({
  task: z
    .string()
    .min(1, 'task is required.')
    .describe('Plain-text task prompt for the child agent.'),
  subagent_type: z
    .enum(SUBAGENT_TYPES)
    .describe(
      'Fixed child role. explorer is read-only; worker includes write/patch/manage_files.',
    ),
  mode: z
    .enum(SPAWN_MODES)
    .optional()
    .describe('Compatibility ingress only. Scheduling is always parallel.'),
});

function assertToolRunId(value: string): RunId {
  if (!isRunId(value)) {
    throw new Error(`invalid runId: ${value}`);
  }
  return value;
}

export function createAgentSpawnTool(
  options: {
    startBackgroundRun?: SubagentRunLauncher['startBackgroundRun'];
    timeoutMs?: number;
  } = {},
) {
  const timeoutMs = options.timeoutMs;

  return defineZodTool({
    name: 'agent_spawn',
    description:
      'Spawn a depth-1 helper agent. Sub-agents always launch in parallel and return a child handle immediately.',
    argsSchema: agentSpawnArgsSchema,
    sideEffectLevel: 'none',
    parallelBatchKind: 'subagent_launch',
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    requiresApproval: false,
    async executeParsed(args, ctx) {
      const task = args.task.trim();
      const subagentType: SubagentType = args.subagent_type;

      if (!task) {
        return toolError('invalid_args', 'task is required.');
      }
      if (!ctx.threadId || !ctx.projectId || !ctx.runId || !ctx.runState) {
        return toolError(
          'execution_failed',
          'run context is required for agent_spawn',
        );
      }
      const ownerThreadId = ctx.threadId;
      const projectId = ctx.projectId;
      const parentRunId = assertToolRunId(ctx.runId);
      if (ctx.runState.parentRunId) {
        return buildChildLaunchPayload(
          buildChildLaunchRejected({
            subagentType,
            errorCode: 'unsupported_nested_spawn',
            error: 'agent_spawn is depth-1 only',
          }),
        );
      }
      const agentCtx = isAgentToolExecutionContext(ctx) ? ctx : undefined;
      if (subagentType === 'worker' && !agentCtx) {
        return toolError(
          'execution_failed',
          'worker requires approval event routing',
        );
      }

      const agentSpawnRuntime = ctx.agentSpawnRuntime;
      if (!agentSpawnRuntime) {
        return toolError('execution_failed', 'agent spawn runtime is required');
      }
      return await runSubagentLaunchPipeline({
        task,
        subagentType,
        parentRunId,
        ownerThreadId,
        projectId,
        workspaceRoot: ctx.workspaceRoot,
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

export const agentSpawnTool = createAgentSpawnTool();
