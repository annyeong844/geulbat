import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderHook } from '../test-support/hook-test.js';
import { brandRunId, brandThreadId } from '../lib/id-brand-helpers.js';
import { useThreadSessionSelection } from './use-thread-session-selection.js';

const THREAD_ID = brandThreadId('00000000-0000-4000-8000-000000000001');
const OTHER_THREAD_ID = brandThreadId('00000000-0000-4000-8000-000000000002');

void test('useThreadSessionSelection applies only newer snapshots for the same thread', async () => {
  const hook = await renderHook(useThreadSessionSelection, undefined);

  await hook.run((current) =>
    current.applyThreadSnapshotForRunSettle({
      threadId: THREAD_ID,
      snapshotVersion: '2026-04-16T00:00:01.000Z',
      activeModelId: 'grok-4.5',
      runPreferences: {
        workingDirectory: '/workspace/thread-one',
        permissionMode: 'full_access',
        reasoningEffort: 'high',
        subagentModelRouting: { mode: 'auto' },
      },
      messages: [
        {
          entryId: 'entry-newer',
          role: 'assistant',
          content: 'newer',
          timestamp: '2026-04-16T00:00:01.000Z',
        },
      ],
      artifacts: [],
      subagentTerminalOutcomes: [
        {
          deliveryId: 'delivery-history',
          parentRunId: brandRunId('run-parent'),
          childRunId: brandRunId('run-child'),
          subagentType: 'worker',
          terminalState: 'failed',
          reason: 'daemon_restart',
          result: 'partial result',
          completedAt: '2026-04-16T00:00:01.000Z',
        },
      ],
    }),
  );

  const appliedStaleSnapshot = await hook.run((current) =>
    current.applyThreadSnapshotForRunSettle({
      threadId: THREAD_ID,
      snapshotVersion: '2026-04-16T00:00:00.000Z',
      activeModelId: 'gpt-5.6-sol',
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
  assert.equal(hook.result.current.activeModelId, 'grok-4.5');
  assert.deepEqual(hook.result.current.runPreferences, {
    workingDirectory: '/workspace/thread-one',
    permissionMode: 'full_access',
    reasoningEffort: 'high',
    subagentModelRouting: { mode: 'auto' },
  });
  assert.deepEqual(hook.result.current.messages, [
    {
      entryId: 'entry-newer',
      role: 'assistant',
      content: 'newer',
      timestamp: '2026-04-16T00:00:01.000Z',
    },
  ]);
  assert.equal(
    hook.result.current.subagentTerminalOutcomes[0]?.deliveryId,
    'delivery-history',
  );
  hook.unmount();
});

void test('useThreadSessionSelection replaces only the transcript suffix anchored before the settled run', async () => {
  const hook = await renderHook(useThreadSessionSelection, undefined);

  await hook.run((current) =>
    current.selectThreadSnapshot({
      threadId: THREAD_ID,
      snapshotVersion: '2026-04-16T00:00:01.000Z',
      messages: [
        {
          entryId: 'entry-before-run',
          role: 'assistant',
          content: 'retained history',
          timestamp: '2026-04-16T00:00:00.000Z',
        },
        {
          entryId: 'optimistic:current-prompt',
          role: 'user',
          content: 'temporary prompt',
          timestamp: '2026-04-16T00:00:01.000Z',
        },
      ],
      subagentTerminalOutcomes: [
        {
          deliveryId: 'delivery-retained-across-delta',
          parentRunId: brandRunId('run-parent-delta'),
          childRunId: brandRunId('run-child-delta'),
          subagentType: 'worker',
          terminalState: 'failed',
          reason: 'daemon_restart',
          result: 'done',
          completedAt: '2026-04-16T00:00:01.000Z',
        },
      ],
    }),
  );

  const applied = await hook.run((current) =>
    current.applyThreadSnapshotForRunSettle({
      threadId: THREAD_ID,
      snapshotVersion: '2026-04-16T00:00:02.000Z',
      baseEntryId: 'entry-before-run',
      messages: [
        {
          entryId: 'entry-persisted-prompt',
          role: 'user',
          content: 'persisted prompt',
          timestamp: '2026-04-16T00:00:01.000Z',
        },
        {
          entryId: 'entry-persisted-answer',
          role: 'assistant',
          content: 'persisted answer',
          timestamp: '2026-04-16T00:00:02.000Z',
        },
      ],
      artifacts: [],
    }),
  );

  assert.equal(applied, true);
  assert.deepEqual(
    hook.result.current.messages.map((message) => [
      message.entryId,
      message.content,
    ]),
    [
      ['entry-before-run', 'retained history'],
      ['entry-persisted-prompt', 'persisted prompt'],
      ['entry-persisted-answer', 'persisted answer'],
    ],
  );
  assert.deepEqual(hook.result.current.subagentTerminalOutcomes, []);
  hook.unmount();
});

void test('useThreadSessionSelection prepends an older page only to its exact current thread anchor', async () => {
  const hook = await renderHook(useThreadSessionSelection, undefined);

  await hook.run((current) =>
    current.selectThreadSnapshot({
      threadId: THREAD_ID,
      snapshotVersion: '2026-07-29T00:00:02.000Z',
      messages: [
        {
          entryId: 'entry-latest-user',
          role: 'user',
          content: 'latest question',
          timestamp: '2026-07-29T00:00:01.000Z',
        },
        {
          entryId: 'entry-latest-answer',
          role: 'assistant',
          content: 'latest answer',
          timestamp: '2026-07-29T00:00:02.000Z',
        },
      ],
      olderMessagesBeforeEntryId: 'entry-latest-user',
    }),
  );

  await hook.run((current) =>
    current.prependThreadMessagePage({
      threadId: THREAD_ID,
      beforeEntryId: 'entry-latest-user',
      page: {
        threadId: THREAD_ID,
        messages: [
          {
            entryId: 'entry-older-user',
            role: 'user',
            content: 'older question',
            timestamp: '2026-07-29T00:00:00.000Z',
          },
        ],
        olderBeforeEntryId: null,
      },
    }),
  );

  assert.deepEqual(
    hook.result.current.messages.map((message) => message.entryId),
    ['entry-older-user', 'entry-latest-user', 'entry-latest-answer'],
  );
  assert.equal(hook.result.current.olderMessagesBeforeEntryId, null);

  await hook.run((current) =>
    current.prependThreadMessagePage({
      threadId: OTHER_THREAD_ID,
      beforeEntryId: 'entry-older-user',
      page: {
        threadId: OTHER_THREAD_ID,
        messages: [
          {
            entryId: 'entry-wrong-thread',
            role: 'user',
            content: 'must not attach',
            timestamp: '2026-07-28T00:00:00.000Z',
          },
        ],
        olderBeforeEntryId: null,
      },
    }),
  );

  assert.deepEqual(
    hook.result.current.messages.map((message) => message.entryId),
    ['entry-older-user', 'entry-latest-user', 'entry-latest-answer'],
  );
  hook.unmount();
});

void test('useThreadSessionSelection requests a full snapshot when a persisted delta anchor is missing', async () => {
  const hook = await renderHook(useThreadSessionSelection, undefined);

  await hook.run((current) =>
    current.selectThreadSnapshot({
      threadId: THREAD_ID,
      snapshotVersion: '2026-04-16T00:00:01.000Z',
      messages: [],
    }),
  );

  const applied = await hook.run((current) =>
    current.applyThreadSnapshotForRunSettle({
      threadId: THREAD_ID,
      snapshotVersion: '2026-04-16T00:00:02.000Z',
      baseEntryId: 'entry-not-loaded',
      messages: [
        {
          entryId: 'entry-persisted-answer',
          role: 'assistant',
          content: 'persisted answer',
          timestamp: '2026-04-16T00:00:02.000Z',
        },
      ],
      artifacts: [],
    }),
  );

  assert.equal(applied, 'missing_base');
  assert.equal(hook.result.current.messages.length, 0);
  const recovered = await hook.run((current) =>
    current.applyThreadSnapshotForRunSettle({
      threadId: THREAD_ID,
      snapshotVersion: '2026-04-16T00:00:02.000Z',
      messages: [
        {
          entryId: 'entry-persisted-answer',
          role: 'assistant',
          content: 'persisted answer',
          timestamp: '2026-04-16T00:00:02.000Z',
        },
      ],
      artifacts: [],
    }),
  );
  assert.equal(recovered, true);
  assert.equal(
    hook.result.current.messages[0]?.entryId,
    'entry-persisted-answer',
  );
  hook.unmount();
});

void test('useThreadSessionSelection explicit selection can reselect an unchanged snapshot', async () => {
  const hook = await renderHook(useThreadSessionSelection, undefined);

  await hook.run((current) =>
    current.applyThreadSnapshotForRunSettle({
      threadId: THREAD_ID,
      snapshotVersion: '2026-04-16T00:00:01.000Z',
      activeModelId: 'grok-4.5',
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
  assert.equal(hook.result.current.newSessionGeneration, 1);
  assert.equal(hook.result.current.activeModelId, null);
  assert.equal(hook.result.current.runPreferences, null);
  assert.deepEqual(hook.result.current.messages, []);
  assert.deepEqual(hook.result.current.artifacts, []);
  assert.deepEqual(hook.result.current.subagentTerminalOutcomes, []);
  hook.unmount();
});

void test('useThreadSessionSelection creates a distinct clean draft even when no thread is selected', async () => {
  const hook = await renderHook(useThreadSessionSelection, undefined);

  assert.equal(hook.result.current.newSessionGeneration, 0);
  await hook.run((current) => current.startNewSession());
  assert.equal(hook.result.current.newSessionGeneration, 1);
  await hook.run((current) => current.startNewSession());
  assert.equal(hook.result.current.newSessionGeneration, 2);
  assert.equal(hook.result.current.runPreferences, null);
  hook.unmount();
});
