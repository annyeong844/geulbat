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
import { brandThreadId } from '../lib/id-brand-helpers.js';

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
  const hook = await renderHook(useThreadSessions, undefined);

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
            title: 'Thread',
            lastUpdated: '2026-03-30T00:00:00.000Z',
            messageCount: 1,
          },
        ],
      }),
    () =>
      jsonResponse({
        threadId: THREAD_ID,
        snapshotVersion: '2026-03-30T00:00:00.000Z',
        messages: [
          {
            entryId: 'entry-conflict-open',
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
  const hook = await renderHook(useThreadSessions, undefined);

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
            title: 'Thread',
            lastUpdated: '2026-03-30T00:00:00.000Z',
            messageCount: 1,
          },
        ],
      }),
    () =>
      jsonResponse({
        threadId: THREAD_ID,
        snapshotVersion: '2026-03-30T00:00:00.000Z',
        messages: [
          {
            entryId: 'entry-delete-open',
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
      }),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useThreadSessions, undefined);

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
        snapshotVersion: '2026-04-16T00:00:01.000Z',
        messages: [
          {
            entryId: 'entry-first-thread',
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
        snapshotVersion: '2026-04-16T00:00:02.000Z',
        messages: [
          {
            entryId: 'entry-second-thread',
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
        snapshotVersion: '2026-04-16T00:00:01.000Z',
        messages: [
          {
            entryId: 'entry-first-thread-reopened',
            role: 'assistant',
            content: 'first thread reopened',
            timestamp: '2026-04-16T00:00:01.000Z',
          },
        ],
        artifacts: [],
      }),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useThreadSessions, undefined);

  await hook.run((current) => current.openThread(THREAD_ID));
  await hook.run((current) => current.openThread(OTHER_THREAD_ID));
  await hook.run((current) => current.openThread(THREAD_ID));

  assert.equal(hook.result.current.threadError, null);
  assert.equal(hook.result.current.selectedThreadId, THREAD_ID);
  assert.deepEqual(hook.result.current.messages, [
    {
      entryId: 'entry-first-thread-reopened',
      role: 'assistant',
      content: 'first thread reopened',
      timestamp: '2026-04-16T00:00:01.000Z',
    },
  ]);
  hook.unmount();
});

void test('useThreadSessions branches from an entry, refreshes the list, and switches threads', async () => {
  restoreDocument = installShellAuthDocument();
  const fetchMock = installFetchSequence(
    // 원 스레드 열기
    () =>
      jsonResponse({
        threadId: THREAD_ID,
        snapshotVersion: '2026-07-12T00:00:01.000Z',
        messages: [
          {
            entryId: 'entry-source-answer',
            role: 'assistant',
            content: 'source answer',
            timestamp: '2026-07-12T00:00:01.000Z',
          },
        ],
        artifacts: [],
      }),
    // 브랜치 생성
    () =>
      jsonResponse({
        ok: true,
        threadId: OTHER_THREAD_ID,
        sourceThreadId: THREAD_ID,
        copiedMessageCount: 1,
      }),
    // 목록 갱신
    () =>
      jsonResponse({
        threads: [
          {
            threadId: THREAD_ID,
            title: 'Source',
            lastUpdated: '2026-07-12T00:00:01.000Z',
            messageCount: 1,
          },
          {
            threadId: OTHER_THREAD_ID,
            title: 'Source',
            lastUpdated: '2026-07-12T00:00:02.000Z',
            messageCount: 1,
          },
        ],
      }),
    // 새 스레드 열기
    () =>
      jsonResponse({
        threadId: OTHER_THREAD_ID,
        snapshotVersion: '2026-07-12T00:00:02.000Z',
        messages: [
          {
            entryId: 'entry-branched-answer',
            role: 'assistant',
            content: 'source answer',
            timestamp: '2026-07-12T00:00:01.000Z',
          },
        ],
        artifacts: [],
      }),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useThreadSessions, undefined);

  await hook.run((current) => current.openThread(THREAD_ID));
  await hook.run((current) =>
    current.branchThreadFromEntry('entry-source-answer'),
  );

  assert.equal(hook.result.current.threadError, null);
  assert.equal(hook.result.current.selectedThreadId, OTHER_THREAD_ID);
  assert.equal(hook.result.current.threads.length, 2);
  assert.equal(
    hook.result.current.messages[0]?.entryId,
    'entry-branched-answer',
  );
  // 성공 알림 — 전환이 화면상 티가 안 나므로 반드시 뜬다
  assert.match(hook.result.current.branchNotice ?? '', /새 채팅으로 전환/);
  await hook.run((current) => current.dismissBranchNotice());
  assert.equal(hook.result.current.branchNotice, null);
  hook.unmount();
});

