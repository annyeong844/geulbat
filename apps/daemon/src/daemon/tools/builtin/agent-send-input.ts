import { createHash } from 'node:crypto';

import { z } from 'zod';
import {
  isRunId,
  isThreadId,
  type RunId,
  type ThreadId,
} from '@geulbat/protocol/ids';
import type { RunCheckpointToolInvocation } from '../../runtime-contracts.js';
import { catchToolError, toolError } from '../result.js';
import { isAgentToolExecutionContext } from '../types.js';
import { defineZodTool } from '../zod-tool.js';
import {
  buildChildLaunchPayload,
  buildChildLaunchRejected,
  buildChildLaunchStarted,
  isAgentChildTerminalState,
  type ChildRunSnapshot,
} from '../../subagent-runtime-contracts.js';
import type {
  AgentRuntimeServices,
  SubagentRunLauncher,
} from '../../daemon-runtime-contract.js';
import { runSubagentLaunchPipeline } from './subagent-launch-pipeline.js';
import {
  recordDurableToolInvocation,
  recordDurableToolInvocationResult,
  resolveDurableToolInvocation,
  type DurableToolInvocationContext,
} from '../tool-invocation-durability.js';
import type { ExecuteResult } from '../types.js';

const agentSendInputArgsSchema = z.strictObject({
  child_run_id: z
    .string()
    .trim()
    .min(1, 'child_run_id is required.')
    .refine(isRunId, 'child_run_id must be a valid child run id.')
    .describe('Stable child handle returned by agent_spawn.'),
  task: z
    .string()
    .trim()
    .min(1, 'task is required.')
    .describe('Follow-up plain-text input for the same child thread.'),
});

function assertToolRunId(value: string): RunId {
  if (!isRunId(value)) {
    throw new Error(`invalid runId: ${value}`);
  }
  return value;
}

const agentSendInputRecoveryStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  childRunId: z.custom<RunId>(
    (value) => typeof value === 'string' && isRunId(value),
  ),
  childThreadId: z.custom<ThreadId>(
    (value) => typeof value === 'string' && isThreadId(value),
  ),
  taskDigest: z.string().min(1),
  childInput: z.strictObject({
    entryId: z.string().trim().min(1),
    timestamp: z.string().trim().min(1),
  }),
  priorChildCheckpoint: z
    .strictObject({
      revision: z.number().int().nonnegative(),
      status: z.enum(['running', 'terminal']),
      createdAt: z.string().trim().min(1),
    })
    .nullable(),
});

type AgentSendInputRecoveryState = z.output<
  typeof agentSendInputRecoveryStateSchema
>;

function buildTaskDigest(task: string): string {
  return `sha256:${createHash('sha256').update(task).digest('hex')}`;
}

function buildChildInputEntryId(args: {
  ownerThreadId: ThreadId;
  parentRunId: RunId;
  callId: string;
  childThreadId: ThreadId;
}): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        args.ownerThreadId,
        args.parentRunId,
        args.callId,
        args.childThreadId,
      ]),
    )
    .digest('hex');
  return `agent-send-input:${digest}`;
}

