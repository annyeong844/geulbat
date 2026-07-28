/**
 * Agent loop — provider-backed with tool execution + approval.
 * Emits internal AgentEvents; adapter/web converts to RunEventEnvelope.
 */

import {
  agentLoopKernelImplementation,
  type AgentLoopKernelFailure,
} from '@geulbat/agent-loop/kernel';
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
  recordAgentLoopObserverCompletionGap,
  recordAgentLoopObserverEvent,
  recordAgentLoopObserverSnapshot,
  recordAgentLoopObserverToolResult,
} from './observer/agent-loop-observer.js';
import {
  assertAgentRunId as assertValidRunId,
  isAgentRunModelId,
  resolveAgentRunModelDescriptor,
} from './contract.js';
import { accumulateRunUsageTotals } from './runtime/run-usage-totals.js';
import {
  appendAssistantTextToHistory,
  appendFunctionCallsToHistory,
  createAgentLoopHistoryPort,
  type AgentLoopHistoryPort,
} from './loop-history.js';
import { closeInterjectBuffer } from '../sessions/active-run-interject-buffer.js';
import { applyNextPendingInterject } from './loop-interject.js';
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
import type { GenericApiErrorCode } from '../error-codes.js';

/**
 * Kernel failure kinds carry distinct meanings, so the public error code must
 * not flatten them all into `execution_failed`.
 *
 * `no_progress` is its own code because "the same requirement stayed unmet and
 * nothing changed it" needs a different user response than a genuine execution
 * error: revise the objective or supply what is missing, not retry.
 *
 * `blocked`, `verification_unavailable`, and the structured-output failures keep
 * `execution_failed` for now. They stay distinguishable through the kernel
 * failure kind and the recorded terminal source, and giving each its own public
 * code is a separate client-visible decision rather than part of the no-progress
 * cut. The switch is exhaustive so a new kind cannot silently inherit a code.
 */
function resolveKernelFailureErrorCode(
  kind: AgentLoopKernelFailure['kind'],
): GenericApiErrorCode {
  switch (kind) {
    case 'aborted':
      return 'aborted';
    case 'no_progress':
      return 'run_no_progress';
    case 'blocked':
    case 'structured_output_failure':
    case 'structured_output_unhandled':
    case 'verification_unavailable':
      return 'execution_failed';
  }

  const exhaustive: never = kind;
  return exhaustive;
}
import { createAgentLoopMemoryPort } from './memory/compaction-loop.js';
import type {
  FunctionCall,
  ProviderStructuredOutput,
} from '../llm/provider/wire/types.js';
import { resolveAgentNoProgressPolicyFromEnv } from './no-progress-policy.js';
import { createAgentRunCompletionPolicy } from './run-completion-policy.js';

const RUN_MODEL_TOOL_DISCOVERY_BY_ID = {
  'gpt-5.6-sol': 'hosted_tool_search',
  'gpt-5.6-terra': 'hosted_tool_search',
  'gpt-5.6-luna': 'hosted_tool_search',
  'grok-4.5': 'direct_only',
  'qwen3.8-max-preview': 'direct_only',
} as const satisfies Record<
  Parameters<typeof resolveAgentRunModelDescriptor>[0],
  'hosted_tool_search' | 'direct_only'
>;

