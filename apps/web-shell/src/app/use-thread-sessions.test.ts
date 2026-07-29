import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { THREAD_ARCHIVE_MEDIA_TYPE } from '@geulbat/protocol/threads';

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

function threadOpenResponse<
  T extends { threadId: string; messages: unknown[] },
>(
  detail: T,
): Omit<T, 'messages'> & {
  messagePage: {
    threadId: string;
    messages: T['messages'];
    olderBeforeEntryId: null;
  };
} {
  const { messages, ...metadata } = detail;
  return {
    ...metadata,
    messagePage: {
      threadId: detail.threadId,
      messages,
      olderBeforeEntryId: null,
    },
  };
}

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
  const fetchMock = installFetchSequence((url) => {
    assert.equal(url, `/api/threads/${THREAD_ID}/open`);
    return textResponse(500, 'thread failed');
  });
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

void test('useThreadSessions imports opaque archive bytes, refreshes the list, and opens the fresh thread', async () => {
  restoreDocument = installShellAuthDocument();
  const fetchMock = installFetchSequence(
    (_url, init) => {
      assert.equal(init?.method, 'POST');
      assert.equal(
        new Headers(init?.headers).get('Content-Type'),
        THREAD_ARCHIVE_MEDIA_TYPE,
      );
      assert.ok(init?.body instanceof Blob);
      return jsonResponse({
        ok: true,
        threadId: OTHER_THREAD_ID,
        archiveId:
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        importedMessageCount: 1,
      });
    },
    () =>
      jsonResponse({
        threads: [
          {
            threadId: OTHER_THREAD_ID,
            title: 'Imported thread',
            lastUpdated: '2026-07-27T00:00:00.000Z',
            messageCount: 1,
          },
        ],
      }),
    () =>
      jsonResponse(
        threadOpenResponse({
          threadId: OTHER_THREAD_ID,
          snapshotVersion: '2026-07-27T00:00:00.000Z',
          messages: [
            {
              entryId: 'entry-imported',
              role: 'assistant',
              content: 'restored',
              timestamp: '2026-07-27T00:00:00.000Z',
            },
          ],
          artifacts: [],
        }),
      ),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useThreadSessions, undefined);

  await hook.run((current) =>
    current.importThread(new Blob(['opaque archive bytes'])),
  );

  assert.equal(fetchMock.calls[0]?.url, '/api/thread-archives/import');
  assert.equal(fetchMock.calls[1]?.url, '/api/threads');
  assert.equal(fetchMock.calls[2]?.url, `/api/threads/${OTHER_THREAD_ID}/open`);
  assert.equal(hook.result.current.selectedThreadId, OTHER_THREAD_ID);
  assert.equal(hook.result.current.messages[0]?.content, 'restored');
  assert.equal(
    hook.result.current.threadTransferNotice,
    '대화를 가져왔습니다 · 메시지 1개',
  );
  assert.equal(hook.result.current.threadError, null);
  assert.equal(hook.result.current.importingThreadArchive, false);
  hook.unmount();
});

void test('useThreadSessions surfaces archive import refusal without changing selection', async () => {
  restoreDocument = installShellAuthDocument();
  const fetchMock = installFetchSequence(() =>
    textResponse(422, 'archive digest mismatch'),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useThreadSessions, undefined);

  await hook.run((current) =>
    current.importThread(new Blob(['tampered archive'])),
  );

  assert.equal(hook.result.current.selectedThreadId, null);
  assert.equal(hook.result.current.threadTransferNotice, null);
  assert.equal(hook.result.current.importingThreadArchive, false);
  assert.equal(
    hook.result.current.threadError,
    '대화를 가져오지 못했습니다. API 422: archive digest mismatch',
  );
  hook.unmount();
});

