import type { HistoryItem, FunctionCall } from '../llm/index.js';
import type { StepResult } from './loop-shared.js';
import { executeFunctionCall } from './loop-tool-approval.js';
import {
  getToolRuntimeRunContext,
  getToolRuntimeRunState,
  getToolRuntimeSignal,
  type AgentToolCallExecutionRuntime,
} from './loop-tool-runtime.js';
import { emitAndSettleTerminalFailure } from './loop-shared.js';
import {
  parseToolCallArguments,
  recordInvalidToolArguments,
  recordToolCall,
  recordToolResult,
} from './loop-tool-support.js';
import {
  buildChildLaunchPayload,
  buildChildLaunchRejected,
  type AgentLaunchRejectedToolRaw,
  type SubagentType,
} from '../subagent-runtime-contracts.js';

interface ProcessFunctionCallsArgs {
  functionCalls: FunctionCall[];
  round: number;
  history: HistoryItem[];
  runtime: AgentToolCallExecutionRuntime;
}

interface PreparedFunctionCall {
  functionCall: FunctionCall;
  toolArgs: Record<string, unknown>;
  workspaceFilesMayHaveChanged: boolean;
}

interface PreparedParallelBatch {
  kind: 'read_only' | 'subagent_launch';
  preparedFunctionCalls: PreparedFunctionCall[];
}

export async function processFunctionCalls(
  args: ProcessFunctionCallsArgs,
): Promise<StepResult<void>> {
  const { functionCalls, round, history, runtime } = args;
  const { emit } = runtime;
  const runContext = getToolRuntimeRunContext(runtime);

  const preparedParallelBatch = prepareParallelFunctionCallBatch(
    functionCalls,
    runtime,
  );
  if (preparedParallelBatch) {
    return processFunctionCallsInParallel({
      preparedBatch: preparedParallelBatch,
      round,
      history,
      runtime,
    });
  }

  for (const functionCall of functionCalls) {
    const abortedBeforeRecord = settleIfFunctionCallProcessingAborted(runtime);
    if (abortedBeforeRecord) {
      return abortedBeforeRecord;
    }

    const parsedArgs = parseToolCallArguments(functionCall.arguments);
    if (!parsedArgs.ok) {
      await recordInvalidToolArguments({
        functionCall,
        round,
        errorResult: parsedArgs.error,
        runContext,
        runId: runtime.executionContextBase.runId,
        history,
        emit,
      });
      continue;
    }

    await recordToolCall({
      functionCall,
      round,
      toolArgs: parsedArgs.args,
      runContext,
      emit,
    });

    const abortedBeforeExecute = settleIfFunctionCallProcessingAborted(runtime);
    if (abortedBeforeExecute) {
      return abortedBeforeExecute;
    }

    const execution = await executeFunctionCall({
      functionCall,
      round,
      toolArgs: parsedArgs.args,
      history,
      runtime,
    });
    if (!execution.ok) {
      return execution;
    }

    const workspaceFilesMayHaveChanged =
      runtime.toolRegistry.getToolMeta(functionCall.name)
        ?.mayMutateWorkspaceFiles ?? false;

    await recordToolResult({
      functionCall,
      round,
      toolResult: execution.value,
      workspaceFilesMayHaveChanged,
      runContext,
      runId: runtime.executionContextBase.runId,
      history,
      emit,
    });
  }

  return { ok: true, value: undefined };
}

function settleIfFunctionCallProcessingAborted(
  runtime: AgentToolCallExecutionRuntime,
): StepResult<void> | null {
  const signal = getToolRuntimeSignal(runtime);
  if (!signal?.aborted) {
    return null;
  }

  return {
    ok: false,
    result: emitAndSettleTerminalFailure(
      runtime.emit,
      'aborted',
      'run cancelled',
      getToolRuntimeRunState(runtime),
      signal,
      'signal',
    ),
  };
}

function prepareParallelFunctionCallBatch(
  functionCalls: FunctionCall[],
  runtime: AgentToolCallExecutionRuntime,
): PreparedParallelBatch | null {
  if (functionCalls.length < 2) {
    return null;
  }

  const signal = getToolRuntimeSignal(runtime);
  const prepared: PreparedFunctionCall[] = [];
  let batchKind: PreparedParallelBatch['kind'] | null = null;
  for (const functionCall of functionCalls) {
    const parsedArgs = parseToolCallArguments(functionCall.arguments);
    if (!parsedArgs.ok) {
      return null;
    }

    const toolMeta = runtime.toolRegistry.getToolMeta(functionCall.name);
    if (!toolMeta) {
      return null;
    }

    const readOnlyParallelEligible =
      !toolMeta.requiresApproval &&
      toolMeta.sideEffectLevel === 'read' &&
      !toolMeta.mayMutateWorkspaceFiles;
    const subagentLaunchParallelEligible =
      !toolMeta.requiresApproval &&
      !toolMeta.mayMutateWorkspaceFiles &&
      toolMeta.parallelBatchKind === 'subagent_launch';

    const nextBatchKind = readOnlyParallelEligible
      ? 'read_only'
      : subagentLaunchParallelEligible
        ? 'subagent_launch'
        : null;
    if (nextBatchKind === null) {
      return null;
    }
    if (nextBatchKind === 'read_only' && signal?.aborted) {
      return null;
    }
    if (batchKind === null) {
      batchKind = nextBatchKind;
    } else if (batchKind !== nextBatchKind) {
      return null;
    }

    prepared.push({
      functionCall,
      toolArgs: parsedArgs.args,
      workspaceFilesMayHaveChanged: toolMeta.mayMutateWorkspaceFiles ?? false,
    });
  }

  if (batchKind === null) {
    return null;
  }

  return {
    kind: batchKind,
    preparedFunctionCalls: prepared,
  };
}

