import test from 'node:test';
import assert from 'node:assert/strict';

import { parseStreamingArtifactEnvelope } from './streaming-artifact-envelope.js';

void test('returns null before the header line is complete', () => {
  assert.equal(parseStreamingArtifactEnvelope(''), null);
  assert.equal(parseStreamingArtifactEnvelope('<!-- GEULBAT_ART'), null);
  assert.equal(
    parseStreamingArtifactEnvelope('<!-- GEULBAT_ARTIFACT {"renderer":'),
    null,
  );
  assert.equal(parseStreamingArtifactEnvelope('일반 답변 텍스트'), null);
});

void test('parses renderer/title and the streamed payload prefix', () => {
  const parsed = parseStreamingArtifactEnvelope(
    '<!-- GEULBAT_ARTIFACT {"renderer":"react_bundle","title":"펠리컨"} -->\nconst a = 1;\nconst b',
  );
  assert.ok(parsed);
  assert.equal(parsed.renderer, 'react_bundle');
  assert.equal(parsed.title, '펠리컨');
  assert.equal(parsed.payloadSoFar, 'const a = 1;\nconst b');
});

void test('falls back to markdown renderer and strips a trailing end marker', () => {
  const parsed = parseStreamingArtifactEnvelope(
    '<!-- GEULBAT_ARTIFACT {"digest":"요약"} -->\n# 제목\n<!-- /GEULBAT_ARTIFACT -->',
  );
  assert.ok(parsed);
  assert.equal(parsed.renderer, 'markdown');
  assert.equal(parsed.title, null);
  assert.equal(parsed.payloadSoFar, '# 제목\n');
});
