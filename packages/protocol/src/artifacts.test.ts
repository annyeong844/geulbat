import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildArtifactEnvelopeText,
  isArtifactDraftCommitRequest,
  MAX_ARTIFACT_DRAFT_COMMIT_PAYLOAD_LENGTH,
  isArtifactRecord,
  isArtifactSourceRef,
  isThreadArtifactVersion,
  isArtifactVersionRecord,
  normalizeArtifactSourceRef,
  isThreadMediaRef,
  parseCanonicalArtifactEnvelopeText,
  parseImageArtifactPayload,
  parseVideoArtifactPayload,
} from './artifacts.js';

void test('parseCanonicalArtifactEnvelopeText accepts canonical whole-envelope text', () => {
  const payload = '# hello';
  const parsed = parseCanonicalArtifactEnvelopeText(
    buildArtifactEnvelopeText({
      renderer: 'markdown',
      digest: '요약',
      payload,
    }),
  );

  assert.deepEqual(parsed, {
    renderer: 'markdown',
    digest: '요약',
    payload: `\n${payload}\n`,
  });
});

void test('parseCanonicalArtifactEnvelopeText reads a valid update target and drops half declarations', () => {
  const updated = parseCanonicalArtifactEnvelopeText(
    '<!-- GEULBAT_ARTIFACT {"renderer":"markdown","artifactId":"art_1","baseVersion":3} -->\n# v4\n<!-- /GEULBAT_ARTIFACT -->',
  );
  assert.deepEqual(updated?.updateTarget, {
    artifactId: 'art_1',
    baseVersion: 3,
  });

  // 반쪽 선언·무효 값은 update로 인정하지 않는다 — 새 아티팩트 생성으로 흘린다
  for (const header of [
    '{"renderer":"markdown","artifactId":"art_1"}',
    '{"renderer":"markdown","baseVersion":2}',
    '{"renderer":"markdown","artifactId":"","baseVersion":2}',
    '{"renderer":"markdown","artifactId":"art_1","baseVersion":0}',
    '{"renderer":"markdown","artifactId":"art_1","baseVersion":1.5}',
  ]) {
    const parsed = parseCanonicalArtifactEnvelopeText(
      `<!-- GEULBAT_ARTIFACT ${header} -->\nbody\n<!-- /GEULBAT_ARTIFACT -->`,
    );
    assert.ok(parsed, header);
    assert.equal(parsed.updateTarget, undefined, header);
  }
});

void test('parseCanonicalArtifactEnvelopeText rejects prose outside the envelope', () => {
  const parsed = parseCanonicalArtifactEnvelopeText(
    `preface\n${buildArtifactEnvelopeText({
      renderer: 'markdown',
      digest: '요약',
      payload: '# hello',
    })}`,
  );

  assert.equal(parsed, null);
});

void test('parseCanonicalArtifactEnvelopeText rejects malformed headers and unsupported renderers', () => {
  assert.equal(
    parseCanonicalArtifactEnvelopeText(
      '<!-- GEULBAT_ARTIFACT {renderer:"markdown"} -->\n# hello\n<!-- /GEULBAT_ARTIFACT -->',
    ),
    null,
  );
  assert.equal(
    parseCanonicalArtifactEnvelopeText(
      '<!-- GEULBAT_ARTIFACT {"renderer":"timeline"} -->\n# hello\n<!-- /GEULBAT_ARTIFACT -->',
    ),
    null,
  );
});

void test('parseCanonicalArtifactEnvelopeText rejects incomplete and legacy artifact syntax', () => {
  assert.equal(
    parseCanonicalArtifactEnvelopeText(
      '<!-- GEULBAT_ARTIFACT {"renderer":"markdown"} -->\n# hello',
    ),
    null,
  );
  assert.equal(
    parseCanonicalArtifactEnvelopeText(
      '<artifact digest="x" renderer="html5"><div>hello</div></artifact>',
    ),
    null,
  );
});

void test('isArtifactVersionRecord accepts explicit preview validation success and failure shapes', () => {
  const baseRecord = {
    artifactId: 'art_1',
    version: 1,
    parentVersion: null,
    baseVersion: null,
    renderer: 'markdown',
    payload: '# hello',
    digest: null,
    contentHash: 'hash',
    createdAt: '2026-04-10T00:00:00.000Z',
    createdByRunId: 'run_1',
  } as const;

  assert.equal(
    isArtifactVersionRecord({
      ...baseRecord,
      previewValidation: { ok: true },
    }),
    true,
  );

  assert.equal(
    isArtifactVersionRecord({
      ...baseRecord,
      previewValidation: {
        ok: false,
        code: 'invalid_html',
        detail: 'missing body tag',
      },
    }),
    true,
  );
});

