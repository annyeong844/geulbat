/**
 * Agent loop — provider-backed with tool execution + approval.
 * Emits internal AgentEvents; adapter/web converts to RunEventEnvelope.
 */

import { runAgentLoopKernel } from '@geulbat/agent-loop/kernel';

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
import { assertAgentRunId as assertValidRunId } from './contract.js';
import { accumulateRunUsageTotals } from './runtime/run-usage-totals.js';
import {
  appendAssistantTextToHistory,
  appendFunctionCallsToHistory,
  appendInterjectToHistory,
  createAgentLoopHistoryPort,
  persistSingleInterjectToTranscript,
} from './loop-history.js';
import {
  clearInterjectFlushRequest,
  dropPendingInterjectFront,
  hasPendingInterject,
  peekPendingInterject,
} from '../sessions/active-run-interject-buffer.js';
import { createAgentLoopLifecyclePort } from './loop-lifecycle-port.js';
import {
  createModelRoundPort,
  type RunModelRoundArgs,
} from './loop-model-round.js';
import { createAgentLoopPromptPort } from './loop-prompt.js';
import { createAgentLoopStructuredOutputPort } from './loop-structured-output-port.js';
import { createAgentLoopToolDefinitionPort } from './loop-tool-definitions.js';
import {
  createAgentLoopToolLibraryProjectionPort,
  formatToolLibraryProjectionFailureMessage,
} from './loop-tool-library-projection.js';
import { createAgentLoopToolRuntimePort } from './loop-tool-runtime-port.js';
import { isRootRunState } from '../runtime-contracts.js';
import {
  projectProviderRunSelection,
  resolveProviderRequestOptionsForRun,
} from '../llm/provider/provider-options.js';
import { isMidRunSteerEnabled } from './mid-run-steer-flag.js';
import { createAgentLoopMemoryPort } from './memory/compaction-loop.js';
import type {
  FunctionCall,
  ProviderStructuredOutput,
} from '../llm/provider/wire/types.js';

