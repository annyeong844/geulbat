import { isRunId, type RunId, type ThreadId } from '@geulbat/protocol/ids';

import type {
  RunCheckpointToolInvocation,
  ToolRecoveryStrategy,
} from '../runtime-contracts.js';
import type { JsonValue } from '../runtime-json.js';
import type { ExecuteResult, ToolExecutionContext } from './types.js';

type DurableToolRuntimeServices = NonNullable<
  Extract<ToolExecutionContext, { kind: 'agent' }>['runtimeServices']
>;

export interface DurableToolInvocationContext {
  threadId: ThreadId;
  runId: RunId;
  checkpoints: Pick<
    DurableToolRuntimeServices['runCheckpoints'],
    'recordToolInvocation' | 'recordToolInvocationResult'
  >;
  invocation?: RunCheckpointToolInvocation;
}

export async function resolveDurableToolInvocation(
  context: ToolExecutionContext,
  toolName: string,
): Promise<DurableToolInvocationContext | undefined> {
  if (context.kind !== 'agent') {
    return undefined;
  }
  if (!isRunId(context.runId) || context.runtimeServices === undefined) {
    throw new Error(`${toolName} durable run context is unavailable`);
  }
  const checkpoint = await context.runtimeServices.runCheckpoints.readThread(
    context.threadId,
  );
  if (checkpoint?.status !== 'running' || checkpoint.runId !== context.runId) {
    throw new Error(`${toolName} durable run checkpoint is unavailable`);
  }
  const invocation = checkpoint.toolInvocations.find(
    (candidate) => candidate.callId === context.callId,
  );
  return {
    threadId: context.threadId,
    runId: context.runId,
    checkpoints: context.runtimeServices.runCheckpoints,
    ...(invocation === undefined ? {} : { invocation }),
  };
}

export async function recordDurableToolInvocation(args: {
  durability: DurableToolInvocationContext;
  callId: string;
  toolName: string;
  recoveryStrategy: ToolRecoveryStrategy;
  recoveryState: JsonValue;
}): Promise<{ changed: boolean; invocation: RunCheckpointToolInvocation }> {
  const recorded = await args.durability.checkpoints.recordToolInvocation({
    threadId: args.durability.threadId,
    runId: args.durability.runId,
    invocation: {
      callId: args.callId,
      toolName: args.toolName,
      recoveryStrategy: args.recoveryStrategy,
      recoveryState: args.recoveryState,
    },
  });
  if (!recorded.ok) {
    throw new Error(
      `${args.toolName} invocation checkpoint failed: ${recorded.code}`,
    );
  }
  const invocation = recorded.checkpoint.toolInvocations.find(
    (candidate) => candidate.callId === args.callId,
  );
  if (invocation === undefined) {
    throw new Error(`${args.toolName} invocation checkpoint disappeared`);
  }
  return { changed: recorded.changed, invocation };
}

export async function recordDurableToolInvocationResult(args: {
  durability: DurableToolInvocationContext | undefined;
  callId: string;
  toolName: string;
  result: ExecuteResult;
}): Promise<void> {
  if (args.durability === undefined) {
    return;
  }
  const recorded = await args.durability.checkpoints.recordToolInvocationResult(
    {
      threadId: args.durability.threadId,
      runId: args.durability.runId,
      callId: args.callId,
      toolName: args.toolName,
      result: args.result,
    },
  );
  if (!recorded.ok) {
    throw new Error(
      `${args.toolName} invocation result checkpoint failed: ${recorded.code}`,
    );
  }
}