void test('isArtifactVersionRecord rejects malformed preview validation payloads', () => {
  const baseRecord = {
    artifactId: 'art_1',
    version: 1,
    parentVersion: null,
    baseVersion: null,
    renderer: 'markdown',
    payload: '# hello',
    digest: null,
    contentHash: 'hash',
    createdAt: '2026-04-10T00:00:00.000Z',
    createdByRunId: 'run_1',
  } as const;

  assert.equal(
    isArtifactVersionRecord({
      ...baseRecord,
      previewValidation: { ok: true, code: 'unexpected' },
    }),
    false,
  );

  assert.equal(
    isArtifactVersionRecord({
      ...baseRecord,
      previewValidation: { ok: false, code: 'invalid_html' },
    }),
    false,
  );
});

void test('isArtifactSourceRef accepts only discriminated thread source refs', () => {
  assert.equal(
    isArtifactSourceRef({
      kind: 'thread',
      workingDirectory: 'workspace',
      threadId: '00000000-0000-4000-8000-000000000001',
      runId: 'run-1',
      filePath: null,
      messageTimestamp: '2026-04-10T00:00:00.000Z',
    }),
    true,
  );

  assert.equal(
    isArtifactSourceRef({
      kind: 'thread-file',
      workingDirectory: 'workspace',
      threadId: '00000000-0000-4000-8000-000000000001',
      runId: 'run-1',
      filePath: 'episodes/ch01.md',
      messageTimestamp: '2026-04-10T00:00:00.000Z',
    }),
    true,
  );

  assert.equal(
    isArtifactSourceRef({
      workingDirectory: 'workspace',
      threadId: '00000000-0000-4000-8000-000000000001',
      runId: 'run-1',
      filePath: 'episodes/ch01.md',
      messageTimestamp: '2026-04-10T00:00:00.000Z',
    }),
    false,
  );

  assert.equal(
    isArtifactSourceRef({
      kind: 'thread-file',
      workingDirectory: 'workspace',
      projectId: 'retired-project-scope',
      threadId: '00000000-0000-4000-8000-000000000001',
      runId: 'run-1',
      filePath: 'episodes/ch01.md',
      messageTimestamp: '2026-04-10T00:00:00.000Z',
    }),
    false,
  );

  for (const sourceRef of [
    {
      kind: 'thread',
      workingDirectory: '/workspace/project',
      threadId: '00000000-0000-4000-8000-000000000001',
      runId: 'run-1',
      filePath: null,
      messageTimestamp: '2026-04-10T00:00:00.000Z',
    },
    {
      kind: 'thread-file',
      workingDirectory: 'workspace',
      threadId: '00000000-0000-4000-8000-000000000001',
      runId: 'run-1',
      filePath: 'D:\\workspace\\chapter.md',
      messageTimestamp: '2026-04-10T00:00:00.000Z',
    },
  ]) {
    assert.equal(isArtifactSourceRef(sourceRef), false);
  }
});

void test('normalizeArtifactSourceRef upgrades legacy nullable records to discriminated refs', () => {
  assert.deepEqual(
    normalizeArtifactSourceRef({
      workingDirectory: 'workspace',
      threadId: '00000000-0000-4000-8000-000000000001',
      runId: 'run-1',
      filePath: 'episodes/ch01.md',
      messageTimestamp: '2026-04-10T00:00:00.000Z',
    }),
    {
      kind: 'thread-file',
      workingDirectory: 'workspace',
      threadId: '00000000-0000-4000-8000-000000000001',
      runId: 'run-1',
      filePath: 'episodes/ch01.md',
      messageTimestamp: '2026-04-10T00:00:00.000Z',
    },
  );

  assert.deepEqual(
    normalizeArtifactSourceRef({
      workingDirectory: 'workspace',
      threadId: '00000000-0000-4000-8000-000000000001',
      runId: null,
      filePath: null,
      messageTimestamp: null,
    }),
    {
      kind: 'thread',
      workingDirectory: 'workspace',
      threadId: '00000000-0000-4000-8000-000000000001',
      runId: null,
      filePath: null,
      messageTimestamp: null,
    },
  );

  assert.equal(
    normalizeArtifactSourceRef({
      workingDirectory: 'workspace',
      threadId: null,
      runId: null,
      filePath: 'episodes/ch01.md',
      messageTimestamp: null,
    }),
    null,
  );

  assert.equal(
    normalizeArtifactSourceRef({
      workingDirectory: '../workspace',
      threadId: '00000000-0000-4000-8000-000000000001',
      runId: null,
      filePath: null,
      messageTimestamp: null,
    }),
    null,
  );
});

