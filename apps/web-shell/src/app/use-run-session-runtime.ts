import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';
import type {
  ApprovalGrantScope,
  ApprovalRequired,
  PermissionMode,
} from '@geulbat/protocol/run-approval';
import type {
  RunAttachmentInput,
  RunModelId,
  RunReasoningEffort,
  RunRequest,
  RunStartRequest,
  RunSubagentModelRouting,
} from '@geulbat/protocol/run-contract';
import {
  DEFAULT_RUN_MODEL_ID,
  DEFAULT_RUN_SUBAGENT_MODEL_ROUTING,
  resolveRunModelDescriptor,
} from '@geulbat/protocol/run-contract';
import type { ThreadDetailResponse } from '@geulbat/protocol/threads';

import { useRunSessionConnection } from './use-run-session-connection.js';
import { createProjectTreeRefreshController } from './run-session-tree-refresh.js';
import type {
  ApprovalDecisionClient,
  CancelRunSessionClient,
  StartRunCommandClient,
} from './run-session-commands.js';
import { useRunSessionControllerActions } from './run-session-controller-actions.js';
import type { RequestWidgetTool } from './run-session-view-model.js';
import { useRunSessionDiagnostics } from './run-session-diagnostics.js';
import { useRunSessionSettleHandlers } from './run-session-settle-handlers.js';
import { getActiveRunId } from './run-session-state-selectors.js';
import {
  createInitialRunSessionState,
  reduceRunSessionState,
} from './run-session-state-reducer.js';
import type {
  RunSessionState,
  RunSessionStateAction,
} from './run-session-state-types.js';
import { RunChannelClient } from '../lib/run-channel/client.js';
import { prepareThreadProviderTransition } from '../lib/api/threads.js';
import {
  readStoredContextUsageByThread,
  storeContextUsageByThread,
} from './run-session-context-usage-cache.js';

export interface RunSessionControllerClient
  extends
    Pick<
      RunChannelClient,
      | 'subscribe'
      | 'close'
      | 'interject'
      | 'cancelInterject'
      | 'flushInterject'
      | 'tool'
    >,
    StartRunCommandClient,
    ApprovalDecisionClient,
    CancelRunSessionClient {}

interface RunStartedHandlerArgs {
  dispatch: (action: RunSessionStateAction) => void;
  clearSessionError: () => void;
  loadThreads: () => Promise<void>;
  projectTreeRefreshControllerRef: MutableRefObject<
    ReturnType<typeof createProjectTreeRefreshController>
  >;
  setSelectedThreadId: (threadId: string | null) => void;
}

function useHandleRunStarted({
  dispatch,
  clearSessionError,
  loadThreads,
  projectTreeRefreshControllerRef,
  setSelectedThreadId,
}: RunStartedHandlerArgs) {
  return useCallback(
    (threadId: string, runId: string) => {
      clearSessionError();
      projectTreeRefreshControllerRef.current.clearQueuedRefresh();
      dispatch({
        type: 'run_started',
        threadId,
        runId,
      });
      setSelectedThreadId(threadId);
      void loadThreads();
    },
    [
      clearSessionError,
      dispatch,
      loadThreads,
      projectTreeRefreshControllerRef,
      setSelectedThreadId,
    ],
  );
}

interface UseRunSessionRuntimeArgs {
  workingDirectory: string;
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
}

