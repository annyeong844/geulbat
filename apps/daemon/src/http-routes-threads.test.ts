import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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

import { upsertThreadSummary } from './daemon/sessions/threads-index.js';
import {
  artifactStoreFilePath,
  indexFilePath,
  threadFilePath,
} from './daemon/sessions/paths.js';
import { commitThreadArtifactVersion } from './daemon/sessions/artifact-store.js';
import { appendTranscriptEntry } from './daemon/sessions/transcript-log.js';
import { createDaemonRuntimeStateStore } from './daemon/runtime-state-store.js';
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

void test('authenticated thread open returns the latest complete turn and pages older turns by exact entry anchor', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const stateRoot = daemonContext.homeStateRoot;
  const threadId = assertValidThreadId(randomUUID());
  const indexPath = indexFilePath(stateRoot);
  const transcriptPath = threadFilePath(stateRoot, threadId);
  const indexSnapshot = await snapshotFile(indexPath);
  const transcriptSnapshot = await snapshotFile(transcriptPath);

  await upsertThreadSummary(stateRoot, {
    threadId,
    title: 'Paged route test thread',
    lastUpdated: '2026-07-29T00:00:05.000Z',
    messageCount: 6,
  });
  const firstUser = await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'first question',
    timestamp: '2026-07-29T00:00:00.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'assistant',
    content: 'first answer',
    timestamp: '2026-07-29T00:00:01.000Z',
  });
  const secondUser = await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'second question',
    timestamp: '2026-07-29T00:00:02.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'assistant',
    content: 'second answer',
    timestamp: '2026-07-29T00:00:03.000Z',
  });
  const thirdUser = await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'third question',
    timestamp: '2026-07-29T00:00:04.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'assistant',
    content: 'third answer',
    timestamp: '2026-07-29T00:00:05.000Z',
  });

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const openResponse = await fetch(
          `http://127.0.0.1:${port}/api/threads/${threadId}/open`,
          { headers: authHeaders() },
        );
        assert.equal(openResponse.status, 200);
        const openBody = (await openResponse.json()) as {
          threadId: string;
          snapshotVersion: string;
          messages?: unknown;
          messagePage: {
            threadId: string;
            messages: Array<{ entryId: string; content: string }>;
            olderBeforeEntryId: string | null;
          };
        };
        assert.equal(openBody.threadId, threadId);
        assert.equal(openBody.snapshotVersion, '2026-07-29T00:00:05.000Z');
        assert.equal(openBody.messages, undefined);
        assert.equal(openBody.messagePage.threadId, threadId);
        assert.deepEqual(
          openBody.messagePage.messages.map((message) => message.content),
          ['third question', 'third answer'],
        );
        assert.equal(
          openBody.messagePage.olderBeforeEntryId,
          thirdUser.entryId,
        );

        const secondPageResponse = await fetch(
          `http://127.0.0.1:${port}/api/threads/${threadId}/messages?before=${encodeURIComponent(thirdUser.entryId)}`,
          { headers: authHeaders() },
        );
        assert.equal(secondPageResponse.status, 200);
        const secondPage = (await secondPageResponse.json()) as {
          threadId: string;
          messages: Array<{ entryId: string; content: string }>;
          olderBeforeEntryId: string | null;
        };
        assert.deepEqual(
          secondPage.messages.map((message) => message.content),
          ['second question', 'second answer'],
        );
        assert.equal(secondPage.olderBeforeEntryId, secondUser.entryId);

        const firstPageResponse = await fetch(
          `http://127.0.0.1:${port}/api/threads/${threadId}/messages?before=${encodeURIComponent(secondUser.entryId)}`,
          { headers: authHeaders() },
        );
        assert.equal(firstPageResponse.status, 200);
        const firstPage = (await firstPageResponse.json()) as {
          messages: Array<{ entryId: string; content: string }>;
          olderBeforeEntryId: string | null;
        };
        assert.deepEqual(
          firstPage.messages.map((message) => message.content),
          ['first question', 'first answer'],
        );
        assert.equal(firstPage.messages[0]?.entryId, firstUser.entryId);
        assert.equal(firstPage.olderBeforeEntryId, null);

        const missingAnchorResponse = await fetch(
          `http://127.0.0.1:${port}/api/threads/${threadId}/messages?before=missing-entry`,
          { headers: authHeaders() },
        );
        assert.equal(missingAnchorResponse.status, 404);

        const fullResponse = await fetch(
          `http://127.0.0.1:${port}/api/threads/${threadId}`,
          { headers: authHeaders() },
        );
        assert.equal(fullResponse.status, 200);
        const fullBody = (await fullResponse.json()) as {
          messages: Array<{ content: string }>;
        };
        assert.equal(fullBody.messages.length, 6);
      },
      { daemonContext },
    );
  } finally {
    await restoreFileSnapshot(indexPath, indexSnapshot);
    await restoreFileSnapshot(transcriptPath, transcriptSnapshot);
  }
});

