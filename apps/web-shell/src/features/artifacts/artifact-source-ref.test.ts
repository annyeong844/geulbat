import test from 'node:test';
import assert from 'node:assert/strict';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { ThreadMessage } from '@geulbat/protocol/threads';

import { brandThreadId } from '../../lib/id-brand-helpers.js';
import {
  buildCanonicalArtifactSourceRef,
  buildCommittedArtifactSourceRef,
  buildStreamingArtifactSourceRef,
  buildTranscriptArtifactSourceRef,
  deriveArtifactRuntimePersistenceScopeFromSourceRef,
} from './artifact-source-ref.js';

const THREAD_ID = brandThreadId('00000000-0000-4000-8000-000000000001');
const WORKING_DIRECTORY = 'stories/sample';

void test('artifact source ref helpers assemble transcript, streaming, and committed source refs', () => {
  const message: ThreadMessage = {
    entryId: 'entry-transcript-artifact-source',
    role: 'assistant',
    content: '',
    timestamp: '2026-04-12T00:00:00.000Z',
    metadata: {
      phase: 'final_answer',
      sourceRunId: 'run-transcript',
      sourceFile: 'notes/demo.md',
    },
  };
  const artifact: ThreadArtifactVersion = {
    artifactId: 'art_demo',
    version: 2,
    parentVersion: 1,
    baseVersion: 1,
    renderer: 'markdown',
    payload: '# demo',
    digest: null,
    contentHash: 'hash',
    createdAt: '2026-04-12T00:00:00.000Z',
    createdByRunId: 'run-committed',
    previewValidation: { ok: true },
    title: 'Demo',
    persistenceEpoch: 3,
    sourceRef: {
      kind: 'thread-file',
      workingDirectory: WORKING_DIRECTORY,
      threadId: THREAD_ID,
      runId: 'run-committed',
      filePath: 'notes/demo.md',
      messageTimestamp: '2026-04-12T00:00:00.000Z',
    },
  };
  const threadArtifact: ThreadArtifactVersion = {
    ...artifact,
    artifactId: 'art_thread_demo',
    version: 4,
    sourceRef: {
      kind: 'thread',
      workingDirectory: WORKING_DIRECTORY,
      threadId: THREAD_ID,
      runId: 'run-thread-committed',
      filePath: null,
      messageTimestamp: '2026-04-12T00:00:00.000Z',
    },
  };

  assert.deepEqual(
    buildTranscriptArtifactSourceRef(message, {
      workingDirectory: WORKING_DIRECTORY,
      threadId: THREAD_ID,
    }),
    {
      workingDirectory: WORKING_DIRECTORY,
      threadId: THREAD_ID,
      runId: 'run-transcript',
      filePath: 'notes/demo.md',
      messageTimestamp: '2026-04-12T00:00:00.000Z',
    },
  );

  assert.deepEqual(
    buildStreamingArtifactSourceRef({
      workingDirectory: WORKING_DIRECTORY,
      threadId: THREAD_ID,
      runId: 'run-streaming',
      filePath: 'notes/demo.md',
    }),
    {
      workingDirectory: WORKING_DIRECTORY,
      threadId: THREAD_ID,
      runId: 'run-streaming',
      filePath: 'notes/demo.md',
    },
  );

  assert.deepEqual(buildCommittedArtifactSourceRef(artifact), {
    kind: 'thread-file',
    workingDirectory: WORKING_DIRECTORY,
    threadId: THREAD_ID,
    runId: 'run-committed',
    filePath: 'notes/demo.md',
    messageTimestamp: '2026-04-12T00:00:00.000Z',
    artifactId: 'art_demo',
    artifactVersion: 2,
    persistenceEpoch: 3,
  });

  assert.deepEqual(buildCommittedArtifactSourceRef(threadArtifact), {
    kind: 'thread',
    workingDirectory: WORKING_DIRECTORY,
    threadId: THREAD_ID,
    runId: 'run-thread-committed',
    filePath: null,
    messageTimestamp: '2026-04-12T00:00:00.000Z',
    artifactId: 'art_thread_demo',
    artifactVersion: 4,
    persistenceEpoch: 3,
  });
});

