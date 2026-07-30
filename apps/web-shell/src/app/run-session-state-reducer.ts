import type { ErrorCode } from '@geulbat/protocol/errors';
import type { RunTranscriptEntry } from '../lib/run-transcript-entry.js';

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
import {
  applySubagentActivity,
  preserveSettledSubagentActivities,
} from './run-session-subagent-activity.js';
import {
  createEmptyActiveRunView,
  createRunSessionLaneState,
  type ActiveRunViewState,
  type RunSessionLaneState,
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
    runLanesByThread: {},
    newThreadRunLane: createRunSessionLaneState(),
    sessionError: null,
    backgroundNotificationsByThread: {},
    contextUsageByThread: {},
  };
}

export function reduceRunSessionState(
  state: RunSessionState,
  action: RunSessionStateAction,
): RunSessionState {
  if (action.type === 'new_session_started') {
    return {
      ...state,
      newThreadRunLane: createRunSessionLaneState(),
      sessionError: null,
    };
  }
  if (action.type === 'new_thread_run_adopted') {
    if (state.newThreadRunLane?.activeRunView.threadId !== action.threadId) {
      return state;
    }
    return {
      ...state,
      newThreadRunLane: createRunSessionLaneState(),
    };
  }
  const laneThreadId = resolveActionLaneThreadId(state, action);
  if (laneThreadId === undefined) {
    return reduceSingleRunSessionState(state, action);
  }

  const existingLane = readStoredRunLane(state, laneThreadId);
  const newThreadRunLane =
    state.newThreadRunLane ?? createRunSessionLaneState();
  const consumesNewThreadLane =
    action.type === 'run_started' &&
    existingLane === undefined &&
    newThreadRunLane.phase === 'starting';
  if (
    existingLane === undefined &&
    !consumesNewThreadLane &&
    action.type !== 'run_start_requested' &&
    action.type !== 'run_started'
  ) {
    return action.type === 'subagent_activity_added'
      ? reduceSingleRunSessionState(state, action)
      : state;
  }
  const lane =
    existingLane ??
    (consumesNewThreadLane
      ? newThreadRunLane
      : createRunSessionLaneState(laneThreadId));
  const mirrorsNewThreadLane =
    laneThreadId !== null &&
    newThreadRunLane.activeRunView.threadId === laneThreadId &&
    newThreadRunLane.activeRunView.runId !== null &&
    newThreadRunLane.activeRunView.runId === lane.activeRunView.runId;
  const reduced = reduceSingleRunSessionState(
    {
      ...state,
      phase: lane.phase,
      pendingStartThreadId: lane.phase === 'starting' ? laneThreadId : null,
      activeRunView: lane.activeRunView,
    },
    action,
  );
  if (
    reduced.phase === lane.phase &&
    reduced.activeRunView === lane.activeRunView
  ) {
    if (
      reduced.sessionError === state.sessionError &&
      reduced.backgroundNotificationsByThread ===
        state.backgroundNotificationsByThread &&
      reduced.contextUsageByThread === state.contextUsageByThread
    ) {
      return state;
    }
    return {
      ...state,
      sessionError: reduced.sessionError,
      backgroundNotificationsByThread: reduced.backgroundNotificationsByThread,
      contextUsageByThread: reduced.contextUsageByThread,
    };
  }
  const nextLane: RunSessionLaneState = {
    phase: reduced.phase,
    activeRunView: reduced.activeRunView,
  };

  if (laneThreadId === null) {
    return {
      ...reduced,
      newThreadRunLane: nextLane,
    };
  }
  return {
    ...reduced,
    runLanesByThread: {
      ...(reduced.runLanesByThread ?? {}),
      [laneThreadId]: nextLane,
    },
    ...(consumesNewThreadLane || mirrorsNewThreadLane
      ? { newThreadRunLane: nextLane }
      : {}),
  };
}