void test('authenticated thread read routes reject invalid identities and missing page anchors', async () => {
  const daemonContext = createRouteTestDaemonContext();

  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      for (const request of [
        { method: 'GET', path: '/api/threads/not-a-thread/open' },
        {
          method: 'GET',
          path: '/api/threads/not-a-thread/messages?before=entry',
        },
        { method: 'GET', path: '/api/threads/not-a-thread' },
        {
          method: 'GET',
          path: '/api/threads/not-a-thread/attachments/attachment',
        },
        { method: 'GET', path: '/api/threads/not-a-thread/media/media.mp4' },
        { method: 'GET', path: '/api/threads/not-a-thread/archive' },
        { method: 'POST', path: '/api/threads/not-a-thread/branch' },
        {
          method: 'POST',
          path: '/api/threads/not-a-thread/artifacts/artifact/versions',
        },
        { method: 'PATCH', path: '/api/threads/not-a-thread' },
        { method: 'DELETE', path: '/api/threads/not-a-thread' },
      ]) {
        const response = await fetch(
          `http://127.0.0.1:${port}${request.path}`,
          {
            method: request.method,
            headers: authHeaders(),
          },
        );
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), {
          code: 'bad_request',
          message: 'invalid threadId',
        });
      }

      const missingAnchor = await fetch(
        `http://127.0.0.1:${port}/api/threads/${assertValidThreadId(randomUUID())}/messages`,
        { headers: authHeaders() },
      );
      assert.equal(missingAnchor.status, 400);
      assert.deepEqual(await missingAnchor.json(), {
        code: 'invalid_args',
        message: 'before entry id is required',
      });
    },
    { daemonContext },
  );
});

