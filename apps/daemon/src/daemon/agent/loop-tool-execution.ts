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
import {
  hasPendingInterject,
  isInterjectFlushRequested,
} from '../sessions/active-run-interject-buffer.js';

interface ProcessFunctionCallsArgs {
  functionCalls: FunctionCall[];
  round: number;
  history: HistoryItem[];
  runtime: AgentToolCallExecutionRuntime;
}

interface PreparedFunctionCall {
  functionCall: FunctionCall;
  toolArgs: Record<string, unknown>;
  computerFilesMayHaveChanged: boolean;
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

    const abortSignalBeforeItem = getFunctionCallProcessingAbortSignal(runtime);
    if (abortSignalBeforeItem !== undefined) {
      await recordSkippedScheduleItems({
        scheduleItems: schedule.slice(itemIndex),
        round,
        history,
        runtime,
        toolResult: buildAbortedSkippedToolResult(),
      });
      return settleFunctionCallProcessingAbort(runtime, abortSignalBeforeItem);
    }

    // 스티어 즉시 반영 요청 — 아직 시작하지 않은 이 라운드의 도구 호출을
    // 건너뛰어 라운드를 조기 종결한다. 다음 라운드 시작 지점에서 대기 중
    // 인터젝트가 소비된다(이미 실행 중인 도구는 완료를 기다린다).
    if (shouldFlushPendingInterject(runtime)) {
      await recordSkippedScheduleItems({
        scheduleItems: schedule.slice(itemIndex),
        round,
        history,
        runtime,
        toolResult: buildInterjectFlushSkippedToolResult(),
      });
      return { ok: true, value: undefined };
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
      const abortSignalAfterSharedWindow =
        getFunctionCallProcessingAbortSignal(runtime);
      if (abortSignalAfterSharedWindow !== undefined) {
        await recordSkippedScheduleItems({
          scheduleItems: schedule.slice(itemIndex + 1),
          round,
          history,
          runtime,
          toolResult: buildAbortedSkippedToolResult(),
        });
        return settleFunctionCallProcessingAbort(
          runtime,
          abortSignalAfterSharedWindow,
        );
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
      const abortSignalAfterInvalidArguments =
        getFunctionCallProcessingAbortSignal(runtime);
      if (abortSignalAfterInvalidArguments !== undefined) {
        await recordSkippedScheduleItems({
          scheduleItems: schedule.slice(itemIndex + 1),
          round,
          history,
          runtime,
          toolResult: buildAbortedSkippedToolResult(),
        });
        return settleFunctionCallProcessingAbort(
          runtime,
          abortSignalAfterInvalidArguments,
        );
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

    const abortSignalAfterToolCall =
      getFunctionCallProcessingAbortSignal(runtime);
    if (abortSignalAfterToolCall !== undefined) {
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
      return settleFunctionCallProcessingAbort(
        runtime,
        abortSignalAfterToolCall,
      );
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
      computerFilesMayHaveChanged:
        preparedFunctionCall.computerFilesMayHaveChanged,
      runContext,
      runId: runtime.executionContextBase.runId,
      history,
      emit,
    });
    const abortSignalAfterToolResult =
      getFunctionCallProcessingAbortSignal(runtime);
    if (abortSignalAfterToolResult !== undefined) {
      await recordSkippedScheduleItems({
        scheduleItems: schedule.slice(itemIndex + 1),
        round,
        history,
        runtime,
        toolResult: buildAbortedSkippedToolResult(),
      });
      return settleFunctionCallProcessingAbort(
        runtime,
        abortSignalAfterToolResult,
      );
    }
  }

  return { ok: true, value: undefined };
}

function getFunctionCallProcessingAbortSignal(
  runtime: AgentToolCallExecutionRuntime,
): AbortSignal | undefined {
  const signal = getToolRuntimeSignal(runtime);
  return signal?.aborted === true ? signal : undefined;
}

function settleFunctionCallProcessingAbort(
  runtime: AgentToolCallExecutionRuntime,
  signal: AbortSignal,
): StepResult<void> {
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
    computerFilesMayHaveChanged: false,
    runContext,
    runId: args.runtime.executionContextBase.runId,
    history: args.history,
    emit: args.runtime.emit,
  });
}

function buildAbortedSkippedToolResult(): ExecuteResult {
  return toolError('aborted', 'tool skipped because run was cancelled');
}

function shouldFlushPendingInterject(
  runtime: AgentToolCallExecutionRuntime,
): boolean {
  const runState = getToolRuntimeRunState(runtime);
  return (
    runState !== undefined &&
    isInterjectFlushRequested(runState.interject) &&
    hasPendingInterject(runState.interject)
  );
}

function buildInterjectFlushSkippedToolResult(): ExecuteResult {
  return toolError(
    'aborted',
    'tool skipped because the user asked to apply a pending message immediately; see the next user message',
  );
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
      computerFilesMayHaveChanged:
        toolMeta !== null ? toolMeta.mayMutateComputerFiles : false,
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
    toolMeta.mayMutateComputerFiles
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
    toolMeta.mayMutateComputerFiles === false &&
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
    computerFilesMayHaveChanged:
      preparedFunctionCall.computerFilesMayHaveChanged,
    runContext: getToolRuntimeRunContext(runtime),
    runId: runtime.executionContextBase.runId,
    history,
    emit: runtime.emit,
  });
}

function getPreparedSubagentType(
  preparedFunctionCall: PreparedFunctionCall,
): SubagentType {
  return preparedFunctionCall.toolArgs.subagent_type === 'worker'
    ? 'worker'
    : 'explorer';
}
