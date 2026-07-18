import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import {
  mkdir,
  readFile as fsReadFile,
  rm,
  stat,
  utimes,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import type { ArtifactId } from '@geulbat/protocol/artifacts';

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
import { commitThreadArtifactVersion } from './daemon/sessions/artifact-store.js';
import { hasErrorCode } from './daemon/utils/error.js';
import { assertThreadId as assertValidThreadId } from '@geulbat/protocol/ids';
import { isThreadBranchResponse } from '@geulbat/protocol/threads';
import {
  authHeaders,
  createRouteTestDaemonContext,
  withAuthenticatedDaemonServer,
} from './test-support/http-routes.js';
import { testRunId } from './test-support/run-id.js';

void test('authenticated threads routes return stored summaries and transcript detail', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const stateRoot = daemonContext.homeStateRoot;
  const threadId = assertValidThreadId(randomUUID());
  const indexPath = indexFilePath(stateRoot);
  const transcriptPath = threadFilePath(stateRoot, threadId);
  const artifactPath = artifactStoreFilePath(stateRoot, threadId);
  const indexSnapshot = await snapshotFile(indexPath);
  const transcriptSnapshot = await snapshotFile(transcriptPath);
  const artifactSnapshot = await snapshotFile(artifactPath);

  await upsertThreadSummary(stateRoot, {
    threadId,
    title: 'Route test thread',
    lastUpdated: '2026-03-25T00:00:00.000Z',
    messageCount: 2,
  });
  await mkdir(dirname(transcriptPath), { recursive: true });
  const committedArtifact = await commitThreadArtifactVersion({
    workspaceRoot: stateRoot,
    threadId,
    runId: 'run_route_test',
    renderer: 'markdown',
    payload: '# world',
    digest: '요약',
    sourceRef: {
      kind: 'thread-file',
      workingDirectory: 'stories',
      threadId,
      runId: 'run_route_test',
      filePath: 'episodes/ch01.md',
      messageTimestamp: '2026-03-25T00:00:01.000Z',
    },
    timestamp: '2026-03-25T00:00:01.000Z',
  });
  await fsWriteFile(
    transcriptPath,
    [
      JSON.stringify({
        role: 'user',
        content: 'hello',
        timestamp: '2026-03-25T00:00:00.000Z',
      }),
      JSON.stringify({
        role: 'assistant',
        content: '',
        timestamp: '2026-03-25T00:00:01.000Z',
        metadata: {
          phase: 'final_answer',
          artifactRefs: [committedArtifact.ref],
          activeArtifactRef: committedArtifact.ref,
        },
      }),
      '',
    ].join('\n'),
    'utf8',
  );

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const listRes = await fetch(`http://127.0.0.1:${port}/api/threads`, {
          headers: authHeaders(),
        });
        assert.equal(listRes.status, 200);
        const listBody = (await listRes.json()) as {
          threads: Array<{
            threadId: string;
            title?: string;
            messageCount: number;
          }>;
        };
        assert.ok(
          listBody.threads.some(
            (thread) =>
              thread.threadId === threadId &&
              thread.title === 'Route test thread' &&
              thread.messageCount === 2,
          ),
        );
        assert.equal(
          listBody.threads.some((thread) => 'projectId' in thread),
          false,
        );

        const detailRes = await fetch(
          `http://127.0.0.1:${port}/api/threads/${threadId}`,
          {
            headers: authHeaders(),
          },
        );
        assert.equal(detailRes.status, 200);
        const detailBody = (await detailRes.json()) as {
          threadId: string;
          snapshotVersion: string;
          diagnostics?: {
            unlinkedPersistedArtifactCount: number;
            missingLinkedArtifactCount: number;
          };
          messages: Array<{ role: string; content: string }>;
          artifacts: Array<{
            artifactId: ArtifactId;
            version: number;
            payload: string;
            digest: string | null;
          }>;
        };
        assert.equal(detailBody.threadId, threadId);
        assert.equal('projectId' in detailBody, false);
        assert.equal(detailBody.snapshotVersion, '2026-03-25T00:00:00.000Z');
        assert.equal(detailBody.diagnostics, undefined);
        assert.deepEqual(
          detailBody.messages.map((message) => [message.role, message.content]),
          [
            ['user', 'hello'],
            ['assistant', ''],
          ],
        );
        assert.equal(detailBody.artifacts.length, 1);
        assert.equal(
          detailBody.artifacts[0]?.artifactId,
          committedArtifact.artifact.artifactId,
        );
        assert.equal(detailBody.artifacts[0]?.version, 1);
        assert.equal(detailBody.artifacts[0]?.payload, '# world');
        assert.equal(detailBody.artifacts[0]?.digest, '요약');
      },
      { daemonContext },
    );
  } finally {
    await restoreFileSnapshot(indexPath, indexSnapshot);
    await restoreFileSnapshot(transcriptPath, transcriptSnapshot);
    await restoreFileSnapshot(artifactPath, artifactSnapshot);
  }
});

