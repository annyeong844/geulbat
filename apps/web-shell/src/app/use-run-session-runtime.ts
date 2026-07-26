import {
  useCallback,
  useEffect,
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
  resolveRunModelDescriptor,
} from '@geulbat/protocol/run-contract';
import type {
  PrepareProviderTransitionRequest,
  ThreadDetailResponse,
} from '@geulbat/protocol/threads';
import { createLogger } from '@geulbat/structured-logger/logger';

import { useRunSessionConnection } from './use-run-session-connection.js';
import {
  cachePermissionMode,
  readCachedPermissionMode,
} from './permission-mode-cache.js';
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
import { RunChannelClient } from '../lib/run-channel/client.js';
import {
  fetchPermissionMode,
  savePermissionMode,
} from '../lib/api/permission-mode.js';
import { prepareThreadProviderTransition } from '../lib/api/threads.js';
import {
  readStoredContextUsageByThread,
  storeContextUsageByThread,
} from './run-session-context-usage-cache.js';

const logger = createLogger('run-session-runtime');

export interface RunSessionControllerClient
  extends
    Pick<
      RunChannelClient,
      | 'subscribe'
      | 'close'
      | 'endComputerSession'
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
}

function useHandleRunStarted({
  dispatch,
  clearSessionError,
  loadThreads,
  computerTreeRefreshControllerRef,
  setSelectedThreadId,
  selectStartedThread,
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
      setSelectedThreadId,
    ],
  );
}

interface UseRunSessionRuntimeArgs {
  workingDirectory?: string;
  selectedFile: string | null;
  selectedThreadId: string | null;
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
  applyThreadSnapshotForRunSettle?: (thread: ThreadDetailResponse) => boolean;
  createClient?: () => RunSessionControllerClient;
  prepareStartRequest?: (request: RunRequest) => Promise<RunStartRequest>;
  prepareProviderTransitionRequest?: typeof prepareThreadProviderTransition;
  readPermissionModeState?: typeof fetchPermissionMode;
  writePermissionModeState?: typeof savePermissionMode;
}

// 뷰모델 입력에서 파생한다 — 손으로 베낀 목록이었을 때는 24개 필드가 두 곳에
// 따로 선언돼 있었고, 한쪽만 늘려도 컴파일이 통과했다. selectedThreadId는
// 셸이 얹으므로 여기서 뺀다.
type UseRunSessionRuntimeResult = Omit<
  CreateRunSessionViewModelArgs,
  'selectedThreadId'
>;

export function useRunSessionRuntime({
  workingDirectory,
  selectedFile,
  selectedThreadId,
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
  readPermissionModeState = fetchPermissionMode,
  writePermissionModeState = savePermissionMode,
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
  // 승인 모드는 세션을 넘어 유지한다 — 새로고침/재접속마다 basic으로
  // 조용히 리셋되면 "전체 승인이 풀렸다"로 체감된다 (오너 결정 2026-07-23).
  // durable 소유자는 daemon이다. 캐시된 값으로 첫 페인트만 채우고, 곧바로
  // daemon 값으로 맞춘다.
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>(
    () => readCachedPermissionMode(),
  );
  const permissionModeTransportRef = useRef({
    read: readPermissionModeState,
    write: writePermissionModeState,
  });
  permissionModeTransportRef.current = {
    read: readPermissionModeState,
    write: writePermissionModeState,
  };
  const applyPermissionMode = useCallback((next: PermissionMode) => {
    setPermissionModeState(next);
    cachePermissionMode(next);
  }, []);
  const reconcilePermissionMode = useCallback(async () => {
    try {
      const state = await permissionModeTransportRef.current.read();
      applyPermissionMode(state.permissionMode);
    } catch (error: unknown) {
      // daemon을 못 읽었으면 캐시 값을 진실로 승격하지 않는다. 안전한 기본값으로
      // 내려두고 진단을 남긴다.
      applyPermissionMode(DEFAULT_PERMISSION_MODE);
      logger.warn(
        'permission mode could not be read from the daemon; using the safe default:',
        error,
      );
    }
  }, [applyPermissionMode]);
  useEffect(() => {
    void reconcilePermissionMode();
  }, [reconcilePermissionMode]);
  const setPermissionMode = useCallback(
    async (next: PermissionMode) => {
      applyPermissionMode(next);
      try {
        const state = await permissionModeTransportRef.current.write(next);
        applyPermissionMode(state.permissionMode);
      } catch (error: unknown) {
        logger.warn('permission mode could not be persisted:', error);
        // 저장이 실패했으면 저장된 것처럼 두지 않고 소유자 값으로 되돌린다.
        await reconcilePermissionMode();
      }
    },
    [applyPermissionMode, reconcilePermissionMode],
  );
  // 계획 모드는 권한 방식과 다른 축이다 — 켜면 daemon이 그 run의 실행을
  // 잠그고, 끄면 저장된 권한 방식이 그대로 다시 드러난다. 활성 워크플로우의
  // 진실 소유자는 daemon이므로 이 값은 진입 요청일 뿐이다.
  const [planModeRequested, setPlanModeRequested] = useState(false);
  const [planModeIntensity, setPlanModeIntensity] =
    useState<PlanModeIntensity>('visual');
  const [planModeDepth, setPlanModeDepth] = useState<PlanModeDepth>('standard');
  const [modelId, setModelIdState] = useState<RunModelId>(DEFAULT_RUN_MODEL_ID);
  const [reasoningEffort, setReasoningEffortState] =
    useState<RunReasoningSelection>('medium');
  const [serviceTier, setServiceTier] = useState<RunServiceTier>(
    DEFAULT_RUN_SERVICE_TIER,
  );
  const [subagentModelRouting, setSubagentModelRoutingState] =
    useState<RunSubagentModelRouting>(DEFAULT_RUN_SUBAGENT_MODEL_ROUTING);
  const setReasoningEffort = useCallback((effort: RunReasoningSelection) => {
    setReasoningEffortState(effort);
  }, []);
  const setSubagentModelRouting = useCallback(
    (routing: RunSubagentModelRouting) => {
      setSubagentModelRoutingState(routing);
    },
    [],
  );
  const setModelId = useCallback((nextModelId: RunModelId) => {
    const model = resolveRunModelDescriptor(nextModelId);
    setModelIdState(nextModelId);
    setReasoningEffortState((current) =>
      current === 'ultra' ||
      model.reasoningEfforts.some((effort) => effort === current)
        ? current
        : model.defaultReasoningEffort,
    );
    setServiceTier((current) =>
      model.serviceTiers.some((serviceTier) => serviceTier === current)
        ? current
        : DEFAULT_RUN_SERVICE_TIER,
    );
  }, []);
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
      ...(workingDirectory !== undefined ? { workingDirectory } : {}),
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
