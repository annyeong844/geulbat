import type { RunTranscriptEntry } from '../lib/run-transcript-entry.js';
import { appendSubagentActivityToActiveRun } from './run-session-active-run-view.js';
import { appendThreadNotification } from './run-session-entry-state.js';
import type { RunSessionState } from './run-session-state-types.js';

export function applySubagentActivity(
  state: RunSessionState,
  threadId: string,
  entry: Extract<RunTranscriptEntry, { kind: 'subagent_activity' }>,
): RunSessionState {
  const shouldAppendToActiveTranscript =
    state.phase !== 'idle' && state.activeRunView.threadId === threadId;
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

  return {
    ...state,
    backgroundNotificationsByThread: appendThreadNotification(
      state.backgroundNotificationsByThread,
      threadId,
      entry,
    ),
  };
}
