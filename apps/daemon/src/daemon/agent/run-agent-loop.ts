/**
 * Agent loop — provider-backed with tool execution + approval.
 * Emits internal AgentEvents; adapter/web converts to RunEventEnvelope.
 */

import { runAgentLoopKernel } from '@geulbat/agent-loop/kernel';
import {
  isProviderReplayScopeId,
  isRootRunState,
  type ProviderReplayScopeId,
} from '../runtime-contracts.js';

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
  closeInterjectBuffer,
  hasPendingInterject,
  peekPendingInterject,
  removePendingInterjectBySeq,
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
import {
  projectProviderRunSelection,
  resolveProviderRequestOptionsForRun,
} from '../llm/provider/provider-options.js';
import { resolveGrokOAuthModelDescriptor } from '../llm/provider/grok-oauth-transport.js';
import {
  normalizeProviderErrorCode,
  sanitizeProviderErrorMessage,
} from '../llm/provider/provider-error.js';
import { resolveProviderReplayScopeForRun } from '../llm/provider/provider-replay-scope.js';
import { resolveCodexResponsesUrl } from '../llm/provider/transport/responses-websocket-url.js';
import { coerceGenericApiErrorCode } from '../error-codes.js';
import { createAgentLoopMemoryPort } from './memory/compaction-loop.js';
import type { RunCheckpointStore } from '../sessions/run-checkpoint-store.js';
import { readTranscriptEntries } from '../sessions/transcript-log.js';
import { appendProviderRound } from '../sessions/provider-round-journal.js';
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
    workingDirectory: runContext.workingDirectory,
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
  let providerReplayScopeId: ProviderReplayScopeId | undefined;
  if (callModelImpl === undefined && injectedModelRoundPort === undefined) {
    try {
      providerReplayScopeId = await resolveProviderReplayScopeForRun({
        providerId: providerRequestOptions.providerId,
        endpoint:
          providerRequestOptions.providerId === 'grok_oauth'
            ? resolveGrokOAuthModelDescriptor(providerRequestOptions.model)
                .baseUrl
            : resolveCodexResponsesUrl(),
        providerAuthRuntime,
      });
    } catch (error: unknown) {
      const code = normalizeProviderErrorCode(error);
      const result = lifecyclePort.createTerminalFailure({
        emit,
        code: coerceGenericApiErrorCode(code, 'llm_auth_failed'),
        message: sanitizeProviderErrorMessage(code),
      });
      lifecyclePort.settleAfterResult({ runState, result, signal });
      return result;
    }
  }
  let history: HistoryItem[];
  try {
    history = await historyPort.loadInitialHistory({
      workspaceRoot: stateRoot,
      threadId,
      prompt,
      providerTarget: {
        providerId: providerRequestOptions.providerId,
        model: providerRequestOptions.model,
        ...(providerReplayScopeId === undefined
          ? {}
          : { replayScopeId: providerReplayScopeId }),
      },
    });
  } catch (error: unknown) {
    const code = normalizeProviderErrorCode(error);
    if (code !== 'llm_auth_failed') {
      throw error;
    }
    const result = lifecyclePort.createTerminalFailure({
      emit,
      code,
      message: sanitizeProviderErrorMessage(code),
    });
    lifecyclePort.settleAfterResult({ runState, result, signal });
    return result;
  }
  const processRoundFunctionCalls = async (args: {
    round: number;
    functionCalls: readonly FunctionCall[];
  }) =>
    await toolRuntimePort.processFunctionCalls({
      functionCalls: [...args.functionCalls],
      round: args.round,
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
      providerRunSelection: projectProviderRunSelection(providerRequestOptions),
      ...(subagentModelRouting === undefined ? {} : { subagentModelRouting }),
    });
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
      midRunSteerEnabled: true,
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
      async beforeModelRound() {
        if (runState !== undefined) {
          await applyNextPendingInterject({
            history,
            workspaceRoot: stateRoot,
            threadId,
            runState,
            runCheckpoints: runtimeServices.runCheckpoints,
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
          ...(providerReplayScopeId === undefined
            ? {}
            : { providerReplayScopeId }),
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
        if (modelRound.ok) {
          const providerItems = modelRound.value.itemsToAppend;
          let roundReplayScopeId = providerReplayScopeId;
          if (
            providerItems !== undefined &&
            providerItems.length > 0 &&
            providerItems.every((item) => item.kind === 'backend_item')
          ) {
            const itemScopes = providerItems.map(
              (item) => item.providerReplayScopeId,
            );
            const firstScope = itemScopes[0];
            if (
              !isProviderReplayScopeId(firstScope) ||
              itemScopes.some((scope) => scope !== firstScope) ||
              (providerReplayScopeId !== undefined &&
                firstScope !== providerReplayScopeId)
            ) {
              return {
                ok: false,
                result: lifecyclePort.createTerminalFailure({
                  emit,
                  code: 'llm_auth_failed',
                  message: sanitizeProviderErrorMessage('llm_auth_failed'),
                }),
              };
            }
            roundReplayScopeId = firstScope;
          }
          const compaction = await memoryPort.compactAfterModelRound({
            workspaceRoot: stateRoot,
            threadId,
            history,
            systemPrompt,
            tools: toolDefs,
            providerAuthRuntime,
            providerRequestOptions,
            ...(roundReplayScopeId === undefined
              ? {}
              : { providerReplayScopeId: roundReplayScopeId }),
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
          if (
            providerItems !== undefined &&
            providerItems.length > 0 &&
            providerItems.every((item) => item.kind === 'backend_item') &&
            roundReplayScopeId !== undefined
          ) {
            const transcriptEntries = await readTranscriptEntries(
              stateRoot,
              threadId,
            );
            await appendProviderRound({
              stateRoot,
              threadId,
              runId: assertValidRunId(runId),
              round,
              providerId: providerRequestOptions.providerId,
              model: providerRequestOptions.model,
              replayScopeId: roundReplayScopeId,
              precedingTranscriptEntryId:
                transcriptEntries.at(-1)?.entryId ?? null,
              items: providerItems.map((item) => item.data),
              functionCalls: modelRound.value.functionCalls.map((call) => ({
                ...call,
                replaySafe:
                  registry.getToolMeta(call.name)?.recoveryStrategy ===
                  'replay_safe',
              })),
            });
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
        return await processRoundFunctionCalls({
          round: context.round,
          functionCalls,
        });
      },
      resolveTerminalCandidate({ source, result }) {
        if (runState !== undefined && hasPendingInterject(runState.interject)) {
          return source === 'structured_output'
            ? {
                kind: 'continue',
                historyText: describeAgentResultForTextSurface(result),
              }
            : { kind: 'continue' };
        }
        if (runState !== undefined) {
          closeInterjectBuffer(runState.interject);
        }
        return { kind: 'terminal' };
      },
      createTerminalFailure(failure) {
        if (runState !== undefined) {
          closeInterjectBuffer(runState.interject);
        }
        return lifecyclePort.createTerminalFailure({
          emit,
          code: failure.kind === 'aborted' ? 'aborted' : 'execution_failed',
          message: failure.message,
        });
      },
      settleTerminal({ result, source }) {
        if (runState !== undefined) {
          closeInterjectBuffer(runState.interject);
        }
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
  runCheckpoints: RunCheckpointStore;
  emit: AgentEventEmitter;
}): Promise<void> {
  const interject = peekPendingInterject(args.runState.interject);
  if (interject === undefined) {
    return;
  }

  const enqueued = await args.runCheckpoints.enqueueInterject({
    threadId: args.runState.threadId,
    runId: args.runState.runId,
    interject,
  });
  if (!enqueued.ok) {
    if (enqueued.code === 'not_pending') {
      removePendingInterjectBySeq(
        args.runState.interject,
        interject.receivedSeq,
      );
      return;
    }
    throw new Error(`interject checkpoint enqueue failed: ${enqueued.code}`);
  }
  const claimed = await args.runCheckpoints.claimInterject({
    threadId: args.runState.threadId,
    runId: args.runState.runId,
    receivedSeq: interject.receivedSeq,
  });
  if (!claimed.ok) {
    if (claimed.code === 'not_pending') {
      removePendingInterjectBySeq(
        args.runState.interject,
        interject.receivedSeq,
      );
      return;
    }
    throw new Error(`interject checkpoint claim failed: ${claimed.code}`);
  }
  const persisted = await persistSingleInterjectToTranscript(
    args.workspaceRoot,
    args.threadId,
    args.runState.runId,
    interject,
  );
  const completed = await args.runCheckpoints.completeInterject({
    threadId: args.runState.threadId,
    runId: args.runState.runId,
    receivedSeq: interject.receivedSeq,
  });
  if (!completed.ok) {
    throw new Error(
      `interject checkpoint completion failed: ${completed.code}`,
    );
  }
  if (
    !removePendingInterjectBySeq(args.runState.interject, interject.receivedSeq)
  ) {
    throw new Error(
      `applied interject missing from live buffer: ${interject.receivedSeq}`,
    );
  }
  // 즉시 반영 요청은 소비 1회로 목적을 다한다 — 남은 큐는 평소 케이던스로
  clearInterjectFlushRequest(args.runState.interject);
  if (persisted.appended) {
    appendInterjectToHistory(args.history, interject);
  }
  args.emit('interject_applied', {
    runId: args.runState.runId,
    count: 1,
    receivedSeqs: [interject.receivedSeq],
  });
}
