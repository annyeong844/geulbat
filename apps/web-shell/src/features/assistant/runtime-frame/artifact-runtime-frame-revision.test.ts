import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createArtifactRuntimeFrameRevision,
  createArtifactRuntimeSourceIdentity,
} from './artifact-runtime-frame-revision.js';

void test('artifact runtime source identity and revision change when run/file/timestamp change', () => {
  const runtimePayload = 'window.__artifact = true;';
  const persistenceScopeKey = JSON.stringify([
    'project-1',
    'thread-1',
    'art_1',
    0,
  ]);
  const base = createArtifactRuntimeSourceIdentity({
    projectId: 'project-1',
    threadId: 'thread-1',
    runId: 'run-1',
    filePath: 'drafts/chapter-1.md',
    messageTimestamp: '2026-04-04T00:00:00.000Z',
  });
  const changedRun = createArtifactRuntimeSourceIdentity({
    projectId: 'project-1',
    threadId: 'thread-1',
    runId: 'run-2',
    filePath: 'drafts/chapter-1.md',
    messageTimestamp: '2026-04-04T00:00:00.000Z',
  });
  const changedFile = createArtifactRuntimeSourceIdentity({
    projectId: 'project-1',
    threadId: 'thread-1',
    runId: 'run-1',
    filePath: 'drafts/chapter-2.md',
    messageTimestamp: '2026-04-04T00:00:00.000Z',
  });
  const changedTimestamp = createArtifactRuntimeSourceIdentity({
    projectId: 'project-1',
    threadId: 'thread-1',
    runId: 'run-1',
    filePath: 'drafts/chapter-1.md',
    messageTimestamp: '2026-04-04T00:00:01.000Z',
  });

  assert.notEqual(base, changedRun);
  assert.notEqual(base, changedFile);
  assert.notEqual(base, changedTimestamp);
  const changedArtifactIdentity = createArtifactRuntimeSourceIdentity({
    projectId: 'project-1',
    threadId: 'thread-1',
    runId: 'run-1',
    filePath: 'drafts/chapter-1.md',
    messageTimestamp: '2026-04-04T00:00:00.000Z',
    artifactId: 'art_1',
    artifactVersion: 2,
    persistenceEpoch: 1,
  });
  assert.notEqual(base, changedArtifactIdentity);
  const baseRevision = createArtifactRuntimeFrameRevision({
    renderer: 'js',
    runtimePayload,
    sourceIdentity: base,
    persistenceScopeKey,
    parentOrigin: 'http://127.0.0.1:5173',
  });
  assert.notEqual(
    baseRevision,
    createArtifactRuntimeFrameRevision({
      renderer: 'js',
      runtimePayload,
      sourceIdentity: changedRun,
      persistenceScopeKey,
      parentOrigin: 'http://127.0.0.1:5173',
    }),
  );
  assert.notEqual(
    baseRevision,
    createArtifactRuntimeFrameRevision({
      renderer: 'js',
      runtimePayload,
      sourceIdentity: changedArtifactIdentity,
      persistenceScopeKey,
      parentOrigin: 'http://127.0.0.1:5173',
    }),
  );
  assert.notEqual(
    baseRevision,
    createArtifactRuntimeFrameRevision({
      renderer: 'js',
      runtimePayload,
      sourceIdentity: base,
      persistenceScopeKey: JSON.stringify([
        'project-1',
        'thread-1',
        'art_1',
        1,
      ]),
      parentOrigin: 'http://127.0.0.1:5173',
    }),
  );
});

void test('artifact runtime revision is stable for the same canonical inputs', () => {
  const revision = createArtifactRuntimeFrameRevision({
    renderer: 'js',
    runtimePayload: 'window.__artifact = true;',
    sourceIdentity: createArtifactRuntimeSourceIdentity({
      projectId: 'project-1',
      threadId: 'thread-1',
      runId: 'run-1',
      filePath: 'drafts/chapter-1.md',
      messageTimestamp: '2026-04-04T00:00:00.000Z',
    }),
    persistenceScopeKey: JSON.stringify(['project-1', 'thread-1', 'art_1', 0]),
    parentOrigin: 'http://127.0.0.1:5173',
  });

  assert.equal(
    revision,
    createArtifactRuntimeFrameRevision({
      renderer: 'js',
      runtimePayload: 'window.__artifact = true;',
      sourceIdentity: createArtifactRuntimeSourceIdentity({
        projectId: 'project-1',
        threadId: 'thread-1',
        runId: 'run-1',
        filePath: 'drafts/chapter-1.md',
        messageTimestamp: '2026-04-04T00:00:00.000Z',
      }),
      persistenceScopeKey: JSON.stringify([
        'project-1',
        'thread-1',
        'art_1',
        0,
      ]),
      parentOrigin: 'http://127.0.0.1:5173',
    }),
  );
  assert.match(revision, /^rev2-[0-9a-f]+-[0-9a-f]{32}$/);
});
