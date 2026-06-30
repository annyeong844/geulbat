import type { HistoryItem, FunctionCall } from '../llm/index.js';
import type { StepResult } from './loop-shared.js';
import {
  executeFunctionCall,
  type DeferredFunctionCallTerminalFailure,
} from './loop-tool-approval.js';
import {
  getToolRuntimeRunContext,
  getToolRuntimeRunState,
  getToolRuntimeSignal,
  isToolOutputRecoveryAvailable,
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
import { PTC_EXECUTE_CODE_WAIT_TOOL_NAME } from '../ptc/runtime/execute-code/execute-code-runtime-contract.js';
import type {
  ExecuteResult,
  ToolExecutionResourceSnapshotRef,
} from '../tools/types.js';
import type { ToolMeta } from '../tools/tool-registry-model.js';
import { toolError } from '../tools/result.js';

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

type SharedFunctionCallKind = 'read_only' | 'subagent_launch' | 'ptc_cell';

interface PreparedSharedFunctionCall extends PreparedFunctionCall {
  sharedKind: SharedFunctionCallKind;
}

type FunctionCallScheduleItem =
  | {
      kind: 'shared_window';
      preparedFunctionCalls: PreparedSharedFunctionCall[];
    }
  | {
      kind: 'exclusive';
      preparedFunctionCall: PreparedFunctionCall;
    }
  | {
      kind: 'invalid_args';
      functionCall: FunctionCall;
      errorResult: ExecuteResult;
    };

export async function processFunctionCalls(
  args: ProcessFunctionCallsArgs,
): Promise<StepResult<void>> {
  const { functionCalls, round, history, runtime } = args;
  const { emit } = runtime;
  const runContext = getToolRuntimeRunContext(runtime);
  const schedule = prepareFunctionCallSchedule(functionCalls, runtime);

  for (let itemIndex = 0; itemIndex < schedule.length; itemIndex += 1) {
    const item = schedule[itemIndex];
    if (!item) {
      continue;
    }

    if (isFunctionCallProcessingAborted(runtime)) {
      await recordSkippedScheduleItems({
        scheduleItems: schedule.slice(itemIndex),
        round,
        history,
        runtime,
        toolResult: buildAbortedSkippedToolResult(),
      });
      return settleIfFunctionCallProcessingAborted(runtime) as StepResult<void>;
    }

    if (item.kind === 'shared_window') {
      const result = await processSharedFunctionCallWindow({
        preparedFunctionCalls: item.preparedFunctionCalls,
        round,
        history,
        runtime,
      });
      if (!result.ok) {
        return result;
      }
      if (isFunctionCallProcessingAborted(runtime)) {
        await recordSkippedScheduleItems({
          scheduleItems: schedule.slice(itemIndex + 1),
          round,
          history,
          runtime,
          toolResult: buildAbortedSkippedToolResult(),
        });
        return settleIfFunctionCallProcessingAborted(
          runtime,
        ) as StepResult<void>;
      }
      continue;
    }

    if (item.kind === 'invalid_args') {
      await recordInvalidToolArguments({
        functionCall: item.functionCall,
        round,
        errorResult: item.errorResult,
        toolOutputRecoveryAvailable: isToolOutputRecoveryAvailable(runtime),
        runContext,
        runId: runtime.executionContextBase.runId,
        history,
        emit,
      });
      if (isFunctionCallProcessingAborted(runtime)) {
        await recordSkippedScheduleItems({
          scheduleItems: schedule.slice(itemIndex + 1),
          round,
          history,
          runtime,
          toolResult: buildAbortedSkippedToolResult(),
        });
        return settleIfFunctionCallProcessingAborted(
          runtime,
        ) as StepResult<void>;
      }
      continue;
    }

    const { preparedFunctionCall } = item;
    await recordToolCall({
      functionCall: preparedFunctionCall.functionCall,
      round,
      toolArgs: preparedFunctionCall.toolArgs,
      runContext,
      emit,
    });

    if (isFunctionCallProcessingAborted(runtime)) {
      await recordSkippedFunctionCall({
        functionCall: preparedFunctionCall.functionCall,
        toolArgs: preparedFunctionCall.toolArgs,
        round,
        history,
        runtime,
        recordCall: false,
        toolResult: buildAbortedSkippedToolResult(),
      });
      await recordSkippedScheduleItems({
        scheduleItems: schedule.slice(itemIndex + 1),
        round,
        history,
        runtime,
        toolResult: buildAbortedSkippedToolResult(),
      });
      return settleIfFunctionCallProcessingAborted(runtime) as StepResult<void>;
    }

    const execution = await executeFunctionCall({
      functionCall: preparedFunctionCall.functionCall,
      round,
      toolArgs: preparedFunctionCall.toolArgs,
      history,
      runtime,
      deferTerminalFailure: true,
    });
    if (!execution.ok) {
      const deferredTerminalFailure = execution.deferredTerminalFailure;
      if (deferredTerminalFailure !== undefined) {
        await recordSkippedScheduleItems({
          scheduleItems: schedule.slice(itemIndex + 1),
          round,
          history,
          runtime,
          toolResult: buildDeferredTerminalSkippedToolResult(
            deferredTerminalFailure,
          ),
        });
        return {
          ok: false,
          result: emitAndSettleTerminalFailure(
            emit,
            deferredTerminalFailure.code,
            deferredTerminalFailure.message,
            getToolRuntimeRunState(runtime),
            deferredTerminalFailure.signal,
            deferredTerminalFailure.outcome,
          ),
        };
      }
      return execution;
    }

    await recordToolResult({
      functionCall: preparedFunctionCall.functionCall,
      round,
      toolResult: execution.value,
      toolOutputRecoveryAvailable: isToolOutputRecoveryAvailable(runtime),
      workspaceFilesMayHaveChanged:
        preparedFunctionCall.workspaceFilesMayHaveChanged,
      runContext,
      runId: runtime.executionContextBase.runId,
      history,
      emit,
    });
    if (isFunctionCallProcessingAborted(runtime)) {
      await recordSkippedScheduleItems({
        scheduleItems: schedule.slice(itemIndex + 1),
        round,
        history,
        runtime,
        toolResult: buildAbortedSkippedToolResult(),
      });
      return settleIfFunctionCallProcessingAborted(runtime) as StepResult<void>;
    }
  }

  return { ok: true, value: undefined };
}

function isFunctionCallProcessingAborted(
  runtime: AgentToolCallExecutionRuntime,
): boolean {
  return getToolRuntimeSignal(runtime)?.aborted === true;
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

async function recordSkippedScheduleItems(args: {
  scheduleItems: FunctionCallScheduleItem[];
  round: number;
  history: HistoryItem[];
  runtime: AgentToolCallExecutionRuntime;
  toolResult: ExecuteResult;
}): Promise<void> {
  for (const item of args.scheduleItems) {
    if (item.kind === 'shared_window') {
      for (const preparedFunctionCall of item.preparedFunctionCalls) {
        await recordSkippedFunctionCall({
          functionCall: preparedFunctionCall.functionCall,
          toolArgs: preparedFunctionCall.toolArgs,
          round: args.round,
          history: args.history,
          runtime: args.runtime,
          recordCall: true,
          toolResult: args.toolResult,
        });
      }
      continue;
    }

    if (item.kind === 'exclusive') {
      await recordSkippedFunctionCall({
        functionCall: item.preparedFunctionCall.functionCall,
        toolArgs: item.preparedFunctionCall.toolArgs,
        round: args.round,
        history: args.history,
        runtime: args.runtime,
        recordCall: true,
        toolResult: args.toolResult,
      });
      continue;
    }

    await recordSkippedFunctionCall({
      functionCall: item.functionCall,
      toolArgs: {},
      round: args.round,
      history: args.history,
      runtime: args.runtime,
      recordCall: true,
      toolResult: args.toolResult,
    });
  }
}

async function recordSkippedFunctionCall(args: {
  functionCall: FunctionCall;
  toolArgs: Record<string, unknown>;
  round: number;
  history: HistoryItem[];
  runtime: AgentToolCallExecutionRuntime;
  recordCall: boolean;
  toolResult: ExecuteResult;
}): Promise<void> {
  const runContext = getToolRuntimeRunContext(args.runtime);
  if (args.recordCall) {
    await recordToolCall({
      functionCall: args.functionCall,
      round: args.round,
      toolArgs: args.toolArgs,
      runContext,
      emit: args.runtime.emit,
    });
  }
  await recordToolResult({
    functionCall: args.functionCall,
    round: args.round,
    toolResult: args.toolResult,
    toolOutputRecoveryAvailable: isToolOutputRecoveryAvailable(args.runtime),
    workspaceFilesMayHaveChanged: false,
    runContext,
    runId: args.runtime.executionContextBase.runId,
    history: args.history,
    emit: args.runtime.emit,
  });
}

function buildAbortedSkippedToolResult(): ExecuteResult {
  return toolError('aborted', 'tool skipped because run was cancelled');
}

function buildDeferredTerminalSkippedToolResult(
  terminalFailure: DeferredFunctionCallTerminalFailure,
): ExecuteResult {
  return toolError(
    terminalFailure.code,
    `tool skipped because an earlier call ended the run: ${terminalFailure.message}`,
  );
}

function prepareFunctionCallSchedule(
  functionCalls: FunctionCall[],
  runtime: AgentToolCallExecutionRuntime,
): FunctionCallScheduleItem[] {
  const schedule: FunctionCallScheduleItem[] = [];
  let sharedWindow: PreparedSharedFunctionCall[] = [];
  const flushSharedWindow = () => {
    if (sharedWindow.length === 0) {
      return;
    }
    schedule.push({
      kind: 'shared_window',
      preparedFunctionCalls: sharedWindow,
    });
    sharedWindow = [];
  };

  for (const functionCall of functionCalls) {
    const parsedArgs = parseToolCallArguments(functionCall.arguments);
    if (!parsedArgs.ok) {
      flushSharedWindow();
      schedule.push({
        kind: 'invalid_args',
        functionCall,
        errorResult: parsedArgs.error,
      });
      continue;
    }

    const toolMeta = runtime.toolRegistry.getToolMeta(functionCall.name);
    const sharedKind = classifySharedFunctionCallKind({
      toolMeta,
      toolName: functionCall.name,
      toolArgs: parsedArgs.args,
    });

    const preparedFunctionCall = {
      functionCall,
      toolArgs: parsedArgs.args,
      workspaceFilesMayHaveChanged:
        toolMeta !== null ? toolMeta.mayMutateWorkspaceFiles : false,
    };

    if (sharedKind === null) {
      flushSharedWindow();
      schedule.push({
        kind: 'exclusive',
        preparedFunctionCall,
      });
      continue;
    }

    sharedWindow.push({
      ...preparedFunctionCall,
      sharedKind,
    });
  }

  flushSharedWindow();
  return schedule;
}

function classifySharedFunctionCallKind(args: {
  toolMeta: ToolMeta | null;
  toolName: string;
  toolArgs: Record<string, unknown>;
}): SharedFunctionCallKind | null {
  const { toolMeta } = args;
  if (
    toolMeta === null ||
    toolMeta.requiresApproval ||
    toolMeta.mayMutateWorkspaceFiles
  ) {
    return null;
  }

  if (toolMeta.parallelBatchKind === 'subagent_launch') {
    return toolMeta.sideEffectLevel === 'none' ? 'subagent_launch' : null;
  }

  if (toolMeta.parallelBatchKind === 'ptc_cell') {
    return isPtcCellSharedWindowEligibleToolMeta(toolMeta) &&
      isPtcCellSharedWindowEligibleCall(args)
      ? 'ptc_cell'
      : null;
  }

  return toolMeta.sideEffectLevel === 'read' ? 'read_only' : null;
}

function isPtcCellSharedWindowEligibleToolMeta(toolMeta: ToolMeta): boolean {
  return (
    toolMeta.requiresApproval === false &&
    toolMeta.mayMutateWorkspaceFiles === false &&
    toolMeta.sideEffectLevel === 'none' &&
    toolMeta.parallelBatchKind === 'ptc_cell'
  );
}

function isPtcCellSharedWindowEligibleCall(args: {
  toolName: string;
  toolArgs: Record<string, unknown>;
}): boolean {
  if (args.toolName !== PTC_EXECUTE_CODE_WAIT_TOOL_NAME) {
    return true;
  }

  return args.toolArgs.terminate !== true;
}

interface ProcessSharedFunctionCallWindowArgs {
  preparedFunctionCalls: PreparedSharedFunctionCall[];
  round: number;
  history: HistoryItem[];
  runtime: AgentToolCallExecutionRuntime;
}

async function processSharedFunctionCallWindow({
  preparedFunctionCalls,
  round,
  history,
  runtime,
}: ProcessSharedFunctionCallWindowArgs): Promise<StepResult<void>> {
  const runState = getToolRuntimeRunState(runtime);

  await recordPreparedParallelToolCalls({
    preparedFunctionCalls,
    round,
    runtime,
  });

  const subagentLaunchCalls = preparedFunctionCalls.filter(
    isPreparedSubagentLaunchCall,
  );
  const ptcCellCalls = preparedFunctionCalls.filter(isPreparedPtcCellCall);
  let sharedResourceSnapshotRef: ToolExecutionResourceSnapshotRef | undefined;
  if (
    subagentLaunchCalls.length > 0 &&
    ptcCellCalls.length > 0 &&
    runState !== undefined
  ) {
    const resourceSnapshot =
      runtime.executionContextBase.agentSpawnRuntime?.resourceBudgetProvider.captureSnapshot(
        { runState },
      );
    sharedResourceSnapshotRef =
      resourceSnapshot === undefined
        ? undefined
        : {
            snapshotId: resourceSnapshot.snapshotId,
          };
  }
  const stagedExecutions: Array<
    Awaited<ReturnType<typeof executeFunctionCall>> | undefined
  > = [];
  let subagentLaunchesRejected = false;

  if (
    subagentLaunchCalls.length > 0 &&
    runState !== undefined &&
    !runtime.executionContextBase.agentSpawnRuntime
  ) {
    for (const preparedFunctionCall of subagentLaunchCalls) {
      stagedExecutions[preparedFunctionCalls.indexOf(preparedFunctionCall)] = {
        ok: true,
        value: buildRejectedSubagentLaunchResult({
          preparedFunctionCall,
          errorCode: 'execution_failed',
          error: 'agent spawn runtime is required',
        }),
      };
    }
    subagentLaunchesRejected = true;
  }

  const batchAdmission =
    subagentLaunchCalls.length > 0 &&
    runState !== undefined &&
    runtime.executionContextBase.agentSpawnRuntime &&
    !subagentLaunchesRejected
      ? runtime.executionContextBase.agentSpawnRuntime.subagentAdmission.reserveSubagentLaunchSlots(
          {
            runState,
            requestedChildren: subagentLaunchCalls.length,
          },
        )
      : undefined;

  if (batchAdmission && !batchAdmission.ok) {
    for (const preparedFunctionCall of subagentLaunchCalls) {
      stagedExecutions[preparedFunctionCalls.indexOf(preparedFunctionCall)] = {
        ok: true,
        value: buildRejectedSubagentLaunchResult({
          preparedFunctionCall,
          errorCode: batchAdmission.errorCode,
          error: batchAdmission.error,
          effectiveMax: batchAdmission.effectiveMax,
        }),
      };
    }
    subagentLaunchesRejected = true;
  }

  const runnablePreparedFunctionCalls = preparedFunctionCalls
    .map((preparedFunctionCall, index) => ({
      index,
      preparedFunctionCall,
    }))
    .filter(({ index }) => stagedExecutions[index] === undefined);

  try {
    const executions = await Promise.allSettled(
      runnablePreparedFunctionCalls.map(({ preparedFunctionCall }) =>
        executeFunctionCall({
          functionCall: preparedFunctionCall.functionCall,
          round,
          toolArgs: preparedFunctionCall.toolArgs,
          history,
          runtime,
          ...(preparedFunctionCall.sharedKind === 'ptc_cell' &&
          sharedResourceSnapshotRef !== undefined
            ? { resourceSnapshotRef: sharedResourceSnapshotRef }
            : {}),
        }),
      ),
    );
    for (const [executionIndex, execution] of executions.entries()) {
      const runnable = runnablePreparedFunctionCalls[executionIndex];
      if (runnable) {
        stagedExecutions[runnable.index] =
          execution.status === 'fulfilled'
            ? execution.value
            : {
                ok: true,
                value: toolError(
                  'execution_failed',
                  'tool execution failed unexpectedly',
                ),
              };
      }
    }
  } finally {
    if (batchAdmission?.ok) {
      batchAdmission.reservation.release();
    }
  }

  let terminalFailure: StepResult<void> | undefined;
  for (const [index, execution] of stagedExecutions.entries()) {
    if (!execution) {
      continue;
    }
    if (!execution.ok) {
      terminalFailure = execution;
      continue;
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

  if (terminalFailure) {
    return terminalFailure;
  }

  return { ok: true, value: undefined };
}

async function recordPreparedParallelToolCalls(args: {
  preparedFunctionCalls: PreparedFunctionCall[];
  round: number;
  runtime: AgentToolCallExecutionRuntime;
}): Promise<void> {
  const { preparedFunctionCalls, round, runtime } = args;
  const runContext = getToolRuntimeRunContext(runtime);
  const { emit } = runtime;

  for (const preparedFunctionCall of preparedFunctionCalls) {
    await recordToolCall({
      functionCall: preparedFunctionCall.functionCall,
      round,
      toolArgs: preparedFunctionCall.toolArgs,
      runContext,
      emit,
    });
  }
}

function isPreparedSubagentLaunchCall(
  preparedFunctionCall: PreparedSharedFunctionCall,
): boolean {
  return preparedFunctionCall.sharedKind === 'subagent_launch';
}

function isPreparedPtcCellCall(
  preparedFunctionCall: PreparedSharedFunctionCall,
): boolean {
  return preparedFunctionCall.sharedKind === 'ptc_cell';
}

function buildRejectedSubagentLaunchResult(args: {
  preparedFunctionCall: PreparedFunctionCall;
  errorCode: AgentLaunchRejectedToolRaw['errorCode'];
  error: string;
  effectiveMax?: number;
}): ExecuteResult {
  const rejectionArgs: Parameters<typeof buildChildLaunchRejected>[0] = {
    subagentType: getPreparedSubagentType(args.preparedFunctionCall),
    errorCode: args.errorCode,
    error: args.error,
  };
  if (args.effectiveMax !== undefined) {
    rejectionArgs.effectiveMax = args.effectiveMax;
  }

  return buildChildLaunchPayload(buildChildLaunchRejected(rejectionArgs));
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
    toolOutputRecoveryAvailable: isToolOutputRecoveryAvailable(runtime),
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