void test('isArtifactRecord requires an explicit sourceRef field', () => {
  const baseRecord = {
    artifactId: 'art_1',
    threadId: '00000000-0000-4000-8000-000000000001',
    renderer: 'markdown',
    title: null,
    latestVersion: 1,
    persistenceEpoch: 0,
    createdAt: '2026-04-10T00:00:00.000Z',
    updatedAt: '2026-04-10T00:00:00.000Z',
  } as const;

  assert.equal(isArtifactRecord({ ...baseRecord, sourceRef: null }), true);
  assert.equal(
    isArtifactRecord({
      ...baseRecord,
      projectId: 'retired-project-scope',
      sourceRef: null,
    }),
    false,
  );
  assert.equal(isArtifactRecord(baseRecord), false);
});

void test('isThreadArtifactVersion requires an explicit sourceRef field', () => {
  const baseVersion = {
    artifactId: 'art_1',
    version: 1,
    parentVersion: null,
    baseVersion: null,
    renderer: 'markdown',
    payload: '# hello',
    digest: null,
    contentHash: 'hash',
    createdAt: '2026-04-10T00:00:00.000Z',
    createdByRunId: 'run_1',
    previewValidation: { ok: true },
    title: null,
    persistenceEpoch: 0,
  } as const;

  assert.equal(
    isThreadArtifactVersion({ ...baseVersion, sourceRef: null }),
    true,
  );
  assert.equal(isThreadArtifactVersion(baseVersion), false);
});

void test('parseImageArtifactPayload accepts a canonical generated-image manifest', () => {
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
      revisedPrompt: 'a fluffy cat',
      generatedAt: '2026-07-05T00:00:00.000Z',
    },
  };

  const parsed = parseImageArtifactPayload(JSON.stringify(manifest));
  assert.ok(parsed);
  assert.equal(parsed.mimeType, 'image/png');
  assert.equal(parsed.source.type, 'inline_base64');
  if (parsed.source.type === 'inline_base64') {
    assert.equal(parsed.source.dataBase64, 'cG5nLWJvZHk=');
  }
  assert.equal(parsed.provenance.revisedPrompt, 'a fluffy cat');
});

void test('parseImageArtifactPayload accepts a thread_media image manifest (file-store, D-V7)', () => {
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
  const parsed = parseImageArtifactPayload(JSON.stringify(manifest));
  assert.ok(parsed);
  assert.equal(parsed.source.type, 'thread_media');
  if (parsed.source.type === 'thread_media') {
    assert.equal(parsed.source.mediaRef, `${sha}.jpg`);
  }
  // 신형 매니페스트에는 base64가 없다(스냅샷 비대 해소)
  assert.ok(!JSON.stringify(manifest).includes('dataBase64'));

  // 형식 밖 mediaRef는 거부(경로 탈출 방어)
  assert.equal(
    parseImageArtifactPayload(
      JSON.stringify({
        ...manifest,
        source: { type: 'thread_media', mediaRef: '../escape.jpg' },
      }),
    ),
    null,
  );
});

void test('parseImageArtifactPayload rejects malformed manifests', () => {
  assert.equal(parseImageArtifactPayload('not json'), null);
  assert.equal(parseImageArtifactPayload('{}'), null);
  assert.equal(
    parseImageArtifactPayload(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'generated_image',
        mimeType: 'image/png',
        byteLength: 8,
        digest: { algorithm: 'md5', encoding: 'hex', value: 'ab12' },
        source: { type: 'inline_base64', dataBase64: 'cG5n' },
        provenance: {
          providerId: 'grok_oauth',
          model: 'grok-2-image',
          capability: 'image_generation',
          prompt: 'a cat',
          generatedAt: '2026-07-05T00:00:00.000Z',
        },
      }),
    ),
    null,
  );
  assert.equal(
    parseImageArtifactPayload(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'generated_image',
        mimeType: 'image/png',
        byteLength: 8,
        digest: { algorithm: 'sha256', encoding: 'hex', value: 'ab12' },
        source: { type: 'external_url', url: 'https://example.com/x.png' },
        provenance: {
          providerId: 'grok_oauth',
          model: 'grok-2-image',
          capability: 'image_generation',
          prompt: 'a cat',
          generatedAt: '2026-07-05T00:00:00.000Z',
        },
      }),
    ),
    null,
  );
});

