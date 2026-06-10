import type { ApprovalRequired } from '@geulbat/protocol/run-approval';
import type { RunTranscriptEntry } from '../lib/run-transcript-entry.js';

import type {
  BackgroundNotificationEntry,
  BackgroundNotificationsByThread,
} from './run-session-state-types.js';

export function appendThreadNotification(
  notificationsByThread: BackgroundNotificationsByThread,
  threadId: string,
  entry: BackgroundNotificationEntry,
): BackgroundNotificationsByThread {
  if (
    entry.kind === 'subagent_activity' &&
    entry.deliveryId &&
    (notificationsByThread[threadId] ?? []).some(
      (existing) =>
        existing.kind === 'subagent_activity' &&
        existing.deliveryId === entry.deliveryId,
    )
  ) {
    return notificationsByThread;
  }
  const nextThreadEntries = [
    ...(notificationsByThread[threadId] ?? []),
    entry,
  ].slice(-10);
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

export function appendSubagentTranscriptEntry(
  entries: RunTranscriptEntry[],
  entry: Extract<RunTranscriptEntry, { kind: 'subagent_activity' }>,
): RunTranscriptEntry[] {
  const alreadyPresent =
    entry.deliveryId !== undefined &&
    entries.some(
      (existing) =>
        existing.kind === 'subagent_activity' &&
        existing.deliveryId === entry.deliveryId,
    );
  if (alreadyPresent) {
    return entries;
  }
  return [...entries, entry];
}
