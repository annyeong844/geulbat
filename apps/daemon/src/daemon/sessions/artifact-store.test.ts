import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { testThreadId } from '../../test-support/thread-id.js';
import { artifactStoreFilePath } from './paths.js';
import {
  ArtifactStoreCorruptionError,
  commitThreadArtifactUpdateVersion,
  commitThreadArtifactVersion,
  copyThreadArtifactVersionsByRefs,
  deleteThreadArtifactUpdateVersion,
  isArtifactStoreCorruptionError,
  loadAllThreadArtifactVersions,
} from './artifact-store.js';
import {
  statThreadMediaFile,
  writeThreadMediaFile,
} from './media-file-store.js';

void test('commitThreadArtifactUpdateVersion appends the next version with lineage and bumps latestVersion', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-artifact-'));
  const threadId = testThreadId(521);
  const created = await commitThreadArtifactVersion({
    workspaceRoot,
    threadId,
    runId: 'run-create',
    renderer: 'markdown',
    payload: '# v1',
    digest: 'digest-1',
    title: '초안',
    sourceRef: null,
    timestamp: '2026-07-17T00:00:00.000Z',
  });

  const updated = await commitThreadArtifactUpdateVersion({
    workspaceRoot,
    threadId,
    artifactId: created.artifact.artifactId,
    baseVersion: 1,
    payload: '# v2 (사용자 draft 커밋)',
    createdByRunId: 'user-edit-1',
    timestamp: '2026-07-17T00:01:00.000Z',
  });

  assert.equal(updated.ok, true);
  if (!updated.ok) {
    return;
  }
  assert.equal(updated.version.version, 2);
  assert.equal(updated.version.parentVersion, 1);
  assert.equal(updated.version.baseVersion, 1);
  assert.equal(updated.version.renderer, 'markdown');
  assert.equal(updated.version.createdByRunId, 'user-edit-1');
  assert.equal(updated.artifact.latestVersion, 2);
  assert.deepEqual(updated.ref, {
    artifactId: created.artifact.artifactId,
    version: 2,
  });

  const persisted = await loadAllThreadArtifactVersions(
    workspaceRoot,
    threadId,
  );
  assert.deepEqual(
    persisted.map((artifact) => [artifact.version, artifact.payload]),
    [
      [1, '# v1'],
      [2, '# v2 (사용자 draft 커밋)'],
    ],
  );
  // title/persistenceEpoch 같은 아티팩트 레벨 필드는 모든 버전에 승계된다
  assert.equal(persisted[1]?.title, '초안');
});

void test('commitThreadArtifactUpdateVersion rejects stale baseVersion and unknown artifacts without writing', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-artifact-'));
  const threadId = testThreadId(522);
  const created = await commitThreadArtifactVersion({
    workspaceRoot,
    threadId,
    runId: 'run-create',
    renderer: 'html5',
    payload: '<h1>v1</h1>',
    digest: null,
    sourceRef: null,
    timestamp: '2026-07-17T00:00:00.000Z',
  });
  const firstUpdate = await commitThreadArtifactUpdateVersion({
    workspaceRoot,
    threadId,
    artifactId: created.artifact.artifactId,
    baseVersion: 1,
    payload: '<h1>v2</h1>',
    createdByRunId: 'user-edit-1',
    timestamp: '2026-07-17T00:01:00.000Z',
  });
  assert.equal(firstUpdate.ok, true);

  // 같은 baseVersion으로 또 커밋 — 낙관적 동시성 위반은 version_conflict
  const stale = await commitThreadArtifactUpdateVersion({
    workspaceRoot,
    threadId,
    artifactId: created.artifact.artifactId,
    baseVersion: 1,
    payload: '<h1>stale</h1>',
    createdByRunId: 'user-edit-2',
    timestamp: '2026-07-17T00:02:00.000Z',
  });
  assert.deepEqual(stale, {
    ok: false,
    reason: 'version_conflict',
    latestVersion: 2,
  });

  const missing = await commitThreadArtifactUpdateVersion({
    workspaceRoot,
    threadId,
    artifactId: 'art_missing',
    baseVersion: 1,
    payload: '<h1>none</h1>',
    createdByRunId: 'user-edit-3',
    timestamp: '2026-07-17T00:03:00.000Z',
  });
  assert.deepEqual(missing, { ok: false, reason: 'artifact_not_found' });

  // 실패한 커밋은 version row를 남기지 않는다 (spec §5.2)
  const persisted = await loadAllThreadArtifactVersions(
    workspaceRoot,
    threadId,
  );
  assert.deepEqual(
    persisted.map((artifact) => artifact.version),
    [1, 2],
  );
});