const VALID_MEDIA_SHA =
  'af2434551dcb9d993703ba9281c42e1a1ed66d199e14a077e3c3df801920cf55';

function buildVideoManifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: 'generated_video',
    mimeType: 'video/mp4',
    byteLength: 843620,
    digest: { algorithm: 'sha256', encoding: 'hex', value: VALID_MEDIA_SHA },
    source: { type: 'thread_media', mediaRef: `${VALID_MEDIA_SHA}.mp4` },
    durationSeconds: 5,
    provenance: {
      providerId: 'grok_oauth',
      model: 'grok-imagine-video-1.5',
      capability: 'video_generation',
      prompt: 'a cat waving',
      sourceImage: 'blank_canvas',
      generatedAt: '2026-07-13T00:00:00.000Z',
    },
    ...overrides,
  };
}

void test('parseVideoArtifactPayload accepts a canonical thread-media manifest', () => {
  const parsed = parseVideoArtifactPayload(
    JSON.stringify(buildVideoManifest()),
  );
  assert.ok(parsed);
  assert.equal(parsed.source.mediaRef, `${VALID_MEDIA_SHA}.mp4`);
  assert.equal(parsed.durationSeconds, 5);
  assert.equal(parsed.provenance.sourceImage, 'blank_canvas');

  // 아티팩트 소스 이미지 출처도 왕복된다
  const fromArtifact = parseVideoArtifactPayload(
    JSON.stringify(
      buildVideoManifest({
        provenance: {
          ...buildVideoManifest().provenance,
          sourceImage: { artifactRef: 'art_x@1' },
        },
      }),
    ),
  );
  assert.ok(fromArtifact);
  assert.deepEqual(fromArtifact.provenance.sourceImage, {
    artifactRef: 'art_x@1',
  });
});

void test('parseVideoArtifactPayload rejects inline bytes and malformed media refs', () => {
  // 인라인 base64 소스는 video 매니페스트에서 금지(§4.6 — 비대 방지 규범)
  assert.equal(
    parseVideoArtifactPayload(
      JSON.stringify(
        buildVideoManifest({
          source: { type: 'inline_base64', dataBase64: 'bXA0' },
        }),
      ),
    ),
    null,
  );
  // mediaRef는 <sha256>.<ext> 형식만 — 경로 탈출류는 파서부터 거부
  for (const bad of [
    '../../../etc/passwd',
    `${VALID_MEDIA_SHA}`,
    `${VALID_MEDIA_SHA}.exe`,
    `${VALID_MEDIA_SHA.slice(0, 10)}.mp4`,
    `${VALID_MEDIA_SHA}.mp4/..`,
  ]) {
    assert.equal(
      parseVideoArtifactPayload(
        JSON.stringify(
          buildVideoManifest({
            source: { type: 'thread_media', mediaRef: bad },
          }),
        ),
      ),
      null,
      `expected rejection for mediaRef: ${bad}`,
    );
    assert.equal(isThreadMediaRef(bad), false);
  }
  assert.equal(isThreadMediaRef(`${VALID_MEDIA_SHA}.mp4`), true);
});

void test('isArtifactDraftCommitRequest enforces baseVersion and payload bounds', () => {
  assert.equal(
    isArtifactDraftCommitRequest({ baseVersion: 1, payload: '# v2' }),
    true,
  );
  assert.equal(
    isArtifactDraftCommitRequest({ baseVersion: 0, payload: '# v2' }),
    false,
  );
  assert.equal(
    isArtifactDraftCommitRequest({ baseVersion: 1.5, payload: '# v2' }),
    false,
  );
  assert.equal(
    isArtifactDraftCommitRequest({ baseVersion: 1, payload: '' }),
    false,
  );
  assert.equal(
    isArtifactDraftCommitRequest({
      baseVersion: 1,
      payload: 'x'.repeat(MAX_ARTIFACT_DRAFT_COMMIT_PAYLOAD_LENGTH + 1),
    }),
    false,
  );
  assert.equal(isArtifactDraftCommitRequest({ payload: '# v2' }), false);
});
