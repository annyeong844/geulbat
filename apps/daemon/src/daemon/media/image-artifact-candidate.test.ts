import test from 'node:test';
import assert from 'node:assert/strict';

import { parseImageArtifactPayload } from '@geulbat/protocol/artifacts';
import { sha256Digest } from '@geulbat/content-identity/sha256';
import type { GeneratedImageCandidate } from './contract.js';
import { buildImageArtifactCandidate } from './image-artifact-candidate.js';

function buildCandidate(): GeneratedImageCandidate {
  return {
    asset: {
      mimeType: 'image/png',
      byteLength: 21,
      dataBase64: Buffer.from('fake-generated-bytes!').toString('base64'),
      digest: {
        algorithm: 'sha256',
        encoding: 'hex',
        value: 'a'.repeat(64),
      },
    },
    provenance: {
      providerId: 'grok_oauth',
      model: 'grok-2-image',
      capability: 'image_generation',
      prompt: '눈 오는 서울의 골목길',
      revisedPrompt: 'A snowy alley in Seoul at dusk',
      generatedAt: '2026-07-05T00:00:00.000Z',
    },
  };
}

const MEDIA_REF = `${'a'.repeat(64)}.png`;

void test('buildImageArtifactCandidate produces a thread_media manifest without inline bytes', () => {
  const artifactCandidate = buildImageArtifactCandidate({
    candidate: buildCandidate(),
    mediaRef: MEDIA_REF,
  });

  assert.equal(artifactCandidate.renderer, 'image');
  assert.equal(
    artifactCandidate.digest,
    sha256Digest(artifactCandidate.payload),
  );

  const manifest = parseImageArtifactPayload(artifactCandidate.payload);
  assert.ok(manifest);
  assert.equal(manifest.mimeType, 'image/png');
  assert.equal(manifest.byteLength, 21);
  assert.equal(manifest.digest.value, 'a'.repeat(64));
  // 바이트는 media 파일 스토어에 있고 매니페스트엔 mediaRef만(D-V7)
  assert.equal(manifest.source.type, 'thread_media');
  if (manifest.source.type === 'thread_media') {
    assert.equal(manifest.source.mediaRef, MEDIA_REF);
  }
  assert.ok(!artifactCandidate.payload.includes('dataBase64'));
  assert.equal(manifest.provenance.providerId, 'grok_oauth');
  assert.equal(manifest.provenance.prompt, '눈 오는 서울의 골목길');
  assert.equal(
    manifest.provenance.revisedPrompt,
    'A snowy alley in Seoul at dusk',
  );
});

void test('image artifact payload never contains credential material fields', () => {
  const artifactCandidate = buildImageArtifactCandidate({
    candidate: buildCandidate(),
    mediaRef: MEDIA_REF,
  });

  // 후보/커밋 payload는 provenance+asset 요약만 담는다. 토큰류 키가 섞여
  // 들어오면 계약 위반이다(P6.5 §7 diagnostics redaction).
  for (const forbidden of ['accessToken', 'refreshToken', 'Authorization']) {
    assert.ok(
      !artifactCandidate.payload.includes(forbidden),
      `payload must not contain ${forbidden}`,
    );
  }
});
