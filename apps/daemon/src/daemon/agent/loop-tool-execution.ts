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
  recordToolCalls,
  recordToolResult,
  recordToolResults,
} from './loop-tool-support.js';
import {
  buildChildLaunchPayload,
  buildChildLaunchRejected,
  type AgentLaunchRejectedToolRaw,
  type DurableSubagentLaunchRequest,
  type SubagentLaunchRequestInput,
  type SubagentType,
} from '../subagent-runtime-contracts.js';
import { PTC_EXECUTE_CODE_WAIT_TOOL_NAME } from '../ptc/runtime/execute-code/execute-code-runtime-contract.js';
import type {
  ExecuteResult,
  ToolExecutionResourceSnapshotRef,
  ToolResultProjectionCapability,
} from '../tools/types.js';
import { buildAgentToolExecutionContext } from '../tools/types.js';
import type {
  ToolMeta,
  ToolRecoveryStrategy,
} from '../tools/tool-registry-model.js';
import { toolError } from '../tools/result.js';
import type { ToolOutputProjectionRound } from './tool-output-offload.js';
import type { ToolResultObservation } from './observer/agent-loop-observer.js';
import {
  hasPendingInterject,
  isInterjectFlushRequested,
} from '../sessions/active-run-interject-buffer.js';
import { resolveAgentSpawnLaunchRequest } from '../tools/builtin/agent-spawn.js';

interface ProcessFunctionCallsArgs {
  functionCalls: FunctionCall[];
  round: number;
  history: HistoryItem[];
  runtime: AgentToolCallExecutionRuntime;
  projectionRound?: ToolOutputProjectionRound;
  observeToolResult?:
    | ((observation: ToolResultObservation) => void)
    | undefined;
}

interface PreparedFunctionCall {
  functionCall: FunctionCall;
  toolArgs: Record<string, unknown>;
  computerFilesMayHaveChanged: boolean;
  resultProjection?: ToolResultProjectionCapability;
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
      resultProjection?: ToolResultProjectionCapability;
    };