void test('artifact source ref helper derives runtime persistence scope only for committed identity', () => {
  assert.equal(
    deriveArtifactRuntimePersistenceScopeFromSourceRef({
      renderer: 'js',
      sourceRef: {
        workingDirectory: WORKING_DIRECTORY,
        threadId: THREAD_ID,
      },
    }),
    null,
  );

  assert.deepEqual(
    deriveArtifactRuntimePersistenceScopeFromSourceRef({
      renderer: 'js',
      sourceRef: {
        workingDirectory: WORKING_DIRECTORY,
        threadId: THREAD_ID,
        artifactId: 'art_demo',
        persistenceEpoch: 4,
      },
    }),
    {
      threadId: THREAD_ID,
      renderer: 'js',
      artifactId: 'art_demo',
      persistenceEpoch: 4,
    },
  );

  assert.equal(
    deriveArtifactRuntimePersistenceScopeFromSourceRef({
      renderer: 'js',
      sourceRef: {
        workingDirectory: WORKING_DIRECTORY,
        threadId: '../thread',
        artifactId: 'art_demo',
        persistenceEpoch: 0,
      },
    }),
    null,
  );

  assert.equal(
    deriveArtifactRuntimePersistenceScopeFromSourceRef({
      renderer: 'js',
      sourceRef: {
        workingDirectory: WORKING_DIRECTORY,
        threadId: THREAD_ID,
        persistenceEpoch: 0,
      },
    }),
    null,
  );

  assert.equal(
    deriveArtifactRuntimePersistenceScopeFromSourceRef({
      renderer: 'js',
      sourceRef: {
        workingDirectory: WORKING_DIRECTORY,
        threadId: THREAD_ID,
        artifactId: 'art_demo',
      },
    }),
    null,
  );

  assert.deepEqual(
    deriveArtifactRuntimePersistenceScopeFromSourceRef({
      renderer: 'html5',
      sourceRef: {
        workingDirectory: WORKING_DIRECTORY,
        threadId: THREAD_ID,
        artifactId: 'art_demo_html',
        persistenceEpoch: 1,
      },
    }),
    {
      threadId: THREAD_ID,
      renderer: 'html5',
      artifactId: 'art_demo_html',
      persistenceEpoch: 1,
    },
  );
});

void test('artifact source ref helper canonicalizes runtime frame source input', () => {
  assert.deepEqual(
    buildCanonicalArtifactSourceRef({
      workingDirectory: WORKING_DIRECTORY,
      threadId: THREAD_ID,
      kind: 'thread-file',
      runId: 'run-streaming',
      artifactId: 'art_demo',
      artifactVersion: 2,
      persistenceEpoch: 4,
      filePath: 'notes/demo.md',
      messageTimestamp: '2026-04-12T00:00:00.000Z',
    }),
    {
      kind: 'thread-file',
      workingDirectory: WORKING_DIRECTORY,
      threadId: THREAD_ID,
      runId: 'run-streaming',
      artifactId: 'art_demo',
      artifactVersion: 2,
      persistenceEpoch: 4,
      filePath: 'notes/demo.md',
      messageTimestamp: '2026-04-12T00:00:00.000Z',
    },
  );

  assert.deepEqual(
    buildCanonicalArtifactSourceRef({
      workingDirectory: WORKING_DIRECTORY,
      threadId: THREAD_ID,
      runId: 'run-transcript-input',
      filePath: null,
      messageTimestamp: '2026-04-12T00:00:00.000Z',
    }),
    {
      kind: 'thread',
      workingDirectory: WORKING_DIRECTORY,
      threadId: THREAD_ID,
      runId: 'run-transcript-input',
      artifactId: null,
      artifactVersion: null,
      persistenceEpoch: null,
      filePath: null,
      messageTimestamp: '2026-04-12T00:00:00.000Z',
    },
  );
});
