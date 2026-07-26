import { brandRunId, brandThreadId } from '../lib/id-brand-helpers.js';

export const RUN_ID = brandRunId('run-1');
export const STALE_RUN_ID = brandRunId('run-stale');
export const CHILD_RUN_ID = brandRunId('run-child-1');
export const THREAD_ID_VALUE = '00000000-0000-4000-8000-000000000001';
export const OTHER_THREAD_ID_VALUE = '00000000-0000-4000-8000-000000000002';
export const THREAD_ID = brandThreadId(THREAD_ID_VALUE);

export function createPersistedThreadDetail() {
  return {
    threadId: THREAD_ID,
    snapshotVersion: '2026-04-16T00:00:00.000Z',
    messages: [
      {
        entryId: 'entry-persisted',
        role: 'assistant' as const,
        content: 'persisted',
        timestamp: '2026-04-16T00:00:00.000Z',
      },
    ],
    artifacts: [],
  };
}
