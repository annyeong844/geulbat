import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  isStaticArtifactPreviewRenderer,
  resolveStaticArtifactPreview,
  STATIC_ARTIFACT_PREVIEW_RESOURCE_POLICY,
} from './artifact-static-preview-registry.js';

void test('resolveStaticArtifactPreview renders markdown through the artifact-owned static registry', () => {
  const preview = resolveStaticArtifactPreview('markdown', '# Hello');

  assert.equal(preview.kind, 'rendered');
  const html = renderToStaticMarkup(preview.node);
  assert.match(html, /Hello/);
});

void test('resolveStaticArtifactPreview renders table previews without runtime adapters', () => {
  const preview = resolveStaticArtifactPreview(
    'table',
    ['Name | Count', '--- | ---', 'apples | 3'].join('\n'),
  );

  assert.equal(preview.kind, 'rendered');
  const html = renderToStaticMarkup(preview.node);
  assert.match(html, /<table/);
  assert.match(html, /apples/);
});

void test('resolveStaticArtifactPreview refuses markdown previews that exceed the line policy', () => {
  const preview = resolveStaticArtifactPreview(
    'markdown',
    Array.from(
      {
        length: STATIC_ARTIFACT_PREVIEW_RESOURCE_POLICY.maxMarkdownLines + 1,
      },
      (_, index) => `# heading ${index}`,
    ).join('\n'),
  );

  assert.equal(preview.kind, 'unavailable');
  if (preview.kind !== 'unavailable') {
    assert.fail('expected static preview resource policy to block rendering');
  }
  assert.equal(preview.code, 'policy_blocked');
  assert.match(preview.detail, /markdown has/);
});

void test('resolveStaticArtifactPreview refuses oversized code previews without truncating the artifact surface', () => {
  const preview = resolveStaticArtifactPreview(
    'code',
    'x'.repeat(STATIC_ARTIFACT_PREVIEW_RESOURCE_POLICY.maxTextCodeUnits + 1),
  );

  assert.equal(preview.kind, 'unavailable');
  if (preview.kind !== 'unavailable') {
    assert.fail('expected static preview resource policy to block rendering');
  }
  assert.equal(preview.code, 'policy_blocked');
  assert.match(
    preview.detail,
    new RegExp(STATIC_ARTIFACT_PREVIEW_RESOURCE_POLICY.policyId),
  );
  assert.match(preview.detail, /Raw\/source content remains available/);
});

void test('resolveStaticArtifactPreview refuses diff previews that exceed the row policy', () => {
  const preview = resolveStaticArtifactPreview(
    'diff',
    Array.from(
      {
        length: STATIC_ARTIFACT_PREVIEW_RESOURCE_POLICY.maxDiffLines + 1,
      },
      (_, index) => `+line ${index}`,
    ).join('\n'),
  );

  assert.equal(preview.kind, 'unavailable');
  if (preview.kind !== 'unavailable') {
    assert.fail('expected static preview resource policy to block rendering');
  }
  assert.equal(preview.code, 'policy_blocked');
  assert.match(preview.detail, /diff has/);
});

void test('resolveStaticArtifactPreview refuses table previews that exceed the cell policy', () => {
  const preview = resolveStaticArtifactPreview(
    'table',
    [
      Array.from(
        {
          length: STATIC_ARTIFACT_PREVIEW_RESOURCE_POLICY.maxTableCells + 1,
        },
        (_, index) => `cell_${index}`,
      ).join('|'),
    ].join('\n'),
  );

  assert.equal(preview.kind, 'unavailable');
  if (preview.kind !== 'unavailable') {
    assert.fail('expected static preview resource policy to block rendering');
  }
  assert.equal(preview.code, 'policy_blocked');
  assert.match(preview.detail, /table has/);
});

void test('isStaticArtifactPreviewRenderer rejects runtime-backed renderers', () => {
  assert.equal(isStaticArtifactPreviewRenderer('markdown'), true);
  assert.equal(isStaticArtifactPreviewRenderer('code'), true);
  assert.equal(isStaticArtifactPreviewRenderer('image'), true);
  assert.equal(isStaticArtifactPreviewRenderer('html5'), false);
  assert.equal(isStaticArtifactPreviewRenderer('js'), false);
  assert.equal(isStaticArtifactPreviewRenderer('react_bundle'), false);
  assert.equal(isStaticArtifactPreviewRenderer('unknown'), false);
});

