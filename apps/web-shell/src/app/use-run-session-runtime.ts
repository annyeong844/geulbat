import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';
import {
  DEFAULT_PERMISSION_MODE,
  type PermissionMode,
} from '@geulbat/protocol/run-approval';
import type {
  RunModelId,
  RunReasoningSelection,
  RunRequest,
  RunServiceTier,
  RunStartRequest,
  RunSubagentModelRouting,
} from '@geulbat/protocol/run-contract';
import type {
  PlanModeDepth,
  PlanModeIntensity,
  PlanningWorkflowSnapshot,
  PlanWorkflowCommand,
} from '@geulbat/protocol/planning-workflow';
import type { GoalCommand, GoalSnapshot } from '@geulbat/protocol/goal';
import {
  DEFAULT_RUN_MODEL_ID,
  DEFAULT_RUN_SERVICE_TIER,
  DEFAULT_RUN_SUBAGENT_MODEL_ROUTING,
  isRunModelId,
  isRunReasoningSelection,
  isRunServiceTier,
  isRunSubagentModelRouting,
  resolveRunModelDescriptor,
} from '@geulbat/protocol/run-contract';
import {
  isPlanModeDepth,
  isPlanModeIntensity,
} from '@geulbat/protocol/planning-workflow';
import type {
  PrepareProviderTransitionRequest,
  ThreadDetailResponse,
  ThreadRunPreferences,
} from '@geulbat/protocol/threads';
import type { ThreadStateSettlePayload } from '@geulbat/protocol/run-events';

import { useRunSessionConnection } from './use-run-session-connection.js';
import { createComputerTreeRefreshController } from './run-session-computer-tree-refresh.js';
import type {
  ApprovalDecisionClient,
  CancelRunSessionClient,
  StartRunCommandClient,
} from './run-session-commands.js';
import { useRunSessionControllerActions } from './run-session-controller-actions.js';
import type { CreateRunSessionViewModelArgs } from './run-session-view-model.js';
import { useRunSessionDiagnostics } from './run-session-diagnostics.js';
import { useRunSessionSettleHandlers } from './run-session-settle-handlers.js';
import {
  getActiveRunId,
  selectRunSessionLaneState,
} from './run-session-state-selectors.js';
import {
  createInitialRunSessionState,
  reduceRunSessionState,
} from './run-session-state-reducer.js';
import type { RunSessionStateAction } from './run-session-state-types.js';
import type { ThreadStateApplyResult } from './use-thread-session-selection.js';
import { RunChannelClient } from '../lib/run-channel/client.js';
import { prepareThreadProviderTransition } from '../lib/api/threads.js';
import {
  readStoredContextUsageByThread,
  storeContextUsageByThread,
} from './run-session-context-usage-cache.js';
import { isRecord, tryParseJsonRecord } from '../lib/json.js';

export interface RunSessionControllerClient
  extends
    Pick<
      RunChannelClient,
      | 'subscribe'
      | 'close'
      | 'acknowledgeEvent'
      | 'interject'
      | 'cancelInterject'
      | 'flushInterject'
      | 'tool'
      | 'cancelChild'
      | 'subscribeThread'
      | 'planCommand'
      | 'goalCommand'
      | 'getActiveRunForThread'
    >,
    StartRunCommandClient,
    ApprovalDecisionClient,
    CancelRunSessionClient {}

interface RunStartedHandlerArgs {
  dispatch: (action: RunSessionStateAction) => void;
  clearSessionError: () => void;
  loadThreads: () => Promise<void>;
  computerTreeRefreshControllerRef: MutableRefObject<
    ReturnType<typeof createComputerTreeRefreshController>
  >;
  setSelectedThreadId: (threadId: string | null) => void;
  selectStartedThread: boolean;
  adoptStartedThreadPreferences: (threadId: string) => void;
}

