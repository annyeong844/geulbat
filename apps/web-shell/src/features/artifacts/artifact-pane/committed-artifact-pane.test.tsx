import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';

import {
  brandProjectId,
  brandThreadId,
} from '../../../lib/id-brand-helpers.js';
import type { ArtifactRuntimeFrameRenderArgs } from '../runtime-preview/types.js';
import { CommittedArtifactPane } from './committed-artifact-pane.js';

function createRuntimeFrameRecorder() {
  const calls: ArtifactRuntimeFrameRenderArgs[] = [];
  return {
    calls,
    renderRuntimeFrame(args: ArtifactRuntimeFrameRenderArgs) {
      calls.push(args);
      return createElement('iframe', {
        sandbox: args.sandbox,
        src: `http://127.0.0.1:3456/artifact-runtime/host?renderer=${args.renderer}&rev=fixture`,
      });
    },
  };
}

function createCommittedArtifact(
  overrides: Partial<ThreadArtifactVersion> & {
    artifactId: string;
    renderer: ThreadArtifactVersion['renderer'];
    payload: string;
  },
): ThreadArtifactVersion {
  return {
    artifactId: overrides.artifactId,
    version: overrides.version ?? 1,
    parentVersion: overrides.parentVersion ?? null,
    baseVersion: overrides.baseVersion ?? null,
    renderer: overrides.renderer,
    payload: overrides.payload,
    digest: overrides.digest ?? 'digest',
    contentHash: overrides.contentHash ?? 'hash',
    createdAt: overrides.createdAt ?? '2026-04-29T00:00:00.000Z',
    createdByRunId: overrides.createdByRunId ?? 'run-1',
    previewValidation: overrides.previewValidation ?? { ok: true },
    title: overrides.title ?? null,
    persistenceEpoch: overrides.persistenceEpoch ?? 0,
    sourceRef: overrides.sourceRef ?? {
      kind: 'thread-file',
      projectId: brandProjectId('workspace'),
      threadId: brandThreadId('00000000-0000-4000-8000-000000000001'),
      runId: 'run-1',
      filePath: 'notes/demo.md',
      messageTimestamp: '2026-04-29T00:00:00.000Z',
    },
  };
}

void test('CommittedArtifactPane renders markdown without runtime-frame work', () => {
  const runtimeFrame = createRuntimeFrameRecorder();
  const markup = renderToStaticMarkup(
    <CommittedArtifactPane
      label="Artifact"
      artifact={createCommittedArtifact({
        artifactId: 'art_markdown',
        renderer: 'markdown',
        payload: '# committed',
      })}
      isRunning={false}
      renderRuntimeFrame={runtimeFrame.renderRuntimeFrame}
    />,
  );

  assert.match(markup, /Artifact/);
  assert.match(markup, /committed/);
  assert.deepEqual(runtimeFrame.calls, []);
});

void test('CommittedArtifactPane forwards runtime previews through the injected frame renderer', () => {
  const runtimeFrame = createRuntimeFrameRecorder();
  const markup = renderToStaticMarkup(
    <CommittedArtifactPane
      label="Artifact"
      artifact={createCommittedArtifact({
        artifactId: 'art_js',
        renderer: 'js',
        payload: 'document.body.textContent = "committed runtime";',
      })}
      isRunning={false}
      renderRuntimeFrame={runtimeFrame.renderRuntimeFrame}
    />,
  );

  assert.match(markup, /iframe/);
  assert.ok(runtimeFrame.calls.length > 0);
  for (const call of runtimeFrame.calls) {
    assert.equal(call.renderer, 'js');
    assert.equal(
      call.runtimePayload,
      'document.body.textContent = "committed runtime";',
    );
  }
});