interface UseRunSessionRuntimeResult {
  state: RunSessionState;
  permissionMode: PermissionMode;
  setPermissionMode: (mode: PermissionMode) => void;
  modelId: RunModelId;
  setModelId: (modelId: RunModelId) => void;
  prepareProviderTransition: (targetModelId: RunModelId) => Promise<void>;
  reasoningEffort: RunReasoningEffort;
  setReasoningEffort: (effort: RunReasoningEffort) => void;
  subagentModelRouting: RunSubagentModelRouting;
  setSubagentModelRouting: (routing: RunSubagentModelRouting) => void;
  sendPrompt: (
    prompt: string,
    attachments?: RunAttachmentInput[],
  ) => Promise<void>;
  sendWidgetPrompt: (prompt: string) => Promise<void>;
  requestWidgetTool: RequestWidgetTool;
  regeneratePrompt: (prompt: string) => Promise<void>;
  cancelSteer: (receivedSeq: number) => Promise<void>;
  flushSteers: () => Promise<void>;
  startRunRequest: (
    request: RunRequest,
    optimisticPrompt?: string,
  ) => Promise<void>;
  handleApprove: (
    pending: ApprovalRequired,
    grantScope?: ApprovalGrantScope,
  ) => Promise<void>;
  handleDeny: (pending: ApprovalRequired) => Promise<void>;
  handleCancel: () => Promise<void>;
}

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
}: UseRunSessionRuntimeArgs): UseRunSessionRuntimeResult {
  const [client] = useState(() => createClient());
  const projectTreeRefreshControllerRef = useRef(
    createProjectTreeRefreshController(),
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
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('basic');
  const [modelId, setModelIdState] = useState<RunModelId>(DEFAULT_RUN_MODEL_ID);
  const [reasoningEffort, setReasoningEffort] =
    useState<RunReasoningEffort>('medium');
  const [subagentModelRouting, setSubagentModelRouting] =
    useState<RunSubagentModelRouting>(DEFAULT_RUN_SUBAGENT_MODEL_ROUTING);
  const setModelId = useCallback((nextModelId: RunModelId) => {
    const model = resolveRunModelDescriptor(nextModelId);
    setModelIdState(nextModelId);
    setReasoningEffort((current) =>
      model.reasoningEfforts.some((effort) => effort === current)
        ? current
        : model.defaultReasoningEffort,
    );
  }, []);
  const prepareProviderTransition = useCallback(
    async (targetModelId: RunModelId) => {
      const source = resolveRunModelDescriptor(modelId);
      const target = resolveRunModelDescriptor(targetModelId);
      if (
        selectedThreadId === null ||
        source.providerId === target.providerId
      ) {
        return;
      }
      const response = await prepareProviderTransitionRequest(
        selectedThreadId,
        {
          sourceModelId: modelId,
          targetModelId,
          reasoningEffort,
        },
      );
      if (
        response.threadId !== selectedThreadId ||
        response.sourceModelId !== modelId ||
        response.targetModelId !== targetModelId
      ) {
        throw new Error('provider transition response does not match request');
      }
      await loadThreads();
    },
    [
      loadThreads,
      modelId,
      prepareProviderTransitionRequest,
      reasoningEffort,
      selectedThreadId,
    ],
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
  const {
    sendPrompt,
    sendWidgetPrompt,
    requestWidgetTool,
    regeneratePrompt,
    cancelSteer,
    flushSteers,
    startRunRequest,
    handleApprove,
    handleDeny,
    handleCancel,
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
      workingDirectory,
      modelId,
      selectedThreadId,
      permissionMode,
      reasoningEffort,
      subagentModelRouting,
    },
    cancelState: {
      phase: state.phase,
      activeRunId: getActiveRunId(state),
    },
    ...(prepareStartRequest ? { prepareStartRequest } : {}),
  });

  const handleRunStarted = useHandleRunStarted({
    dispatch,
    clearSessionError,
    loadThreads,
    projectTreeRefreshControllerRef,
    setSelectedThreadId,
  });

  useRunSessionConnection({
    client,
    dispatch,
    projectTreeRefreshControllerRef,
    loadTree,
    handleRunStarted,
    handleRunSettledSuccess: settleRunSuccess,
    handleRunSettleSyncFailed: settleRunSyncFailure,
    handleRunSettledError: settleRunError,
    reportSessionFailure,
  });

  return {
    state,
    permissionMode,
    setPermissionMode,
    modelId,
    setModelId,
    prepareProviderTransition,
    reasoningEffort,
    setReasoningEffort,
    subagentModelRouting,
    setSubagentModelRouting,
    sendPrompt,
    sendWidgetPrompt,
    requestWidgetTool,
    regeneratePrompt,
    cancelSteer,
    flushSteers,
    startRunRequest,
    handleApprove,
    handleDeny,
    handleCancel,
  };
}