void test('authenticated thread detail returns persisted artifacts even when transcript metadata omits refs', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const stateRoot = daemonContext.homeStateRoot;
  const threadId = assertValidThreadId(randomUUID());
  const indexPath = indexFilePath(stateRoot);
  const transcriptPath = threadFilePath(stateRoot, threadId);
  const artifactPath = artifactStoreFilePath(stateRoot, threadId);
  const indexSnapshot = await snapshotFile(indexPath);
  const transcriptSnapshot = await snapshotFile(transcriptPath);
  const artifactSnapshot = await snapshotFile(artifactPath);

  await upsertThreadSummary(stateRoot, {
    threadId,
    title: 'Metadata-light artifact thread',
    lastUpdated: '2026-03-25T00:05:00.000Z',
    messageCount: 1,
  });
  await mkdir(dirname(transcriptPath), { recursive: true });
  const committedArtifact = await commitThreadArtifactVersion({
    workspaceRoot: stateRoot,
    threadId,
    runId: 'run_route_test_metadata_light',
    renderer: 'markdown',
    payload: '# detached',
    digest: 'metadata-light',
    sourceRef: {
      kind: 'thread-file',
      workingDirectory: 'stories',
      threadId,
      runId: 'run_route_test_metadata_light',
      filePath: 'episodes/ch01.md',
      messageTimestamp: '2026-03-25T00:05:01.000Z',
    },
    timestamp: '2026-03-25T00:05:01.000Z',
  });
  await fsWriteFile(
    transcriptPath,
    [
      JSON.stringify({
        role: 'assistant',
        content: '',
        timestamp: '2026-03-25T00:05:01.000Z',
        metadata: {
          phase: 'final_answer',
          sourceRunId: 'run_route_test_metadata_light',
        },
      }),
      '',
    ].join('\n'),
    'utf8',
  );

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const detailRes = await fetch(
          `http://127.0.0.1:${port}/api/threads/${threadId}`,
          {
            headers: authHeaders(),
          },
        );
        assert.equal(detailRes.status, 200);
        const detailBody = (await detailRes.json()) as {
          threadId: string;
          snapshotVersion: string;
          diagnostics?: {
            unlinkedPersistedArtifactCount: number;
            missingLinkedArtifactCount: number;
          };
          messages: Array<{ role: string; content: string }>;
          artifacts: Array<{
            artifactId: ArtifactId;
            version: number;
            payload: string;
            digest: string | null;
          }>;
        };
        assert.equal(detailBody.threadId, threadId);
        assert.equal(detailBody.snapshotVersion, '2026-03-25T00:05:00.000Z');
        assert.equal(detailBody.messages.length, 1);
        assert.equal(detailBody.artifacts.length, 1);
        assert.deepEqual(detailBody.diagnostics, {
          unlinkedPersistedArtifactCount: 1,
          missingLinkedArtifactCount: 0,
        });
        assert.equal(
          detailBody.artifacts[0]?.artifactId,
          committedArtifact.artifact.artifactId,
        );
        assert.equal(detailBody.artifacts[0]?.version, 1);
        assert.equal(detailBody.artifacts[0]?.payload, '# detached');
        assert.equal(detailBody.artifacts[0]?.digest, 'metadata-light');
      },
      { daemonContext },
    );
  } finally {
    await restoreFileSnapshot(indexPath, indexSnapshot);
    await restoreFileSnapshot(transcriptPath, transcriptSnapshot);
    await restoreFileSnapshot(artifactPath, artifactSnapshot);
  }
});

