import {
  useCallback,
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
  RunRequest,
  RunStartRequest,
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

export interface RunSessionControllerClient
  extends
    Pick<RunChannelClient, 'subscribe' | 'close'>,
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
  projectId: string;
  selectedFile: string | null;
  selectedThreadId: string | null;
  loadThreads: () => Promise<void>;
  openFile: (path: string) => Promise<void>;
  appendOptimisticUserMessage: (prompt: string) => void;
  loadTree: () => Promise<void>;
  setSelectedThreadId: (threadId: string | null) => void;
  openThreadForRunSettle: (
    threadId: string,
  ) => Promise<ThreadDetailResponse | null>;
  applyThreadSnapshotForRunSettle?: (thread: ThreadDetailResponse) => boolean;
  createClient?: () => RunSessionControllerClient;
  prepareStartRequest?: (request: RunRequest) => Promise<RunStartRequest>;
}

interface UseRunSessionRuntimeResult {
  state: RunSessionState;
  permissionMode: PermissionMode;
  setPermissionMode: (mode: PermissionMode) => void;
  sendPrompt: (prompt: string) => Promise<void>;
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
  projectId,
  selectedFile,
  selectedThreadId,
  loadThreads,
  loadTree,
  openFile,
  appendOptimisticUserMessage,
  setSelectedThreadId,
  openThreadForRunSettle,
  applyThreadSnapshotForRunSettle = () => true,
  createClient = () => new RunChannelClient(),
  prepareStartRequest,
}: UseRunSessionRuntimeArgs): UseRunSessionRuntimeResult {
  const [client] = useState(() => createClient());
  const projectTreeRefreshControllerRef = useRef(
    createProjectTreeRefreshController(),
  );
  const [state, dispatch] = useReducer(
    reduceRunSessionState,
    undefined,
    createInitialRunSessionState,
  );
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('basic');
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
    startRunRequest,
    handleApprove,
    handleDeny,
    handleCancel,
  } = useRunSessionControllerActions({
    startClient: client,
    approvalClient: client,
    cancelClient: client,
    dispatch,
    projectId,
    appendOptimisticUserMessage,
    clearSessionError,
    reportSessionFailure,
    logCommandFailure,
    promptInputs: {
      selectedThreadId,
      selectedFile,
      permissionMode,
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
    sendPrompt,
    startRunRequest,
    handleApprove,
    handleDeny,
    handleCancel,
  };
}