void test('commitThreadArtifactUpdateVersion rejects renderer mismatch and version rollback removes only the appended version', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-artifact-'));
  const threadId = testThreadId(523);
  const created = await commitThreadArtifactVersion({
    workspaceRoot,
    threadId,
    runId: 'run-create',
    renderer: 'markdown',
    payload: '# v1',
    digest: null,
    sourceRef: null,
    timestamp: '2026-07-17T00:00:00.000Z',
  });

  // 렌더러 불일치 — identity가 갈라지므로 거절 (호출자는 새 생성 폴백)
  const mismatch = await commitThreadArtifactUpdateVersion({
    workspaceRoot,
    threadId,
    artifactId: created.artifact.artifactId,
    baseVersion: 1,
    payload: '<h1>html</h1>',
    createdByRunId: 'run-x',
    timestamp: '2026-07-17T00:01:00.000Z',
    expectedRenderer: 'html5',
  });
  assert.deepEqual(mismatch, {
    ok: false,
    reason: 'renderer_mismatch',
    renderer: 'markdown',
  });

  const updated = await commitThreadArtifactUpdateVersion({
    workspaceRoot,
    threadId,
    artifactId: created.artifact.artifactId,
    baseVersion: 1,
    payload: '# v2',
    createdByRunId: 'run-y',
    timestamp: '2026-07-17T00:02:00.000Z',
    expectedRenderer: 'markdown',
  });
  assert.equal(updated.ok, true);

  // update 롤백 — 최신 버전만 걷어내고 v1은 남는다
  await deleteThreadArtifactUpdateVersion({
    workspaceRoot,
    threadId,
    artifactId: created.artifact.artifactId,
    version: 2,
  });
  const afterRollback = await loadAllThreadArtifactVersions(
    workspaceRoot,
    threadId,
  );
  assert.deepEqual(
    afterRollback.map((artifact) => artifact.version),
    [1],
  );

  // 최신이 아닌 버전 지우기 요청은 히스토리 정합을 위해 no-op
  await deleteThreadArtifactUpdateVersion({
    workspaceRoot,
    threadId,
    artifactId: created.artifact.artifactId,
    version: 5,
  });
  assert.equal(
    (await loadAllThreadArtifactVersions(workspaceRoot, threadId)).length,
    1,
  );

  // 롤백 후 latestVersion이 1로 복원돼 같은 baseVersion 재커밋이 성립한다
  const recommitted = await commitThreadArtifactUpdateVersion({
    workspaceRoot,
    threadId,
    artifactId: created.artifact.artifactId,
    baseVersion: 1,
    payload: '# v2 다시',
    createdByRunId: 'run-z',
    timestamp: '2026-07-17T00:03:00.000Z',
  });
  assert.equal(recommitted.ok, true);
});

void test('commitThreadArtifactVersion serializes concurrent commits for the same thread', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-artifact-'));
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
        threadId,
        runId: entry.runId,
        renderer: 'markdown',
        payload: entry.payload,
        digest: entry.digest,
        sourceRef: {
          kind: 'thread-file',
          workingDirectory: 'stories',
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
            threadId,
            renderer: 'markdown',
            title: null,
            sourceRef: {
              workingDirectory: 'stories',
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
    workingDirectory: 'stories',
    threadId,
    runId: 'run-legacy-source',
    filePath: 'episodes/ch01.md',
    messageTimestamp: '2026-04-17T00:00:00.000Z',
  });
});

void test('commitThreadArtifactVersion writes schemaVersioned artifact store files', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-artifact-'));
  const threadId = testThreadId(503);

  await commitThreadArtifactVersion({
    workspaceRoot,
    threadId,
    runId: 'run-versioned',
    renderer: 'markdown',
    payload: '# versioned',
    digest: 'versioned-digest',
    sourceRef: {
      kind: 'thread-file',
      workingDirectory: 'stories',
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

void test('loadAllThreadArtifactVersions serializes structured unsupported schema versions', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-artifact-'));
  const threadId = testThreadId(505);
  const storePath = artifactStoreFilePath(workspaceRoot, threadId);
  await mkdir(join(workspaceRoot, '.geulbat', 'sessions', threadId), {
    recursive: true,
  });
  await writeFile(
    storePath,
    JSON.stringify({
      schemaVersion: { major: 2 },
      artifacts: [],
      versions: [],
    }) + '\n',
    'utf8',
  );

  await assert.rejects(
    () => loadAllThreadArtifactVersions(workspaceRoot, threadId),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /schema version: \{"major":2\}/u);
      assert.doesNotMatch(error.message, /\[object Object\]/u);
      return true;
    },
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

void test('copyThreadArtifactVersionsByRefs copies referenced video media files with the payloads', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-artifact-media-'),
  );
  const sourceThreadId = testThreadId(601);
  const targetThreadId = testThreadId(602);

  const media = await writeThreadMediaFile({
    workspaceRoot,
    threadId: sourceThreadId,
    extension: 'mp4',
    bytes: new TextEncoder().encode('branch-media-bytes'),
    maxBytes: 4096,
  });
  const manifest = {
    schemaVersion: 1,
    kind: 'generated_video',
    mimeType: 'video/mp4',
    byteLength: media.byteLength,
    digest: { algorithm: 'sha256', encoding: 'hex', value: media.sha256 },
    source: { type: 'thread_media', mediaRef: media.mediaRef },
    durationSeconds: 5,
    provenance: {
      providerId: 'grok_oauth',
      model: 'grok-imagine-video-1.5',
      capability: 'video_generation',
      prompt: 'branching cat',
      sourceImage: 'blank_canvas',
      generatedAt: '2026-07-13T00:00:00.000Z',
    },
  };
  const committed = await commitThreadArtifactVersion({
    workspaceRoot,
    threadId: sourceThreadId,
    runId: 'run-video',
    renderer: 'video',
    payload: JSON.stringify(manifest),
    digest: media.sha256,
    sourceRef: null,
    timestamp: '2026-07-13T00:00:00.000Z',
  });

  const copied = await copyThreadArtifactVersionsByRefs({
    workspaceRoot,
    sourceThreadId,
    targetThreadId,
    refs: [committed.ref],
  });
  assert.equal(copied, 1);

  // payload와 함께 가리키는 media 파일도 대상 스레드로 복사된다(§4.6)
  const copiedMedia = await statThreadMediaFile({
    workspaceRoot,
    threadId: targetThreadId,
    mediaRef: media.mediaRef,
  });
  assert.ok(copiedMedia);
  assert.equal(copiedMedia.byteLength, media.byteLength);
});
