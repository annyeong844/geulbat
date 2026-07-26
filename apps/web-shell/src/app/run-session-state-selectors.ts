import { createArtifactRefKey } from '@geulbat/protocol/artifacts';
import type {
  RunSessionState,
  ActiveRunViewState,
  RunSessionLaneState,
  VisibleRunState,
} from './run-session-state-types.js';
import { createRunSessionLaneState } from './run-session-state-types.js';

interface SelectVisibleRunStateArgs {
  selectedThreadId: string | null;
  state: RunSessionState;
}

export function selectRunSessionLaneState(
  state: RunSessionState,
  threadId: string | null,
): RunSessionLaneState {
  const stored =
    threadId === null
      ? state.newThreadRunLane
      : state.runLanesByThread?.[threadId];
  if (stored !== undefined) {
    return stored;
  }
  const legacyMatches =
    threadId === null
      ? state.phase !== 'idle'
      : state.activeRunView.threadId === threadId ||
        (state.phase === 'starting' && state.pendingStartThreadId === threadId);
  return legacyMatches
    ? { phase: state.phase, activeRunView: state.activeRunView }
    : createRunSessionLaneState(threadId);
}

export function isRunSessionStarting(
  state: RunSessionState,
  threadId?: string | null,
): boolean {
  return threadId === undefined
    ? state.phase === 'starting'
    : selectRunSessionLaneState(state, threadId).phase === 'starting';
}

export function getActiveRunId(
  state: RunSessionState,
  threadId?: string | null,
): string | null {
  const lane =
    threadId === undefined
      ? { phase: state.phase, activeRunView: state.activeRunView }
      : selectRunSessionLaneState(state, threadId);
  return lane.phase === 'running' ? lane.activeRunView.runId : null;
}

export function selectVisibleRunState({
  selectedThreadId,
  state,
}: SelectVisibleRunStateArgs): VisibleRunState {
  const lane = selectRunSessionLaneState(state, selectedThreadId);
  const isStarting = lane.phase === 'starting';
  const showRunState = lane.phase !== 'idle';
  const visibleThreadId = showRunState
    ? (lane.activeRunView.threadId ?? selectedThreadId)
    : selectedThreadId;

  return {
    visibleThreadId,
    activeRunId: showRunState ? lane.activeRunView.runId : null,
    transcriptEntries: showRunState
      ? appendStreamingToolEntry(lane.activeRunView)
      : [],
    finalAnswerText: showRunState ? lane.activeRunView.finalAnswerText : '',
    activeArtifact: showRunState
      ? resolveActiveArtifact(lane.activeRunView)
      : null,
    streamingArtifactText: showRunState
      ? lane.activeRunView.streamingArtifactText
      : '',
    // Approvals are keyed to the active run view, not the payload threadId:
    // a worker(child)-run approval carries the child threadId but must still
    // surface on the parent session that owns the run.
    pendingApproval: showRunState ? lane.activeRunView.pendingApproval : null,
    pendingSteers: showRunState ? lane.activeRunView.pendingSteers : [],
    pendingSteerFlushRequested: showRunState
      ? lane.activeRunView.pendingSteerFlushRequested
      : false,
    usageTotals: showRunState ? lane.activeRunView.usageTotals : null,
    providerRuntime: showRunState ? lane.activeRunView.providerRuntime : null,
    contextUsage:
      visibleThreadId === null
        ? null
        : (state.contextUsageByThread[visibleThreadId] ?? null),
    streamError: showRunState
      ? (lane.activeRunView.streamError ?? state.sessionError)
      : state.sessionError,
    streamErrorCode:
      showRunState && lane.activeRunView.streamError !== null
        ? lane.activeRunView.streamErrorCode
        : null,
    backgroundNotifications:
      visibleThreadId === null
        ? []
        : (state.backgroundNotificationsByThread[visibleThreadId] ?? []),
    isRunning: showRunState && (isStarting || lane.phase === 'running'),
    isSettling: showRunState && lane.phase === 'settling',
  };
}

// 스트리밍 중인 도구 호출을 라이브 꼬리 엔트리로 노출한다 — 완성본
// tool_call이 도착하면 스트리밍이 닫히고 일반 엔트리가 대체한다.
function appendStreamingToolEntry(
  activeRunView: ActiveRunViewState,
): VisibleRunState['transcriptEntries'] {
  const streaming = activeRunView.streamingToolCall;
  if (streaming === null || streaming.argsText === '') {
    return activeRunView.transcriptEntries;
  }
  return [
    ...activeRunView.transcriptEntries,
    {
      kind: 'tool_activity',
      tool: streaming.tool,
      state: 'running',
      argsText: streaming.argsText,
    },
  ];
}

function resolveActiveArtifact(
  activeRunView: ActiveRunViewState,
): VisibleRunState['activeArtifact'] {
  if (!activeRunView.activeArtifactRef) {
    return null;
  }
  return (
    activeRunView.artifactsByRef[
      createArtifactRefKey(activeRunView.activeArtifactRef)
    ] ?? null
  );
}
