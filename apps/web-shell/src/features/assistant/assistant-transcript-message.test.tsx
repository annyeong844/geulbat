import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { ThreadMessage } from '@geulbat/protocol/threads';

import { createArtifactsByRefMap } from '../artifacts/artifact-transcript-lookup.js';
import { brandProjectId, brandThreadId } from '../../lib/id-brand-helpers.js';
import { TranscriptMessage } from './assistant-transcript-message.js';

void test('TranscriptMessage preserves assistant prose beside a committed artifact ref', () => {
  const artifact = createThreadArtifactVersion({
    artifactId: 'art_transcript_1',
    version: 1,
    payload: '# committed artifact',
  });

  const markup = renderToStaticMarkup(
    <TranscriptMessage
      message={createAssistantMessage({
        content: 'Here is the artifact.',
        artifact,
      })}
      artifactsByRef={createArtifactsByRefMap([artifact])}
      isRunning={false}
    />,
  );

  assert.match(markup, /Here is the artifact\./);
  assert.match(markup, /committed artifact/);
});

void test('TranscriptMessage keeps artifact-looking raw text plain without metadata refs', () => {
  const artifact = createThreadArtifactVersion({
    artifactId: 'art_ghost',
    version: 1,
    payload: '# should not render',
  });

  const markup = renderToStaticMarkup(
    <TranscriptMessage
      message={{
        role: 'assistant',
        content: '{"artifactId":"art_ghost","version":1}',
        timestamp: '2026-04-29T00:00:00.000Z',
        metadata: { phase: 'final_answer' },
      }}
      artifactsByRef={createArtifactsByRefMap([artifact])}
      isRunning={false}
    />,
  );

  assert.match(markup, /artifactId/);
  assert.doesNotMatch(markup, /should not render/);
});

function createAssistantMessage(args: {
  content: string;
  artifact: Pick<ThreadArtifactVersion, 'artifactId' | 'version'>;
}): ThreadMessage {
  const { content, artifact } = args;
  return {
    role: 'assistant',
    content,
    timestamp: '2026-04-29T00:00:00.000Z',
    metadata: {
      phase: 'final_answer',
      artifactRefs: [
        { artifactId: artifact.artifactId, version: artifact.version },
      ],
      activeArtifactRef: {
        artifactId: artifact.artifactId,
        version: artifact.version,
      },
    },
  };
}

function createThreadArtifactVersion(args: {
  artifactId: string;
  version: number;
  payload: string;
}): ThreadArtifactVersion {
  return {
    artifactId: args.artifactId,
    version: args.version,
    parentVersion: null,
    baseVersion: null,
    renderer: 'markdown',
    payload: args.payload,
    digest: `digest-${args.artifactId}`,
    contentHash: `hash-${args.artifactId}`,
    createdAt: '2026-04-29T00:00:00.000Z',
    createdByRunId: 'run-1',
    previewValidation: { ok: true },
    title: null,
    persistenceEpoch: 0,
    sourceRef: {
      kind: 'thread-file',
      projectId: brandProjectId('workspace'),
      threadId: brandThreadId('00000000-0000-4000-8000-000000000001'),
      runId: 'run-1',
      filePath: 'notes/demo.md',
      messageTimestamp: '2026-04-29T00:00:00.000Z',
    },
  };
}
