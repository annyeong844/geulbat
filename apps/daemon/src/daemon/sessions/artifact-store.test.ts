import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { testProjectId } from '../../test-support/project-id.js';
import { testThreadId } from '../../test-support/thread-id.js';
import { artifactStoreFilePath } from './paths.js';
import {
  ArtifactStoreCorruptionError,
  commitThreadArtifactVersion,
  isArtifactStoreCorruptionError,
  loadAllThreadArtifactVersions,
} from './artifact-store.js';

void test('commitThreadArtifactVersion serializes concurrent commits for the same thread', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-artifact-'));
  const projectId = testProjectId('project');
  const threadId = testThreadId(501);
  const commits = Array.from({ length: 12 }, (_, index) => ({
    payload: `# artifact-${index}\n\n${'x'.repeat(2048)}`,
    timestamp: `2026-04-17T00:00:${String(index).padStart(2, '0')}.000Z`,
    runId: `run-${index}`,
    digest: `digest-${index}`,
  }));

  await Promise.all(
    commits.map((entry) =>
      commitThreadArtifactVersion({
        workspaceRoot,
        projectId,
        threadId,
        runId: entry.runId,
        renderer: 'markdown',
        payload: entry.payload,
        digest: entry.digest,
        sourceRef: {
          kind: 'thread-file',
          projectId,
          threadId,
          runId: entry.runId,
          filePath: 'episodes/ch01.md',
          messageTimestamp: entry.timestamp,
        },
        timestamp: entry.timestamp,
      }),
    ),
  );

  const persisted = await loadAllThreadArtifactVersions(
    workspaceRoot,
    threadId,
  );
  assert.equal(persisted.length, commits.length);
  assert.deepEqual(
    persisted.map((artifact) => artifact.payload),
    commits.map((entry) => entry.payload),
  );
  assert.deepEqual(
    persisted.map((artifact) => artifact.digest),
    commits.map((entry) => entry.digest),
  );
});

void test('loadAllThreadArtifactVersions accepts legacy unversioned artifact store files', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-artifact-'));
  const projectId = testProjectId('project');
  const threadId = testThreadId(502);
  const storePath = artifactStoreFilePath(workspaceRoot, threadId);
  await mkdir(join(workspaceRoot, '.geulbat', 'sessions', threadId), {
    recursive: true,
  });
  await writeFile(
    storePath,
    JSON.stringify(
      {
        artifacts: [
          {
            artifactId: 'art_legacy',
            projectId,
            threadId,
            renderer: 'markdown',
            title: null,
            sourceRef: null,
            latestVersion: 1,
            persistenceEpoch: 0,
            createdAt: '2026-04-17T00:00:00.000Z',
            updatedAt: '2026-04-17T00:00:00.000Z',
          },
        ],
        versions: [
          {
            artifactId: 'art_legacy',
            version: 1,
            parentVersion: null,
            baseVersion: null,
            renderer: 'markdown',
            payload: '# legacy',
            digest: 'legacy-digest',
            contentHash: 'legacy-hash',
            createdAt: '2026-04-17T00:00:00.000Z',
            createdByRunId: 'run-legacy',
            previewValidation: { ok: true },
          },
        ],
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  const persisted = await loadAllThreadArtifactVersions(
    workspaceRoot,
    threadId,
  );
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]?.artifactId, 'art_legacy');
  assert.equal(persisted[0]?.payload, '# legacy');
});