void test('useThreadSessions surfaces branch failures without switching threads', async () => {
  restoreDocument = installShellAuthDocument();
  const fetchMock = installFetchSequence(
    () =>
      jsonResponse({
        threadId: THREAD_ID,
        snapshotVersion: '2026-07-12T00:00:01.000Z',
        messages: [
          {
            entryId: 'entry-source-answer',
            role: 'assistant',
            content: 'source answer',
            timestamp: '2026-07-12T00:00:01.000Z',
          },
        ],
        artifacts: [],
      }),
    () => textResponse(500, 'branch failed'),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useThreadSessions, undefined);

  await hook.run((current) => current.openThread(THREAD_ID));
  await hook.run((current) =>
    current.branchThreadFromEntry('entry-source-answer'),
  );

  assert.equal(
    hook.result.current.threadError,
    `Unable to branch thread ${THREAD_ID}. API 500: branch failed`,
  );
  assert.equal(hook.result.current.selectedThreadId, THREAD_ID);
  assert.equal(hook.result.current.branchNotice, null);
  hook.unmount();
});

void test('useThreadSessions branches before an entry for past-question edit', async () => {
  restoreDocument = installShellAuthDocument();
  let branchRequestBody = '';
  const fetchMock = installFetchSequence(
    // 원 스레드 열기 — [답변, 질문, 답변] 3개
    () =>
      jsonResponse({
        threadId: THREAD_ID,
        snapshotVersion: '2026-07-12T00:00:01.000Z',
        messages: [
          {
            entryId: 'entry-a1',
            role: 'assistant',
            content: 'first answer',
            timestamp: '2026-07-12T00:00:01.000Z',
          },
          {
            entryId: 'entry-u2',
            role: 'user',
            content: 'past question',
            timestamp: '2026-07-12T00:00:02.000Z',
          },
          {
            entryId: 'entry-a3',
            role: 'assistant',
            content: 'second answer',
            timestamp: '2026-07-12T00:00:03.000Z',
          },
        ],
        artifacts: [],
      }),
    // 브랜치 생성 — upToEntryId가 "직전" entry여야 한다
    (_url, init) => {
      branchRequestBody = String(init?.body ?? '');
      return jsonResponse({
        ok: true,
        threadId: OTHER_THREAD_ID,
        sourceThreadId: THREAD_ID,
        copiedMessageCount: 1,
      });
    },
    () => jsonResponse({ threads: [] }),
    () =>
      jsonResponse({
        threadId: OTHER_THREAD_ID,
        snapshotVersion: '2026-07-12T00:00:04.000Z',
        messages: [
          {
            entryId: 'entry-branched-a1',
            role: 'assistant',
            content: 'first answer',
            timestamp: '2026-07-12T00:00:01.000Z',
          },
        ],
        artifacts: [],
      }),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useThreadSessions, undefined);

  await hook.run((current) => current.openThread(THREAD_ID));
  const result = await hook.run((current) =>
    current.branchThreadBeforeEntry('entry-u2'),
  );

  assert.deepEqual(result, { kind: 'branched', threadId: OTHER_THREAD_ID });
  assert.deepEqual(JSON.parse(branchRequestBody), { upToEntryId: 'entry-a1' });
  assert.equal(hook.result.current.selectedThreadId, OTHER_THREAD_ID);
  assert.match(hook.result.current.branchNotice ?? '', /수정한 질문/);
  hook.unmount();
});