void test('useThreadSessions exports opaque archive bytes through the OS save surface', async (t) => {
  restoreDocument = installShellAuthDocument();
  const writtenArchives: Blob[] = [];
  let writableClosed = false;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      showSaveFilePicker: async () => ({
        createWritable: async () => ({
          write: async (archive: Blob) => {
            writtenArchives.push(archive);
          },
          close: async () => {
            writableClosed = true;
          },
        }),
      }),
    },
  });
  t.after(() => {
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, 'window');
      return;
    }
    Object.defineProperty(globalThis, 'window', originalWindow);
  });
  const fetchMock = installFetchSequence(
    () =>
      new Response('opaque export bytes', {
        status: 200,
        headers: { 'Content-Type': THREAD_ARCHIVE_MEDIA_TYPE },
      }),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useThreadSessions, undefined);

  await hook.run((current) => current.exportThread(THREAD_ID));

  assert.equal(fetchMock.calls[0]?.url, `/api/threads/${THREAD_ID}/archive`);
  const writtenArchive = writtenArchives[0];
  assert.ok(writtenArchive);
  assert.equal(await writtenArchive.text(), 'opaque export bytes');
  assert.equal(writableClosed, true);
  assert.equal(
    hook.result.current.threadTransferNotice,
    '대화 아카이브를 내보냈습니다.',
  );
  assert.equal(hook.result.current.exportingThreadId, null);
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
      jsonResponse(
        threadOpenResponse({
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
          subagentTerminalOutcomes: [
            {
              deliveryId: 'delivery-conflict-history',
              parentRunId: 'run-parent',
              childRunId: 'run-child',
              subagentType: 'worker',
              terminalState: 'failed',
              reason: 'daemon_restart',
              result: 'partial result',
              completedAt: '2026-03-30T00:00:01.000Z',
            },
          ],
        }),
      ),
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
  assert.equal(
    hook.result.current.subagentTerminalOutcomes[0]?.deliveryId,
    'delivery-conflict-history',
  );
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
      jsonResponse(
        threadOpenResponse({
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
      ),
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
      jsonResponse(
        threadOpenResponse({
          threadId: THREAD_ID,
          snapshotVersion: '2026-04-16T00:00:01.000Z',
          activeModelId: 'grok-4.5',
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
      ),
    () =>
      jsonResponse(
        threadOpenResponse({
          threadId: OTHER_THREAD_ID,
          snapshotVersion: '2026-04-16T00:00:02.000Z',
          activeModelId: 'gpt-5.6-sol',
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
      ),
    () =>
      jsonResponse(
        threadOpenResponse({
          threadId: THREAD_ID,
          snapshotVersion: '2026-04-16T00:00:01.000Z',
          activeModelId: 'grok-4.5',
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
      ),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useThreadSessions, undefined);

  await hook.run((current) => current.openThread(THREAD_ID));
  await hook.run((current) => current.openThread(OTHER_THREAD_ID));
  await hook.run((current) => current.openThread(THREAD_ID));

  assert.equal(hook.result.current.threadError, null);
  assert.equal(hook.result.current.selectedThreadId, THREAD_ID);
  assert.equal(hook.result.current.activeModelId, 'grok-4.5');
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

void test('useThreadSessions ignores an older open response after the user selects another thread', async () => {
  restoreDocument = installShellAuthDocument();
  let resolveFirstResponse!: (response: Response) => void;
  const firstResponse = new Promise<Response>((resolve) => {
    resolveFirstResponse = resolve;
  });
  const fetchMock = installFetchSequence(
    () => firstResponse,
    () =>
      jsonResponse(
        threadOpenResponse({
          threadId: OTHER_THREAD_ID,
          snapshotVersion: '2026-07-29T00:00:02.000Z',
          messages: [
            {
              entryId: 'entry-second-selection',
              role: 'assistant',
              content: 'second selection',
              timestamp: '2026-07-29T00:00:02.000Z',
            },
          ],
          artifacts: [],
        }),
      ),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useThreadSessions, undefined);
  let firstOpen!: Promise<void>;

  await hook.run((current) => {
    firstOpen = current.openThread(THREAD_ID);
  });
  await hook.run((current) => current.openThread(OTHER_THREAD_ID));
  resolveFirstResponse(
    jsonResponse(
      threadOpenResponse({
        threadId: THREAD_ID,
        snapshotVersion: '2026-07-29T00:00:03.000Z',
        messages: [
          {
            entryId: 'entry-stale-first-selection',
            role: 'assistant',
            content: 'must not replace the second selection',
            timestamp: '2026-07-29T00:00:03.000Z',
          },
        ],
        artifacts: [],
      }),
    ),
  );
  await hook.run(() => firstOpen);

  assert.equal(hook.result.current.selectedThreadId, OTHER_THREAD_ID);
  assert.equal(
    hook.result.current.messages[0]?.entryId,
    'entry-second-selection',
  );
  hook.unmount();
});

void test('useThreadSessions loads the immediately preceding turn into the selected thread', async () => {
  restoreDocument = installShellAuthDocument();
  const fetchMock = installFetchSequence(
    () =>
      jsonResponse({
        threadId: THREAD_ID,
        snapshotVersion: '2026-07-29T00:00:03.000Z',
        artifacts: [],
        messagePage: {
          threadId: THREAD_ID,
          messages: [
            {
              entryId: 'entry-latest-user',
              role: 'user',
              content: 'latest question',
              timestamp: '2026-07-29T00:00:02.000Z',
            },
            {
              entryId: 'entry-latest-answer',
              role: 'assistant',
              content: 'latest answer',
              timestamp: '2026-07-29T00:00:03.000Z',
            },
          ],
          olderBeforeEntryId: 'entry-latest-user',
        },
      }),
    () =>
      jsonResponse({
        threadId: THREAD_ID,
        messages: [
          {
            entryId: 'entry-older-user',
            role: 'user',
            content: 'older question',
            timestamp: '2026-07-29T00:00:00.000Z',
          },
          {
            entryId: 'entry-older-answer',
            role: 'assistant',
            content: 'older answer',
            timestamp: '2026-07-29T00:00:01.000Z',
          },
        ],
        olderBeforeEntryId: null,
      }),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useThreadSessions, undefined);

  await hook.run((current) => current.openThread(THREAD_ID));
  assert.equal(hook.result.current.hasOlderMessages, true);
  await hook.run((current) => current.loadOlderMessages());

  assert.equal(
    fetchMock.calls[1]?.url,
    `/api/threads/${THREAD_ID}/messages?before=entry-latest-user`,
  );
  assert.deepEqual(
    hook.result.current.messages.map((message) => message.entryId),
    [
      'entry-older-user',
      'entry-older-answer',
      'entry-latest-user',
      'entry-latest-answer',
    ],
  );
  assert.equal(hook.result.current.hasOlderMessages, false);
  assert.equal(hook.result.current.olderMessagesLoading, false);
  hook.unmount();
});

void test('useThreadSessions branches from an entry, refreshes the list, and switches threads', async () => {
  restoreDocument = installShellAuthDocument();
  const fetchMock = installFetchSequence(
    // 원 스레드 열기
    () =>
      jsonResponse(
        threadOpenResponse({
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
      ),
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
      jsonResponse(
        threadOpenResponse({
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
      ),
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
      jsonResponse(
        threadOpenResponse({
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
      ),
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
      jsonResponse(
        threadOpenResponse({
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
      ),
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
      jsonResponse(
        threadOpenResponse({
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
      ),
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
    jsonResponse(
      threadOpenResponse({
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
    ),
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