void test('authenticated thread detail surfaces missing transcript linkage diagnostics', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const stateRoot = daemonContext.homeStateRoot;
  const threadId = assertValidThreadId(randomUUID());
  const indexPath = indexFilePath(stateRoot);
  const transcriptPath = threadFilePath(stateRoot, threadId);
  const artifactPath = artifactStoreFilePath(stateRoot, threadId);
  const indexSnapshot = await snapshotFile(indexPath);
  const transcriptSnapshot = await snapshotFile(transcriptPath);
  const artifactSnapshot = await snapshotFile(artifactPath);

  await upsertThreadSummary(stateRoot, {
    threadId,
    title: 'Missing linkage thread',
    lastUpdated: '2026-03-25T00:07:00.000Z',
    messageCount: 1,
  });
  await mkdir(dirname(transcriptPath), { recursive: true });
  await fsWriteFile(
    transcriptPath,
    [
      JSON.stringify({
        role: 'assistant',
        content: '',
        timestamp: '2026-03-25T00:07:01.000Z',
        metadata: {
          phase: 'final_answer',
          sourceRunId: 'run_route_test_missing_link',
          artifactRefs: [{ artifactId: 'art_missing', version: 1 }],
          activeArtifactRef: { artifactId: 'art_missing', version: 1 },
        },
      }),
      '',
    ].join('\n'),
    'utf8',
  );

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const detailRes = await fetch(
          `http://127.0.0.1:${port}/api/threads/${threadId}`,
          {
            headers: authHeaders(),
          },
        );
        assert.equal(detailRes.status, 200);
        const detailBody = (await detailRes.json()) as {
          diagnostics?: {
            unlinkedPersistedArtifactCount: number;
            missingLinkedArtifactCount: number;
          };
          artifacts: Array<unknown>;
        };
        assert.equal(detailBody.artifacts.length, 0);
        assert.deepEqual(detailBody.diagnostics, {
          unlinkedPersistedArtifactCount: 0,
          missingLinkedArtifactCount: 1,
        });
      },
      { daemonContext },
    );
  } finally {
    await restoreFileSnapshot(indexPath, indexSnapshot);
    await restoreFileSnapshot(transcriptPath, transcriptSnapshot);
    await restoreFileSnapshot(artifactPath, artifactSnapshot);
  }
});

void test('authenticated thread detail rejects corrupted transcript data', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const stateRoot = daemonContext.homeStateRoot;
  const threadId = assertValidThreadId(randomUUID());
  const transcriptPath = threadFilePath(stateRoot, threadId);
  const transcriptSnapshot = await snapshotFile(transcriptPath);

  await mkdir(dirname(transcriptPath), { recursive: true });
  await fsWriteFile(
    transcriptPath,
    [
      JSON.stringify({
        role: 'user',
        content: 'visible before corruption',
        timestamp: '2026-03-25T00:08:00.000Z',
      }),
      '{"role":"assistant"',
      '',
    ].join('\n'),
    'utf8',
  );

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const detailRes = await fetch(
          `http://127.0.0.1:${port}/api/threads/${threadId}`,
          {
            headers: authHeaders(),
          },
        );
        assert.equal(detailRes.status, 500);
        const detailBody = (await detailRes.json()) as Record<string, unknown>;
        assert.deepEqual(detailBody, {
          code: 'internal',
          message: 'thread transcript is corrupted',
        });
        assert.equal('messages' in detailBody, false);
      },
      { daemonContext },
    );
  } finally {
    await restoreFileSnapshot(transcriptPath, transcriptSnapshot);
  }
});

void test('authenticated thread detail rejects corrupted artifact store data', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const stateRoot = daemonContext.homeStateRoot;
  const threadId = assertValidThreadId(randomUUID());
  const transcriptPath = threadFilePath(stateRoot, threadId);
  const artifactPath = artifactStoreFilePath(stateRoot, threadId);
  const transcriptSnapshot = await snapshotFile(transcriptPath);
  const artifactSnapshot = await snapshotFile(artifactPath);

  await mkdir(dirname(transcriptPath), { recursive: true });
  await fsWriteFile(
    transcriptPath,
    [
      JSON.stringify({
        role: 'user',
        content: 'visible before artifact corruption',
        timestamp: '2026-03-25T00:09:00.000Z',
      }),
      '',
    ].join('\n'),
    'utf8',
  );
  await mkdir(dirname(artifactPath), { recursive: true });
  await fsWriteFile(artifactPath, '{"schemaVersion":1,"artifacts":[', 'utf8');

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const detailRes = await fetch(
          `http://127.0.0.1:${port}/api/threads/${threadId}`,
          {
            headers: authHeaders(),
          },
        );
        assert.equal(detailRes.status, 500);
        const detailBody = (await detailRes.json()) as Record<string, unknown>;
        assert.deepEqual(detailBody, {
          code: 'internal',
          message: 'thread artifact store is corrupted',
        });
        assert.equal('artifacts' in detailBody, false);
      },
      { daemonContext },
    );
  } finally {
    await restoreFileSnapshot(transcriptPath, transcriptSnapshot);
    await restoreFileSnapshot(artifactPath, artifactSnapshot);
  }
});

