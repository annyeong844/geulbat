import { createArtifactRefKey } from '@geulbat/protocol/artifacts';
import type {
  RunSessionState,
  ActiveRunViewState,
  VisibleRunState,
} from './run-session-state-types.js';

interface SelectVisibleRunStateArgs {
  selectedThreadId: string | null;
  state: RunSessionState;
}

export function isRunSessionStarting(state: RunSessionState): boolean {
  return state.phase === 'starting';
}

export function getActiveRunId(state: RunSessionState): string | null {
  return state.phase === 'running' ? state.activeRunView.runId : null;
}

export function selectVisibleRunState({
  selectedThreadId,
  state,
}: SelectVisibleRunStateArgs): VisibleRunState {
  const isStarting = isRunSessionStarting(state);
  const showingPendingExistingThread =
    isStarting &&
    state.activeRunView.runId === null &&
    state.pendingStartThreadId !== null &&
    state.pendingStartThreadId === selectedThreadId;
  const showingPendingNewThread =
    isStarting &&
    state.activeRunView.runId === null &&
    state.pendingStartThreadId === null &&
    selectedThreadId === null;
  const showingActiveThread =
    (state.phase === 'running' ||
      state.phase === 'settling' ||
      state.phase === 'error') &&
    state.activeRunView.threadId !== null &&
    state.activeRunView.threadId === selectedThreadId;
  const showingUnselectedActiveThread =
    (state.phase === 'running' ||
      state.phase === 'settling' ||
      state.phase === 'error') &&
    selectedThreadId === null &&
    state.activeRunView.threadId !== null;
  const showingThreadlessError =
    state.phase === 'error' &&
    state.activeRunView.threadId === null &&
    selectedThreadId === null;
  const showRunState =
    showingPendingExistingThread ||
    showingPendingNewThread ||
    showingActiveThread ||
    showingUnselectedActiveThread ||
    showingThreadlessError;
  const visibleThreadId = showRunState
    ? (state.activeRunView.threadId ?? selectedThreadId)
    : selectedThreadId;

  return {
    visibleThreadId,
    activeRunId: showRunState ? state.activeRunView.runId : null,
    transcriptEntries: showRunState
      ? appendStreamingToolEntry(state.activeRunView)
      : [],
    finalAnswerText: showRunState ? state.activeRunView.finalAnswerText : '',
    activeArtifact: showRunState
      ? resolveActiveArtifact(state.activeRunView)
      : null,
    // Approvals are keyed to the active run view, not the payload threadId:
    // a worker(child)-run approval carries the child threadId but must still
    // surface on the parent session that owns the run.
    pendingApproval: showRunState ? state.activeRunView.pendingApproval : null,
    pendingSteers: showRunState ? state.activeRunView.pendingSteers : [],
    pendingSteerFlushRequested: showRunState
      ? state.activeRunView.pendingSteerFlushRequested
      : false,
    usageTotals: showRunState ? state.activeRunView.usageTotals : null,
    contextUsage:
      visibleThreadId === null
        ? null
        : (state.contextUsageByThread[visibleThreadId] ?? null),
    streamError: showRunState
      ? (state.activeRunView.streamError ?? state.sessionError)
      : state.sessionError,
    backgroundNotifications:
      visibleThreadId === null
        ? []
        : (state.backgroundNotificationsByThread[visibleThreadId] ?? []),
    isRunning: showRunState && (isStarting || state.phase === 'running'),
    isSettling: showRunState && state.phase === 'settling',
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
