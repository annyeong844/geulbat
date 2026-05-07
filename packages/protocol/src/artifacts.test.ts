import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildArtifactEnvelopeText,
  isArtifactRecord,
  isArtifactSourceRef,
  isThreadArtifactVersion,
  isArtifactVersionRecord,
  normalizeArtifactSourceRef,
  parseCanonicalArtifactEnvelopeText,
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
      projectId: 'workspace',
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
      projectId: 'workspace',
      threadId: '00000000-0000-4000-8000-000000000001',
      runId: 'run-1',
      filePath: 'episodes/ch01.md',
      messageTimestamp: '2026-04-10T00:00:00.000Z',
    }),
    true,
  );

  assert.equal(
    isArtifactSourceRef({
      projectId: 'workspace',
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
      projectId: null,
      threadId: '00000000-0000-4000-8000-000000000001',
      runId: 'run-1',
      filePath: 'episodes/ch01.md',
      messageTimestamp: '2026-04-10T00:00:00.000Z',
    }),
    false,
  );
});

void test('normalizeArtifactSourceRef upgrades legacy nullable records to discriminated refs', () => {
  assert.deepEqual(
    normalizeArtifactSourceRef({
      projectId: 'workspace',
      threadId: '00000000-0000-4000-8000-000000000001',
      runId: 'run-1',
      filePath: 'episodes/ch01.md',
      messageTimestamp: '2026-04-10T00:00:00.000Z',
    }),
    {
      kind: 'thread-file',
      projectId: 'workspace',
      threadId: '00000000-0000-4000-8000-000000000001',
      runId: 'run-1',
      filePath: 'episodes/ch01.md',
      messageTimestamp: '2026-04-10T00:00:00.000Z',
    },
  );

  assert.deepEqual(
    normalizeArtifactSourceRef({
      projectId: 'workspace',
      threadId: '00000000-0000-4000-8000-000000000001',
      runId: null,
      filePath: null,
      messageTimestamp: null,
    }),
    {
      kind: 'thread',
      projectId: 'workspace',
      threadId: '00000000-0000-4000-8000-000000000001',
      runId: null,
      filePath: null,
      messageTimestamp: null,
    },
  );

  assert.equal(
    normalizeArtifactSourceRef({
      projectId: null,
      threadId: '00000000-0000-4000-8000-000000000001',
      runId: null,
      filePath: 'episodes/ch01.md',
      messageTimestamp: null,
    }),
    null,
  );
});

void test('isArtifactRecord requires an explicit sourceRef field', () => {
  const baseRecord = {
    artifactId: 'art_1',
    projectId: 'workspace',
    threadId: '00000000-0000-4000-8000-000000000001',
    renderer: 'markdown',
    title: null,
    latestVersion: 1,
    persistenceEpoch: 0,
    createdAt: '2026-04-10T00:00:00.000Z',
    updatedAt: '2026-04-10T00:00:00.000Z',
  } as const;

  assert.equal(isArtifactRecord({ ...baseRecord, sourceRef: null }), true);
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
