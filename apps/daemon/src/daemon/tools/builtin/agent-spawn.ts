import { z } from 'zod';
import { isRunId, type RunId } from '@geulbat/protocol/ids';
import {
  DEFAULT_RUN_SUBAGENT_MODEL_ROUTING,
  RUN_MODEL_CATALOG,
  RUN_REASONING_EFFORTS,
} from '@geulbat/protocol/run-contract';
import { toolError } from '../result.js';
import { defineZodTool, formatZodToolParseError } from '../zod-tool.js';
import { isAgentToolExecutionContext } from '../types.js';
import {
  SUBAGENT_CAPABILITIES,
  SUBAGENT_TYPES,
  buildChildLaunchPayload,
  buildChildLaunchQueued,
  resolveChildModelPin,
  type DurableSubagentLaunchRequest,
  type SubagentLaunchRequestInput,
  type SubagentType,
} from '../../subagent-runtime-contracts.js';
import type {
  AgentRuntimeServices,
  SubagentRunLauncher,
} from '../../daemon-runtime-contract.js';
import type { ToolRunState } from '../../runtime-contracts.js';
import type { ExecuteResult, ToolExecutionContext } from '../types.js';
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
const agentSpawnCapabilitiesSchema = z
  .array(z.enum(SUBAGENT_CAPABILITIES))
  .max(
    SUBAGENT_CAPABILITIES.length,
    'Each supported child capability may be requested once.',
  )
  .optional()
  .describe(
    'Optional launch-time capabilities. Request ptc only for an explorer that benefits from batched read/search computation.',
  );

const agentSpawnArgsSchema = z.strictObject({
  task: agentSpawnTaskSchema,
  subagent_type: agentSpawnSubagentTypeSchema,
  capabilities: agentSpawnCapabilitiesSchema,
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
  capabilities: agentSpawnCapabilitiesSchema,
  model_id: agentSpawnModelIdSchema.optional(),
  reasoning_effort: agentSpawnReasoningEffortSchema.optional(),
});

interface ResolvedAgentSpawnLaunchRequest {
  request: SubagentLaunchRequestInput;
  parentRunState: ToolRunState;
  runtimeServices: AgentRuntimeServices;
  computerSessionId: string | undefined;
  emitAgentEvent: ToolExecutionContext['emitAgentEvent'];
}

type AgentSpawnLaunchResolution =
  | { ok: true; value: ResolvedAgentSpawnLaunchRequest }
  | { ok: false; result: ExecuteResult };

function assertToolRunId(value: string): RunId {
  if (!isRunId(value)) {
    throw new Error(`invalid runId: ${value}`);
  }
  return value;
}