void test('loadAllThreadArtifactVersions upgrades legacy nullable artifact source refs', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-artifact-'));
  const projectId = testProjectId('project');
  const threadId = testThreadId(505);
  const storePath = artifactStoreFilePath(workspaceRoot, threadId);
  await mkdir(join(workspaceRoot, '.geulbat', 'sessions', threadId), {
    recursive: true,
  });
  await writeFile(
    storePath,
    JSON.stringify(
      {
        schemaVersion: 1,
        artifacts: [
          {
            artifactId: 'art_legacy_source',
            projectId,
            threadId,
            renderer: 'markdown',
            title: null,
            sourceRef: {
              projectId,
              threadId,
              runId: 'run-legacy-source',
              filePath: 'episodes/ch01.md',
              messageTimestamp: '2026-04-17T00:00:00.000Z',
            },
            latestVersion: 1,
            persistenceEpoch: 0,
            createdAt: '2026-04-17T00:00:00.000Z',
            updatedAt: '2026-04-17T00:00:00.000Z',
          },
        ],
        versions: [
          {
            artifactId: 'art_legacy_source',
            version: 1,
            parentVersion: null,
            baseVersion: null,
            renderer: 'markdown',
            payload: '# legacy source',
            digest: 'legacy-source-digest',
            contentHash: 'legacy-source-hash',
            createdAt: '2026-04-17T00:00:00.000Z',
            createdByRunId: 'run-legacy-source',
            previewValidation: { ok: true },
          },
        ],
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  const persisted = await loadAllThreadArtifactVersions(
    workspaceRoot,
    threadId,
  );
  assert.deepEqual(persisted[0]?.sourceRef, {
    kind: 'thread-file',
    projectId,
    threadId,
    runId: 'run-legacy-source',
    filePath: 'episodes/ch01.md',
    messageTimestamp: '2026-04-17T00:00:00.000Z',
  });
});

void test('commitThreadArtifactVersion writes schemaVersioned artifact store files', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-artifact-'));
  const projectId = testProjectId('project');
  const threadId = testThreadId(503);

  await commitThreadArtifactVersion({
    workspaceRoot,
    projectId,
    threadId,
    runId: 'run-versioned',
    renderer: 'markdown',
    payload: '# versioned',
    digest: 'versioned-digest',
    sourceRef: {
      kind: 'thread-file',
      projectId,
      threadId,
      runId: 'run-versioned',
      filePath: 'episodes/ch01.md',
      messageTimestamp: '2026-04-17T00:00:00.000Z',
    },
    timestamp: '2026-04-17T00:00:00.000Z',
  });

  const raw = await readFile(
    artifactStoreFilePath(workspaceRoot, threadId),
    'utf8',
  );
  const parsed = JSON.parse(raw) as { schemaVersion?: unknown };
  assert.equal(parsed.schemaVersion, 1);
});

void test('loadAllThreadArtifactVersions rejects unsupported artifact store schema versions', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-artifact-'));
  const threadId = testThreadId(504);
  const storePath = artifactStoreFilePath(workspaceRoot, threadId);
  await mkdir(join(workspaceRoot, '.geulbat', 'sessions', threadId), {
    recursive: true,
  });
  await writeFile(
    storePath,
    JSON.stringify({
      schemaVersion: 99,
      artifacts: [],
      versions: [],
    }) + '\n',
    'utf8',
  );

  await assert.rejects(
    () => loadAllThreadArtifactVersions(workspaceRoot, threadId),
    /Unsupported thread artifact store schema version: 99/,
  );
});

void test('loadAllThreadArtifactVersions rejects malformed artifact store JSON as typed corruption', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-artifact-'));
  const threadId = testThreadId(506);
  const storePath = artifactStoreFilePath(workspaceRoot, threadId);
  const corruptedContents = '{"schemaVersion":1,"artifacts":[';
  await mkdir(join(workspaceRoot, '.geulbat', 'sessions', threadId), {
    recursive: true,
  });
  await writeFile(storePath, corruptedContents, 'utf8');

  await assert.rejects(
    () => loadAllThreadArtifactVersions(workspaceRoot, threadId),
    (error: unknown) => {
      assert.equal(error instanceof ArtifactStoreCorruptionError, true);
      assert.equal(isArtifactStoreCorruptionError(error), true);
      assert.equal(
        (error as { code?: unknown }).code,
        'artifact_store_corrupt',
      );
      assert.equal((error as { threadId?: unknown }).threadId, threadId);
      assert.doesNotMatch(
        String((error as { message?: unknown }).message ?? ''),
        /schemaVersion|artifacts|\[/u,
      );
      return true;
    },
  );
  assert.equal(await readFile(storePath, 'utf8'), corruptedContents);
});
