import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { ThreadMessage } from '@geulbat/protocol/threads';

import { createArtifactsByRefMap } from '../artifacts/artifact-transcript-lookup.js';
import { brandThreadId } from '../../lib/id-brand-helpers.js';
import { TranscriptMessage } from './assistant-transcript-message.js';
import { VisualizeWidget } from './visualize/visualize-widget.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

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
        entryId: 'entry-raw-artifact-text',
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

void test('TranscriptMessage replays settled visualize calls instantly and can defer runtime boot', () => {
  const view = {
    mode: 'html' as const,
    code: '<section><h2>Settled visualization</h2><p>Ready.</p></section>',
    title: 'Settled visualization',
  };
  const historyMarkup = renderToStaticMarkup(
    <TranscriptMessage
      message={{
        entryId: 'entry-settled-visualize',
        role: 'tool_call',
        content: JSON.stringify({ tool: 'visualize', args: view }),
        timestamp: '2026-07-19T00:00:00.000Z',
      }}
      artifactsByRef={createArtifactsByRefMap([])}
      isRunning={false}
    />,
  );
  const instantMarkup = renderToStaticMarkup(
    <VisualizeWidget view={view} playback="instant" />,
  );
  const replayMarkup = renderToStaticMarkup(<VisualizeWidget view={view} />);
  const deferredMarkup = renderToStaticMarkup(
    <TranscriptMessage
      message={{
        entryId: 'entry-deferred-visualize',
        role: 'tool_call',
        content: JSON.stringify({ tool: 'visualize', args: view }),
        timestamp: '2026-07-19T00:00:00.000Z',
      }}
      artifactsByRef={createArtifactsByRefMap([])}
      isRunning={false}
      deferVisualizeRuntimeBoot
    />,
  );

  assert.equal(
    readIframeSource(historyMarkup),
    readIframeSource(instantMarkup),
  );
  assert.notEqual(
    readIframeSource(historyMarkup),
    readIframeSource(replayMarkup),
  );
  assert.match(deferredMarkup, /visualize-widget/);
  assert.doesNotMatch(deferredMarkup, /<iframe/);
});

void test('VisualizeWidget keeps its iframe mounted after deferred boot becomes active again', async () => {
  const view = {
    mode: 'html' as const,
    code: '<section>Stable visualization</section>',
    title: 'Stable visualization',
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <VisualizeWidget view={view} deferRuntimeBoot />,
    );
  });
  assert.equal(renderer.root.findAllByType('iframe').length, 0);

  await act(async () => {
    renderer.update(<VisualizeWidget view={view} />);
  });
  const mountedFrame = renderer.root.findByType('iframe');

  await act(async () => {
    renderer.update(<VisualizeWidget view={view} deferRuntimeBoot />);
  });
  assert.equal(renderer.root.findByType('iframe'), mountedFrame);

  await act(async () => {
    renderer.unmount();
  });
});

function readIframeSource(markup: string): string {
  const match = /<iframe[^>]*\ssrc="([^"]+)"/.exec(markup);
  assert.ok(match?.[1]);
  return match[1];
}

function createAssistantMessage(args: {
  content: string;
  artifact: Pick<ThreadArtifactVersion, 'artifactId' | 'version'>;
}): ThreadMessage {
  const { content, artifact } = args;
  return {
    entryId: `entry-${artifact.artifactId}-${artifact.version}`,
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
      workingDirectory: 'computer-root',
      threadId: brandThreadId('00000000-0000-4000-8000-000000000001'),
      runId: 'run-1',
      filePath: 'notes/demo.md',
      messageTimestamp: '2026-04-29T00:00:00.000Z',
    },
  };
}
