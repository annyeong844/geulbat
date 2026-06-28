import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderHook } from '../test-support/hook-test.js';
import { useThreadSessionSelection } from './use-thread-session-selection.js';

const THREAD_ID = '00000000-0000-4000-8000-000000000001';

void test('useThreadSessionSelection applies only newer snapshots for the same thread', async () => {
  const hook = await renderHook(useThreadSessionSelection, undefined);

  await hook.run((current) =>
    current.applyThreadSnapshotForRunSettle({
      threadId: THREAD_ID,
      snapshotVersion: '2026-04-16T00:00:01.000Z',
      messages: [
        {
          entryId: 'entry-newer',
          role: 'assistant',
          content: 'newer',
          timestamp: '2026-04-16T00:00:01.000Z',
        },
      ],
      artifacts: [],
    }),
  );

  const appliedStaleSnapshot = await hook.run((current) =>
    current.applyThreadSnapshotForRunSettle({
      threadId: THREAD_ID,
      snapshotVersion: '2026-04-16T00:00:00.000Z',
      messages: [
        {
          entryId: 'entry-older',
          role: 'assistant',
          content: 'older',
          timestamp: '2026-04-16T00:00:00.000Z',
        },
      ],
      artifacts: [],
    }),
  );

  assert.equal(appliedStaleSnapshot, false);
  assert.equal(hook.result.current.selectedThreadId, THREAD_ID);
  assert.deepEqual(hook.result.current.messages, [
    {
      entryId: 'entry-newer',
      role: 'assistant',
      content: 'newer',
      timestamp: '2026-04-16T00:00:01.000Z',
    },
  ]);
  hook.unmount();
});

void test('useThreadSessionSelection explicit selection can reselect an unchanged snapshot', async () => {
  const hook = await renderHook(useThreadSessionSelection, undefined);

  await hook.run((current) =>
    current.applyThreadSnapshotForRunSettle({
      threadId: THREAD_ID,
      snapshotVersion: '2026-04-16T00:00:01.000Z',
      messages: [
        {
          entryId: 'entry-settled',
          role: 'assistant',
          content: 'settled',
          timestamp: '2026-04-16T00:00:01.000Z',
        },
      ],
      artifacts: [],
    }),
  );

  await hook.run((current) =>
    current.selectThreadSnapshot({
      threadId: THREAD_ID,
      snapshotVersion: '2026-04-16T00:00:01.000Z',
      messages: [
        {
          entryId: 'entry-explicit-open',
          role: 'assistant',
          content: 'explicit open',
          timestamp: '2026-04-16T00:00:01.000Z',
        },
      ],
      artifacts: [],
    }),
  );

  assert.equal(hook.result.current.selectedThreadId, THREAD_ID);
  assert.deepEqual(hook.result.current.messages, [
    {
      entryId: 'entry-explicit-open',
      role: 'assistant',
      content: 'explicit open',
      timestamp: '2026-04-16T00:00:01.000Z',
    },
  ]);
  hook.unmount();
});

void test('useThreadSessionSelection clears selected thread state for deleted threads', async () => {
  const hook = await renderHook(useThreadSessionSelection, undefined);

  await hook.run((current) =>
    current.applyThreadSnapshotForRunSettle({
      threadId: THREAD_ID,
      snapshotVersion: '2026-04-16T00:00:01.000Z',
      messages: [
        {
          entryId: 'entry-persisted-answer',
          role: 'assistant',
          content: 'persisted answer',
          timestamp: '2026-04-16T00:00:01.000Z',
        },
      ],
      artifacts: [
        {
          artifactId: 'artifact-1',
          version: 1,
          parentVersion: null,
          baseVersion: null,
          renderer: 'markdown',
          payload: '# persisted answer',
          digest: null,
          contentHash: 'sha256:artifact-1',
          createdAt: '2026-04-16T00:00:01.000Z',
          createdByRunId: 'run-1',
          previewValidation: { ok: true },
          title: null,
          persistenceEpoch: 1,
          sourceRef: null,
        },
      ],
    }),
  );

  await hook.run((current) => current.clearThreadSelectionState(THREAD_ID));

  assert.equal(hook.result.current.selectedThreadId, null);
  assert.deepEqual(hook.result.current.messages, []);
  assert.deepEqual(hook.result.current.artifacts, []);
  hook.unmount();
});
