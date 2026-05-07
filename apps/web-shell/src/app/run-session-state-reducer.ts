import {
  activateRunningRun,
  activateCommittedArtifact,
  appendAssistantAnswerText,
  appendAssistantTranscriptTextToActiveRun,
  appendTranscriptActivity,
  clearPendingApprovalState,
  setPendingApproval,
  setRunErrorState,
  setRunSyncFailedState,
} from './run-session-active-run-view.js';
import { applySubagentActivity } from './run-session-subagent-activity.js';
import {
  createEmptyActiveRunView,
  type ActiveRunViewState,
  type RunSessionState,
  type RunSessionStateAction,
} from './run-session-state-types.js';

export function createInitialRunSessionState(): RunSessionState {
  return {
    phase: 'idle',
    pendingStartThreadId: null,
    activeRunView: createEmptyActiveRunView(),
    sessionError: null,
    backgroundNotificationsByThread: {},
  };
}

export function reduceRunSessionState(
  state: RunSessionState,
  action: RunSessionStateAction,
): RunSessionState {
  switch (action.type) {
    case 'run_start_requested':
      return transitionToStarting(state, action.threadId);
    case 'run_started':
      return transitionToRunning(state, action.threadId, action.runId);
    case 'assistant_text_streamed':
      return appendAssistantTextStream(state, action);
    case 'artifact_activated':
      return {
        ...state,
        activeRunView: activateCommittedArtifact(
          state.activeRunView,
          action.threadId,
          action.artifact,
        ),
      };
    case 'transcript_activity_added':
      return {
        ...state,
        activeRunView: appendTranscriptActivity(
          state.activeRunView,
          action.threadId,
          action.entry,
        ),
      };
    case 'approval_requested':
      return {
        ...state,
        activeRunView: setPendingApproval(
          state.activeRunView,
          action.threadId,
          action.pendingApproval,
        ),
      };
    case 'subagent_activity_added':
      return applySubagentActivity(state, action.threadId, action.entry);
    case 'run_settle_sync_started':
      return transitionToSettling(state);
    case 'run_settled_success':
      return transitionToIdle(state);
    case 'run_settle_sync_failed':
      return transitionToSyncFailed(state, action.threadId, action.message);
    case 'run_settled_error':
      return transitionToError(state, action.threadId, action.message);
    case 'run_transport_error':
      return transitionToError(
        state,
        state.activeRunView.threadId,
        action.message,
      );
    case 'session_error_recorded':
      return {
        ...state,
        sessionError: action.message,
      };
    case 'session_error_cleared':
      return {
        ...state,
        sessionError: null,
      };
    case 'run_start_failed':
      return transitionToError(
        state,
        state.activeRunView.threadId,
        action.message,
      );
    case 'approval_submit_failed':
      return {
        ...state,
        activeRunView: {
          ...state.activeRunView,
          streamError: action.message,
        },
      };
    case 'approval_cleared':
      return {
        ...state,
        activeRunView: clearPendingApprovalState(state.activeRunView),
      };
    case 'run_start_cancelled':
      return transitionToIdle(
        state,
        clearPendingApprovalState(state.activeRunView),
      );
  }
}

function appendAssistantTextStream(
  state: RunSessionState,
  action: Extract<RunSessionStateAction, { type: 'assistant_text_streamed' }>,
): RunSessionState {
  if (action.target === 'answer') {
    return {
      ...state,
      activeRunView: appendAssistantAnswerText(
        state.activeRunView,
        action.threadId,
        action.text,
      ),
    };
  }

  return {
    ...state,
    activeRunView: appendAssistantTranscriptTextToActiveRun(
      state.activeRunView,
      action.threadId,
      action.text,
    ),
  };
}

function transitionToStarting(
  state: RunSessionState,
  threadId: string | null,
): RunSessionState {
  return {
    ...state,
    phase: 'starting',
    pendingStartThreadId: threadId,
    activeRunView: createEmptyActiveRunView(threadId),
  };
}

function transitionToRunning(
  state: RunSessionState,
  threadId: string,
  runId: string,
): RunSessionState {
  return {
    ...state,
    phase: 'running',
    pendingStartThreadId: null,
    activeRunView: activateRunningRun(state.activeRunView, threadId, runId),
  };
}

function transitionToError(
  state: RunSessionState,
  threadId: string | null,
  message: string,
): RunSessionState {
  return {
    ...state,
    phase: 'error',
    pendingStartThreadId: null,
    activeRunView: setRunErrorState(state.activeRunView, threadId, message),
  };
}

function transitionToSettling(state: RunSessionState): RunSessionState {
  return {
    ...state,
    phase: 'settling',
    pendingStartThreadId: null,
    activeRunView: clearPendingApprovalState(state.activeRunView),
  };
}

function transitionToSyncFailed(
  state: RunSessionState,
  threadId: string,
  message: string,
): RunSessionState {
  return {
    ...state,
    phase: 'error',
    pendingStartThreadId: null,
    activeRunView: setRunSyncFailedState(
      state.activeRunView,
      threadId,
      message,
    ),
  };
}

function transitionToIdle(
  state: RunSessionState,
  activeRunView: ActiveRunViewState = createEmptyActiveRunView(),
): RunSessionState {
  return {
    ...state,
    phase: 'idle',
    pendingStartThreadId: null,
    activeRunView,
  };
}
