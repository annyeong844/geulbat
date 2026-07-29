import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { THREAD_ARCHIVE_MEDIA_TYPE } from '@geulbat/protocol/threads';

import { upsertThreadSummary } from './daemon/sessions/threads-index.js';
import {
  artifactStoreFilePath,
  indexFilePath,
  threadFilePath,
} from './daemon/sessions/paths.js';
import { appendTranscriptEntry } from './daemon/sessions/transcript-log.js';
import {
  createRunAttachmentId,
  writeRunAttachment,
} from './daemon/sessions/run-attachment-store.js';
import { writeThreadMediaFile } from './daemon/sessions/media-file-store.js';
import { assertThreadId as assertValidThreadId } from '@geulbat/protocol/ids';
import {
  authHeaders,
  createRouteTestDaemonContext,
  withAuthenticatedDaemonServer,
} from './test-support/http-routes.js';
import {
  restoreFileSnapshot,
  snapshotFile,
} from './test-support/file-snapshot.js';

void test('authenticated thread attachment and media routes serve only thread-owned immutable bytes', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const stateRoot = daemonContext.homeStateRoot;
  const threadId = assertValidThreadId(randomUUID());
  const transcriptPath = threadFilePath(stateRoot, threadId);
  const transcriptSnapshot = await snapshotFile(transcriptPath);
  const attachmentId = createRunAttachmentId();
  const unlinkedAttachmentId = createRunAttachmentId();
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  const mediaBytes = Buffer.from('0123456789', 'utf8');
  await writeRunAttachment({
    workspaceRoot: stateRoot,
    threadId,
    attachmentId,
    bytes: imageBytes,
  });
  await writeRunAttachment({
    workspaceRoot: stateRoot,
    threadId,
    attachmentId: unlinkedAttachmentId,
    bytes: Buffer.from('must remain private', 'utf8'),
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'inspect this image',
    timestamp: '2026-07-28T00:00:00.000Z',
    metadata: {
      attachments: [
        {
          attachmentId,
          name: 'diagram.png',
          mimeType: 'image/png',
          kind: 'image',
          byteLength: imageBytes.byteLength,
        },
      ],
    },
  });
  const media = await writeThreadMediaFile({
    workspaceRoot: stateRoot,
    threadId,
    extension: 'mp4',
    bytes: mediaBytes,
    maxBytes: 1_024,
  });

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const attachment = await fetch(
          `http://127.0.0.1:${port}/api/threads/${threadId}/attachments/${attachmentId}`,
          { headers: authHeaders() },
        );
        assert.equal(attachment.status, 200);
        assert.equal(attachment.headers.get('content-type'), 'image/png');
        assert.equal(
          attachment.headers.get('content-security-policy'),
          'sandbox',
        );
        assert.equal(
          attachment.headers.get('cache-control'),
          'private, max-age=31536000, immutable',
        );
        assert.deepEqual(
          Buffer.from(await attachment.arrayBuffer()),
          imageBytes,
        );

        const unlinked = await fetch(
          `http://127.0.0.1:${port}/api/threads/${threadId}/attachments/${unlinkedAttachmentId}`,
          { headers: authHeaders() },
        );
        assert.equal(unlinked.status, 404);

        const fullMedia = await fetch(
          `http://127.0.0.1:${port}/api/threads/${threadId}/media/${media.mediaRef}`,
          { headers: authHeaders() },
        );
        assert.equal(fullMedia.status, 200);
        assert.equal(fullMedia.headers.get('content-type'), 'video/mp4');
        assert.deepEqual(
          Buffer.from(await fullMedia.arrayBuffer()),
          mediaBytes,
        );

        const range = await fetch(
          `http://127.0.0.1:${port}/api/threads/${threadId}/media/${media.mediaRef}`,
          { headers: { ...authHeaders(), Range: 'bytes=2-5' } },
        );
        assert.equal(range.status, 206);
        assert.equal(range.headers.get('content-range'), 'bytes 2-5/10');
        assert.equal(await range.text(), '2345');

        const suffix = await fetch(
          `http://127.0.0.1:${port}/api/threads/${threadId}/media/${media.mediaRef}`,
          { headers: { ...authHeaders(), Range: 'bytes=-3' } },
        );
        assert.equal(suffix.status, 206);
        assert.equal(await suffix.text(), '789');

        const unsatisfiable = await fetch(
          `http://127.0.0.1:${port}/api/threads/${threadId}/media/${media.mediaRef}`,
          { headers: { ...authHeaders(), Range: 'bytes=10-' } },
        );
        assert.equal(unsatisfiable.status, 416);
        assert.equal(unsatisfiable.headers.get('content-range'), 'bytes */10');

        const invalidRef = await fetch(
          `http://127.0.0.1:${port}/api/threads/${threadId}/media/not-a-media-ref`,
          { headers: authHeaders() },
        );
        assert.equal(invalidRef.status, 400);
      },
      { daemonContext },
    );
  } finally {
    await restoreFileSnapshot(transcriptPath, transcriptSnapshot);
    await rm(
      join(stateRoot, '.geulbat', 'sessions', `${threadId}.attachments`),
      { recursive: true, force: true },
    );
    await rm(join(stateRoot, '.geulbat', 'media', threadId), {
      recursive: true,
      force: true,
    });
  }
});

