import type { ThreadMessage } from '@geulbat/protocol/threads';

import type { RunTranscriptEntry } from '../../lib/run-transcript-entry.js';

export function createStableOccurrenceKeys<T>(
  items: readonly T[],
  getBaseKey: (item: T) => string,
): string[] {
  const counts = new Map<string, number>();
  return items.map((item) => {
    const baseKey = getBaseKey(item);
    const nextCount = (counts.get(baseKey) ?? 0) + 1;
    counts.set(baseKey, nextCount);
    return `${baseKey}::${nextCount}`;
  });
}

export function getThreadMessageBaseKey(message: ThreadMessage): string {
  return `message:${message.entryId}`;
}

export function getRunTranscriptEntryBaseKey(
  entry: RunTranscriptEntry,
): string {
  switch (entry.kind) {
    case 'assistant_text':
      return 'assistant_text';
    case 'user_text':
      return 'user_text';
    case 'tool_activity':
      return `tool_activity:${entry.tool}`;
    case 'approval_request':
      return `approval:${entry.pendingApproval.callId}`;
    case 'subagent_activity':
      return `subagent:${entry.childRunId}`;
  }
}
