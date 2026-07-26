/**
 * Agent loop — provider-backed with tool execution + approval.
 * Emits internal AgentEvents; adapter/web converts to RunEventEnvelope.
 */

import { agentLoopKernelImplementation } from '@geulbat/agent-loop/kernel';
import {
  validateToolCapabilityPolicy,
  type ToolCapabilityPolicy,
} from '@geulbat/tool-library/tool-capability-policy';
import {
  isProviderReplayScopeId,
  isRootRunState,
  type ProviderReplayScopeId,
} from '../runtime-contracts.js';

import { createAgentEvent, type AgentEventEmitter } from './events.js';
import type { AgentResult } from './agent-result.js';
import type { AgentInput } from './loop-types.js';
import { loadGeulbatInstructions } from './prompt/load-geulbat-md.js';
import {
  listPendingMemoryNotes,
  memoryConsolidationIsDue,
} from '../memories/notes-store.js';
import { readMemoryEntries } from '../memories/entries-store.js';
import { startMemoryConsolidationDetached } from './memory-consolidation.js';
import type { HistoryItem } from '../llm/index.js';
import {
  buildAgentLoopObserverEvent,
  buildAgentLoopObserverSnapshot,
  recordAgentLoopObserverEvent,
  recordAgentLoopObserverSnapshot,
  recordAgentLoopObserverToolResult,
} from './observer/agent-loop-observer.js';
import {
  assertAgentRunId as assertValidRunId,
  resolveAgentRunModelDescriptor,
} from './contract.js';
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
import {
  normalizeProviderErrorCode,
  sanitizeProviderErrorMessage,
} from '../llm/provider/provider-error.js';
import { resolveProviderReplayScopeForRun } from '../llm/provider/provider-replay-scope.js';
import { coerceGenericApiErrorCode } from '../error-codes.js';
import { createAgentLoopMemoryPort } from './memory/compaction-loop.js';
import type { RunCheckpointStore } from '../sessions/run-checkpoint-store.js';
import { readLastTranscriptEntryId } from '../sessions/transcript-log.js';
import { appendProviderRound } from '../sessions/provider-round-journal.js';
import type {
  FunctionCall,
  ProviderStructuredOutput,
} from '../llm/provider/wire/types.js';
import { createAgentRunCompletionPolicy } from './run-completion-policy.js';

