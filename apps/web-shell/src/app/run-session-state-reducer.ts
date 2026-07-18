import {
  activateRunningRun,
  activateCommittedArtifact,
  appendAssistantAnswerText,
  appendAssistantTranscriptTextToActiveRun,
  appendTranscriptActivity,
  clearResolvedPendingApproval,
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

const FAILED_RUN_TERMINAL_MESSAGE =
  'Run ended before completing successfully. The streamed result is still shown.';

export function createInitialRunSessionState(): RunSessionState {
  return {
    phase: 'idle',
    pendingStartThreadId: null,
    activeRunView: createEmptyActiveRunView(),
    sessionError: null,
    backgroundNotificationsByThread: {},
    contextUsageByThread: {},
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
    case 'transcript_activity_added': {
      const appended = appendTranscriptActivity(
        state.activeRunView,
        action.threadId,
        action.entry,
      );
      // 완성본 tool_call이 도착하면 해당 스트리밍 누적은 닫는다
      const clearsStreaming =
        action.streamedToolCallId !== undefined &&
        appended.streamingToolCall?.callId === action.streamedToolCallId;
      return {
        ...state,
        activeRunView: clearsStreaming
          ? { ...appended, streamingToolCall: null }
          : appended,
      };
    }
    case 'tool_call_args_streamed': {
      if (state.activeRunView.threadId !== action.threadId) {
        return state;
      }
      const current = state.activeRunView.streamingToolCall;
      const streamingToolCall =
        current !== null && current.callId === action.callId
          ? { ...current, argsText: current.argsText + action.argsDelta }
          : {
              callId: action.callId,
              tool: action.tool,
              argsText: action.argsDelta,
            };
      return {
        ...state,
        activeRunView: { ...state.activeRunView, streamingToolCall },
      };
    }
    case 'approval_requested':
      return {
        ...state,
        activeRunView: setPendingApproval(
          state.activeRunView,
          action.threadId,
          action.pendingApproval,
        ),
      };
    case 'run_usage_updated':
      // 다른 스레드(백그라운드 차일드 등)의 usage가 현재 뷰를 오염시키지
      // 않게 활성 런 뷰의 스레드에만 반영한다
      if (state.activeRunView.threadId !== action.threadId) {
        return state;
      }
      return {
        ...state,
        activeRunView: {
          ...state.activeRunView,
          usageTotals: action.usage,
        },
      };
    case 'run_context_usage_updated':
      return {
        ...state,
        contextUsageByThread: {
          ...state.contextUsageByThread,
          [action.threadId]: action.contextUsage,
        },
      };
    case 'run_terminal':
      // 성공 런은 앞선 thread_state_persisted/failed 이벤트가 정본이다.
      // 실패 done은 저장 스냅샷 없이 올 수 있으므로 정확히 같은 활성 런만 닫는다.
      if (
        action.ok ||
        (state.phase !== 'running' && state.phase !== 'settling') ||
        state.activeRunView.threadId !== action.threadId ||
        state.activeRunView.runId !== action.runId
      ) {
        return state;
      }
      return transitionToError(
        state,
        action.threadId,
        FAILED_RUN_TERMINAL_MESSAGE,
      );
    case 'steer_queued':
      return {
        ...state,
        activeRunView: {
          ...state.activeRunView,
          threadId: action.threadId || state.activeRunView.threadId,
          pendingSteers: [...state.activeRunView.pendingSteers, action.steer],
        },
      };
    case 'steer_applied': {
      // 소비된 스티어는 큐에서 빠지고, 그 텍스트가 대화(사용자 발화)로
      // 승격된다 — settle 스냅샷이 오면 실제 transcript로 대체된다.
      const appliedSeqs = new Set(action.receivedSeqs);
      const applied = state.activeRunView.pendingSteers.filter((steer) =>
        appliedSeqs.has(steer.receivedSeq),
      );
      if (applied.length === 0) {
        return state;
      }
      const remainingSteers = state.activeRunView.pendingSteers.filter(
        (steer) => !appliedSeqs.has(steer.receivedSeq),
      );
      return {
        ...state,
        activeRunView: {
          ...state.activeRunView,
          pendingSteers: remainingSteers,
          // 소비 1회로 플러시 요청은 목적을 다한다(데몬과 같은 규칙)
          pendingSteerFlushRequested: false,
          transcriptEntries: [
            ...state.activeRunView.transcriptEntries,
            ...applied.map(
              (steer) => ({ kind: 'user_text', text: steer.text }) as const,
            ),
          ],
        },
      };
    }
    case 'steer_cancelled': {
      const remainingSteers = state.activeRunView.pendingSteers.filter(
        (steer) => steer.receivedSeq !== action.receivedSeq,
      );
      return {
        ...state,
        activeRunView: {
          ...state.activeRunView,
          pendingSteers: remainingSteers,
          pendingSteerFlushRequested:
            remainingSteers.length === 0
              ? false
              : state.activeRunView.pendingSteerFlushRequested,
        },
      };
    }
    case 'steer_flush_requested':
      if (state.activeRunView.pendingSteers.length === 0) {
        return state;
      }
      return {
        ...state,
        activeRunView: {
          ...state.activeRunView,
          pendingSteerFlushRequested: true,
        },
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
        activeRunView: clearResolvedPendingApproval(
          state.activeRunView,
          action.pendingApproval,
        ),
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