function useHandleRunStarted({
  dispatch,
  clearSessionError,
  loadThreads,
  computerTreeRefreshControllerRef,
  setSelectedThreadId,
  selectStartedThread,
  adoptStartedThreadPreferences,
}: RunStartedHandlerArgs) {
  return useCallback(
    (threadId: string, runId: string) => {
      clearSessionError();
      computerTreeRefreshControllerRef.current.clearQueuedRefresh();
      dispatch({
        type: 'run_started',
        threadId,
        runId,
      });
      if (selectStartedThread) {
        adoptStartedThreadPreferences(threadId);
        setSelectedThreadId(threadId);
      }
      void loadThreads();
    },
    [
      clearSessionError,
      dispatch,
      loadThreads,
      computerTreeRefreshControllerRef,
      selectStartedThread,
      adoptStartedThreadPreferences,
      setSelectedThreadId,
    ],
  );
}

interface UseRunSessionRuntimeArgs {
  selectedFile: string | null;
  selectedThreadId: string | null;
  newSessionGeneration: number;
  activeModelId: RunModelId | null;
  runPreferences: ThreadRunPreferences | null;
  loadThreads: () => Promise<void>;
  openFile: (path: string) => Promise<void>;
  appendOptimisticUserMessage: (
    prompt: string,
    origin?: 'artifact_frame',
  ) => void;
  trimMessagesForRegenerate: () => void;
  loadTree: () => Promise<void>;
  setSelectedThreadId: (threadId: string | null) => void;
  openThreadForRunSettle: (
    threadId: string,
  ) => Promise<ThreadDetailResponse | null>;
  applyThreadSnapshotForRunSettle?: (
    thread: ThreadStateSettlePayload,
  ) => ThreadStateApplyResult;
  createClient?: () => RunSessionControllerClient;
  prepareStartRequest?: (request: RunRequest) => Promise<RunStartRequest>;
  prepareProviderTransitionRequest?: typeof prepareThreadProviderTransition;
}

// 뷰모델 입력에서 파생한다 — 손으로 베낀 목록이었을 때는 24개 필드가 두 곳에
// 따로 선언돼 있었고, 한쪽만 늘려도 컴파일이 통과했다. selectedThreadId는
// 셸이 얹으므로 여기서 뺀다.
type UseRunSessionRuntimeResult = Omit<
  CreateRunSessionViewModelArgs,
  'selectedThreadId'
>;

interface RunSessionPreferences {
  workingDirectory: string | null;
  permissionMode: PermissionMode;
  planModeRequested: boolean;
  planModeIntensity: PlanModeIntensity;
  planModeDepth: PlanModeDepth;
  modelId: RunModelId;
  reasoningEffort: RunReasoningSelection;
  serviceTier: RunServiceTier;
  subagentModelRouting: RunSubagentModelRouting;
}

type StoredRunSessionPreferences = Omit<
  RunSessionPreferences,
  'permissionMode' | 'workingDirectory'
>;

const RUN_SESSION_PREFERENCES_STORAGE_KEY =
  'geulbat.shell.run-session-preferences.v1';

function readStoredRunSessionPreferences(): StoredRunSessionPreferences | null {
  try {
    const raw = globalThis.localStorage?.getItem(
      RUN_SESSION_PREFERENCES_STORAGE_KEY,
    );
    if (raw === null || raw === undefined) {
      return null;
    }
    const parsed = tryParseJsonRecord(raw);
    if (
      !parsed.ok ||
      parsed.value.version !== 1 ||
      !isRecord(parsed.value.preferences)
    ) {
      return null;
    }
    const preferences = parsed.value.preferences;
    if (
      !(
        preferences.workingDirectory === undefined ||
        preferences.workingDirectory === null ||
        typeof preferences.workingDirectory === 'string'
      ) ||
      typeof preferences.planModeRequested !== 'boolean' ||
      !isPlanModeIntensity(preferences.planModeIntensity) ||
      !isPlanModeDepth(preferences.planModeDepth) ||
      !isRunModelId(preferences.modelId) ||
      !isRunReasoningSelection(preferences.reasoningEffort) ||
      !isRunServiceTier(preferences.serviceTier) ||
      !isRunSubagentModelRouting(preferences.subagentModelRouting)
    ) {
      return null;
    }
    return {
      planModeRequested: preferences.planModeRequested,
      planModeIntensity: preferences.planModeIntensity,
      planModeDepth: preferences.planModeDepth,
      modelId: preferences.modelId,
      reasoningEffort: preferences.reasoningEffort,
      serviceTier: preferences.serviceTier,
      subagentModelRouting: preferences.subagentModelRouting,
    };
  } catch {
    return null;
  }
}

