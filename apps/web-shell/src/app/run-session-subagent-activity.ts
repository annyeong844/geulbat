import type { RunTranscriptEntry } from '../lib/run-transcript-entry.js';
import { appendSubagentActivityToActiveRun } from './run-session-active-run-view.js';
import { appendThreadNotification } from './run-session-entry-state.js';
import type { RunSessionState } from './run-session-state-types.js';

export function applySubagentActivity(
  state: RunSessionState,
  threadId: string,
  entry: Extract<RunTranscriptEntry, { kind: 'subagent_activity' }>,
): RunSessionState {
  const terminalReplayAlreadyNotified =
    isTerminalSubagentActivity(entry) &&
    (state.backgroundNotificationsByThread[threadId] ?? []).some(
      (existing) =>
        existing.kind === 'subagent_activity' &&
        existing.deliveryId === entry.deliveryId,
    );
  if (terminalReplayAlreadyNotified) {
    return state;
  }

  const shouldAppendToActiveTranscript =
    state.phase !== 'idle' &&
    state.activeRunView.threadId === threadId &&
    (entry.parentRunId === undefined ||
      entry.parentRunId === state.activeRunView.runId);
  if (shouldAppendToActiveTranscript) {
    const nextActiveRunView = appendSubagentActivityToActiveRun(
      state.activeRunView,
      entry,
    );
    if (nextActiveRunView === state.activeRunView) {
      return state;
    }
    return {
      ...state,
      activeRunView: nextActiveRunView,
    };
  }

  // 다른 스레드 또는 같은 스레드의 이전 부모에서 온 child 활동은 원래
  // 부모 답변에 귀속될 수 있도록 addressed notification으로 남긴다.
  return {
    ...state,
    backgroundNotificationsByThread: appendThreadNotification(
      state.backgroundNotificationsByThread,
      threadId,
      entry,
    ),
  };
}

export function preserveSettledSubagentActivities(
  state: RunSessionState,
): RunSessionState {
  const { runId, threadId, transcriptEntries } = state.activeRunView;
  if (runId === null || threadId === null) {
    return state;
  }

  let backgroundNotificationsByThread = state.backgroundNotificationsByThread;
  for (const entry of transcriptEntries) {
    if (entry.kind !== 'subagent_activity' || entry.parentRunId !== runId) {
      continue;
    }
    backgroundNotificationsByThread = appendThreadNotification(
      backgroundNotificationsByThread,
      threadId,
      entry,
    );
  }
  if (
    backgroundNotificationsByThread === state.backgroundNotificationsByThread
  ) {
    return state;
  }
  return { ...state, backgroundNotificationsByThread };
}

function isTerminalSubagentActivity(
  entry: Extract<RunTranscriptEntry, { kind: 'subagent_activity' }>,
): boolean {
  return entry.deliveryId !== undefined;
}
