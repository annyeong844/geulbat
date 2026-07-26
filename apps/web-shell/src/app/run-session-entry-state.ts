import type { ApprovalRequired } from '@geulbat/protocol/run-approval';
import type { RunTranscriptEntry } from '../lib/run-transcript-entry.js';

import type {
  BackgroundNotificationEntry,
  BackgroundNotificationsByThread,
} from './run-session-state-types.js';

export { appendSubagentTranscriptEntry } from '../lib/run-transcript-entry.js';

export function appendThreadNotification(
  notificationsByThread: BackgroundNotificationsByThread,
  threadId: string,
  entry: BackgroundNotificationEntry,
): BackgroundNotificationsByThread {
  const currentThreadEntries = notificationsByThread[threadId] ?? [];
  if (
    entry.kind === 'subagent_activity' &&
    entry.deliveryId &&
    currentThreadEntries.some(
      (existing) =>
        existing.kind === 'subagent_activity' &&
        existing.deliveryId === entry.deliveryId,
    )
  ) {
    return notificationsByThread;
  }
  const existingChildIndex = currentThreadEntries.findIndex(
    (existing) =>
      existing.kind === 'subagent_activity' &&
      entry.kind === 'subagent_activity' &&
      existing.childRunId === entry.childRunId,
  );
  const nextThreadEntries =
    existingChildIndex === -1
      ? [...currentThreadEntries, entry]
      : currentThreadEntries.map((existing, index) =>
          index === existingChildIndex &&
          existing.kind === 'subagent_activity' &&
          entry.kind === 'subagent_activity'
            ? { ...existing, ...entry }
            : existing,
        );
  return {
    ...notificationsByThread,
    [threadId]: nextThreadEntries,
  };
}

export function appendAssistantTranscriptText(
  entries: RunTranscriptEntry[],
  text: string,
): RunTranscriptEntry[] {
  if (text.length === 0) {
    return entries;
  }

  const lastEntry = entries.at(-1);
  if (lastEntry?.kind !== 'assistant_text') {
    return [...entries, { kind: 'assistant_text', text }];
  }

  return [
    ...entries.slice(0, -1),
    {
      kind: 'assistant_text',
      text: lastEntry.text + text,
    },
  ];
}

export function appendApprovalRequestEntry(
  entries: RunTranscriptEntry[],
  pendingApproval: ApprovalRequired,
): RunTranscriptEntry[] {
  return [
    ...entries,
    {
      kind: 'approval_request',
      pendingApproval,
    },
  ];
}
