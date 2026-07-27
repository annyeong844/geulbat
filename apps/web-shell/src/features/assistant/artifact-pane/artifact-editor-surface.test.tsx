import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import { createCommittedArtifact } from '../../../test-support/thread-artifact-fixtures.js';
import { ArtifactEditorSurface } from './artifact-editor-surface.js';

const VIDEO_MEDIA_SHA =
  'af2434551dcb9d993703ba9281c42e1a1ed66d199e14a077e3c3df801920cf55';

function createVideoArtifact() {
  return createCommittedArtifact({
    artifactId: 'video-preview-viewer',
    renderer: 'video',
    payload: JSON.stringify({
      schemaVersion: 1,
      kind: 'generated_video',
      mimeType: 'video/mp4',
      byteLength: 843_620,
      digest: {
        algorithm: 'sha256',
        encoding: 'hex',
        value: VIDEO_MEDIA_SHA,
      },
      source: {
        type: 'thread_media',
        mediaRef: `${VIDEO_MEDIA_SHA}.mp4`,
      },
      durationSeconds: 5,
      provenance: {
        providerId: 'grok_oauth',
        model: 'grok-imagine-video-1.5',
        capability: 'video_generation',
        prompt: '수채화 고양이',
        sourceImage: 'blank_canvas',
        generatedAt: '2026-07-13T00:00:00.000Z',
      },
    }),
  });
}

void test('ArtifactEditorSurface plays the video in the artifact itself', () => {
  const markup = renderToStaticMarkup(
    <ArtifactEditorSurface
      artifact={createVideoArtifact()}
      threadId={null}
      isRunning={false}
      mode="render"
      onSelectMode={() => {}}
      streamToken={null}
      expanded={false}
      onToggleExpand={() => {}}
    />,
  );

  // 아티팩트 자리가 그 영상을 보여줄 자리다 — 여는 버튼도, 별도 창도 없다.
  assert.match(markup, /<video[^>]*controls/);
  assert.match(markup, /class="artifact-video-sizing"/);
  assert.doesNotMatch(markup, /감상 창|크게 보기/);
});
