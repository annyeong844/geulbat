/**
 * Agent loop — provider-backed with tool execution + approval.
 * Emits internal AgentEvents; adapter/web converts to RunEventEnvelope.
 */

import { buildSystemPrompt } from './prompt/build-system-prompt.js';
import { buildPromptContext } from './prompt/build-prompt-context.js';
import { createAgentEvent, type AgentEventEmitter } from './events.js';
import type { AgentResult } from './agent-result.js';
import type { AgentInput } from './loop-types.js';
import {
  buildAgentToolExecutionContextBase,
  buildToolCallExecutionRuntime,
} from './loop-tool-runtime.js';
import { assertRunId as assertValidRunId } from '@geulbat/protocol/ids';
import { settleRunAfterResult } from './runtime/run-state.js';
import {
  appendAssistantTextToHistory,
  appendFunctionCallsToHistory,
  loadInitialHistory,
} from './loop-history.js';
import {
  MAX_TOOL_ROUNDS,
  emitAndSettleTerminalFailure,
  formatBackgroundResultNote,
} from './loop-shared.js';
import { finalizeAfterToolLimit, runModelRound } from './loop-model-round.js';
import { processFunctionCalls } from './loop-tool-execution.js';
import { isRootRunState } from '../runtime-contracts.js';
import { runReactBundleStructuredOutputCaller } from './react-bundle-structured-output-caller.js';
import {
  PTC_FIXED_PROBE_STRUCTURED_OUTPUT_KIND,
  runPtcFixedProbeStructuredOutputCaller,
} from './ptc-fixed-probe-structured-output-caller.js';

const STRUCTURED_REACT_BUNDLE_INGRESS_TIMEOUT_MS = 30_000;

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

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (signal?.aborted) {
      const abortedResult = emitAndSettleTerminalFailure(
        emit,
        'aborted',
        'run cancelled',
        runState,
        signal,
        'signal',
      );
      return abortedResult;
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
      return modelRound.result;
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
              timeoutMs: STRUCTURED_REACT_BUNDLE_INGRESS_TIMEOUT_MS,
              ...(signal !== undefined ? { signal } : {}),
            });

      if (!structuredResult.ok) {
        return emitAndSettleTerminalFailure(
          emit,
          'execution_failed',
          structuredResult.message,
          runState,
          signal,
        );
      }

      settleRunAfterResult(runState, structuredResult.result, signal);
      return structuredResult.result;
    }

    appendAssistantTextToHistory(history, assistantText, functionCalls);

    // No tool calls → natural termination
    if (functionCalls.length === 0) {
      const result: AgentResult = terminalResult;
      settleRunAfterResult(runState, result);
      return result;
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
      return toolProcessing.result;
    }
  }

  const finalRoundArgs: Parameters<typeof finalizeAfterToolLimit>[0] = {
    history,
    systemPrompt,
    threadId,
    providerWebSocketSessions: webSocketSessions,
    providerAuthRuntime,
    providerRequestOptions,
    emit,
  };
  if (signal !== undefined) {
    finalRoundArgs.signal = signal;
  }
  if (callModelImpl !== undefined) {
    finalRoundArgs.callModelImpl = callModelImpl;
  }
  const finalResult = await finalizeAfterToolLimit(finalRoundArgs);
  settleRunAfterResult(runState, finalResult, signal);
  return finalResult;
}