function storeRunSessionPreferences(preferences: RunSessionPreferences): void {
  const stored = toStoredRunSessionPreferences(preferences);
  try {
    globalThis.localStorage?.setItem(
      RUN_SESSION_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ version: 1, preferences: stored }),
    );
  } catch {
    // 로컬 UI 기본값 저장이 막혀도 현재 세션의 exact state는 유지한다.
  }
}

function toStoredRunSessionPreferences(
  preferences: RunSessionPreferences,
): StoredRunSessionPreferences {
  return {
    planModeRequested: preferences.planModeRequested,
    planModeIntensity: preferences.planModeIntensity,
    planModeDepth: preferences.planModeDepth,
    modelId: preferences.modelId,
    reasoningEffort: preferences.reasoningEffort,
    serviceTier: preferences.serviceTier,
    subagentModelRouting: preferences.subagentModelRouting,
  };
}

function createRunSessionPreferences(
  activeModelId: RunModelId | null,
  restored: ThreadRunPreferences | null,
  lastUsed: StoredRunSessionPreferences | null,
): RunSessionPreferences {
  const modelId = activeModelId ?? lastUsed?.modelId ?? DEFAULT_RUN_MODEL_ID;
  const model = resolveRunModelDescriptor(modelId);
  const restoredReasoningEffort =
    restored?.reasoningEffort ?? lastUsed?.reasoningEffort;
  const reasoningEffort =
    restoredReasoningEffort !== undefined &&
    model.reasoningEfforts.some((effort) => effort === restoredReasoningEffort)
      ? restoredReasoningEffort
      : model.defaultReasoningEffort;
  const restoredServiceTier = restored?.serviceTier ?? lastUsed?.serviceTier;
  const serviceTier =
    restoredServiceTier !== undefined &&
    model.serviceTiers.some((tier) => tier === restoredServiceTier)
      ? restoredServiceTier
      : DEFAULT_RUN_SERVICE_TIER;
  return {
    // cwd는 thread/session 소유다. 모델·사고 강도 같은 편의 기본값과 함께
    // localStorage에 흘리면 새 세션이 이전 작업 폴더를 잘못 상속한다.
    workingDirectory: restored?.workingDirectory ?? null,
    permissionMode: restored?.permissionMode ?? DEFAULT_PERMISSION_MODE,
    planModeRequested: lastUsed?.planModeRequested ?? false,
    planModeIntensity: lastUsed?.planModeIntensity ?? 'visual',
    planModeDepth: lastUsed?.planModeDepth ?? 'standard',
    modelId,
    reasoningEffort,
    serviceTier,
    subagentModelRouting:
      restored?.subagentModelRouting ??
      lastUsed?.subagentModelRouting ??
      DEFAULT_RUN_SUBAGENT_MODEL_ROUTING,
  };
}

