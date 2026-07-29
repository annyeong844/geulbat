import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdir, rm, stat, writeFile as fsWriteFile } from 'node:fs/promises';

import {
  loadThreadIndex,
  upsertThreadSummary,
} from './daemon/sessions/threads-index.js';
import {
  artifactStoreFilePath,
  indexFilePath,
  summaryFilePath,
  threadFilePath,
} from './daemon/sessions/paths.js';
import { createRunInterjectBuffer } from './daemon/sessions/active-run-interject-buffer.js';
import { assertThreadId as assertValidThreadId } from '@geulbat/protocol/ids';
import { isThreadBranchResponse } from '@geulbat/protocol/threads';
import {
  authHeaders,
  createRouteTestDaemonContext,
  withAuthenticatedDaemonServer,
} from './test-support/http-routes.js';
import {
  restoreFileSnapshot,
  snapshotFile,
} from './test-support/file-snapshot.js';
import { testRunId } from './test-support/run-id.js';

void test('authenticated thread delete route removes session artifacts', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const stateRoot = daemonContext.homeStateRoot;
  const threadId = assertValidThreadId(randomUUID());
  const indexPath = indexFilePath(stateRoot);
  const transcriptPath = threadFilePath(stateRoot, threadId);
  const summaryPath = summaryFilePath(stateRoot, threadId);
  const artifactPath = artifactStoreFilePath(stateRoot, threadId);
  const indexSnapshot = await snapshotFile(indexPath);
  const transcriptSnapshot = await snapshotFile(transcriptPath);
  const summarySnapshot = await snapshotFile(summaryPath);
  const artifactSnapshot = await snapshotFile(artifactPath);

  await upsertThreadSummary(stateRoot, {
    threadId,
    title: 'Delete me',
    lastUpdated: '2026-03-26T00:00:00.000Z',
    messageCount: 1,
  });
  await mkdir(dirname(transcriptPath), { recursive: true });
  await fsWriteFile(
    transcriptPath,
    JSON.stringify({
      role: 'user',
      content: 'bye',
      timestamp: '2026-03-26T00:00:00.000Z',
    }) + '\n',
    'utf8',
  );
  await fsWriteFile(summaryPath, '# Summary\n', 'utf8');
  await fsWriteFile(
    artifactPath,
    JSON.stringify({ artifacts: [], versions: [] }) + '\n',
    'utf8',
  );
  daemonContext.backgroundNotifications.enqueueThreadBackgroundResult(
    threadId,
    {
      deliveryId: 'delivery-delete-thread',
      parentRunId: testRunId('delete-thread-parent'),
      childRunId: testRunId('delete-thread-child'),
      subagentType: 'explorer',
      terminalState: 'completed',
      result: 'deleted thread background result',
      completedAt: '2026-03-26T00:00:01.000Z',
    },
  );

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/threads/${threadId}`,
          {
            method: 'DELETE',
            headers: authHeaders(),
          },
        );

        assert.equal(res.status, 200);
        const body = (await res.json()) as {
          ok: boolean;
          threadId: string;
        };
        assert.equal(body.ok, true);
        assert.equal(body.threadId, threadId);
        assert.equal('projectId' in body, false);
        assert.equal(await fileExists(transcriptPath), false);
        assert.equal(await fileExists(summaryPath), false);
        assert.equal(await fileExists(artifactPath), false);
        const remainingEntries = await loadThreadIndex(stateRoot);
        assert.equal(
          remainingEntries.some((entry) => entry.threadId === threadId),
          false,
        );
        assert.deepEqual(
          daemonContext.backgroundNotifications.consumeThreadBackgroundResults(
            threadId,
          ),
          [],
        );
      },
      { daemonContext },
    );
  } finally {
    await restoreFileSnapshot(indexPath, indexSnapshot);
    await restoreFileSnapshot(transcriptPath, transcriptSnapshot);
    await restoreFileSnapshot(summaryPath, summarySnapshot);
    await restoreFileSnapshot(artifactPath, artifactSnapshot);
  }
});

void test('authenticated thread delete route rejects active run threads', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const threadId = assertValidThreadId(randomUUID());
  const runId = testRunId('delete-conflict');
  const abortController = new AbortController();

  assert.deepEqual(
    daemonContext.activeRuns.tryStartRun(threadId, {
      runId,
      threadId,
      stateRoot: daemonContext.homeStateRoot,
      workingDirectory: 'stories',
      ownerThreadId: threadId,
      abortController,
      interject: createRunInterjectBuffer(),
      startedAt: '2026-03-26T00:00:00.000Z',
    }),
    { ok: true },
  );

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/threads/${threadId}`,
          {
            method: 'DELETE',
            headers: authHeaders(),
          },
        );

        assert.equal(res.status, 409);
        const body = (await res.json()) as {
          code: string;
          threadId: string;
          activeRunId: string;
        };
        assert.equal(body.code, 'conflict_active_run');
        assert.equal(body.threadId, threadId);
        assert.equal(body.activeRunId, runId);
      },
      { daemonContext },
    );
  } finally {
    daemonContext.activeRuns.finishRun(threadId, runId);
  }
});