function reduceSingleRunSessionState(
  state: RunSessionState,
  action: RunSessionStateAction,
): RunSessionState {
  switch (action.type) {
    case 'new_session_started':
      return state;
    case 'new_thread_run_adopted':
      return state;
    case 'run_start_requested':
      return transitionToStarting(state, action.threadId);
    case 'run_started':
      return transitionToRunning(state, action.threadId, action.runId);
    case 'assistant_text_streamed':
      return appendAssistantTextStream(state, action);
    case 'artifact_activated':
      return {
        ...state,
        activeRunView: {
          ...activateCommittedArtifact(
            state.activeRunView,
            action.threadId,
            action.artifact,
          ),
          // 라이브 스트림은 커밋본으로 대체됐다 — 중앙 창이 렌더로 전환
          streamingArtifactText: '',
          providerRuntime: null,
        },
      };
    case 'artifact_text_streamed':
      if (state.activeRunView.threadId !== action.threadId) {
        return state;
      }
      return {
        ...state,
        activeRunView: {
          ...state.activeRunView,
          streamingArtifactText:
            state.activeRunView.streamingArtifactText + action.text,
          providerRuntime: null,
        },
      };
    case 'transcript_activity_added': {
      const appended = appendTranscriptActivity(
        state.activeRunView,
        action.threadId,
        action.entry,
      );
      const terminalToolCallId =
        action.entry.kind === 'tool_activity' &&
        action.entry.state !== 'running'
          ? action.entry.callId
          : undefined;
      const matchingApproval =
        terminalToolCallId === undefined
          ? undefined
          : appended.pendingApprovals.find(
              (approval) =>
                approval.callId === terminalToolCallId &&
                approval.runId === action.runId &&
                approval.threadId === action.threadId,
            );
      const afterApprovalSettlement =
        matchingApproval === undefined
          ? appended
          : clearResolvedPendingApproval(appended, matchingApproval);
      // 완성본 tool_call이 도착하면 해당 스트리밍 누적은 닫는다
      const clearsStreaming =
        action.streamedToolCallId !== undefined &&
        afterApprovalSettlement.streamingToolCall?.callId ===
          action.streamedToolCallId;
      return {
        ...state,
        activeRunView: clearsStreaming
          ? {
              ...afterApprovalSettlement,
              streamingToolCall: null,
              providerRuntime: null,
            }
          : { ...afterApprovalSettlement, providerRuntime: null },
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
        activeRunView: {
          ...state.activeRunView,
          streamingToolCall,
          providerRuntime: null,
        },
      };
    }
    case 'tool_output_streamed': {
      if (
        state.activeRunView.threadId !== action.threadId ||
        action.text.length === 0
      ) {
        return state;
      }
      const transcriptEntries = state.activeRunView.transcriptEntries;
      let matchingIndex = -1;
      let matchingEntry:
        | Extract<RunTranscriptEntry, { kind: 'tool_activity' }>
        | undefined;
      for (let index = transcriptEntries.length - 1; index >= 0; index -= 1) {
        const entry = transcriptEntries[index];
        if (
          entry?.kind === 'tool_activity' &&
          entry.state === 'running' &&
          entry.callId === action.callId &&
          entry.tool === action.tool
        ) {
          matchingIndex = index;
          matchingEntry = entry;
          break;
        }
      }
      if (matchingIndex < 0 || matchingEntry === undefined) {
        return state;
      }
      const output = matchingEntry.output ?? { stdout: '', stderr: '' };
      const nextEntries = [...transcriptEntries];
      nextEntries[matchingIndex] = {
        ...matchingEntry,
        output: {
          ...output,
          [action.stream]: output[action.stream] + action.text,
        },
      };
      return {
        ...state,
        activeRunView: {
          ...state.activeRunView,
          transcriptEntries: nextEntries,
          providerRuntime: null,
        },
      };
    }
    case 'approval_requested':
      if (
        state.phase !== 'running' ||
        state.activeRunView.runId !== action.runId ||
        state.activeRunView.threadId !== action.threadId ||
        action.pendingApproval.threadId !== action.threadId
      ) {
        return state;
      }
      return {
        ...state,
        activeRunView: {
          ...setPendingApproval(
            state.activeRunView,
            action.threadId,
            action.pendingApproval,
          ),
          providerRuntime: null,
        },
      };
    case 'run_usage_updated':
      // 다른 스레드(백그라운드 차일드 등)의 usage가 현재 뷰를 오염시키지
      // 않게 정확히 같은 활성 런에만 반영한다
      if (
        state.activeRunView.runId !== action.runId ||
        state.activeRunView.threadId !== action.threadId
      ) {
        return state;
      }
      return {
        ...state,
        activeRunView: {
          ...state.activeRunView,
          usageTotals: action.usage,
        },
      };
    case 'run_context_usage_updated': {
      const current = state.contextUsageByThread[action.threadId];
      if (
        action.contextUsage.quality === 'unknown' &&
        current?.modelId === action.contextUsage.modelId &&
        current.quality !== 'unknown'
      ) {
        return state;
      }
      return {
        ...state,
        contextUsageByThread: {
          ...state.contextUsageByThread,
          [action.threadId]: action.contextUsage,
        },
      };
    }
    case 'provider_runtime_updated':
      if (
        state.activeRunView.runId !== action.runId ||
        state.activeRunView.threadId !== action.threadId
      ) {
        return state;
      }
      return {
        ...state,
        activeRunView: {
          ...state.activeRunView,
          providerRuntime: action.providerRuntime,
        },
      };
    case 'run_terminal':
      // 성공 런은 앞선 thread_state_persisted/delta/failed 이벤트가 정본이다.
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
        null,
        FAILED_RUN_TERMINAL_MESSAGE,
      );
    case 'steer_queued':
      if (
        state.phase !== 'running' ||
        state.activeRunView.runId !== action.runId ||
        state.activeRunView.threadId !== action.threadId
      ) {
        return state;
      }
      return {
        ...state,
        activeRunView: {
          ...state.activeRunView,
          // 보낸 말은 즉시 대화에 보이되 pendingSteerSeq를 달고 반짝인다.
          // 모델에는 아직 넣지 않는다. 다음 요청 전 자연 소비 또는 사용자의
          // 명시적 flush만 그 경계를 넘는다.
          pendingSteers: [...state.activeRunView.pendingSteers, action.steer],
          transcriptEntries: [
            ...state.activeRunView.transcriptEntries,
            {
              kind: 'user_text',
              text: action.steer.text,
              pendingSteerSeq: action.steer.receivedSeq,
            },
          ],
        },
      };
    case 'steer_applied': {
      if (
        state.activeRunView.runId !== action.runId ||
        state.activeRunView.threadId !== action.threadId
      ) {
        return state;
      }
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
          // 반영되면 이미 대화에 보이던 말의 반짝임만 걷는다. 재연결 경합 등
          // 로컬 pending 행이 없던 경우에만 실제 적용 이벤트가 말을 보충한다.
          transcriptEntries: [
            ...state.activeRunView.transcriptEntries.map((entry) =>
              entry.kind === 'user_text' &&
              entry.pendingSteerSeq !== undefined &&
              appliedSeqs.has(entry.pendingSteerSeq)
                ? { kind: 'user_text' as const, text: entry.text }
                : entry,
            ),
            ...applied
              .filter(
                (steer) =>
                  !state.activeRunView.transcriptEntries.some(
                    (entry) =>
                      entry.kind === 'user_text' &&
                      entry.pendingSteerSeq === steer.receivedSeq,
                  ),
              )
              .map((steer) => ({
                kind: 'user_text' as const,
                text: steer.text,
              })),
          ],
        },
      };
    }
    case 'steer_cancelled': {
      if (state.activeRunView.runId !== action.runId) {
        return state;
      }
      const remainingSteers = state.activeRunView.pendingSteers.filter(
        (steer) => steer.receivedSeq !== action.receivedSeq,
      );
      return {
        ...state,
        activeRunView: {
          ...state.activeRunView,
          pendingSteers: remainingSteers,
          // 아직 읽히지 않은 말만 지운다 — 이미 읽힌 말은 대화의 일부다.
          transcriptEntries: state.activeRunView.transcriptEntries.filter(
            (entry) =>
              !(
                entry.kind === 'user_text' &&
                entry.pendingSteerSeq === action.receivedSeq
              ),
          ),
          pendingSteerFlushRequested:
            remainingSteers.length === 0
              ? false
              : state.activeRunView.pendingSteerFlushRequested,
        },
      };
    }
    case 'steer_flush_requested':
      if (
        state.activeRunView.runId !== action.runId ||
        state.activeRunView.pendingSteers.length === 0
      ) {
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
      if (
        action.runId !== undefined &&
        state.activeRunView.runId !== action.runId
      ) {
        return state;
      }
      return transitionToSettling(state);
    case 'run_settled_success':
      if (
        action.runId !== undefined &&
        state.activeRunView.runId !== action.runId
      ) {
        return state;
      }
      return transitionToIdle(preserveSettledSubagentActivities(state));
    case 'run_settle_sync_failed':
      if (
        action.runId !== undefined &&
        state.activeRunView.runId !== action.runId
      ) {
        return state;
      }
      return transitionToSyncFailed(state, action.threadId, action.message);
    case 'run_settled_error':
      if (
        action.runId !== undefined &&
        state.activeRunView.runId !== action.runId
      ) {
        return state;
      }
      return transitionToError(
        state,
        action.threadId,
        action.code,
        action.message,
      );
    case 'run_transport_error':
      return {
        ...state,
        sessionError: action.message,
      };
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
        null,
        action.message,
      );
    case 'approval_submit_failed':
      return {
        ...state,
        activeRunView: {
          ...state.activeRunView,
          streamError: action.message,
          streamErrorCode: null,
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

function resolveActionLaneThreadId(
  state: RunSessionState,
  action: RunSessionStateAction,
): string | null | undefined {
  switch (action.type) {
    case 'new_thread_run_adopted':
      return undefined;
    case 'run_start_requested':
    case 'run_started':
    case 'assistant_text_streamed':
    case 'artifact_activated':
    case 'artifact_text_streamed':
    case 'transcript_activity_added':
    case 'tool_call_args_streamed':
    case 'tool_output_streamed':
    case 'approval_requested':
    case 'run_usage_updated':
    case 'provider_runtime_updated':
    case 'run_terminal':
    case 'steer_queued':
    case 'steer_applied':
    case 'subagent_activity_added':
    case 'run_settle_sync_failed':
    case 'run_settled_error':
      return action.threadId;
    case 'steer_cancelled':
    case 'steer_flush_requested':
      return findRunLaneThreadId(state, action.runId);
    case 'run_settle_sync_started':
    case 'run_settled_success':
      return (
        action.threadId ??
        (action.runId === undefined
          ? state.activeRunView.threadId
          : findRunLaneThreadId(state, action.runId))
      );
    case 'run_start_failed':
      return action.threadId ?? state.pendingStartThreadId;
    case 'approval_submit_failed':
      return action.threadId ?? state.activeRunView.threadId;
    case 'approval_cleared':
      return (
        action.pendingApproval?.threadId ??
        action.threadId ??
        state.activeRunView.threadId
      );
    case 'run_start_cancelled':
      return action.threadId ?? state.pendingStartThreadId;
    case 'run_context_usage_updated':
    case 'run_transport_error':
    case 'session_error_recorded':
    case 'session_error_cleared':
      return undefined;
  }
}

function readStoredRunLane(
  state: RunSessionState,
  threadId: string | null,
): RunSessionLaneState | undefined {
  const stored =
    threadId === null
      ? state.newThreadRunLane
      : state.runLanesByThread?.[threadId];
  if (stored !== undefined) {
    return stored;
  }
  const legacyMatches =
    threadId === null
      ? state.activeRunView.threadId === null && state.phase !== 'idle'
      : state.activeRunView.threadId === threadId ||
        (state.phase === 'starting' && state.pendingStartThreadId === threadId);
  return legacyMatches
    ? { phase: state.phase, activeRunView: state.activeRunView }
    : undefined;
}

function findRunLaneThreadId(
  state: RunSessionState,
  runId: string,
): string | null | undefined {
  if (state.newThreadRunLane?.activeRunView.runId === runId) {
    return null;
  }
  for (const [threadId, lane] of Object.entries(state.runLanesByThread ?? {})) {
    if (lane.activeRunView.runId === runId) {
      return threadId;
    }
  }
  return state.activeRunView.runId === runId
    ? state.activeRunView.threadId
    : undefined;
}

function appendAssistantTextStream(
  state: RunSessionState,
  action: Extract<RunSessionStateAction, { type: 'assistant_text_streamed' }>,
): RunSessionState {
  const activeRunView =
    action.target === 'answer'
      ? appendAssistantAnswerText(
          state.activeRunView,
          action.threadId,
          action.text,
        )
      : appendAssistantTranscriptTextToActiveRun(
          state.activeRunView,
          action.threadId,
          action.text,
        );

  return {
    ...state,
    activeRunView: {
      ...activeRunView,
      providerRuntime: null,
    },
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
  code: ErrorCode | null,
  message: string,
): RunSessionState {
  return {
    ...state,
    phase: 'error',
    pendingStartThreadId: null,
    activeRunView: setRunErrorState(
      state.activeRunView,
      threadId,
      code,
      message,
    ),
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