void test('authenticated thread archives export with a fixed media type and import as a new thread', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const stateRoot = daemonContext.homeStateRoot;
  const threadId = assertValidThreadId(randomUUID());
  const missingThreadId = assertValidThreadId(randomUUID());
  const indexPath = indexFilePath(stateRoot);
  const transcriptPath = threadFilePath(stateRoot, threadId);
  const indexSnapshot = await snapshotFile(indexPath);
  const transcriptSnapshot = await snapshotFile(transcriptPath);
  let archiveBytes = Buffer.alloc(0);
  let importedThreadId: string | undefined;
  const projection =
    await daemonContext.toolLibraryProjection.resolveProjection({
      stateRoot,
      threadId,
      allowedRegistryNames: [],
    });
  assert.equal(projection.ok, true);
  await upsertThreadSummary(stateRoot, {
    threadId,
    title: 'Portable route thread',
    lastUpdated: '2026-07-28T00:00:00.000Z',
    messageCount: 1,
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'portable message',
    timestamp: '2026-07-28T00:00:00.000Z',
  });

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const exported = await fetch(
          `http://127.0.0.1:${port}/api/threads/${threadId}/archive`,
          { headers: authHeaders() },
        );
        const exportedBytes = Buffer.from(await exported.arrayBuffer());
        assert.equal(exported.status, 200, exportedBytes.toString('utf8'));
        assert.equal(
          exported.headers.get('content-type'),
          THREAD_ARCHIVE_MEDIA_TYPE,
        );
        assert.equal(exported.headers.get('cache-control'), 'no-store');
        assert.notEqual(exported.headers.get('x-geulbat-archive-id'), null);
        archiveBytes = exportedBytes;

        const wrongContentType = await fetch(
          `http://127.0.0.1:${port}/api/thread-archives/import`,
          {
            method: 'POST',
            headers: {
              ...authHeaders(),
              'Content-Type': 'application/json',
            },
            body: archiveBytes,
          },
        );
        assert.equal(wrongContentType.status, 400);

        const imported = await fetch(
          `http://127.0.0.1:${port}/api/thread-archives/import`,
          {
            method: 'POST',
            headers: {
              ...authHeaders(),
              'Content-Type': `${THREAD_ARCHIVE_MEDIA_TYPE}; charset=utf-8`,
            },
            body: archiveBytes,
          },
        );
        assert.equal(imported.status, 200);
        const importedBody = (await imported.json()) as {
          ok: true;
          threadId: string;
          archiveId: string;
          importedMessageCount: number;
        };
        importedThreadId = importedBody.threadId;
        assert.notEqual(importedBody.threadId, threadId);
        assert.equal(importedBody.importedMessageCount, 1);

        const missing = await fetch(
          `http://127.0.0.1:${port}/api/threads/${missingThreadId}/archive`,
          { headers: authHeaders() },
        );
        assert.equal(missing.status, 404);

        const invalidArchive = await fetch(
          `http://127.0.0.1:${port}/api/thread-archives/import`,
          {
            method: 'POST',
            headers: {
              ...authHeaders(),
              'Content-Type': THREAD_ARCHIVE_MEDIA_TYPE,
            },
            body: Buffer.from('not an archive', 'utf8'),
          },
        );
        assert.equal(invalidArchive.status, 400);
      },
      { daemonContext },
    );
  } finally {
    await restoreFileSnapshot(indexPath, indexSnapshot);
    await restoreFileSnapshot(transcriptPath, transcriptSnapshot);
    if (importedThreadId !== undefined) {
      await rm(threadFilePath(stateRoot, importedThreadId), { force: true });
      await rm(artifactStoreFilePath(stateRoot, importedThreadId), {
        force: true,
      });
    }
  }
});