export async function runAgentLoop(input: AgentInput): Promise<AgentResult> {
  const {
    runId,
    runContext,
    prompt,
    currentFile,
    selection,
    embeddedBackgroundResultCount = 0,
    providerModel,
    providerTransitionRecovery,
    ultraReasoning = false,
    reasoningEffort,
    serviceTier,
    subagentModelRouting,
    planningWorkflow,
    approvedPlan,
    goal,
    signal,
    onEvent,
    runState,
    toolSurface,
    toolCapabilityPolicy: requestedToolCapabilityPolicy,
    promptProfile = 'root',
    loopImplementation = agentLoopKernelImplementation,
    runtimeServices,
    approvalContext,
    callModelImpl,
    promptPort: injectedPromptPort,
    historyPort: injectedHistoryPort,
    lifecyclePort: injectedLifecyclePort,
    memoryPort: injectedMemoryPort,
    modelRoundPort: injectedModelRoundPort,
    goalCompletionVerifier: injectedGoalCompletionVerifier,
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

  const rejectToolAdmission = (message: string): AgentResult => {
    const result = lifecyclePort.createTerminalFailure({
      emit,
      code: 'execution_failed',
      message,
    });
    lifecyclePort.settleAfterResult({ runState, result, signal });
    return result;
  };
  if (
    toolSurface !== undefined &&
    requestedToolCapabilityPolicy !== undefined
  ) {
    return rejectToolAdmission(
      'toolSurface and toolCapabilityPolicy cannot be supplied together',
    );
  }
  let toolCapabilityPolicy: ToolCapabilityPolicy | undefined;
  if (requestedToolCapabilityPolicy !== undefined) {
    try {
      toolCapabilityPolicy = validateToolCapabilityPolicy(
        requestedToolCapabilityPolicy,
      );
    } catch (error: unknown) {
      return rejectToolAdmission(
        `invalid tool capability policy: ${error instanceof Error ? error.message : 'validation failed'}`,
      );
    }
  }
  const effectiveToolSurface =
    toolCapabilityPolicy === undefined
      ? toolSurface
      : {
          directRegistryNames: toolCapabilityPolicy.directRegistryNames,
          allowedRegistryNames: toolCapabilityPolicy.allowedRegistryNames,
        };

  if (effectiveToolSurface !== undefined) {
    const allowedRegistryNames = new Set(
      effectiveToolSurface.allowedRegistryNames,
    );
    const invalidDirectRegistryName =
      effectiveToolSurface.directRegistryNames.find(
        (name) => !allowedRegistryNames.has(name),
      );
    if (invalidDirectRegistryName !== undefined) {
      return rejectToolAdmission(
        `direct tool is outside the allowed registry surface: ${invalidDirectRegistryName}`,
      );
    }
  }

  const registry = runtimeServices.toolRegistry.captureSnapshot();
  const runRuntimeServices = Object.freeze({
    ...runtimeServices,
    toolRegistry: registry,
  });
  if (toolCapabilityPolicy !== undefined) {
    const unknownRegistryName = toolCapabilityPolicy.allowedRegistryNames.find(
      (name) => registry.getTool(name) === undefined,
    );
    if (unknownRegistryName !== undefined) {
      return rejectToolAdmission(
        `tool capability policy includes an unknown registry tool: ${unknownRegistryName}`,
      );
    }
  }

  const promptPort = injectedPromptPort ?? createAgentLoopPromptPort();
  // 작업 폴더의 geulbat.md — 없으면 undefined이고 프롬프트는 예전과 같다.
  const { instructions: projectInstructions } = await loadGeulbatInstructions(
    runContext.workingDirectory,
  );
  // 메모리는 root 런에만 싣는다. 서브에이전트는 부모가 준 과제로 일하고,
  // 사용자 장기 기억을 자식마다 복제하면 비용과 노출이 함께 늘어난다.
  const [memoryEntries, pendingMemoryNotes] =
    promptProfile === 'root'
      ? await Promise.all([
          readMemoryEntries(runContext.stateRoot),
          listPendingMemoryNotes(runContext.stateRoot),
        ])
      : [[], []];
  const memoryNotes = pendingMemoryNotes.map((note) => note.text);
  const { systemPrompt } = promptPort.buildPromptBundle({
    threadId,
    promptProfile,
    computerSessionAvailable: runtimeServices.computerFileRoot !== undefined,
    workingDirectory: runContext.workingDirectory,
    ...(effectiveToolSurface === undefined
      ? {}
      : { directRegistryNames: effectiveToolSurface.directRegistryNames }),
    ...(currentFile === undefined ? {} : { currentFile }),
    ...(selection === undefined ? {} : { selection }),
    ...(projectInstructions === undefined ? {} : { projectInstructions }),
    ...(planningWorkflow === undefined ? {} : { planMode: planningWorkflow }),
    ...(approvedPlan === undefined ? {} : { approvedPlan }),
    ...(goal === undefined ? {} : { goal }),
    ...(memoryNotes.length === 0 ? {} : { memoryNotes }),
    ...(memoryEntries.length === 0
      ? {}
      : {
          memoryEntries: memoryEntries.map((entry) => ({
            id: entry.id,
            text: entry.text,
          })),
        }),
  });
  const providerAuthRuntime = runtimeServices.provider.authRuntime;
  // The web adapter projects public model identity to the provider-owned
  // selection before it reaches the agent/LLM boundary.
  const providerRequestOptions = resolveProviderRequestOptionsForRun(
    runtimeServices.provider.requestOptions,
    {
      ...(providerModel !== undefined ? { providerModel } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(serviceTier !== undefined ? { serviceTier } : {}),
    },
  );
  const webSocketSessions = runtimeServices.provider.webSocketSessions;
  if (memoryConsolidationIsDue(pendingMemoryNotes.length)) {
    startMemoryConsolidationDetached({
      stateRoot: runContext.stateRoot,
      access: {
        providerAuthRuntime,
        providerWebSocketSessions: webSocketSessions,
        providerRequestOptions,
      },
    });
  }
  const historyPort = injectedHistoryPort ?? createAgentLoopHistoryPort();
  const memoryPort =
    injectedMemoryPort ??
    runtimeServices.agent.loopMemory ??
    createAgentLoopMemoryPort();
  let completedContextBudgetRound:
    | ReturnType<typeof memoryPort.beginContextBudgetRound>
    | undefined;
  const recoverProviderTransitionAfterOverflow =
    memoryPort.recoverProviderTransitionAfterOverflow;
  const providerTransitionSource =
    providerTransitionRecovery === undefined
      ? undefined
      : resolveAgentRunModelDescriptor(
          providerTransitionRecovery.sourceModelId,
        );
  let providerTransitionRecoveryAvailable =
    providerTransitionSource !== undefined;
  const modelRoundPort = injectedModelRoundPort ?? createModelRoundPort();
  const structuredOutputPort =
    injectedStructuredOutputPort ??
    createAgentLoopStructuredOutputPort(runRuntimeServices);
  const toolDefinitionPort =
    injectedToolDefinitionPort ?? createAgentLoopToolDefinitionPort(registry);
  const toolRuntimePort =
    injectedToolRuntimePort ??
    createAgentLoopToolRuntimePort(runRuntimeServices);
  const toolLibraryProjectionPort =
    injectedToolLibraryProjectionPort ??
    createAgentLoopToolLibraryProjectionPort(
      runtimeServices.toolLibraryProjection,
    );
  const toolDefs = [
    ...toolDefinitionPort.buildToolDefinitions({
      ...(effectiveToolSurface === undefined
        ? {}
        : {
            directRegistryNames: effectiveToolSurface.directRegistryNames,
          }),
    }),
  ].filter(
    (definition) => goal !== undefined || definition.name !== 'update_goal',
  );
  if (
    goal !== undefined &&
    !toolDefs.some((definition) => definition.name === 'update_goal')
  ) {
    return rejectToolAdmission(
      'Goal mode requires the update_goal tool in the admitted tool surface',
    );
  }
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
  const turnEndingToolNames: ReadonlySet<string> = new Set(
    toolDefs
      .filter(
        (definition) =>
          registry.getToolMeta(definition.name)?.endsTurnAfterSuccess === true,
      )
      .map((definition) => definition.name),
  );
  const toolLibraryProjection =
    await toolLibraryProjectionPort.resolveProjection({
      stateRoot,
      threadId,
      ...(toolCapabilityPolicy === undefined
        ? effectiveToolSurface === undefined
          ? {}
          : {
              allowedRegistryNames: effectiveToolSurface.allowedRegistryNames,
            }
        : { toolCapabilityPolicy }),
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
  let endTurnAfterLastToolProcessing = false;
  let providerReplayScopeId: ProviderReplayScopeId | undefined;
  if (callModelImpl === undefined && injectedModelRoundPort === undefined) {
    try {
      providerReplayScopeId = await resolveProviderReplayScopeForRun({
        providerRequestOptions,
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
  const completionPolicy = createAgentRunCompletionPolicy({
    runId: assertValidRunId(runId),
    threadId,
    history,
    planningWorkflows: runtimeServices.planningWorkflows,
    goals: runtimeServices.goals,
    emit,
    providerAuthRuntime,
    providerWebSocketSessions: webSocketSessions,
    providerRequestOptions,
    ...(runState === undefined ? {} : { runState }),
    ...(planningWorkflow === undefined ? {} : { planningWorkflow }),
    ...(approvedPlan === undefined ? {} : { approvedPlan }),
    ...(goal === undefined ? {} : { goal }),
    ...(providerReplayScopeId === undefined ? {} : { providerReplayScopeId }),
    ...(callModelImpl === undefined ? {} : { callModelImpl }),
    ...(injectedGoalCompletionVerifier === undefined
      ? {}
      : { goalCompletionVerifier: injectedGoalCompletionVerifier }),
    ...(signal === undefined ? {} : { signal }),
  });
  const processRoundFunctionCalls = async (args: {
    round: number;
    functionCalls: readonly FunctionCall[];
  }) => {
    endTurnAfterLastToolProcessing = false;
    const contextBudgetRound = completedContextBudgetRound;
    completedContextBudgetRound = undefined;
    const toolResultContextBudget =
      contextBudgetRound?.getToolResultContextBudget();
    return await toolRuntimePort.processFunctionCalls({
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
      toolRegistry: registry,
      ...(effectiveToolSurface === undefined
        ? {}
        : {
            allowedRegistryNames: effectiveToolSurface.allowedRegistryNames,
          }),
      ...(toolCapabilityPolicy === undefined ? {} : { toolCapabilityPolicy }),
      toolLibraryProjectionIdentity: toolLibraryProjection.identity,
      providerRunSelection: projectProviderRunSelection(providerRequestOptions),
      ultraReasoning,
      ...(subagentModelRouting === undefined ? {} : { subagentModelRouting }),
      ...(planningWorkflow === undefined ? {} : { planningWorkflow }),
      ...(toolResultContextBudget === undefined
        ? {}
        : { toolResultContextBudget }),
      observeToolResult(observation) {
        if (
          observation.outcome === 'success' &&
          turnEndingToolNames.has(observation.toolName)
        ) {
          endTurnAfterLastToolProcessing = true;
        }
        if (observer !== undefined) {
          recordAgentLoopObserverToolResult(observer, observation);
        }
      },
    });
  };
  recordAgentLoopObserverSnapshot(
    observer,
    buildAgentLoopObserverSnapshot({
      runId,
      runContext,
      approvalContext,
      ...(effectiveToolSurface !== undefined
        ? { toolSurface: effectiveToolSurface }
        : {}),
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
      loopImplementation,
    }),
  );

  return loopImplementation.run<
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
        completedContextBudgetRound = undefined;
        const contextBudgetRound = memoryPort.beginContextBudgetRound({
          workspaceRoot: stateRoot,
          threadId,
          history,
          systemPrompt,
          tools: toolDefs,
          providerAuthRuntime,
          providerRequestOptions,
          ...(providerReplayScopeId === undefined
            ? {}
            : { providerReplayScopeId }),
          ...(signal === undefined ? {} : { signal }),
          onContextUsage(snapshot) {
            emit('context_usage_updated', snapshot);
          },
        });
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
          onProviderRequestPrepared:
            contextBudgetRound.onProviderRequestPrepared,
          onContextPreparationRequired: async () =>
            await contextBudgetRound.prepareBeforeModelRound(),
        };
        if (signal !== undefined) {
          modelRoundArgs.signal = signal;
        }
        if (callModelImpl !== undefined) {
          modelRoundArgs.callModelImpl = callModelImpl;
        }
        if (
          providerTransitionSource !== undefined &&
          providerTransitionRecovery !== undefined &&
          recoverProviderTransitionAfterOverflow !== undefined
        ) {
          modelRoundArgs.onContextOverflow = async () => {
            if (!providerTransitionRecoveryAvailable) {
              return false;
            }
            providerTransitionRecoveryAvailable = false;
            return await recoverProviderTransitionAfterOverflow({
              workspaceRoot: stateRoot,
              threadId,
              prompt,
              history,
              source: {
                providerId: providerTransitionSource.providerId,
                model: providerTransitionSource.id,
              },
              target: {
                providerId: providerRequestOptions.providerId,
                model: providerRequestOptions.model,
              },
              sourceReasoningEffort:
                providerTransitionRecovery.sourceReasoningEffort,
              providerAuthRuntime,
              providerWebSocketSessions: webSocketSessions,
              providerRequestOptions,
              ...(providerReplayScopeId === undefined
                ? {}
                : { targetReplayScopeId: providerReplayScopeId }),
              ...(signal === undefined ? {} : { signal }),
            });
          };
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
            contextBudgetRound,
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
            compaction.kind === 'compacted' &&
            compaction.providerUsageTelemetry !== undefined &&
            runState !== undefined
          ) {
            accumulateRunUsageTotals(
              runState.usageTotals,
              compaction.providerUsageTelemetry,
            );
            emit('usage_updated', { ...runState.usageTotals });
          }
          completedContextBudgetRound = contextBudgetRound;
          if (
            providerItems !== undefined &&
            providerItems.length > 0 &&
            providerItems.every((item) => item.kind === 'backend_item') &&
            roundReplayScopeId !== undefined
          ) {
            const precedingTranscriptEntryId =
              compaction.kind === 'compacted'
                ? compaction.providerRoundAnchorEntryId
                : await readLastTranscriptEntryId(stateRoot, threadId);
            await appendProviderRound({
              stateRoot,
              threadId,
              runId: assertValidRunId(runId),
              round,
              providerId: providerRequestOptions.providerId,
              model: providerRequestOptions.model,
              replayScopeId: roundReplayScopeId,
              precedingTranscriptEntryId,
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
      shouldEndTurnAfterFunctionCalls({ functionCalls }) {
        return (
          endTurnAfterLastToolProcessing &&
          functionCalls.some((call) => turnEndingToolNames.has(call.name))
        );
      },
      async resolveTerminalCandidate({ source, result }) {
        return await completionPolicy.resolveTerminalCandidate({
          source,
          result,
        });
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
        recordAgentLoopObserverEvent(
          observer,
          buildAgentLoopObserverEvent({ runId, threadId, event }),
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
