/**
 * Agent loop — provider-backed with tool execution + approval.
 * Emits internal AgentEvents; adapter/web converts to RunEventEnvelope.
 */

import { buildSystemPrompt } from './prompt/build-system-prompt.js';
import { buildPromptContext } from './prompt/build-prompt-context.js';
import { createAgentEvent, type AgentEventEmitter } from './events.js';
import {
  describeAgentResultForTextSurface,
  type AgentResult,
} from './agent-result.js';
import type { AgentInput } from './loop-types.js';
import type { HistoryItem } from '../llm/index.js';
import {
  buildAgentLoopObserverRoundCompletedEvent,
  buildAgentLoopObserverRoundStartedEvent,
  buildAgentLoopObserverSnapshot,
  recordAgentLoopObserverEvent,
  recordAgentLoopObserverSnapshot,
} from './observer/agent-loop-observer.js';
import {
  buildAgentToolExecutionContextBase,
  buildToolCallExecutionRuntime,
} from './loop-tool-runtime.js';
import { assertAgentRunId as assertValidRunId } from './contract.js';
import { settleRunAfterResult } from './runtime/run-state.js';
import {
  appendAssistantTextToHistory,
  appendFunctionCallsToHistory,
  appendInterjectToHistory,
  loadInitialHistory,
  persistSingleInterjectToTranscript,
} from './loop-history.js';
import {
  dropPendingInterjectFront,
  hasPendingInterject,
  peekPendingInterject,
} from '../sessions/active-run-interject-buffer.js';
import {
  emitAndSettleTerminalFailure,
  formatBackgroundResultNote,
} from './loop-shared.js';
import { runModelRound } from './loop-model-round.js';
import { processFunctionCalls } from './loop-tool-execution.js';
import { isRootRunState } from '../runtime-contracts.js';
import { runReactBundleStructuredOutputCaller } from './react-bundle-structured-output-caller.js';
import {
  PTC_FIXED_PROBE_STRUCTURED_OUTPUT_KIND,
  runPtcFixedProbeStructuredOutputCaller,
} from './ptc-fixed-probe-structured-output-caller.js';
import { isMidRunSteerEnabled } from './mid-run-steer-flag.js';

type AgentLoopRoundOutcome =
  | { kind: 'continue' }
  | { kind: 'terminal'; result: AgentResult };