function parseAgentSendInputRecoveryState(
  value: unknown,
): AgentSendInputRecoveryState | null {
  const parsed = agentSendInputRecoveryStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function validateRecoveredInvocation(args: {
  invocation: RunCheckpointToolInvocation;
  callId: string;
  task: string;
  childRunId: RunId;
}): AgentSendInputRecoveryState {
  if (
    args.invocation.callId !== args.callId ||
    args.invocation.toolName !== 'agent_send_input' ||
    args.invocation.recoveryStrategy !== 'reconcile_then_replay'
  ) {
    throw new Error('agent_send_input recovery invocation identity conflicts');
  }
  const recoveryState = parseAgentSendInputRecoveryState(
    args.invocation.recoveryState,
  );
  if (
    recoveryState === null ||
    recoveryState.childRunId !== args.childRunId ||
    recoveryState.taskDigest !== buildTaskDigest(args.task)
  ) {
    throw new Error('agent_send_input recovery state conflicts');
  }
  return recoveryState;
}

function hasChildDeliveryAcknowledgement(args: {
  recoveryState: AgentSendInputRecoveryState;
  checkpoint: Awaited<
    ReturnType<AgentRuntimeServices['runCheckpoints']['readThread']>
  >;
}): boolean {
  const { checkpoint, recoveryState } = args;
  if (checkpoint === null) {
    return false;
  }
  if (checkpoint.runId !== recoveryState.childRunId) {
    throw new Error('agent_send_input child checkpoint identity conflicts');
  }
  const prior = recoveryState.priorChildCheckpoint;
  if (prior === null) {
    return true;
  }
  if (checkpoint.createdAt !== prior.createdAt) {
    return true;
  }
  if (
    prior.status === 'terminal' &&
    checkpoint.status === 'running' &&
    checkpoint.revision > prior.revision
  ) {
    return true;
  }
  return (
    checkpoint.status === 'terminal' &&
    checkpoint.revision >= prior.revision + 2
  );
}

function buildStartedResult(
  recoveryState: AgentSendInputRecoveryState,
  childRecord: ChildRunSnapshot,
): ExecuteResult {
  return buildChildLaunchPayload(
    buildChildLaunchStarted({
      childRunId: recoveryState.childRunId,
      childThreadId: recoveryState.childThreadId,
      subagentType: childRecord.subagentType,
      modelPin: childRecord.modelPin,
    }),
  );
}

async function recordAgentSendInputResult(args: {
  durability: DurableToolInvocationContext | undefined;
  invocationRecorded: boolean;
  callId: string;
  result: ExecuteResult;
}): Promise<ExecuteResult> {
  await recordDurableToolInvocationResult({
    durability: args.invocationRecorded ? args.durability : undefined,
    callId: args.callId,
    toolName: 'agent_send_input',
    result: args.result,
  });
  return args.result;
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
    mayMutateComputerFiles: false,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    requiresApproval: false,
    recoveryStrategy: 'reconcile_then_replay',
    catalogSearchMetadata: {
      family: 'agent',
      searchHints: [
        'send input to agent',
        'message subagent',
        'continue subagent',
        'reply to agent',
      ],
      tags: ['agent', 'subagent', 'input'],
      whenToUse: 'Send follow-up instructions to an existing subagent.',
      notFor: 'Starting a new subagent or waiting for results.',
    },
    async executeParsed(args, ctx) {
      const task = args.task;
      const childRunId = args.child_run_id;
      if (!ctx.threadId || !ctx.stateRoot || !ctx.runId || !ctx.runState) {
        return toolError(
          'execution_failed',
          'run context is required for agent_send_input',
        );
      }
      if (!ctx.runtimeServices) {
        return toolError(
          'execution_failed',
          'agent_send_input requires agent runtime',
        );
      }

      const stateRoot = ctx.stateRoot;
      const parentRunId = assertToolRunId(ctx.runId);
      const ownerThreadId = ctx.threadId;
      const runtimeServices = ctx.runtimeServices;
      const agentCtx = isAgentToolExecutionContext(ctx) ? ctx : undefined;
      const childRunHandleId = assertToolRunId(childRunId);
      let durability: DurableToolInvocationContext | undefined;
      try {
        durability = await resolveDurableToolInvocation(
          ctx,
          'agent_send_input',
        );
      } catch (error: unknown) {
        return catchToolError(error);
      }
      let recoveryState: AgentSendInputRecoveryState | undefined;
      if (durability?.invocation !== undefined) {
        try {
          recoveryState = validateRecoveredInvocation({
            invocation: durability.invocation,
            callId: ctx.callId,
            task,
            childRunId: childRunHandleId,
          });
        } catch (error: unknown) {
          return catchToolError(error);
        }
        if (durability.invocation.status === 'reconciled') {
          return durability.invocation.result;
        }
      }
      const childRecord =
        runtimeServices.childRuns.getChildRun(childRunHandleId);
      if (!childRecord) {
        const result = toolError(
          'invalid_args',
          `unknown child run: ${childRunId}`,
        );
        return await recordAgentSendInputResult({
          durability,
          invocationRecorded: recoveryState !== undefined,
          callId: ctx.callId,
          result,
        });
      }
      if (childRecord.ownerThreadId !== ownerThreadId) {
        const result = toolError(
          'invalid_args',
          `child run does not belong to current owner thread: ${childRunId}`,
        );
        return await recordAgentSendInputResult({
          durability,
          invocationRecorded: recoveryState !== undefined,
          callId: ctx.callId,
          result,
        });
      }
      if (
        recoveryState !== undefined &&
        childRecord.childThreadId !== recoveryState.childThreadId
      ) {
        const result = catchToolError(
          new Error('agent_send_input child thread identity conflicts'),
        );
        return await recordAgentSendInputResult({
          durability,
          invocationRecorded: true,
          callId: ctx.callId,
          result,
        });
      }
      const subagentType = childRecord.subagentType;
      if (recoveryState !== undefined && durability !== undefined) {
        let acknowledged: boolean;
        try {
          acknowledged = hasChildDeliveryAcknowledgement({
            recoveryState,
            checkpoint: await runtimeServices.runCheckpoints.readThread(
              recoveryState.childThreadId,
            ),
          });
        } catch (error: unknown) {
          return catchToolError(error);
        }
        if (acknowledged) {
          const result = buildStartedResult(recoveryState, childRecord);
          return await recordAgentSendInputResult({
            durability,
            invocationRecorded: true,
            callId: ctx.callId,
            result,
          });
        }
      }
      if (!isAgentChildTerminalState(childRecord.status)) {
        const result = buildChildLaunchPayload(
          buildChildLaunchRejected({
            subagentType,
            errorCode: 'invalid_args',
            error:
              'child run is not terminal; wait for completion or stop it first',
          }),
        );
        return await recordAgentSendInputResult({
          durability,
          invocationRecorded: recoveryState !== undefined,
          callId: ctx.callId,
          result,
        });
      }
      if (subagentType === 'worker' && !agentCtx) {
        const result = toolError(
          'execution_failed',
          'worker requires approval event routing',
        );
        return await recordAgentSendInputResult({
          durability,
          invocationRecorded: recoveryState !== undefined,
          callId: ctx.callId,
          result,
        });
      }
      if (recoveryState === undefined) {
        const priorChildCheckpoint =
          await runtimeServices.runCheckpoints.readThread(
            childRecord.childThreadId,
          );
        recoveryState = {
          schemaVersion: 1,
          childRunId: childRunHandleId,
          childThreadId: childRecord.childThreadId,
          taskDigest: buildTaskDigest(task),
          childInput: {
            entryId: buildChildInputEntryId({
              ownerThreadId,
              parentRunId,
              callId: ctx.callId,
              childThreadId: childRecord.childThreadId,
            }),
            timestamp: new Date().toISOString(),
          },
          priorChildCheckpoint:
            priorChildCheckpoint === null
              ? null
              : {
                  revision: priorChildCheckpoint.revision,
                  status: priorChildCheckpoint.status,
                  createdAt: priorChildCheckpoint.createdAt,
                },
        };
        if (durability !== undefined) {
          let recorded;
          try {
            recorded = await recordDurableToolInvocation({
              durability,
              callId: ctx.callId,
              toolName: 'agent_send_input',
              recoveryStrategy: 'reconcile_then_replay',
              recoveryState,
            });
          } catch (error: unknown) {
            return catchToolError(error);
          }
          if (!recorded.changed) {
            try {
              recoveryState = validateRecoveredInvocation({
                invocation: recorded.invocation,
                callId: ctx.callId,
                task,
                childRunId: childRunHandleId,
              });
            } catch (error: unknown) {
              return catchToolError(error);
            }
            if (recorded.invocation.status === 'reconciled') {
              return recorded.invocation.result;
            }
          }
        }
      }
      const result = await runSubagentLaunchPipeline({
        task,
        subagentType,
        capabilities: childRecord.capabilities ?? [],
        parentRunId,
        ownerThreadId,
        stateRoot,
        workingDirectory:
          agentCtx?.workingDirectory ?? ctx.workingDirectory ?? '',
        childRunId: childRunHandleId,
        childThreadId: childRecord.childThreadId,
        childInputPersistence: recoveryState.childInput,
        parentRunState: ctx.runState,
        runtimeServices: runtimeServices,
        ...(options.startBackgroundRun !== undefined
          ? { startBackgroundRun: options.startBackgroundRun }
          : {}),
        ...(agentCtx ? { emitAgentEvent: agentCtx.emitAgentEvent } : {}),
        ...(ctx.computerSessionId !== undefined
          ? { computerSessionId: ctx.computerSessionId }
          : {}),
        ...(agentCtx ? { permissionMode: agentCtx.permissionMode } : {}),
        ultraReasoning: agentCtx?.ultraReasoning ?? false,
        modelPin: childRecord.modelPin,
        subagentModelRouting: childRecord.subagentModelRouting,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      return await recordAgentSendInputResult({
        durability,
        invocationRecorded: durability !== undefined,
        callId: ctx.callId,
        result,
      });
    },
  });
}

export const agentSendInputTool = createAgentSendInputTool();