void test('resolveStaticArtifactPreview renders generated-image manifests as an img element', () => {
  const manifest = {
    schemaVersion: 1,
    kind: 'generated_image',
    mimeType: 'image/png',
    byteLength: 8,
    digest: { algorithm: 'sha256', encoding: 'hex', value: 'ab12' },
    source: { type: 'inline_base64', dataBase64: 'cG5nLWJvZHk=' },
    provenance: {
      providerId: 'grok_oauth',
      model: 'grok-2-image',
      capability: 'image_generation',
      prompt: 'a cat',
      generatedAt: '2026-07-05T00:00:00.000Z',
    },
  };

  const preview = resolveStaticArtifactPreview(
    'image',
    JSON.stringify(manifest),
  );

  assert.equal(preview.kind, 'rendered');
  const html = renderToStaticMarkup(preview.node);
  assert.match(html, /<img/);
  assert.match(html, /data:image\/png;base64,cG5nLWJvZHk=/);
  assert.match(html, /a cat/);
});

void test('resolveStaticArtifactPreview renders thread_media images via the media route (S4b)', () => {
  const sha = 'a'.repeat(64);
  const manifest = {
    schemaVersion: 1,
    kind: 'generated_image',
    mimeType: 'image/jpeg',
    byteLength: 262328,
    digest: { algorithm: 'sha256', encoding: 'hex', value: sha },
    source: { type: 'thread_media', mediaRef: `${sha}.jpg` },
    provenance: {
      providerId: 'grok_oauth',
      model: 'grok-imagine-image-quality',
      capability: 'image_generation',
      prompt: 'a cat',
      generatedAt: '2026-07-13T00:00:00.000Z',
    },
  };

  // 스레드 스코프가 있으면 미디어 라우트를 src로 쓴다(base64 인라인 없음)
  const preview = resolveStaticArtifactPreview(
    'image',
    JSON.stringify(manifest),
    { threadId: '11111111-1111-4111-8111-111111111111' },
  );
  assert.equal(preview.kind, 'rendered');
  const html = renderToStaticMarkup(preview.node);
  assert.match(html, /<img/);
  assert.match(
    html,
    /\/api\/threads\/11111111-1111-4111-8111-111111111111\/media\//,
  );
  assert.doesNotMatch(html, /base64/);

  // 스레드 스코프를 모르면 잘못된 URL 대신 unavailable(fail-closed)
  const noScope = resolveStaticArtifactPreview(
    'image',
    JSON.stringify(manifest),
  );
  assert.equal(noScope.kind, 'unavailable');
});

void test('resolveStaticArtifactPreview refuses malformed image manifests instead of rendering raw payload', () => {
  const preview = resolveStaticArtifactPreview('image', '{"not":"a manifest"}');

  assert.equal(preview.kind, 'unavailable');
  assert.equal(preview.code, 'sanitize_rejected');
});

const VIDEO_MEDIA_SHA =
  'af2434551dcb9d993703ba9281c42e1a1ed66d199e14a077e3c3df801920cf55';

function buildVideoManifestPayload(): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: 'generated_video',
    mimeType: 'video/mp4',
    byteLength: 843620,
    digest: { algorithm: 'sha256', encoding: 'hex', value: VIDEO_MEDIA_SHA },
    source: { type: 'thread_media', mediaRef: `${VIDEO_MEDIA_SHA}.mp4` },
    durationSeconds: 5,
    provenance: {
      providerId: 'grok_oauth',
      model: 'grok-imagine-video-1.5',
      capability: 'video_generation',
      prompt: '수채화 고양이',
      sourceImage: 'blank_canvas',
      generatedAt: '2026-07-13T00:00:00.000Z',
    },
  });
}

void test('resolveStaticArtifactPreview renders video manifests as an inline player with a save link', () => {
  assert.equal(isStaticArtifactPreviewRenderer('video'), true);

  const preview = resolveStaticArtifactPreview(
    'video',
    buildVideoManifestPayload(),
    { threadId: '11111111-1111-4111-8111-111111111111' },
  );
  assert.equal(preview.kind, 'rendered');
  const html = renderToStaticMarkup(preview.node);
  // 인라인 재생이 1급(D-V6) — 미디어 라우트를 스트리밍 src로 쓴다
  assert.match(html, /<video[^>]*controls/);
  assert.match(
    html,
    /\/api\/threads\/11111111-1111-4111-8111-111111111111\/media\//,
  );
  // 저장은 선택 링크
  assert.match(html, /download=/);
  // 인라인 base64 없음(D-V7)
  assert.doesNotMatch(html, /base64/);
});

void test('resolveStaticArtifactPreview fails closed on video payloads without thread scope or manifest', () => {
  // 스레드 스코프를 모르면 잘못된 URL 대신 명시적 unavailable
  const noScope = resolveStaticArtifactPreview(
    'video',
    buildVideoManifestPayload(),
  );
  assert.equal(noScope.kind, 'unavailable');

  const badManifest = resolveStaticArtifactPreview('video', '{"not":"video"}', {
    threadId: '11111111-1111-4111-8111-111111111111',
  });
  assert.equal(badManifest.kind, 'unavailable');
});
