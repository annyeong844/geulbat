import test from 'node:test';
import assert from 'node:assert/strict';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { parseVideoArtifactPayload } from '@geulbat/protocol/artifacts';

import { ArtifactVideoSurface } from './artifact-video-viewer.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const VIDEO_MEDIA_SHA =
  'af2434551dcb9d993703ba9281c42e1a1ed66d199e14a077e3c3df801920cf55';

function createVideoManifest() {
  const manifest = parseVideoArtifactPayload(
    JSON.stringify({
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
  );
  assert.ok(manifest);
  return manifest;
}

void test('the video plays in place and cycles fit, fill, and original size', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <ArtifactVideoSurface
        manifest={createVideoManifest()}
        threadId="00000000-0000-4000-8000-000000000001"
      />,
    );
  });

  // 아티팩트가 차지한 자리에서 바로 재생한다 — 여는 런처도, 별도 창도 없다.
  const stage = renderer.root.findByProps({
    className: 'artifact-video-stage',
  });
  assert.equal(stage.props['data-video-sizing'], 'fit');
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0);

  const video = renderer.root.findByType('video');
  assert.equal(video.props.controls, true);
  assert.match(
    video.props.src,
    /\/api\/threads\/00000000-0000-4000-8000-000000000001\/media\//,
  );
  await act(async () => {
    video.props.onLoadedMetadata({
      currentTarget: { videoWidth: 1920, videoHeight: 1080 },
    });
  });

  const sizingButton = () =>
    renderer.root.findByProps({ className: 'artifact-video-sizing' });
  const pressSizing = async () => {
    const button = sizingButton();
    await act(async () => {
      button.props.onClick();
    });
  };

  // 버튼 하나가 세 크기를 순환한다. 이름은 지금 상태와 누르면 될 상태를 함께
  // 말한다 — 3단 순환은 aria-pressed(2상태)로 말할 수 없다.
  assert.equal(
    sizingButton().props['aria-label'],
    '영역에 맞춰 보기 중 — 눌러서 영역 가득 채우기',
  );
  assert.match(sizingButton().props.title, /가장자리가 잘릴 수 있어요/);

  await pressSizing();
  assert.equal(stage.props['data-video-sizing'], 'fill');
  assert.equal(video.props.className, 'artifact-video fill');
  assert.equal(video.props.style, undefined);
  assert.equal(
    sizingButton().props['aria-label'],
    '영역 가득 채우기 중 — 눌러서 원본 크기로 보기',
  );
  // 실제 픽셀 크기를 알면 버튼이 그 값을 말한다.
  assert.match(sizingButton().props.title, /실제 픽셀 크기\(1:1\).*1920×1080/u);

  await pressSizing();
  assert.equal(stage.props['data-video-sizing'], 'original');
  assert.deepEqual(video.props.style, { width: 1920, height: 1080 });
  assert.equal(
    sizingButton().props['aria-label'],
    '원본 크기로 보기 중 — 눌러서 영역에 맞춰 보기',
  );

  // 한 바퀴 — 다시 맞춤으로 돌아온다.
  await pressSizing();
  assert.equal(stage.props['data-video-sizing'], 'fit');
  assert.equal(video.props.style, undefined);

  await act(async () => {
    renderer.unmount();
  });
});
