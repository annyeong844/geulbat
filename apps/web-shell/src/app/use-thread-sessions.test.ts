import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { useThreadSessions } from './use-thread-sessions.js';
import {
  installFetchSequence,
  installShellAuthDocument,
  jsonResponse,
  renderHook,
  textResponse,
} from '../test-support/hook-test.js';
import { brandProjectId, brandThreadId } from '../lib/id-brand-helpers.js';

const THREAD_ID = brandThreadId('00000000-0000-4000-8000-000000000001');
const OTHER_THREAD_ID = brandThreadId('00000000-0000-4000-8000-000000000002');

let restoreDocument = () => {};
let restoreFetch = () => {};

afterEach(() => {
  restoreFetch();
  restoreFetch = () => {};
  restoreDocument();
  restoreDocument = () => {};
});

void test('useThreadSessions surfaces openThread failures', async () => {
  restoreDocument = installShellAuthDocument();
  const fetchMock = installFetchSequence(() =>
    textResponse(500, 'thread failed'),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useThreadSessions, 'workspace');

  await hook.run((current) => current.openThread(THREAD_ID));

  assert.equal(
    hook.result.current.threadError,
    `Unable to open thread ${THREAD_ID}. API 500: thread failed`,
  );
  assert.equal(hook.result.current.selectedThreadId, null);
  assert.deepEqual(hook.result.current.messages, []);
  hook.unmount();
});

void test('useThreadSessions clears the pending delete dialog after conflict', async () => {
  restoreDocument = installShellAuthDocument();
  const fetchMock = installFetchSequence(
    () =>
      jsonResponse({
        threads: [
          {
            threadId: THREAD_ID,
            projectId: 'workspace',
            title: 'Thread',
            lastUpdated: '2026-03-30T00:00:00.000Z',
            messageCount: 1,
          },
        ],
      }),
    () =>
      jsonResponse({
        threadId: THREAD_ID,
        projectId: 'workspace',
        snapshotVersion: '2026-03-30T00:00:00.000Z',
        messages: [
          {
            role: 'assistant',
            content: 'hello',
            timestamp: '2026-03-30T00:00:00.000Z',
          },
        ],
      }),
    () =>
      jsonResponse(
        {
          code: 'conflict_active_run',
          message: 'run still active',
          threadId: THREAD_ID,
          activeRunId: 'run-1',
        },
        { status: 409 },
      ),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useThreadSessions, 'workspace');

  await hook.run((current) => current.loadThreads());
  await hook.run((current) => current.openThread(THREAD_ID));
  await hook.run((current) => current.requestDeleteThread(THREAD_ID));
  await hook.run((current) => current.confirmDeleteThread());

  assert.equal(hook.result.current.pendingDeleteThread, null);
  assert.equal(hook.result.current.deletingThreadId, null);
  assert.equal(hook.result.current.selectedThreadId, THREAD_ID);
  assert.equal(hook.result.current.messages.length, 1);
  assert.equal(hook.result.current.threads.length, 1);
  assert.equal(
    hook.result.current.threadError,
    `Unable to delete thread ${THREAD_ID}. Active run run-1 is still in progress.`,
  );
  hook.unmount();
});

void test('useThreadSessions clears selected thread state after confirmed delete succeeds', async () => {
  restoreDocument = installShellAuthDocument();
  const fetchMock = installFetchSequence(
    () =>
      jsonResponse({
        threads: [
          {
            threadId: THREAD_ID,
            projectId: 'workspace',
            title: 'Thread',
            lastUpdated: '2026-03-30T00:00:00.000Z',
            messageCount: 1,
          },
        ],
      }),
    () =>
      jsonResponse({
        threadId: THREAD_ID,
        projectId: 'workspace',
        snapshotVersion: '2026-03-30T00:00:00.000Z',
        messages: [
          {
            role: 'assistant',
            content: 'hello',
            timestamp: '2026-03-30T00:00:00.000Z',
          },
        ],
        artifacts: [],
      }),
    () =>
      jsonResponse({
        ok: true,
        threadId: THREAD_ID,
        projectId: 'workspace',
      }),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useThreadSessions, 'workspace');

  await hook.run((current) => current.loadThreads());
  await hook.run((current) => current.openThread(THREAD_ID));
  await hook.run((current) => current.requestDeleteThread(THREAD_ID));
  await hook.run((current) => current.confirmDeleteThread());

  assert.equal(hook.result.current.pendingDeleteThread, null);
  assert.equal(hook.result.current.deletingThreadId, null);
  assert.equal(hook.result.current.threadError, null);
  assert.equal(hook.result.current.selectedThreadId, null);
  assert.deepEqual(hook.result.current.messages, []);
  assert.deepEqual(hook.result.current.artifacts, []);
  assert.deepEqual(hook.result.current.threads, []);
  hook.unmount();
});