void test('authenticated thread delete route rejects a surviving background child after its parent settles', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const ownerThreadId = assertValidThreadId(randomUUID());
  const childThreadId = assertValidThreadId(randomUUID());
  const parentRunId = testRunId('delete-settled-parent');
  const childRunId = testRunId('delete-active-child');

  assert.deepEqual(
    daemonContext.activeRuns.tryStartRun(ownerThreadId, {
      runId: parentRunId,
      threadId: ownerThreadId,
      stateRoot: daemonContext.homeStateRoot,
      workingDirectory: 'stories',
      ownerThreadId,
      abortController: new AbortController(),
      interject: createRunInterjectBuffer(),
      startedAt: '2026-07-22T00:00:00.000Z',
    }),
    { ok: true },
  );
  assert.deepEqual(
    daemonContext.activeRuns.tryStartRun(childThreadId, {
      runId: childRunId,
      threadId: childThreadId,
      stateRoot: daemonContext.homeStateRoot,
      workingDirectory: 'stories',
      ownerThreadId,
      parentRunId,
      abortController: new AbortController(),
      interject: createRunInterjectBuffer(),
      startedAt: '2026-07-22T00:00:01.000Z',
    }),
    { ok: true },
  );
  daemonContext.activeRuns.finishRun(ownerThreadId, parentRunId);

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/threads/${ownerThreadId}`,
          {
            method: 'DELETE',
            headers: authHeaders(),
          },
        );

        assert.equal(res.status, 409);
        const body = (await res.json()) as {
          code: string;
          threadId: string;
          activeRunId: string;
        };
        assert.equal(body.code, 'conflict_active_run');
        assert.equal(body.threadId, ownerThreadId);
        assert.equal(body.activeRunId, childRunId);
      },
      { daemonContext },
    );
  } finally {
    daemonContext.activeRuns.finishRun(childThreadId, childRunId);
  }
});

void test('authenticated thread branch clones a transcript prefix into a new thread', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const stateRoot = daemonContext.homeStateRoot;
  const threadId = assertValidThreadId(randomUUID());
  const indexPath = indexFilePath(stateRoot);
  const transcriptPath = threadFilePath(stateRoot, threadId);
  const indexSnapshot = await snapshotFile(indexPath);
  const transcriptSnapshot = await snapshotFile(transcriptPath);
  let branchedThreadId: string | null = null;

  await mkdir(dirname(transcriptPath), { recursive: true });
  await fsWriteFile(
    transcriptPath,
    [
      JSON.stringify({
        entryId: 'entry-user-1',
        role: 'user',
        content: 'first question',
        timestamp: '2026-07-12T00:00:00.000Z',
      }),
      JSON.stringify({
        entryId: 'entry-assistant-1',
        role: 'assistant',
        content: 'first answer',
        timestamp: '2026-07-12T00:00:01.000Z',
      }),
      JSON.stringify({
        entryId: 'entry-user-2',
        role: 'user',
        content: 'second question',
        timestamp: '2026-07-12T00:00:02.000Z',
      }),
      '',
    ].join('\n'),
    'utf8',
  );

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const branchRes = await fetch(
          `http://127.0.0.1:${port}/api/threads/${threadId}/branch`,
          {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ upToEntryId: 'entry-assistant-1' }),
          },
        );
        assert.equal(branchRes.status, 200);
        const branchBody: unknown = await branchRes.json();
        assert.equal(isThreadBranchResponse(branchBody), true);
        if (!isThreadBranchResponse(branchBody)) {
          return;
        }
        branchedThreadId = branchBody.threadId;
        assert.equal(branchBody.sourceThreadId, threadId);
        assert.equal('projectId' in branchBody, false);
        assert.equal(branchBody.copiedMessageCount, 2);
        assert.notEqual(branchBody.threadId, threadId);

        const detailRes = await fetch(
          `http://127.0.0.1:${port}/api/threads/${branchBody.threadId}`,
          { headers: authHeaders() },
        );
        assert.equal(detailRes.status, 200);
        const detailBody = (await detailRes.json()) as {
          messages: Array<{ role: string; content: string }>;
        };
        assert.deepEqual(
          detailBody.messages.map((message) => message.content),
          ['first question', 'first answer'],
        );

        const missingCutRes = await fetch(
          `http://127.0.0.1:${port}/api/threads/${threadId}/branch`,
          {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ upToEntryId: 'entry-missing' }),
          },
        );
        assert.equal(missingCutRes.status, 404);

        const invalidBodyRes = await fetch(
          `http://127.0.0.1:${port}/api/threads/${threadId}/branch`,
          {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ upToEntryId: 42 }),
          },
        );
        assert.equal(invalidBodyRes.status, 400);
      },
      { daemonContext },
    );
  } finally {
    await restoreFileSnapshot(indexPath, indexSnapshot);
    await restoreFileSnapshot(transcriptPath, transcriptSnapshot);
    if (branchedThreadId !== null) {
      await rm(threadFilePath(stateRoot, branchedThreadId), {
        force: true,
      });
      await rm(artifactStoreFilePath(stateRoot, branchedThreadId), {
        force: true,
      });
    }
  }
});