function resolveProviderToolExposure(args: {
  toolSurface:
    | {
        directRegistryNames: readonly string[];
        allowedRegistryNames: readonly string[];
      }
    | undefined;
  providerId: string;
  model: string;
}): {
  directRegistryNames: string[] | undefined;
  deferredRegistryNames: string[];
} {
  if (args.toolSurface === undefined || !isAgentRunModelId(args.model)) {
    return {
      directRegistryNames: args.toolSurface
        ? [...args.toolSurface.directRegistryNames]
        : undefined,
      deferredRegistryNames: [],
    };
  }
  const model = resolveAgentRunModelDescriptor(args.model);
  if (model.providerId !== args.providerId) {
    return {
      directRegistryNames: [...args.toolSurface.directRegistryNames],
      deferredRegistryNames: [],
    };
  }
  const directRegistryNames = new Set(args.toolSurface.directRegistryNames);
  if (RUN_MODEL_TOOL_DISCOVERY_BY_ID[model.id] === 'direct_only') {
    return {
      directRegistryNames: args.toolSurface.allowedRegistryNames.filter(
        (name) => name !== 'tool_search',
      ),
      deferredRegistryNames: [],
    };
  }
  const deferredRegistryNames = args.toolSurface.allowedRegistryNames.filter(
    (name) => name !== 'tool_search' && !directRegistryNames.has(name),
  );
  return {
    directRegistryNames: [...directRegistryNames],
    deferredRegistryNames,
  };
}

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
    toolLibraryProjectionIdentity,
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
  const providerRequestOptions = resolveProviderRequestOptionsForRun(
    runtimeServices.provider.requestOptions,
    {
      ...(providerModel !== undefined ? { providerModel } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(serviceTier !== undefined ? { serviceTier } : {}),
    },
  );
  const providerToolExposure = resolveProviderToolExposure({
    toolSurface: effectiveToolSurface,
    providerId: providerRequestOptions.providerId,
    model: providerRequestOptions.model,
  });
  const providerDeferredToolNames =
    providerToolExposure.deferredRegistryNames.filter(
      (name) =>
        (goal !== undefined || name !== 'update_goal') &&
        (promptProfile !== 'root' || name !== 'submit_result_report'),
    );
  const providerHostedToolSearchEnabled = providerDeferredToolNames.length > 0;
  const providerDirectRegistryNames =
    providerToolExposure.directRegistryNames === undefined
      ? undefined
      : providerHostedToolSearchEnabled
        ? providerToolExposure.directRegistryNames.filter(
            (name) => name !== 'tool_search',
          )
        : providerToolExposure.directRegistryNames;

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
    ...(providerDirectRegistryNames === undefined
      ? {}
      : { directRegistryNames: providerDirectRegistryNames }),
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
  const historyPort: Required<AgentLoopHistoryPort> = {
    ...createAgentLoopHistoryPort(),
    ...(injectedHistoryPort ?? {}),
  };
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
  const configuredDirectToolDefs = [
    ...toolDefinitionPort.buildToolDefinitions({
      ...(providerDirectRegistryNames === undefined
        ? {}
        : {
            directRegistryNames: providerDirectRegistryNames,
          }),
    }),
  ];
  const providerDeferredToolDefs =
    providerDeferredToolNames.length === 0
      ? undefined
      : [
          ...toolDefinitionPort.buildToolDefinitions({
            directRegistryNames: providerDeferredToolNames,
          }),
        ];
  const toolDefs = configuredDirectToolDefs.filter(
    (definition) =>
      (goal !== undefined || definition.name !== 'update_goal') &&
      (promptProfile !== 'root' ||
        definition.name !== 'submit_result_report') &&
      (!providerHostedToolSearchEnabled || definition.name !== 'tool_search'),
  );
  if (
    goal !== undefined &&
    ![...toolDefs, ...(providerDeferredToolDefs ?? [])].some(
      (definition) => definition.name === 'update_goal',
    )
  ) {
    return rejectToolAdmission(
      'Goal mode requires the update_goal tool in the admitted tool surface',
    );
  }
  const admittedProviderToolNames: ReadonlySet<string> = new Set([
    ...toolDefs.map((definition) => definition.name),
    ...(providerDeferredToolDefs ?? []).map((definition) => definition.name),
  ]);
  // 인자 스트리밍 opt-in 도구(ToolMeta.streamsArgsDelta) — 모델 라운드가
  // 이 목록에 한해 tool_call_delta를 방출한다 (visualize 실시간 렌더)
  const streamArgsToolNames: ReadonlySet<string> = new Set(
    [...toolDefs, ...(providerDeferredToolDefs ?? [])]
      .filter(
        (definition) =>
          registry.getToolMeta(definition.name)?.streamsArgsDelta === true,
      )
      .map((definition) => definition.name),
  );
  const turnEndingToolNames: ReadonlySet<string> = new Set(
    [...toolDefs, ...(providerDeferredToolDefs ?? [])]
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
      ...(toolLibraryProjectionIdentity === undefined
        ? {}
        : { expectedIdentity: toolLibraryProjectionIdentity }),
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
    planningWorkflows: runtimeServices.planningWorkflows,
    goals: runtimeServices.goals,
    backgroundNotifications: runtimeServices.backgroundNotifications,
    emit,
    ...(runState === undefined ? {} : { runState }),
    ...(planningWorkflow === undefined ? {} : { planningWorkflow }),
    ...(approvedPlan === undefined ? {} : { approvedPlan }),
    ...(goal === undefined ? {} : { goal }),
    observeCompletionGap(observation) {
      recordAgentLoopObserverCompletionGap(observer, observation);
    },
    // 설정이 없으면 undefined가 그대로 전달돼 관측 전용 동작이 유지된다.
    noProgressPolicy: resolveAgentNoProgressPolicyFromEnv(),
  });
  const processRoundFunctionCalls = async (args: {
    round: number;
    functionCalls: readonly FunctionCall[];
  }) => {
    endTurnAfterLastToolProcessing = false;
    const unadmittedFunctionCall = args.functionCalls.find(
      (functionCall) => !admittedProviderToolNames.has(functionCall.name),
    );
    if (unadmittedFunctionCall !== undefined) {
      completedContextBudgetRound = undefined;
      return {
        ok: false as const,
        result: lifecyclePort.createTerminalFailure({
          emit,
          code: 'execution_failed',
          message: `provider requested a tool outside the admitted provider surface: ${unadmittedFunctionCall.name}`,
        }),
      };
    }
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
          ...(providerDeferredToolDefs === undefined
            ? {}
            : { deferredTools: providerDeferredToolDefs }),
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
          ...(providerDeferredToolDefs === undefined
            ? {}
            : { providerDeferredToolDefs }),
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
        // 사용자가 "지금 넣어라"라고 하면 이 라운드를 끊는다. 런 전체의 취소
        // 신호를 쓸 수 없다 — 그것을 당기면 대화가 끝나 버린다. 그래서 라운드
        // 수명만큼 사는 신호를 따로 만들어 버퍼의 flush 요청에 건다.
        //
        // 끊긴 라운드는 실패가 아니라 "할 말 다 했고 도구는 안 부름"으로
        // 끝나므로, 완결 정책이 대기 중인 말을 보고 대화를 이어가고
        // `beforeModelRound`가 그 말을 넣는다.
        const roundInterrupt = new AbortController();
        const unsubscribeInterjectFlush =
          runState === undefined
            ? undefined
            : runState.interject.subscribeFlush(() => {
                roundInterrupt.abort();
              });
        modelRoundArgs.interruptSignal = roundInterrupt.signal;
        let modelRound;
        try {
          modelRound = await modelRoundPort.runModelRound(modelRoundArgs);
        } finally {
          unsubscribeInterjectFlush?.();
        }
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
            ...(providerDeferredToolDefs === undefined
              ? {}
              : { deferredTools: providerDeferredToolDefs }),
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
            await historyPort.recordProviderRound({
              workspaceRoot: stateRoot,
              threadId,
              runId: assertValidRunId(runId),
              round,
              providerId: providerRequestOptions.providerId,
              model: providerRequestOptions.model,
              replayScopeId: roundReplayScopeId,
              ...(compaction.kind === 'compacted'
                ? {
                    precedingTranscriptEntryId:
                      compaction.providerRoundAnchorEntryId,
                  }
                : {}),
              items: providerItems.map((item) => item.data),
              functionCalls: modelRound.value.functionCalls.map((call) => {
                const recoveryStrategy = registry.getToolMeta(
                  call.name,
                )?.recoveryStrategy;
                return {
                  ...call,
                  replaySafe: recoveryStrategy === 'replay_safe',
                  ...(recoveryStrategy === undefined
                    ? {}
                    : { recoveryStrategy }),
                };
              }),
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
          code: resolveKernelFailureErrorCode(failure.kind),
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
