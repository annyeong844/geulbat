import { z } from 'zod';
import { isRunId, type RunId } from '@geulbat/protocol/ids';
import {
  DEFAULT_RUN_SUBAGENT_MODEL_ROUTING,
  RUN_MODEL_CATALOG,
  RUN_REASONING_EFFORTS,
} from '@geulbat/protocol/run-contract';
import { toolError } from '../result.js';
import { defineZodTool } from '../zod-tool.js';
import { isAgentToolExecutionContext } from '../types.js';
import {
  SUBAGENT_TYPES,
  resolveChildModelPin,
  type SubagentType,
} from '../../subagent-runtime-contracts.js';
import type { SubagentRunLauncher } from '../types.js';
import { runSubagentLaunchPipeline } from './subagent-launch-pipeline.js';

const SPAWN_MODES = ['blocking', 'background'] as const;

const agentSpawnTaskSchema = z
  .string()
  .trim()
  .min(1, 'task is required.')
  .describe('Plain-text task prompt for the child agent.');
const agentSpawnSubagentTypeSchema = z
  .enum(SUBAGENT_TYPES)
  .describe(
    'Fixed child role. explorer is read-only; worker includes write/patch/manage_files.',
  );
const agentSpawnModelIdSchema = z
  .enum(RUN_MODEL_CATALOG.map((model) => model.id))
  .describe(
    'Optional child model. Omit to inherit in automatic mode or use the fixed user selection.',
  );
const agentSpawnReasoningEffortSchema = z
  .enum(RUN_REASONING_EFFORTS)
  .describe('Optional effort for model_id. model_id is required when set.');

const agentSpawnArgsSchema = z.strictObject({
  task: agentSpawnTaskSchema,
  subagent_type: agentSpawnSubagentTypeSchema,
  model_id: agentSpawnModelIdSchema.optional(),
  reasoning_effort: agentSpawnReasoningEffortSchema.optional(),
  mode: z
    .enum(SPAWN_MODES)
    .optional()
    .describe('Compatibility ingress only. Scheduling is always parallel.'),
});

const agentSpawnParametersSchema = z.strictObject({
  task: agentSpawnTaskSchema,
  subagent_type: agentSpawnSubagentTypeSchema,
  model_id: agentSpawnModelIdSchema.optional(),
  reasoning_effort: agentSpawnReasoningEffortSchema.optional(),
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
      'Spawn a helper agent. Sub-agents always launch in parallel and return a child handle immediately.',
    argsSchema: agentSpawnArgsSchema,
    parametersSchema: agentSpawnParametersSchema,
    sideEffectLevel: 'none',
    mayMutateComputerFiles: false,
    parallelBatchKind: 'subagent_launch',
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    requiresApproval: false,
    catalogSearchMetadata: {
      family: 'agent',
      searchHints: [
        'spawn subagent',
        'start agent',
        'parallel agent',
        'delegate task',
        'launch worker',
      ],
      tags: ['agent', 'subagent', 'parallel'],
      whenToUse: 'Start one or more parallel subagents for independent work.',
      notFor:
        'Continuing, stopping, or collecting results from an existing agent.',
    },
    async executeParsed(args, ctx) {
      const task = args.task;
      const subagentType: SubagentType = args.subagent_type;

      if (args.reasoning_effort !== undefined && args.model_id === undefined) {
        return toolError(
          'invalid_args',
          'reasoning_effort requires model_id for agent_spawn',
        );
      }

      if (!ctx.threadId || !ctx.stateRoot || !ctx.runId || !ctx.runState) {
        return toolError(
          'execution_failed',
          'run context is required for agent_spawn',
        );
      }
      const ownerThreadId = ctx.threadId;
      const stateRoot = ctx.stateRoot;
      const parentRunId = assertToolRunId(ctx.runId);
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
      const subagentModelRouting =
        ctx.subagentModelRouting ?? DEFAULT_RUN_SUBAGENT_MODEL_ROUTING;
      const modelPinResolution = resolveChildModelPin({
        routing: subagentModelRouting,
        ...(args.model_id === undefined
          ? {}
          : {
              requestedChoice: {
                modelId: args.model_id,
                ...(args.reasoning_effort === undefined
                  ? {}
                  : { reasoningEffort: args.reasoning_effort }),
              },
            }),
        ...(ctx.providerRunSelection === undefined
          ? {}
          : { inheritedSelection: ctx.providerRunSelection }),
      });
      if (!modelPinResolution.ok) {
        return toolError(
          modelPinResolution.errorCode,
          modelPinResolution.error,
        );
      }
      return await runSubagentLaunchPipeline({
        task,
        subagentType,
        parentRunId,
        ownerThreadId,
        stateRoot,
        workingDirectory:
          agentCtx?.workingDirectory ?? ctx.workingDirectory ?? '',
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
        modelPin: modelPinResolution.pin,
        subagentModelRouting,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
    },
  });
}

export const agentSpawnTool = createAgentSpawnTool();