interface ProcessFunctionCallsInParallelArgs {
  preparedBatch: PreparedParallelBatch;
  round: number;
  history: HistoryItem[];
  runtime: AgentToolCallExecutionRuntime;
}

async function processFunctionCallsInParallel({
  preparedBatch,
  round,
  history,
  runtime,
}: ProcessFunctionCallsInParallelArgs): Promise<StepResult<void>> {
  const runState = getToolRuntimeRunState(runtime);
  const { preparedFunctionCalls } = preparedBatch;

  const recordCallsResult = await recordPreparedParallelToolCalls({
    preparedFunctionCalls,
    round,
    runtime,
  });
  if (recordCallsResult) {
    return recordCallsResult;
  }

  if (
    preparedBatch.kind === 'subagent_launch' &&
    runState !== undefined &&
    !runtime.executionContextBase.agentSpawnRuntime
  ) {
    await recordRejectedSubagentLaunchBatch({
      preparedFunctionCalls,
      round,
      history,
      runtime,
      errorCode: 'execution_failed',
      error: 'agent spawn runtime is required',
    });
    return { ok: true, value: undefined };
  }

  const batchAdmission =
    preparedBatch.kind === 'subagent_launch' &&
    runState !== undefined &&
    runtime.executionContextBase.agentSpawnRuntime
      ? runtime.executionContextBase.agentSpawnRuntime.subagentAdmission.reserveSubagentLaunchSlots(
          {
            runState,
            requestedChildren: preparedFunctionCalls.length,
          },
        )
      : undefined;

  if (batchAdmission && !batchAdmission.ok) {
    await recordRejectedSubagentLaunchBatch({
      preparedFunctionCalls,
      round,
      history,
      runtime,
      errorCode: batchAdmission.errorCode,
      error: batchAdmission.error,
      effectiveMax: batchAdmission.effectiveMax,
    });
    return { ok: true, value: undefined };
  }

  let executions: Awaited<ReturnType<typeof executeFunctionCall>>[];
  try {
    executions = await Promise.all(
      preparedFunctionCalls.map(({ functionCall, toolArgs }) =>
        executeFunctionCall({
          functionCall,
          round,
          toolArgs,
          history,
          runtime,
        }),
      ),
    );
  } finally {
    if (batchAdmission?.ok) {
      batchAdmission.reservation.release();
    }
  }

  for (const [index, execution] of executions.entries()) {
    if (!execution.ok) {
      return execution;
    }

    const preparedFunctionCall = preparedFunctionCalls[index];
    if (!preparedFunctionCall) {
      continue;
    }

    await recordParallelExecutionResult({
      preparedFunctionCall,
      round,
      history,
      runtime,
      toolResult: execution.value,
    });
  }

  return { ok: true, value: undefined };
}

async function recordPreparedParallelToolCalls(args: {
  preparedFunctionCalls: PreparedFunctionCall[];
  round: number;
  runtime: AgentToolCallExecutionRuntime;
}): Promise<StepResult<void> | null> {
  const { preparedFunctionCalls, round, runtime } = args;
  const runContext = getToolRuntimeRunContext(runtime);
  const { emit } = runtime;

  for (const preparedFunctionCall of preparedFunctionCalls) {
    const abortResult = settleIfFunctionCallProcessingAborted(runtime);
    if (abortResult) {
      return abortResult;
    }

    await recordToolCall({
      functionCall: preparedFunctionCall.functionCall,
      round,
      toolArgs: preparedFunctionCall.toolArgs,
      runContext,
      emit,
    });
  }

  return settleIfFunctionCallProcessingAborted(runtime);
}

async function recordRejectedSubagentLaunchBatch(args: {
  preparedFunctionCalls: PreparedFunctionCall[];
  round: number;
  history: HistoryItem[];
  runtime: AgentToolCallExecutionRuntime;
  errorCode: AgentLaunchRejectedToolRaw['errorCode'];
  error: string;
  effectiveMax?: number;
}): Promise<void> {
  const {
    preparedFunctionCalls,
    round,
    history,
    runtime,
    errorCode,
    error,
    effectiveMax,
  } = args;

  for (const preparedFunctionCall of preparedFunctionCalls) {
    const rejectionArgs: Parameters<typeof buildChildLaunchRejected>[0] = {
      subagentType: getPreparedSubagentType(preparedFunctionCall),
      errorCode,
      error,
    };
    if (effectiveMax !== undefined) {
      rejectionArgs.effectiveMax = effectiveMax;
    }

    await recordParallelExecutionResult({
      preparedFunctionCall,
      round,
      history,
      runtime,
      toolResult: buildChildLaunchPayload(
        buildChildLaunchRejected(rejectionArgs),
      ),
    });
  }
}

async function recordParallelExecutionResult(args: {
  preparedFunctionCall: PreparedFunctionCall;
  round: number;
  history: HistoryItem[];
  runtime: AgentToolCallExecutionRuntime;
  toolResult: Parameters<typeof recordToolResult>[0]['toolResult'];
}): Promise<void> {
  const { preparedFunctionCall, round, history, runtime, toolResult } = args;
  await recordToolResult({
    functionCall: preparedFunctionCall.functionCall,
    round,
    toolResult,
    workspaceFilesMayHaveChanged:
      preparedFunctionCall.workspaceFilesMayHaveChanged,
    runContext: getToolRuntimeRunContext(runtime),
    runId: runtime.executionContextBase.runId,
    history,
    emit: runtime.emit,
  });
}

function getPreparedSubagentType(
  preparedFunctionCall: PreparedFunctionCall,
): SubagentType {
  return String(preparedFunctionCall.toolArgs.subagent_type ?? '') === 'worker'
    ? 'worker'
    : 'explorer';
}