void test('useThreadSessions explicit open selects a previously seen unchanged thread', async () => {
  restoreDocument = installShellAuthDocument();
  const fetchMock = installFetchSequence(
    () =>
      jsonResponse({
        threadId: THREAD_ID,
        projectId: 'workspace',
        snapshotVersion: '2026-04-16T00:00:01.000Z',
        messages: [
          {
            role: 'assistant',
            content: 'first thread',
            timestamp: '2026-04-16T00:00:01.000Z',
          },
        ],
        artifacts: [],
      }),
    () =>
      jsonResponse({
        threadId: OTHER_THREAD_ID,
        projectId: 'workspace',
        snapshotVersion: '2026-04-16T00:00:02.000Z',
        messages: [
          {
            role: 'assistant',
            content: 'second thread',
            timestamp: '2026-04-16T00:00:02.000Z',
          },
        ],
        artifacts: [],
      }),
    () =>
      jsonResponse({
        threadId: THREAD_ID,
        projectId: 'workspace',
        snapshotVersion: '2026-04-16T00:00:01.000Z',
        messages: [
          {
            role: 'assistant',
            content: 'first thread reopened',
            timestamp: '2026-04-16T00:00:01.000Z',
          },
        ],
        artifacts: [],
      }),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useThreadSessions, 'workspace');

  await hook.run((current) => current.openThread(THREAD_ID));
  await hook.run((current) => current.openThread(OTHER_THREAD_ID));
  await hook.run((current) => current.openThread(THREAD_ID));

  assert.equal(hook.result.current.threadError, null);
  assert.equal(hook.result.current.selectedThreadId, THREAD_ID);
  assert.deepEqual(hook.result.current.messages, [
    {
      role: 'assistant',
      content: 'first thread reopened',
      timestamp: '2026-04-16T00:00:01.000Z',
    },
  ]);
  hook.unmount();
});

void test('useThreadSessions can apply a persisted thread snapshot without refetching', async () => {
  const hook = await renderHook(useThreadSessions, 'workspace');

  await hook.run((current) =>
    current.applyThreadSnapshotForRunSettle({
      threadId: THREAD_ID,
      projectId: brandProjectId('workspace'),
      snapshotVersion: '2026-04-16T00:00:00.000Z',
      messages: [
        {
          role: 'assistant',
          content: 'persisted answer',
          timestamp: '2026-04-16T00:00:00.000Z',
        },
      ],
      artifacts: [],
    }),
  );

  assert.equal(hook.result.current.selectedThreadId, THREAD_ID);
  assert.deepEqual(hook.result.current.messages, [
    {
      role: 'assistant',
      content: 'persisted answer',
      timestamp: '2026-04-16T00:00:00.000Z',
    },
  ]);
  assert.deepEqual(hook.result.current.artifacts, []);
  hook.unmount();
});

void test('useThreadSessions ignores stale persisted snapshots for the same thread', async () => {
  const hook = await renderHook(useThreadSessions, 'workspace');

  await hook.run((current) =>
    current.applyThreadSnapshotForRunSettle({
      threadId: THREAD_ID,
      projectId: brandProjectId('workspace'),
      snapshotVersion: '2026-04-16T00:00:01.000Z',
      messages: [
        {
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
      projectId: brandProjectId('workspace'),
      snapshotVersion: '2026-04-16T00:00:00.000Z',
      messages: [
        {
          role: 'assistant',
          content: 'older',
          timestamp: '2026-04-16T00:00:00.000Z',
        },
      ],
      artifacts: [],
    }),
  );

  assert.equal(appliedStaleSnapshot, false);
  assert.deepEqual(hook.result.current.messages, [
    {
      role: 'assistant',
      content: 'newer',
      timestamp: '2026-04-16T00:00:01.000Z',
    },
  ]);
  hook.unmount();
});

void test('useThreadSessions clears threadError when a persisted snapshot applies successfully', async () => {
  restoreDocument = installShellAuthDocument();
  const fetchMock = installFetchSequence(() =>
    textResponse(500, 'thread failed'),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useThreadSessions, 'workspace');

  await hook.run((current) => current.openThread(THREAD_ID));
  assert.match(hook.result.current.threadError ?? '', /Unable to open thread/);

  await hook.run((current) =>
    current.applyThreadSnapshotForRunSettle({
      threadId: THREAD_ID,
      projectId: brandProjectId('workspace'),
      snapshotVersion: '2026-04-16T00:00:01.000Z',
      messages: [
        {
          role: 'assistant',
          content: 'persisted answer',
          timestamp: '2026-04-16T00:00:01.000Z',
        },
      ],
      artifacts: [],
    }),
  );

  assert.equal(hook.result.current.threadError, null);
  assert.equal(hook.result.current.selectedThreadId, THREAD_ID);
  hook.unmount();
});
