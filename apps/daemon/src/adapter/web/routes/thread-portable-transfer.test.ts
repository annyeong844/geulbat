import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { assertThreadId } from '@geulbat/protocol/ids';
import { isThreadArchiveImportResponse } from '@geulbat/protocol/threads';

import { appendTranscriptEntry } from '../../../daemon/sessions/transcript-log.js';
import { upsertThreadSummary } from '../../../daemon/sessions/threads-index.js';
import {
  authHeaders,
  createRouteTestDaemonContext,
  withAuthenticatedDaemonServer,
} from '../../../test-support/http-routes.js';
import { testRunId } from '../../../test-support/run-id.js';

void test('thread archive routes stream an opaque archive and import it as a new task', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const stateRoot = daemonContext.homeStateRoot;
  const sourceThreadId = assertThreadId(randomUUID());
  const runId = testRunId(9101);
  const projection =
    await daemonContext.toolLibraryProjection.resolveProjection({
      stateRoot,
      threadId: sourceThreadId,
      allowedRegistryNames: [],
    });
  assert.equal(projection.ok, true);
  if (!projection.ok) {
    return;
  }
  await daemonContext.runCheckpoints.startRun({
    runId,
    threadId: sourceThreadId,
    request: {
      workingDirectory: '',
      permissionMode: 'basic',
      toolLibraryProjectionIdentity: {
        sdkVersion: projection.pin.sdkVersion,
        sdkProjectionHash: projection.pin.sdkProjectionHash,
        policyId: projection.pin.policyId,
      },
    },
  });
  await appendTranscriptEntry(stateRoot, sourceThreadId, {
    entryId: 'entry-route-archive',
    role: 'user',
    content: 'portable route',
    timestamp: '2026-07-27T00:00:00.000Z',
  });
  await upsertThreadSummary(stateRoot, {
    threadId: sourceThreadId,
    title: 'route archive',
    lastUpdated: '2026-07-27T00:00:00.000Z',
    messageCount: 1,
  });

  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const exported = await fetch(
        `http://127.0.0.1:${String(port)}/api/threads/${sourceThreadId}/archive`,
        { headers: authHeaders() },
      );
      assert.equal(exported.status, 200);
      assert.equal(
        exported.headers.get('content-type'),
        'application/vnd.geulbat.thread-archive',
      );
      assert.match(
        exported.headers.get('x-geulbat-archive-id') ?? '',
        /^sha256:[0-9a-f]{64}$/u,
      );
      const archiveBytes = await exported.arrayBuffer();

      const imported = await fetch(
        `http://127.0.0.1:${String(port)}/api/thread-archives/import`,
        {
          method: 'POST',
          headers: authHeaders({
            'Content-Type': 'application/vnd.geulbat.thread-archive',
          }),
          body: archiveBytes,
        },
      );
      assert.equal(imported.status, 200);
      const body: unknown = await imported.json();
      assert.equal(isThreadArchiveImportResponse(body), true);
      if (isThreadArchiveImportResponse(body)) {
        assert.notEqual(body.threadId, sourceThreadId);
        assert.equal(body.importedMessageCount, 1);
        assert.equal(
          await daemonContext.runCheckpoints.readThread(body.threadId),
          null,
        );
      }

      const wrongMediaType = await fetch(
        `http://127.0.0.1:${String(port)}/api/thread-archives/import`,
        {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: '{}',
        },
      );
      assert.equal(wrongMediaType.status, 400);
    },
    { daemonContext },
  );
});