export async function runAgentLoop(input: AgentInput): Promise<AgentResult> {
  const {
    runId,
    runContext,
    prompt,
    currentFile,
    selection,
    embeddedBackgroundResultCount = 0,
    providerModel,
    reasoningEffort,
    subagentModelRouting,
    signal,
    onEvent,
    runState,
    toolSurface,
    promptProfile = 'root',
    runtimeServices,
    approvalContext,
    callModelImpl,
    promptPort: injectedPromptPort,
    historyPort: injectedHistoryPort,
    lifecyclePort: injectedLifecyclePort,
    memoryPort: injectedMemoryPort,
    modelRoundPort: injectedModelRoundPort,
    structuredOutputPort: injectedStructuredOutputPort,
    toolDefinitionPort: injectedToolDefinitionPort,
    toolRuntimePort: injectedToolRuntimePort,
    toolLibraryProjectionPort: injectedToolLibraryProjectionPort,
    observer,
  } = input;
  const { threadId, stateRoot } = runContext;

  const emit: AgentEventEmitter = (type, payload) => {
    onEvent(createAgentEvent(type, payload));
  };
  const lifecyclePort = injectedLifecyclePort ?? createAgentLoopLifecyclePort();

  // 1. run_ack
  emit('run_ack', { runId: assertValidRunId(runId), threadId });

  if (toolSurface !== undefined) {
    const allowedRegistryNames = new Set(toolSurface.allowedRegistryNames);
    const invalidDirectRegistryName = toolSurface.directRegistryNames.find(
      (name) => !allowedRegistryNames.has(name),
    );
    if (invalidDirectRegistryName !== undefined) {
      const result = lifecyclePort.createTerminalFailure({
        emit,
        code: 'execution_failed',
        message: `direct tool is outside the allowed registry surface: ${invalidDirectRegistryName}`,
      });
      lifecyclePort.settleAfterResult({ runState, result, signal });
      return result;
    }
  }

  const promptPort = injectedPromptPort ?? createAgentLoopPromptPort();
  const { systemPrompt } = promptPort.buildPromptBundle({
    threadId,
    promptProfile,
    computerSessionAvailable: runtimeServices.computerFileRoot !== undefined,
    ...(currentFile === undefined ? {} : { currentFile }),
    ...(selection === undefined ? {} : { selection }),
  });
  const registry = runtimeServices.toolRegistry;
  const providerAuthRuntime = runtimeServices.providerAuthRuntime;
  // The web adapter projects public model identity to the provider-owned
  // selection before it reaches the agent/LLM boundary.
  const providerRequestOptions = resolveProviderRequestOptionsForRun(
    runtimeServices.providerRequestOptions,
    {
      ...(providerModel !== undefined ? { providerModel } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    },
  );
  const webSocketSessions = runtimeServices.providerWebSocketSessions;
  const historyPort = injectedHistoryPort ?? createAgentLoopHistoryPort();
  const memoryPort = injectedMemoryPort ?? createAgentLoopMemoryPort();
  const modelRoundPort = injectedModelRoundPort ?? createModelRoundPort();
  const structuredOutputPort =
    injectedStructuredOutputPort ??
    createAgentLoopStructuredOutputPort(runtimeServices);
  const toolDefinitionPort =
    injectedToolDefinitionPort ?? createAgentLoopToolDefinitionPort(registry);
  const toolRuntimePort =
    injectedToolRuntimePort ?? createAgentLoopToolRuntimePort(runtimeServices);
  const toolLibraryProjectionPort =
    injectedToolLibraryProjectionPort ??
    createAgentLoopToolLibraryProjectionPort(
      runtimeServices.toolLibraryProjection,
    );
  const toolDefs = [
    ...toolDefinitionPort.buildToolDefinitions({
      ...(toolSurface === undefined
        ? {}
        : { directRegistryNames: toolSurface.directRegistryNames }),
    }),
  ];
  // 인자 스트리밍 opt-in 도구(ToolMeta.streamsArgsDelta) — 모델 라운드가
  // 이 목록에 한해 tool_call_delta를 방출한다 (visualize 실시간 렌더)
  const streamArgsToolNames: ReadonlySet<string> = new Set(
    toolDefs
      .filter(
        (definition) =>
          registry.getToolMeta(definition.name)?.streamsArgsDelta === true,
      )
      .map((definition) => definition.name),
  );
  const toolLibraryProjection =
    await toolLibraryProjectionPort.resolveProjection({
      stateRoot,
      threadId,
      ...(toolSurface === undefined
        ? {}
        : { allowedRegistryNames: toolSurface.allowedRegistryNames }),
    });
  if (!toolLibraryProjection.ok) {
    const result = lifecyclePort.createTerminalFailure({
      emit,
      code: 'execution_failed',
      message: formatToolLibraryProjectionFailureMessage(toolLibraryProjection),
    });
    lifecyclePort.settleAfterResult({ runState, result, signal });
    return result;
  }
  const history = await historyPort.loadInitialHistory({
    workspaceRoot: stateRoot,
    threadId,
    prompt,
  });
  const midRunSteerEnabled = isMidRunSteerEnabled();
  recordAgentLoopObserverSnapshot(
    observer,
    buildAgentLoopObserverSnapshot({
      runId,
      runContext,
      approvalContext,
      ...(toolSurface !== undefined ? { toolSurface } : {}),
      toolLibraryProjection: toolLibraryProjection.identity,
      toolDefs,
      providerRequestOptions,
      callModelImplProvided: callModelImpl !== undefined,
      currentFileProvided: currentFile !== undefined,
      selectionProvided: selection !== undefined,
      signalProvided: signal !== undefined,
      promptPortProvided: injectedPromptPort !== undefined,
      historyPortProvided: injectedHistoryPort !== undefined,
      lifecyclePortProvided: injectedLifecyclePort !== undefined,
      memoryPortProvided: injectedMemoryPort !== undefined,
      modelRoundPortProvided: injectedModelRoundPort !== undefined,
      structuredOutputPortProvided: injectedStructuredOutputPort !== undefined,
      toolDefinitionPortProvided: injectedToolDefinitionPort !== undefined,
      toolRuntimePortProvided: injectedToolRuntimePort !== undefined,
      toolLibraryProjectionPortProvided:
        injectedToolLibraryProjectionPort !== undefined,
      runStateKind:
        runState === undefined
          ? 'none'
          : isRootRunState(runState)
            ? 'root'
            : 'child',
      initialHistoryItemCount: history.length,
      pendingBackgroundResultCount: embeddedBackgroundResultCount,
      midRunSteerEnabled,
    }),
  );

  return runAgentLoopKernel<
    AgentResult,
    FunctionCall,
    ProviderStructuredOutput,
    HistoryItem
  >({
    ...(signal === undefined ? {} : { signal }),
    ports: {
      getHistoryItemCount() {
        return history.length;
      },
      async beforeModelRound({ sawFirstModelRequest }) {
        if (
          midRunSteerEnabled &&
          sawFirstModelRequest &&
          runState !== undefined
        ) {
          await applyNextPendingInterject({
            history,
            workspaceRoot: stateRoot,
            threadId,
            runState,
            emit,
          });
        }
      },
      async runModelRound({ round }) {
        const modelRoundArgs: RunModelRoundArgs = {
          history,
          systemPrompt,
          round,
          toolDefs,
          threadId,
          providerWebSocketSessions: webSocketSessions,
          providerAuthRuntime,
          providerRequestOptions,
          emit,
          streamArgsToolNames,
        };
        if (signal !== undefined) {
          modelRoundArgs.signal = signal;
        }
        if (callModelImpl !== undefined) {
          modelRoundArgs.callModelImpl = callModelImpl;
        }
        const modelRound = await modelRoundPort.runModelRound(modelRoundArgs);
        if (modelRound.ok && runState !== undefined) {
          accumulateRunUsageTotals(
            runState.usageTotals,
            modelRound.value.providerUsageTelemetry,
          );
          if (modelRound.value.providerUsageTelemetry !== undefined) {
            emit('usage_updated', { ...runState.usageTotals });
          }
        }
        if (modelRound.ok && midRunSteerEnabled) {
          const compaction = await memoryPort.compactAfterModelRound({
            workspaceRoot: stateRoot,
            threadId,
            history,
            systemPrompt,
            tools: toolDefs,
            providerAuthRuntime,
            providerRequestOptions,
            ...(modelRound.value.providerUsageTelemetry?.inputTokens !==
            undefined
              ? {
                  inputTokens:
                    modelRound.value.providerUsageTelemetry.inputTokens,
                }
              : {}),
            onContextUsage(snapshot) {
              emit('context_usage_updated', snapshot);
            },
            ...(signal !== undefined ? { signal } : {}),
          });
          if (compaction.kind === 'failed') {
            return {
              ok: false,
              result: lifecyclePort.createTerminalFailure({
                emit,
                code: 'execution_failed',
                message: `context_compaction_failed: ${compaction.message}`,
              }),
            };
          }
        }
        return modelRound;
      },
      async processStructuredOutputs({ structuredOutputs, functionCalls }) {
        return structuredOutputPort.processStructuredOutputs({
          runContext,
          structuredOutputs: [...structuredOutputs],
          functionCalls: [...functionCalls],
          signal,
        });
      },
      appendAssistantText({ text, functionCalls }) {
        appendAssistantTextToHistory(history, text, [...functionCalls]);
      },
      appendHistoryItems(items) {
        history.push(...items);
      },
      appendFunctionCalls(functionCalls) {
        appendFunctionCallsToHistory(history, [...functionCalls]);
      },
      async processFunctionCalls({ context, functionCalls }) {
        return toolRuntimePort.processFunctionCalls({
          functionCalls: [...functionCalls],
          round: context.round,
          history,
          runContext,
          runId,
          approvalContext,
          emit,
          currentFile,
          selection,
          signal,
          runState,
          ...(toolSurface === undefined
            ? {}
            : { allowedRegistryNames: toolSurface.allowedRegistryNames }),
          toolLibraryProjectionIdentity: toolLibraryProjection.identity,
          providerRunSelection: projectProviderRunSelection(
            providerRequestOptions,
          ),
          ...(subagentModelRouting === undefined
            ? {}
            : { subagentModelRouting }),
        });
      },
      resolveTerminalCandidate({ source, result }) {
        if (
          midRunSteerEnabled &&
          runState !== undefined &&
          hasPendingInterject(runState.interject)
        ) {
          return source === 'structured_output'
            ? {
                kind: 'continue',
                historyText: describeAgentResultForTextSurface(result),
              }
            : { kind: 'continue' };
        }
        return { kind: 'terminal' };
      },
      createTerminalFailure(failure) {
        return lifecyclePort.createTerminalFailure({
          emit,
          code: failure.kind === 'aborted' ? 'aborted' : 'execution_failed',
          message: failure.message,
        });
      },
      settleTerminal({ result, source }) {
        lifecyclePort.settleAfterResult({
          runState,
          result,
          ...(source === 'natural' || signal === undefined ? {} : { signal }),
        });
      },
      observe(event) {
        if (event.kind === 'round_started') {
          recordAgentLoopObserverEvent(
            observer,
            buildAgentLoopObserverRoundStartedEvent({
              runId,
              threadId,
              round: event.round,
              historyItemCount: event.historyItemCount,
              sawFirstModelRequest: event.sawFirstModelRequest,
            }),
          );
          return;
        }
        recordAgentLoopObserverEvent(
          observer,
          buildAgentLoopObserverRoundCompletedEvent({
            runId,
            threadId,
            round: event.round,
            outcome: event.outcome,
            ...(event.terminalOk === undefined
              ? {}
              : { terminalOk: event.terminalOk }),
          }),
        );
      },
    },
  });
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
  // 즉시 반영 요청은 소비 1회로 목적을 다한다 — 남은 큐는 평소 케이던스로
  clearInterjectFlushRequest(args.runState.interject);
  appendInterjectToHistory(args.history, interject);
  args.emit('interject_applied', {
    runId: args.runState.runId,
    count: 1,
    receivedSeqs: [interject.receivedSeq],
  });
}