void test('authenticated thread detail falls back to filesystem snapshotVersion when thread index entry is absent', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const stateRoot = daemonContext.homeStateRoot;
  const threadId = assertValidThreadId(randomUUID());
  const transcriptPath = threadFilePath(stateRoot, threadId);
  const artifactPath = artifactStoreFilePath(stateRoot, threadId);
  const transcriptSnapshot = await snapshotFile(transcriptPath);
  const artifactSnapshot = await snapshotFile(artifactPath);

  await mkdir(dirname(transcriptPath), { recursive: true });
  const committedArtifact = await commitThreadArtifactVersion({
    workspaceRoot: stateRoot,
    threadId,
    runId: 'run_route_test_snapshot_fallback',
    renderer: 'markdown',
    payload: '# future artifact timestamp',
    digest: 'snapshot-fallback',
    sourceRef: {
      kind: 'thread-file',
      workingDirectory: 'stories',
      threadId,
      runId: 'run_route_test_snapshot_fallback',
      filePath: 'episodes/ch03.md',
      messageTimestamp: '2099-03-25T00:12:00.000Z',
    },
    timestamp: '2099-03-25T00:12:00.000Z',
  });
  await fsWriteFile(
    transcriptPath,
    [
      JSON.stringify({
        role: 'assistant',
        content: '',
        timestamp: '2099-03-25T00:11:00.000Z',
        metadata: {
          phase: 'final_answer',
          artifactRefs: [committedArtifact.ref],
          activeArtifactRef: committedArtifact.ref,
        },
      }),
      '',
    ].join('\n'),
    'utf8',
  );

  const transcriptMtime = new Date('2026-03-25T00:11:00.000Z');
  const artifactMtime = new Date('2026-03-25T00:12:00.000Z');
  await utimes(transcriptPath, transcriptMtime, transcriptMtime);
  await utimes(artifactPath, artifactMtime, artifactMtime);

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const detailRes = await fetch(
          `http://127.0.0.1:${port}/api/threads/${threadId}`,
          {
            headers: authHeaders(),
          },
        );
        assert.equal(detailRes.status, 200);
        const detailBody = (await detailRes.json()) as {
          snapshotVersion: string;
          artifacts: Array<{ artifactId: ArtifactId; version: number }>;
        };
        assert.equal(detailBody.snapshotVersion, artifactMtime.toISOString());
        assert.equal(detailBody.artifacts.length, 1);
      },
      { daemonContext },
    );
  } finally {
    await restoreFileSnapshot(transcriptPath, transcriptSnapshot);
    await restoreFileSnapshot(artifactPath, artifactSnapshot);
  }
});