export async function runAgentLoop(input: AgentInput): Promise<AgentResult> {
  const {
    runId,
    runContext,
    prompt,
    currentFile,
    selection,
    signal,
    onEvent,
    runState,
    allowedToolNames,
    runtimeServices,
    approvalContext,
    callModelImpl,
    observer,
  } = input;
  const { threadId, projectId, workspaceRoot } = runContext;

  const emit: AgentEventEmitter = (type, payload) => {
    onEvent(createAgentEvent(type, payload));
  };

  // 1. run_ack
  emit('run_ack', { runId: assertValidRunId(runId), threadId });

  const systemPrompt = buildSystemPrompt();
  const promptContext = buildPromptContext({
    projectId,
    threadId,
    currentFile,
    selection,
  });
  const registry = runtimeServices.toolRegistry;
  const gate = runtimeServices.approvalGate;
  const notifications = runtimeServices.backgroundNotifications;
  const resolvedMemoryIndex = runtimeServices.memoryIndex;
  const providerAuthRuntime = runtimeServices.providerAuthRuntime;
  const providerRequestOptions = runtimeServices.providerRequestOptions;
  const webSocketSessions = runtimeServices.providerWebSocketSessions;
  const toolDefs = registry.buildToolDefinitions(
    allowedToolNames !== undefined ? { names: allowedToolNames } : {},
  );
  const history = await loadInitialHistory(workspaceRoot, threadId, prompt);
  const pendingBackgroundResults =
    runState === undefined || isRootRunState(runState)
      ? notifications.consumeThreadBackgroundResults(threadId)
      : [];
  const pendingBackgroundSystemNote = formatBackgroundResultNote(
    pendingBackgroundResults,
  );
  const midRunSteerEnabled = isMidRunSteerEnabled();
  recordAgentLoopObserverSnapshot(
    observer,
    buildAgentLoopObserverSnapshot({
      runId,
      runContext,
      approvalContext,
      ...(allowedToolNames !== undefined ? { allowedToolNames } : {}),
      toolDefs,
      providerRequestOptions,
      callModelImplProvided: callModelImpl !== undefined,
      currentFileProvided: currentFile !== undefined,
      selectionProvided: selection !== undefined,
      signalProvided: signal !== undefined,
      runStateKind:
        runState === undefined
          ? 'none'
          : isRootRunState(runState)
            ? 'root'
            : 'child',
      initialHistoryItemCount: history.length,
      pendingBackgroundResultCount: pendingBackgroundResults.length,
      midRunSteerEnabled,
    }),
  );

  const runRound = async (
    round: number,
    sawFirstModelRequest: boolean,
  ): Promise<AgentLoopRoundOutcome> => {
    if (signal?.aborted) {
      const abortedResult = emitAndSettleTerminalFailure(
        emit,
        'aborted',
        'run cancelled',
        runState,
        signal,
        'signal',
      );
      return { kind: 'terminal', result: abortedResult };
    }

    if (midRunSteerEnabled && sawFirstModelRequest && runState !== undefined) {
      await applyNextPendingInterject({
        history,
        workspaceRoot,
        threadId,
        runState,
        emit,
      });
    }

    const modelRoundArgs: Parameters<typeof runModelRound>[0] = {
      history,
      systemPrompt,
      promptContext,
      pendingBackgroundSystemNote,
      round,
      toolDefs,
      threadId,
      providerWebSocketSessions: webSocketSessions,
      providerAuthRuntime,
      providerRequestOptions,
      emit,
    };
    if (signal !== undefined) {
      modelRoundArgs.signal = signal;
    }
    if (callModelImpl !== undefined) {
      modelRoundArgs.callModelImpl = callModelImpl;
    }
    const modelRound = await runModelRound(modelRoundArgs);
    if (!modelRound.ok) {
      settleRunAfterResult(runState, modelRound.result, signal);
      return { kind: 'terminal', result: modelRound.result };
    }
    const {
      assistantText,
      terminalResult,
      functionCalls,
      structuredOutputs = [],
    } = modelRound.value;

    if (structuredOutputs.length > 0) {
      const firstStructuredOutput = structuredOutputs[0];
      const structuredResult =
        firstStructuredOutput?.kind === PTC_FIXED_PROBE_STRUCTURED_OUTPUT_KIND
          ? await runPtcFixedProbeStructuredOutputCaller({
              runContext,
              runtime: runtimeServices.ptcFixedProbe,
              structuredOutputs,
              functionCalls,
              ...(signal !== undefined ? { signal } : {}),
            })
          : await runReactBundleStructuredOutputCaller({
              workspaceRoot,
              store: runtimeServices.sandboxAttempts,
              structuredOutputs,
              functionCalls,
              ingressPolicy:
                runtimeServices.reactBundleStructuredOutputIngressPolicy,
              ...(signal !== undefined ? { signal } : {}),
            });

      if (!structuredResult.ok) {
        const result = emitAndSettleTerminalFailure(
          emit,
          'execution_failed',
          structuredResult.message,
          runState,
          signal,
        );
        return { kind: 'terminal', result };
      }

      if (
        midRunSteerEnabled &&
        runState !== undefined &&
        hasPendingInterject(runState.interject)
      ) {
        appendAssistantTextToHistory(
          history,
          describeAgentResultForTextSurface(structuredResult.result),
          [],
        );
        return { kind: 'continue' };
      }

      settleRunAfterResult(runState, structuredResult.result, signal);
      return { kind: 'terminal', result: structuredResult.result };
    }

    appendAssistantTextToHistory(history, assistantText, functionCalls);

    // No tool calls → natural termination
    if (functionCalls.length === 0) {
      if (
        midRunSteerEnabled &&
        runState !== undefined &&
        hasPendingInterject(runState.interject)
      ) {
        return { kind: 'continue' };
      }

      const result: AgentResult = terminalResult;
      settleRunAfterResult(runState, result);
      return { kind: 'terminal', result };
    }

    appendFunctionCallsToHistory(history, functionCalls);

    const executionContextBase = buildAgentToolExecutionContextBase({
      runContext,
      runId,
      approvalContext,
      emit,
      currentFile,
      selection,
      signal,
      runState,
      ...(allowedToolNames !== undefined ? { allowedToolNames } : {}),
      fileStateCache: runtimeServices.fileStateCache,
      memoryIndex: resolvedMemoryIndex,
      agentSpawnRuntime: runtimeServices,
    });

    const toolRuntime = buildToolCallExecutionRuntime({
      approvalContext,
      emit,
      toolRegistry: registry,
      approvalGate: gate,
      approvalGrants: runtimeServices.approvalGrants,
      executionContextBase,
    });

    const toolProcessing = await processFunctionCalls({
      functionCalls,
      round,
      history,
      runtime: toolRuntime,
    });
    if (!toolProcessing.ok) {
      settleRunAfterResult(runState, toolProcessing.result, signal);
      return { kind: 'terminal', result: toolProcessing.result };
    }
    return { kind: 'continue' };
  };

  let round = 0;
  let sawFirstModelRequest = false;
  while (true) {
    recordAgentLoopObserverEvent(
      observer,
      buildAgentLoopObserverRoundStartedEvent({
        runId,
        threadId,
        round,
        historyItemCount: history.length,
        sawFirstModelRequest,
      }),
    );
    const outcome = await runRound(round, sawFirstModelRequest);
    recordAgentLoopObserverEvent(
      observer,
      buildAgentLoopObserverRoundCompletedEvent({
        runId,
        threadId,
        round,
        outcome: outcome.kind,
        ...(outcome.kind === 'terminal'
          ? { terminalOk: outcome.result.ok }
          : {}),
      }),
    );
    if (outcome.kind === 'terminal') {
      return outcome.result;
    }
    sawFirstModelRequest = true;
    round += 1;
  }
}

async function applyNextPendingInterject(args: {
  history: HistoryItem[];
  workspaceRoot: string;
  threadId: string;
  runState: NonNullable<AgentInput['runState']>;
  emit: AgentEventEmitter;
}): Promise<void> {
  const interject = peekPendingInterject(args.runState.interject);
  if (interject === undefined) {
    return;
  }

  await persistSingleInterjectToTranscript(
    args.workspaceRoot,
    args.threadId,
    interject,
  );
  dropPendingInterjectFront(args.runState.interject);
  appendInterjectToHistory(args.history, interject);
  args.emit('interject_applied', {
    runId: args.runState.runId,
    count: 1,
    receivedSeqs: [interject.receivedSeq],
  });
}
