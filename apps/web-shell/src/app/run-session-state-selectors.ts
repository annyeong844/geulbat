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
      ? state.activeRunView.transcriptEntries
      : [],
    finalAnswerText: showRunState ? state.activeRunView.finalAnswerText : '',
    activeArtifact: showRunState
      ? resolveActiveArtifact(state.activeRunView)
      : null,
    pendingApproval:
      showRunState &&
      state.activeRunView.pendingApproval?.threadId === visibleThreadId
        ? state.activeRunView.pendingApproval
        : null,
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