void test('authenticated thread detail restores acknowledged terminal worker history', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const stateRoot = daemonContext.homeStateRoot;
  const ownerThreadId = assertValidThreadId(randomUUID());
  const childThreadId = assertValidThreadId(randomUUID());
  const transcriptPath = threadFilePath(stateRoot, ownerThreadId);
  const runtimeStore = await createDaemonRuntimeStateStore({
    homeStateRoot: stateRoot,
  });
  daemonContext.backgroundNotifications.attachDurableStore(runtimeStore);

  await upsertThreadSummary(stateRoot, {
    threadId: ownerThreadId,
    title: 'Worker history',
    lastUpdated: '2026-07-23T10:00:00.000Z',
    messageCount: 0,
  });
  await mkdir(dirname(transcriptPath), { recursive: true });
  await fsWriteFile(transcriptPath, '', 'utf8');

  const terminalResult = {
    deliveryId: 'delivery-thread-history',
    parentRunId: testRunId('history-parent'),
    childRunId: testRunId('history-child-retry'),
    childThreadId,
    subagentType: 'worker' as const,
    capabilities: [] as const,
    toolSurface: 'worker' as const,
    runtime: {
      phase: 'tool_running' as const,
      observedAt: '2026-07-23T10:00:01.000Z',
      lastTool: {
        name: 'apply_patch',
        callId: 'call-history-patch',
        state: 'failed' as const,
      },
      partialOutputAvailable: true,
      previousChildRunId: testRunId('history-child-original'),
    },
    terminalState: 'failed' as const,
    reason: 'daemon_restart' as const,
    result: '재시작 전에 남긴 부분 결과',
    completedAt: '2026-07-23T10:00:02.000Z',
  };
  daemonContext.backgroundNotifications.enqueueThreadBackgroundResult(
    ownerThreadId,
    terminalResult,
  );
  daemonContext.backgroundNotifications.acknowledgeThreadBackgroundResults(
    ownerThreadId,
    [terminalResult.deliveryId],
  );

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/threads/${ownerThreadId}`,
          { headers: authHeaders() },
        );
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
          subagentTerminalOutcomes: Array<{
            deliveryId: string;
            resultRef: string;
            runtime?: { previousChildRunId?: string };
            reason?: string;
            result: string;
          }>;
        };
        assert.deepEqual(body.subagentTerminalOutcomes, [
          {
            ...terminalResult,
            resultDeliveryState: 'acknowledged',
            resultRef: `subagent-result:${terminalResult.deliveryId}`,
            resultDigest: `sha256:${createHash('sha256').update(terminalResult.result, 'utf8').digest('hex')}`,
          },
        ]);
      },
      { daemonContext },
    );
  } finally {
    runtimeStore.close();
    await rm(dirname(stateRoot), { recursive: true, force: true });
  }
});

void test('authenticated thread detail excludes provider compaction payloads from the public DTO', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const stateRoot = daemonContext.homeStateRoot;
  const threadId = assertValidThreadId(randomUUID());
  const indexPath = indexFilePath(stateRoot);
  const transcriptPath = threadFilePath(stateRoot, threadId);
  const indexSnapshot = await snapshotFile(indexPath);
  const transcriptSnapshot = await snapshotFile(transcriptPath);
  const encryptedContent = 'must-not-cross-the-public-thread-detail-boundary';

  await upsertThreadSummary(stateRoot, {
    threadId,
    title: 'Provider compaction visibility test',
    lastUpdated: '2026-03-25T00:00:00.000Z',
    messageCount: 2,
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'compaction',
    content: 'provider-native compaction',
    timestamp: '2026-03-25T00:00:00.000Z',
    compactionData: {
      kind: 'provider_native',
      providerId: 'openai_codex_direct',
      model: 'model-a',
      output: [
        {
          type: 'compaction',
          encrypted_content: encryptedContent,
        },
      ],
      tokensBefore: 7200,
      contextWindow: 8000,
      thresholdTokens: 7000,
    },
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'continue',
    timestamp: '2026-03-25T00:00:01.000Z',
  });

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const response = await fetch(
          `http://127.0.0.1:${port}/api/threads/${threadId}`,
          { headers: authHeaders() },
        );
        assert.equal(response.status, 200);
        const responseText = await response.text();
        assert.doesNotMatch(responseText, new RegExp(encryptedContent, 'u'));
        const detail = JSON.parse(responseText) as {
          messages: Array<{ role: string; content: string }>;
        };
        assert.equal(detail.messages.length, 1);
        assert.equal(detail.messages[0]?.role, 'user');
        assert.equal(detail.messages[0]?.content, 'continue');
        assert.equal('compactionData' in (detail.messages[0] ?? {}), false);
      },
      { daemonContext },
    );
  } finally {
    await restoreFileSnapshot(indexPath, indexSnapshot);
    await restoreFileSnapshot(transcriptPath, transcriptSnapshot);
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
        for (const path of [
          `/api/threads/${threadId}/open`,
          `/api/threads/${threadId}/messages?before=entry`,
        ]) {
          const response = await fetch(`http://127.0.0.1:${port}${path}`, {
            headers: authHeaders(),
          });
          assert.equal(response.status, 500);
          assert.deepEqual(await response.json(), {
            code: 'internal',
            message: 'thread transcript is corrupted',
          });
        }

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
        const openResponse = await fetch(
          `http://127.0.0.1:${port}/api/threads/${threadId}/open`,
          { headers: authHeaders() },
        );
        assert.equal(openResponse.status, 500);
        assert.deepEqual(await openResponse.json(), {
          code: 'internal',
          message: 'thread artifact store is corrupted',
        });

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