export function useRunSessionRuntime({
  selectedFile,
  selectedThreadId,
  newSessionGeneration,
  activeModelId,
  runPreferences,
  loadThreads,
  loadTree,
  openFile,
  appendOptimisticUserMessage,
  trimMessagesForRegenerate,
  setSelectedThreadId,
  openThreadForRunSettle,
  applyThreadSnapshotForRunSettle = () => true,
  createClient = () => new RunChannelClient(),
  prepareStartRequest,
  prepareProviderTransitionRequest = prepareThreadProviderTransition,
}: UseRunSessionRuntimeArgs): UseRunSessionRuntimeResult {
  const [client] = useState(() => createClient());
  const computerTreeRefreshControllerRef = useRef(
    createComputerTreeRefreshController(),
  );
  const [state, dispatch] = useReducer(
    reduceRunSessionState,
    undefined,
    () => ({
      ...createInitialRunSessionState(),
      contextUsageByThread: readStoredContextUsageByThread(),
    }),
  );
  useEffect(() => {
    storeContextUsageByThread(state.contextUsageByThread);
  }, [state.contextUsageByThread]);
  useEffect(() => {
    if (
      selectedThreadId !== null &&
      state.newThreadRunLane?.activeRunView.threadId === selectedThreadId
    ) {
      dispatch({ type: 'new_thread_run_adopted', threadId: selectedThreadId });
    }
  }, [selectedThreadId, state.newThreadRunLane]);
  const sessionPreferenceKey =
    selectedThreadId === null
      ? `new:${newSessionGeneration}`
      : `thread:${selectedThreadId}`;
  const [lastUsedPreferences, setLastUsedPreferences] =
    useState<StoredRunSessionPreferences | null>(
      readStoredRunSessionPreferences,
    );
  const restoredPreferences = useMemo(
    () =>
      createRunSessionPreferences(
        activeModelId,
        runPreferences,
        lastUsedPreferences,
      ),
    [activeModelId, lastUsedPreferences, runPreferences],
  );
  const [preferencesBySession, setPreferencesBySession] = useState<
    Map<string, RunSessionPreferences>
  >(() => new Map());
  const preferences =
    preferencesBySession.get(sessionPreferenceKey) ?? restoredPreferences;
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const updatePreferences = useCallback(
    (
      update: (current: RunSessionPreferences) => RunSessionPreferences,
    ): void => {
      const updatedPreferences = update(preferencesRef.current);
      preferencesRef.current = updatedPreferences;
      setLastUsedPreferences(toStoredRunSessionPreferences(updatedPreferences));
      storeRunSessionPreferences(updatedPreferences);
      setPreferencesBySession((current) => {
        const next = new Map(current);
        next.set(sessionPreferenceKey, updatedPreferences);
        return next;
      });
    },
    [sessionPreferenceKey],
  );
  const setWorkingDirectory = useCallback(
    (workingDirectory: string | null) => {
      updatePreferences((current) => ({ ...current, workingDirectory }));
    },
    [updatePreferences],
  );
  const setPermissionMode = useCallback(
    async (permissionMode: PermissionMode) => {
      updatePreferences((current) => ({ ...current, permissionMode }));
    },
    [updatePreferences],
  );
  const setPlanModeRequested = useCallback(
    (planModeRequested: boolean) => {
      updatePreferences((current) => ({ ...current, planModeRequested }));
    },
    [updatePreferences],
  );
  const setPlanModeIntensity = useCallback(
    (planModeIntensity: PlanModeIntensity) => {
      updatePreferences((current) => ({ ...current, planModeIntensity }));
    },
    [updatePreferences],
  );
  const setPlanModeDepth = useCallback(
    (planModeDepth: PlanModeDepth) => {
      updatePreferences((current) => ({ ...current, planModeDepth }));
    },
    [updatePreferences],
  );
  const setReasoningEffort = useCallback(
    (reasoningEffort: RunReasoningSelection) => {
      updatePreferences((current) => ({ ...current, reasoningEffort }));
    },
    [updatePreferences],
  );
  const setServiceTier = useCallback(
    (serviceTier: RunServiceTier) => {
      updatePreferences((current) => ({ ...current, serviceTier }));
    },
    [updatePreferences],
  );
  const setSubagentModelRouting = useCallback(
    (subagentModelRouting: RunSubagentModelRouting) => {
      updatePreferences((current) => ({ ...current, subagentModelRouting }));
    },
    [updatePreferences],
  );
  const setModelId = useCallback(
    (modelId: RunModelId) => {
      const model = resolveRunModelDescriptor(modelId);
      updatePreferences((current) => ({
        ...current,
        modelId,
        reasoningEffort:
          current.reasoningEffort === 'ultra' ||
          model.reasoningEfforts.some(
            (effort) => effort === current.reasoningEffort,
          )
            ? current.reasoningEffort
            : model.defaultReasoningEffort,
        serviceTier: model.serviceTiers.some(
          (tier) => tier === current.serviceTier,
        )
          ? current.serviceTier
          : DEFAULT_RUN_SERVICE_TIER,
      }));
    },
    [updatePreferences],
  );
  const adoptStartedThreadPreferences = useCallback(
    (threadId: string) => {
      setPreferencesBySession((current) => {
        const next = new Map(current);
        next.set(`thread:${threadId}`, preferences);
        return next;
      });
    },
    [preferences],
  );
  const {
    workingDirectory,
    permissionMode,
    planModeRequested,
    planModeIntensity,
    planModeDepth,
    modelId,
    reasoningEffort,
    serviceTier,
    subagentModelRouting,
  } = preferences;
  const prepareProviderTransition = useCallback(
    async (request: PrepareProviderTransitionRequest) => {
      if (selectedThreadId === null) {
        throw new Error('provider transition requires a selected thread');
      }
      const source = resolveRunModelDescriptor(request.sourceModelId);
      const target = resolveRunModelDescriptor(request.targetModelId);
      if (source.id === target.id) {
        return;
      }
      if (modelId !== request.targetModelId) {
        throw new Error('provider transition target no longer matches');
      }
      const response = await prepareProviderTransitionRequest(
        selectedThreadId,
        request,
      );
      if (
        response.threadId !== selectedThreadId ||
        response.sourceModelId !== request.sourceModelId ||
        response.targetModelId !== request.targetModelId
      ) {
        throw new Error('provider transition response does not match request');
      }
      await loadThreads();
    },
    [loadThreads, modelId, prepareProviderTransitionRequest, selectedThreadId],
  );
  const { clearSessionError, reportSessionFailure, logCommandFailure } =
    useRunSessionDiagnostics({
      dispatch,
    });
  const previousSessionPreferenceKeyRef = useRef(sessionPreferenceKey);
  useEffect(() => {
    if (previousSessionPreferenceKeyRef.current === sessionPreferenceKey) {
      return;
    }
    previousSessionPreferenceKeyRef.current = sessionPreferenceKey;
    if (selectedThreadId === null) {
      dispatch({ type: 'new_session_started' });
      return;
    }
    clearSessionError();
  }, [clearSessionError, selectedThreadId, sessionPreferenceKey]);
  const { settleRunSuccess, settleRunSyncFailure, settleRunError } =
    useRunSessionSettleHandlers({
      dispatch,
      loadThreads,
      openThreadForRunSettle,
      openFile,
      selectedFile,
      applyThreadSnapshotForRunSettle,
    });
  const selectedRunLane = selectRunSessionLaneState(state, selectedThreadId);
  const [planningWorkflowByThread, setPlanningWorkflowByThread] = useState<
    Map<string, PlanningWorkflowSnapshot>
  >(() => new Map());
  const handlePlanningWorkflow = useCallback(
    (threadId: string, snapshot: PlanningWorkflowSnapshot | null) => {
      setPlanningWorkflowByThread((current) => {
        const next = new Map(current);
        if (snapshot === null) {
          next.delete(threadId);
        } else {
          next.set(threadId, snapshot);
        }
        return next;
      });
    },
    [],
  );
  const submitPlanningWorkflowCommand = useCallback(
    async (command: PlanWorkflowCommand) => {
      try {
        const control = await client.planCommand(command);
        handlePlanningWorkflow(command.threadId, control.snapshot);
      } catch (error: unknown) {
        reportSessionFailure('planning workflow command failed', error);
        throw error;
      }
    },
    [client, handlePlanningWorkflow, reportSessionFailure],
  );
  const selectedPlanningWorkflow =
    selectedThreadId === null
      ? undefined
      : planningWorkflowByThread.get(selectedThreadId);
  const planningWorkflow =
    selectedPlanningWorkflow === undefined
      ? null
      : {
          snapshot: selectedPlanningWorkflow,
          busy:
            selectedRunLane.phase === 'starting' ||
            selectedRunLane.phase === 'running' ||
            selectedRunLane.phase === 'settling',
          onCommand: submitPlanningWorkflowCommand,
        };
  const [goalByThread, setGoalByThread] = useState<Map<string, GoalSnapshot>>(
    () => new Map(),
  );
  const handleGoal = useCallback(
    (threadId: string, snapshot: GoalSnapshot | null) => {
      setGoalByThread((current) => {
        const next = new Map(current);
        if (snapshot === null) {
          next.delete(threadId);
        } else {
          next.set(threadId, snapshot);
        }
        return next;
      });
    },
    [],
  );
  const submitGoalCommand = useCallback(
    async (command: GoalCommand) => {
      try {
        const control = await client.goalCommand(command);
        handleGoal(command.threadId, control.snapshot);
      } catch (error: unknown) {
        reportSessionFailure('Goal command failed', error);
        throw error;
      }
    },
    [client, handleGoal, reportSessionFailure],
  );
  const selectedGoal =
    selectedThreadId === null ? undefined : goalByThread.get(selectedThreadId);
  const goal =
    selectedGoal === undefined
      ? null
      : {
          snapshot: selectedGoal,
          busy:
            selectedRunLane.phase === 'starting' ||
            selectedRunLane.phase === 'running' ||
            selectedRunLane.phase === 'settling',
          onCommand: submitGoalCommand,
        };
  const {
    sendPrompt,
    sendPromptAsNewTurn,
    sendWidgetPrompt,
    requestWidgetTool,
    regeneratePrompt,
    cancelSteer,
    flushSteers,
    startRunRequest,
    handleApprove,
    handleDeny,
    handleCancel,
    stopChildRun,
  } = useRunSessionControllerActions({
    startClient: client,
    approvalClient: client,
    cancelClient: client,
    interjectClient: client,
    frameToolClient: client,
    dispatch,
    appendOptimisticUserMessage,
    trimMessagesForRegenerate,
    clearSessionError,
    reportSessionFailure,
    logCommandFailure,
    promptInputs: {
      ...(workingDirectory !== null ? { workingDirectory } : {}),
      modelId,
      selectedThreadId,
      permissionMode,
      planModeRequested,
      planModeIntensity,
      planModeDepth,
      reasoningEffort,
      serviceTier,
      subagentModelRouting,
    },
    cancelState: {
      phase: selectedRunLane.phase,
      activeRunId: getActiveRunId(state, selectedThreadId),
      activeThreadId: selectedRunLane.activeRunView.threadId,
    },
    ...(prepareStartRequest ? { prepareStartRequest } : {}),
  });

  const handleRunStarted = useHandleRunStarted({
    dispatch,
    clearSessionError,
    loadThreads,
    computerTreeRefreshControllerRef,
    setSelectedThreadId,
    adoptStartedThreadPreferences,
    selectStartedThread:
      selectedThreadId === null && state.newThreadRunLane?.phase === 'starting',
  });

  useEffect(() => {
    if (selectedThreadId === null) {
      return;
    }
    void client.subscribeThread(selectedThreadId).catch((error: unknown) => {
      reportSessionFailure('run channel thread subscription failed', error);
    });
  }, [client, reportSessionFailure, selectedThreadId]);

  // 다음 걸음 제안 — 저장하지 않는다. 새 실행이 시작되면 지난 제안은 버린다.
  const [followupSuggestion, setFollowupSuggestion] = useState<string | null>(
    null,
  );
  const dismissFollowupSuggestion = useCallback(() => {
    setFollowupSuggestion(null);
  }, []);
  useEffect(() => {
    setFollowupSuggestion(null);
  }, [sessionPreferenceKey]);

  useRunSessionConnection({
    client,
    dispatch,
    computerTreeRefreshControllerRef,
    loadTree,
    handleRunStarted,
    handleRunSettledSuccess: settleRunSuccess,
    handleRunSettleSyncFailed: settleRunSyncFailure,
    handleRunSettledError: settleRunError,
    handleFollowupSuggested: setFollowupSuggestion,
    handlePlanningWorkflow,
    handleGoal,
    reportSessionFailure,
  });

  return {
    state,
    followupSuggestion,
    dismissFollowupSuggestion,
    planningWorkflow,
    goal,
    workingDirectory,
    setWorkingDirectory,
    permissionMode,
    setPermissionMode,
    planModeRequested,
    setPlanModeRequested,
    planModeIntensity,
    setPlanModeIntensity,
    planModeDepth,
    setPlanModeDepth,
    modelId,
    setModelId,
    prepareProviderTransition,
    reasoningEffort,
    setReasoningEffort,
    serviceTier,
    setServiceTier,
    subagentModelRouting,
    setSubagentModelRouting,
    sendPrompt,
    sendPromptAsNewTurn,
    sendWidgetPrompt,
    requestWidgetTool,
    regeneratePrompt,
    cancelSteer,
    flushSteers,
    startRunRequest,
    handleApprove,
    handleDeny,
    handleCancel,
    stopChildRun,
  };
}