void test('authenticated thread detail leaves legacy envelope transcript messages untouched', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const stateRoot = daemonContext.homeStateRoot;
  const threadId = assertValidThreadId(randomUUID());
  const indexPath = indexFilePath(stateRoot);
  const transcriptPath = threadFilePath(stateRoot, threadId);
  const artifactPath = artifactStoreFilePath(stateRoot, threadId);
  const indexSnapshot = await snapshotFile(indexPath);
  const transcriptSnapshot = await snapshotFile(transcriptPath);
  const artifactSnapshot = await snapshotFile(artifactPath);

  await upsertThreadSummary(stateRoot, {
    threadId,
    title: 'Legacy envelope thread',
    lastUpdated: '2026-03-25T00:10:00.000Z',
    messageCount: 1,
  });
  await mkdir(dirname(transcriptPath), { recursive: true });
  await fsWriteFile(
    transcriptPath,
    [
      JSON.stringify({
        role: 'assistant',
        content:
          '<!-- GEULBAT_ARTIFACT {"renderer":"markdown","digest":"legacy-digest"} -->\n# migrated title\n<!-- /GEULBAT_ARTIFACT -->',
        timestamp: '2026-03-25T00:10:01.000Z',
        metadata: {
          phase: 'final_answer',
          sourceFile: 'episodes/ch02.md',
          sourceRunId: 'run_legacy_backfill',
        },
      }),
      '',
    ].join('\n'),
    'utf8',
  );

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const detailRes = await fetch(
          `http://127.0.0.1:${port}/api/threads/${threadId}`,
          {
            headers: authHeaders(),
          },
        );
        assert.equal(detailRes.status, 200);
        const detailBody = (await detailRes.json()) as {
          threadId: string;
          snapshotVersion: string;
          messages: Array<{
            role: string;
            content: string;
            metadata?: {
              artifactRefs?: Array<{ artifactId: ArtifactId; version: number }>;
              activeArtifactRef?: { artifactId: ArtifactId; version: number };
            };
          }>;
          artifacts: Array<{
            artifactId: ArtifactId;
            version: number;
            renderer: string;
            payload: string;
            digest: string | null;
          }>;
        };
        assert.equal(detailBody.threadId, threadId);
        assert.equal(detailBody.snapshotVersion, '2026-03-25T00:10:00.000Z');
        assert.equal(detailBody.messages.length, 1);
        assert.equal(detailBody.artifacts.length, 0);
        assert.equal(
          detailBody.messages[0]?.content,
          '<!-- GEULBAT_ARTIFACT {"renderer":"markdown","digest":"legacy-digest"} -->\n# migrated title\n<!-- /GEULBAT_ARTIFACT -->',
        );
        assert.equal(detailBody.messages[0]?.metadata?.artifactRefs, undefined);
        assert.equal(
          detailBody.messages[0]?.metadata?.activeArtifactRef,
          undefined,
        );

        const persistedTranscript = (await fsReadFile(transcriptPath, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        assert.equal(
          (
            persistedTranscript[0]?.metadata as
              | {
                  artifactRefs?: Array<{
                    artifactId: ArtifactId;
                    version: number;
                  }>;
                  activeArtifactRef?: {
                    artifactId: ArtifactId;
                    version: number;
                  };
                }
              | undefined
          )?.artifactRefs,
          undefined,
        );
        assert.equal(
          (
            persistedTranscript[0]?.metadata as
              | {
                  activeArtifactRef?: {
                    artifactId: ArtifactId;
                    version: number;
                  };
                }
              | undefined
          )?.activeArtifactRef,
          undefined,
        );

        await assert.rejects(stat(artifactPath));
      },
      { daemonContext },
    );
  } finally {
    await restoreFileSnapshot(indexPath, indexSnapshot);
    await restoreFileSnapshot(transcriptPath, transcriptSnapshot);
    await restoreFileSnapshot(artifactPath, artifactSnapshot);
  }
});

void test('authenticated threads routes tolerate corrupted index entries and return valid summaries', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const stateRoot = daemonContext.homeStateRoot;
  const threadId = assertValidThreadId(randomUUID());
  const indexPath = indexFilePath(stateRoot);
  const indexSnapshot = await snapshotFile(indexPath);

  await mkdir(dirname(indexPath), { recursive: true });
  await fsWriteFile(
    indexPath,
    JSON.stringify([
      {
        threadId,
        title: 'Still visible',
        lastUpdated: '2026-03-25T00:00:00.000Z',
        messageCount: 2,
      },
      {
        threadId: 'broken-thread-id',
        title: 'Broken entry',
      },
      {
        threadId: assertValidThreadId(randomUUID()),
        projectId: 'missing-project',
        title: 'Unknown project',
        lastUpdated: '2026-03-25T00:00:01.000Z',
        messageCount: 1,
      },
    ]) + '\n',
    'utf8',
  );

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const listRes = await fetch(`http://127.0.0.1:${port}/api/threads`, {
          headers: authHeaders(),
        });
        assert.equal(listRes.status, 200);
        const listBody = (await listRes.json()) as {
          threads: Array<{
            threadId: string;
            title?: string;
            messageCount: number;
          }>;
        };
        assert.deepEqual(listBody.threads, [
          {
            threadId,
            title: 'Still visible',
            lastUpdated: '2026-03-25T00:00:00.000Z',
            messageCount: 2,
          },
        ]);
      },
      { daemonContext },
    );
  } finally {
    await restoreFileSnapshot(indexPath, indexSnapshot);
  }
});

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

async function snapshotFile(
  filePath: string,
): Promise<{ exists: boolean; content: string | null }> {
  try {
    return {
      exists: true,
      content: await fsReadFile(filePath, 'utf8'),
    };
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) {
      return { exists: false, content: null };
    }
    throw error;
  }
}

async function restoreFileSnapshot(
  filePath: string,
  snapshot: { exists: boolean; content: string | null },
): Promise<void> {
  if (!snapshot.exists) {
    await rm(filePath, { force: true });
    return;
  }

  await mkdir(dirname(filePath), { recursive: true });
  await fsWriteFile(filePath, snapshot.content ?? '', 'utf8');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