export function resolveAgentSpawnLaunchRequest(
  rawArgs: unknown,
  ctx: ToolExecutionContext,
): AgentSpawnLaunchResolution {
  const parsedArgs = agentSpawnArgsSchema.safeParse(rawArgs);
  if (!parsedArgs.success) {
    return {
      ok: false,
      result: toolError(
        'invalid_args',
        formatZodToolParseError(parsedArgs.error),
      ),
    };
  }
  const args = parsedArgs.data;
  const task = args.task;
  const subagentType: SubagentType = args.subagent_type;
  const capabilities = args.capabilities ?? [];

  if (subagentType === 'worker' && capabilities.length > 0) {
    return {
      ok: false,
      result: toolError(
        'invalid_args',
        'agent_spawn capabilities are available only to explorer children',
      ),
    };
  }

  if (args.reasoning_effort !== undefined && args.model_id === undefined) {
    return {
      ok: false,
      result: toolError(
        'invalid_args',
        'reasoning_effort requires model_id for agent_spawn',
      ),
    };
  }

  if (!ctx.threadId || !ctx.stateRoot || !ctx.runId || !ctx.runState) {
    return {
      ok: false,
      result: toolError(
        'execution_failed',
        'run context is required for agent_spawn',
      ),
    };
  }
  const ownerThreadId = ctx.threadId;
  const parentRunId = assertToolRunId(ctx.runId);
  const agentCtx = isAgentToolExecutionContext(ctx) ? ctx : undefined;
  const ultraReasoning = agentCtx?.ultraReasoning ?? false;
  if (ctx.runOwnerKind === 'child' && !ultraReasoning) {
    return {
      ok: false,
      result: toolError(
        'invalid_args',
        'recursive agent_spawn is available only with Ultra reasoning',
      ),
    };
  }
  if (subagentType === 'worker' && !agentCtx) {
    return {
      ok: false,
      result: toolError(
        'execution_failed',
        'worker requires approval event routing',
      ),
    };
  }

  const runtimeServices = ctx.runtimeServices;
  if (!runtimeServices) {
    return {
      ok: false,
      result: toolError('execution_failed', 'agent spawn runtime is required'),
    };
  }
  const subagentModelRouting =
    ctx.subagentModelRouting ?? DEFAULT_RUN_SUBAGENT_MODEL_ROUTING;
  const modelPinResolution = resolveChildModelPin({
    ultraReasoning,
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
    return {
      ok: false,
      result: toolError(modelPinResolution.errorCode, modelPinResolution.error),
    };
  }

  return {
    ok: true,
    value: {
      request: {
        toolCallId: ctx.callId,
        task,
        subagentType,
        capabilities,
        parentRunId,
        ownerThreadId,
        stateRoot: ctx.stateRoot,
        workingDirectory:
          agentCtx?.workingDirectory ?? ctx.workingDirectory ?? '',
        ...(ctx.permissionMode === undefined
          ? {}
          : { permissionMode: ctx.permissionMode }),
        ultraReasoning,
        modelPin: modelPinResolution.pin,
        subagentModelRouting,
      },
      parentRunState: ctx.runState,
      runtimeServices,
      computerSessionId: ctx.computerSessionId,
      emitAgentEvent: agentCtx?.emitAgentEvent,
    },
  };
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
      const resolution = resolveAgentSpawnLaunchRequest(args, ctx);
      if (!resolution.ok) {
        return resolution.result;
      }
      const {
        request,
        parentRunState,
        runtimeServices,
        computerSessionId,
        emitAgentEvent,
      } = resolution.value;
      const launchRequestStore = runtimeServices.subagent.launchRequests;
      if (launchRequestStore === undefined) {
        return toolError(
          'persistence_unavailable',
          'agent launch persistence is unavailable',
        );
      }

      let durableRequest: DurableSubagentLaunchRequest | undefined;
      try {
        durableRequest = launchRequestStore.readSubagentLaunchRequest({
          parentRunId: request.parentRunId,
          toolCallId: request.toolCallId,
        });
        if (durableRequest === undefined) {
          [durableRequest] = launchRequestStore.enqueueSubagentLaunchBatch([
            request,
          ]);
        }
      } catch {
        return toolError(
          'persistence_unavailable',
          'agent launch could not be durably accepted',
        );
      }
      if (durableRequest === undefined) {
        return toolError(
          'persistence_unavailable',
          'agent launch persistence returned no durable request',
        );
      }
      if (durableRequest.launchState !== 'queued') {
        return toolError(
          'persistence_unavailable',
          `agent launch request is not startable from ${durableRequest.launchState}`,
        );
      }
      const launch = () =>
        runSubagentLaunchPipeline({
          task: request.task,
          subagentType: request.subagentType,
          capabilities: request.capabilities,
          parentRunId: request.parentRunId,
          ownerThreadId: request.ownerThreadId,
          stateRoot: request.stateRoot,
          workingDirectory: request.workingDirectory,
          parentRunState,
          runtimeServices,
          ...(options.startBackgroundRun !== undefined
            ? { startBackgroundRun: options.startBackgroundRun }
            : {}),
          ...(emitAgentEvent === undefined ? {} : { emitAgentEvent }),
          ...(computerSessionId !== undefined ? { computerSessionId } : {}),
          ...(request.permissionMode === undefined
            ? {}
            : { permissionMode: request.permissionMode }),
          ultraReasoning: request.ultraReasoning ?? false,
          modelPin: request.modelPin,
          subagentModelRouting: request.subagentModelRouting,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          childRunId: durableRequest.childRunId,
          childThreadId: durableRequest.childThreadId,
          durableLaunchRecorded: true,
        });
      if (durableRequest.deferReason !== null) {
        const launchPromotions = runtimeServices.subagent.launchPromotions;
        if (launchPromotions === undefined) {
          return toolError(
            'persistence_unavailable',
            'deferred agent launch promotion is unavailable',
          );
        }
        try {
          const deferred = launchPromotions.deferLaunch({
            registration: {
              childRunId: durableRequest.childRunId,
              ultraReasoning: request.ultraReasoning ?? false,
              parentRunState,
              async start() {
                await launch();
              },
            },
            deferReason: durableRequest.deferReason,
          });
          return buildChildLaunchPayload(
            buildChildLaunchQueued({
              childRunId: deferred.childRunId,
              childThreadId: deferred.childThreadId,
              subagentType: request.subagentType,
              deferReason: durableRequest.deferReason,
              modelPin: request.modelPin,
            }),
          );
        } catch {
          return toolError(
            'persistence_unavailable',
            'deferred agent launch could not be registered for promotion',
          );
        }
      }
      return await launch();
    },
  });
}

export const agentSpawnTool = createAgentSpawnTool();