void test('useThreadSessions treats first-message edit as a fresh session', async () => {
  restoreDocument = installShellAuthDocument();
  const fetchMock = installFetchSequence(() =>
    jsonResponse({
      threadId: THREAD_ID,
      snapshotVersion: '2026-07-12T00:00:01.000Z',
      messages: [
        {
          entryId: 'entry-first-question',
          role: 'user',
          content: 'first question',
          timestamp: '2026-07-12T00:00:01.000Z',
        },
        {
          entryId: 'entry-answer',
          role: 'assistant',
          content: 'answer',
          timestamp: '2026-07-12T00:00:02.000Z',
        },
      ],
      artifacts: [],
    }),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useThreadSessions, undefined);

  await hook.run((current) => current.openThread(THREAD_ID));
  const result = await hook.run((current) =>
    current.branchThreadBeforeEntry('entry-first-question'),
  );

  assert.deepEqual(result, { kind: 'fresh' });
  // 새 세션으로 초기화 — 다음 run이 새 스레드를 연다
  assert.equal(hook.result.current.selectedThreadId, null);
  assert.deepEqual(hook.result.current.messages, []);
  hook.unmount();
});

void test('useThreadSessions returns null for unknown edit entry ids', async () => {
  const hook = await renderHook(useThreadSessions, undefined);

  // 스레드 미선택 — 네트워크 호출 없이 null
  const result = await hook.run((current) =>
    current.branchThreadBeforeEntry('entry-unknown'),
  );

  assert.equal(result, null);
  hook.unmount();
});

void test('useThreadSessions ignores branch requests when no thread is selected', async () => {
  const hook = await renderHook(useThreadSessions, undefined);

  // fetch mock 없음 — 네트워크 호출이 일어나면 여기서 실패한다
  await hook.run((current) => current.branchThreadFromEntry('entry-any'));

  assert.equal(hook.result.current.threadError, null);
  assert.equal(hook.result.current.selectedThreadId, null);
  hook.unmount();
});

void test('useThreadSessions can apply a persisted thread snapshot without refetching', async () => {
  const hook = await renderHook(useThreadSessions, undefined);

  await hook.run((current) =>
    current.applyThreadSnapshotForRunSettle({
      threadId: THREAD_ID,
      snapshotVersion: '2026-04-16T00:00:00.000Z',
      messages: [
        {
          entryId: 'entry-persisted-answer',
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
      entryId: 'entry-persisted-answer',
      role: 'assistant',
      content: 'persisted answer',
      timestamp: '2026-04-16T00:00:00.000Z',
    },
  ]);
  assert.deepEqual(hook.result.current.artifacts, []);
  hook.unmount();
});

void test('useThreadSessions ignores stale persisted snapshots for the same thread', async () => {
  const hook = await renderHook(useThreadSessions, undefined);

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

void test('useThreadSessions clears threadError when a persisted snapshot applies successfully', async () => {
  restoreDocument = installShellAuthDocument();
  const fetchMock = installFetchSequence(() =>
    textResponse(500, 'thread failed'),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useThreadSessions, undefined);

  await hook.run((current) => current.openThread(THREAD_ID));
  assert.match(hook.result.current.threadError ?? '', /Unable to open thread/);

  await hook.run((current) =>
    current.applyThreadSnapshotForRunSettle({
      threadId: THREAD_ID,
      snapshotVersion: '2026-04-16T00:00:01.000Z',
      messages: [
        {
          entryId: 'entry-persisted-answer-after-error',
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