export async function processFunctionCalls(
  args: ProcessFunctionCallsArgs,
): Promise<StepResult<void>> {
  const {
    functionCalls,
    round,
    history,
    runtime,
    projectionRound,
    observeToolResult,
  } = args;
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
        projectionRound,
        observeToolResult,
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
        projectionRound,
        observeToolResult,
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
        projectionRound,
        observeToolResult,
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
          projectionRound,
          observeToolResult,
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
        projectionRound,
        ...(item.resultProjection === undefined
          ? {}
          : { resultProjection: item.resultProjection }),
        ...(observeToolResult === undefined ? {} : { observeToolResult }),
      });
      const abortSignalAfterInvalidArguments =
        getFunctionCallProcessingAbortSignal(runtime);
      if (abortSignalAfterInvalidArguments !== undefined) {
        await recordSkippedScheduleItems({
          scheduleItems: schedule.slice(itemIndex + 1),
          round,
          history,
          runtime,
          projectionRound,
          observeToolResult,
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
      ...readToolRecoveryStrategyInput(
        runtime,
        preparedFunctionCall.functionCall.name,
      ),
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
        projectionRound,
        observeToolResult,
        recordCall: false,
        toolResult: buildAbortedSkippedToolResult(),
      });
      await recordSkippedScheduleItems({
        scheduleItems: schedule.slice(itemIndex + 1),
        round,
        history,
        runtime,
        projectionRound,
        observeToolResult,
        toolResult: buildAbortedSkippedToolResult(),
      });
      return settleFunctionCallProcessingAbort(
        runtime,
        abortSignalAfterToolCall,
      );
    }

    const executionStartedAt = Date.now();
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
          projectionRound,
          observeToolResult,
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
      ...(preparedFunctionCall.resultProjection === undefined
        ? {}
        : { resultProjection: preparedFunctionCall.resultProjection }),
      elapsedMs: Date.now() - executionStartedAt,
      computerFilesMayHaveChanged:
        preparedFunctionCall.computerFilesMayHaveChanged,
      runContext,
      runId: runtime.executionContextBase.runId,
      history,
      emit,
      projectionRound,
      ...(observeToolResult === undefined ? {} : { observeToolResult }),
    });
    const abortSignalAfterToolResult =
      getFunctionCallProcessingAbortSignal(runtime);
    if (abortSignalAfterToolResult !== undefined) {
      await recordSkippedScheduleItems({
        scheduleItems: schedule.slice(itemIndex + 1),
        round,
        history,
        runtime,
        projectionRound,
        observeToolResult,
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
  projectionRound?: ToolOutputProjectionRound | undefined;
  observeToolResult?:
    | ((observation: ToolResultObservation) => void)
    | undefined;
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
          projectionRound: args.projectionRound,
          ...(args.observeToolResult === undefined
            ? {}
            : { observeToolResult: args.observeToolResult }),
          recordCall: true,
          ...(preparedFunctionCall.resultProjection === undefined
            ? {}
            : { resultProjection: preparedFunctionCall.resultProjection }),
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
        projectionRound: args.projectionRound,
        ...(args.observeToolResult === undefined
          ? {}
          : { observeToolResult: args.observeToolResult }),
        recordCall: true,
        ...(item.preparedFunctionCall.resultProjection === undefined
          ? {}
          : {
              resultProjection: item.preparedFunctionCall.resultProjection,
            }),
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
      projectionRound: args.projectionRound,
      ...(args.observeToolResult === undefined
        ? {}
        : { observeToolResult: args.observeToolResult }),
      recordCall: true,
      ...(item.resultProjection === undefined
        ? {}
        : { resultProjection: item.resultProjection }),
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
  projectionRound?: ToolOutputProjectionRound | undefined;
  observeToolResult?:
    | ((observation: ToolResultObservation) => void)
    | undefined;
  recordCall: boolean;
  resultProjection?: ToolResultProjectionCapability;
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
      ...readToolRecoveryStrategyInput(args.runtime, args.functionCall.name),
    });
  }
  await recordToolResult({
    functionCall: args.functionCall,
    round: args.round,
    toolResult: args.toolResult,
    toolOutputRecoveryAvailable: isToolOutputRecoveryAvailable(args.runtime),
    ...(args.resultProjection === undefined
      ? {}
      : { resultProjection: args.resultProjection }),
    computerFilesMayHaveChanged: false,
    runContext,
    runId: args.runtime.executionContextBase.runId,
    history: args.history,
    emit: args.runtime.emit,
    projectionRound: args.projectionRound,
    ...(args.observeToolResult === undefined
      ? {}
      : { observeToolResult: args.observeToolResult }),
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
    const toolMeta = runtime.toolRegistry.getToolMeta(functionCall.name);
    const parsedArgs = parseToolCallArguments(functionCall.arguments);
    if (!parsedArgs.ok) {
      flushSharedWindow();
      schedule.push({
        kind: 'invalid_args',
        functionCall,
        errorResult: parsedArgs.error,
        ...(toolMeta?.resultProjection === undefined
          ? {}
          : { resultProjection: toolMeta.resultProjection }),
      });
      continue;
    }

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
      ...(toolMeta?.resultProjection === undefined
        ? {}
        : { resultProjection: toolMeta.resultProjection }),
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
  projectionRound?: ToolOutputProjectionRound | undefined;
  observeToolResult?:
    | ((observation: ToolResultObservation) => void)
    | undefined;
}

async function processSharedFunctionCallWindow({
  preparedFunctionCalls,
  round,
  history,
  runtime,
  projectionRound,
  observeToolResult,
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
  const builtinAgentSpawnCalls = subagentLaunchCalls.filter(
    ({ functionCall }) => functionCall.name === 'agent_spawn',
  );
  const ptcCellCalls = preparedFunctionCalls.filter(isPreparedPtcCellCall);
  const stagedExecutions: Array<
    | {
        execution: Awaited<ReturnType<typeof executeFunctionCall>>;
        elapsedMs: number | null;
      }
    | undefined
  > = [];
  let subagentLaunchesRejected = false;
  const durableLaunchRequests: SubagentLaunchRequestInput[] = [];
  let invalidAgentSpawnBatch = false;

  for (const preparedFunctionCall of builtinAgentSpawnCalls) {
    const resolution = resolveAgentSpawnLaunchRequest(
      preparedFunctionCall.toolArgs,
      buildAgentToolExecutionContext({
        base: runtime.executionContextBase,
        callId: preparedFunctionCall.functionCall.callId,
        approvalGranted: true,
      }),
    );
    if (!resolution.ok) {
      stagedExecutions[preparedFunctionCalls.indexOf(preparedFunctionCall)] = {
        execution: { ok: true, value: resolution.result },
        elapsedMs: null,
      };
      invalidAgentSpawnBatch = true;
      continue;
    }
    durableLaunchRequests.push(resolution.value.request);
  }
  if (invalidAgentSpawnBatch) {
    for (const preparedFunctionCall of subagentLaunchCalls) {
      const preparedIndex = preparedFunctionCalls.indexOf(preparedFunctionCall);
      if (stagedExecutions[preparedIndex] !== undefined) {
        continue;
      }
      stagedExecutions[preparedIndex] = {
        execution: {
          ok: true,
          value: toolError(
            'invalid_args',
            'same-round agent_spawn batch contains an invalid request',
          ),
        },
        elapsedMs: null,
      };
    }
    subagentLaunchesRejected = true;
  }

  let sharedResourceSnapshotRef: ToolExecutionResourceSnapshotRef | undefined;
  if (
    subagentLaunchCalls.length > 0 &&
    ptcCellCalls.length > 0 &&
    runState !== undefined
  ) {
    const resourceSnapshot =
      runtime.executionContextBase.runtimeServices?.agent.resourceBudgetProvider.captureSnapshot(
        { runState },
      );
    sharedResourceSnapshotRef =
      resourceSnapshot === undefined
        ? undefined
        : {
            snapshotId: resourceSnapshot.snapshotId,
          };
  }
  if (
    subagentLaunchCalls.length > 0 &&
    runState !== undefined &&
    !runtime.executionContextBase.runtimeServices
  ) {
    for (const preparedFunctionCall of subagentLaunchCalls) {
      stagedExecutions[preparedFunctionCalls.indexOf(preparedFunctionCall)] = {
        execution: {
          ok: true,
          value: buildRejectedSubagentLaunchResult({
            preparedFunctionCall,
            errorCode: 'execution_failed',
            error: 'agent spawn runtime is required',
          }),
        },
        elapsedMs: null,
      };
    }
    subagentLaunchesRejected = true;
  }

  const launchRuntime = runtime.executionContextBase.runtimeServices;
  const launchRequestStore = launchRuntime?.subagent.launchRequests;
  let durableAcceptedRequests: readonly DurableSubagentLaunchRequest[] = [];
  if (durableLaunchRequests.length > 0 && !subagentLaunchesRejected) {
    let persistenceFailed = launchRequestStore === undefined;
    if (launchRequestStore !== undefined) {
      try {
        durableAcceptedRequests = launchRequestStore.enqueueSubagentLaunchBatch(
          durableLaunchRequests,
        );
      } catch {
        persistenceFailed = true;
      }
    }
    if (persistenceFailed) {
      for (const preparedFunctionCall of subagentLaunchCalls) {
        stagedExecutions[preparedFunctionCalls.indexOf(preparedFunctionCall)] =
          {
            execution: {
              ok: true,
              value: toolError(
                'persistence_unavailable',
                'agent launch batch could not be durably accepted',
              ),
            },
            elapsedMs: null,
          };
      }
      subagentLaunchesRejected = true;
    }
  }

  const batchAdmission =
    subagentLaunchCalls.length > 0 &&
    runState !== undefined &&
    launchRuntime &&
    !subagentLaunchesRejected
      ? launchRuntime.subagent.admission.reserveSubagentLaunchSlots({
          runState,
          requestedChildren: subagentLaunchCalls.length,
          ultraReasoning: runtime.executionContextBase.ultraReasoning ?? false,
          transferable: true,
        })
      : undefined;

  if (batchAdmission && !batchAdmission.ok) {
    const canDurablyDeferWholeBatch =
      launchRequestStore !== undefined &&
      launchRuntime?.subagent.launchPromotions !== undefined &&
      builtinAgentSpawnCalls.length === subagentLaunchCalls.length &&
      durableAcceptedRequests.length === subagentLaunchCalls.length;
    let deferred = false;
    if (canDurablyDeferWholeBatch) {
      try {
        launchRequestStore.markSubagentLaunchDeferredBatch({
          childRunIds: durableAcceptedRequests.map(
            (request) => request.childRunId,
          ),
          deferReason: 'batch_group_wait',
        });
        deferred = true;
      } catch {
        deferred = false;
      }
    }
    if (!deferred) {
      for (const durableRequest of durableAcceptedRequests) {
        try {
          launchRequestStore?.markSubagentLaunchFailedToStart({
            childRunId: durableRequest.childRunId,
            reason: batchAdmission.error,
          });
        } catch {
          // The tool result below remains an explicit rejection; the store
          // operation already reports its own persistence diagnostic.
        }
      }
      for (const preparedFunctionCall of subagentLaunchCalls) {
        stagedExecutions[preparedFunctionCalls.indexOf(preparedFunctionCall)] =
          {
            execution: {
              ok: true,
              value: buildRejectedSubagentLaunchResult({
                preparedFunctionCall,
                errorCode: batchAdmission.errorCode,
                error: batchAdmission.error,
                effectiveMax: batchAdmission.effectiveMax,
              }),
            },
            elapsedMs: null,
          };
      }
      subagentLaunchesRejected = true;
    }
  }

  const runnablePreparedFunctionCalls = preparedFunctionCalls
    .map((preparedFunctionCall, index) => ({
      index,
      preparedFunctionCall,
    }))
    .filter(({ index }) => stagedExecutions[index] === undefined);

  try {
    const executions = await Promise.allSettled(
      runnablePreparedFunctionCalls.map(async ({ preparedFunctionCall }) => {
        const startedAt = Date.now();
        const execution = await executeFunctionCall({
          functionCall: preparedFunctionCall.functionCall,
          round,
          toolArgs: preparedFunctionCall.toolArgs,
          history,
          runtime,
          ...(preparedFunctionCall.sharedKind === 'ptc_cell' &&
          sharedResourceSnapshotRef !== undefined
            ? { resourceSnapshotRef: sharedResourceSnapshotRef }
            : {}),
        });
        return { execution, elapsedMs: Date.now() - startedAt };
      }),
    );
    for (const [executionIndex, execution] of executions.entries()) {
      const runnable = runnablePreparedFunctionCalls[executionIndex];
      if (runnable) {
        stagedExecutions[runnable.index] =
          execution.status === 'fulfilled'
            ? execution.value
            : {
                execution: {
                  ok: true,
                  value: toolError(
                    'execution_failed',
                    'tool execution failed unexpectedly',
                  ),
                },
                elapsedMs: null,
              };
      }
    }
  } finally {
    if (batchAdmission?.ok) {
      batchAdmission.reservation.release();
    }
  }

  let terminalFailure: StepResult<void> | undefined;
  const recordableExecutions: Array<{
    preparedFunctionCall: PreparedFunctionCall;
    toolResult: ExecuteResult;
    elapsedMs: number | null;
  }> = [];
  for (const [index, stagedExecution] of stagedExecutions.entries()) {
    if (!stagedExecution) {
      continue;
    }
    const { execution, elapsedMs } = stagedExecution;
    if (!execution.ok) {
      terminalFailure = execution;
      continue;
    }

    const preparedFunctionCall = preparedFunctionCalls[index];
    if (!preparedFunctionCall) {
      continue;
    }

    recordableExecutions.push({
      preparedFunctionCall,
      toolResult: execution.value,
      elapsedMs,
    });
  }

  await recordToolResults({
    results: recordableExecutions.map(
      ({ preparedFunctionCall, toolResult, elapsedMs }) => ({
        functionCall: preparedFunctionCall.functionCall,
        round,
        toolResult,
        toolOutputRecoveryAvailable: isToolOutputRecoveryAvailable(runtime),
        ...(preparedFunctionCall.resultProjection === undefined
          ? {}
          : { resultProjection: preparedFunctionCall.resultProjection }),
        elapsedMs,
        computerFilesMayHaveChanged:
          preparedFunctionCall.computerFilesMayHaveChanged,
      }),
    ),
    runContext: getToolRuntimeRunContext(runtime),
    runId: runtime.executionContextBase.runId,
    history,
    emit: runtime.emit,
    projectionRound,
    ...(observeToolResult === undefined ? {} : { observeToolResult }),
  });

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

  await recordToolCalls({
    calls: preparedFunctionCalls.map((preparedFunctionCall) => ({
      functionCall: preparedFunctionCall.functionCall,
      round,
      toolArgs: preparedFunctionCall.toolArgs,
      ...readToolRecoveryStrategyInput(
        runtime,
        preparedFunctionCall.functionCall.name,
      ),
    })),
    runContext,
    emit,
  });
}

function readToolRecoveryStrategyInput(
  runtime: AgentToolCallExecutionRuntime,
  toolName: string,
): { recoveryStrategy: ToolRecoveryStrategy } | Record<string, never> {
  const recoveryStrategy =
    runtime.toolRegistry.getToolMeta(toolName)?.recoveryStrategy;
  return recoveryStrategy ? { recoveryStrategy } : {};
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

function getPreparedSubagentType(
  preparedFunctionCall: PreparedFunctionCall,
): SubagentType {
  return preparedFunctionCall.toolArgs.subagent_type === 'worker'
    ? 'worker'
    : 'explorer';
}