void test('authenticated thread metadata patch validates shape and persists title and pin state', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const stateRoot = daemonContext.homeStateRoot;
  const threadId = assertValidThreadId(randomUUID());
  const missingThreadId = assertValidThreadId(randomUUID());
  const indexPath = indexFilePath(stateRoot);
  const indexSnapshot = await snapshotFile(indexPath);
  await upsertThreadSummary(stateRoot, {
    threadId,
    title: 'Before',
    lastUpdated: '2026-07-28T00:00:00.000Z',
    messageCount: 1,
  });

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const patch = async (id: string, body: unknown) =>
          await fetch(`http://127.0.0.1:${port}/api/threads/${id}`, {
            method: 'PATCH',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });

        const updated = await patch(threadId, {
          title: '  After  ',
          pinned: true,
        });
        assert.equal(updated.status, 200);
        assert.deepEqual(await updated.json(), {
          ok: true,
          threadId,
          title: 'After',
        });
        assert.deepEqual(
          (await loadThreadIndex(stateRoot)).find(
            (entry) => entry.threadId === threadId,
          ),
          {
            threadId,
            title: 'After',
            lastUpdated: '2026-07-28T00:00:00.000Z',
            messageCount: 1,
            pinned: true,
          },
        );

        assert.equal((await patch(threadId, {})).status, 400);
        assert.equal((await patch(threadId, { title: '   ' })).status, 400);
        assert.equal((await patch(threadId, { pinned: 'yes' })).status, 400);
        assert.equal(
          (await patch(missingThreadId, { title: 'Missing' })).status,
          404,
        );

        const unpinned = await patch(threadId, { pinned: false });
        assert.equal(unpinned.status, 200);
        assert.equal(
          (await loadThreadIndex(stateRoot)).find(
            (entry) => entry.threadId === threadId,
          )?.pinned,
          undefined,
        );
      },
      { daemonContext },
    );
  } finally {
    await restoreFileSnapshot(indexPath, indexSnapshot);
  }
});

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
