import test from 'node:test';
import assert from 'node:assert/strict';

import { validateJsArtifactPayload } from './validator.js';

void test('validateJsArtifactPayload accepts dynamic import in public web parity mode', () => {
  assert.deepEqual(validateJsArtifactPayload('import("./entry.js")'), {
    ok: true,
  });
});

void test('validateJsArtifactPayload accepts import.meta in public web parity mode', () => {
  assert.deepEqual(validateJsArtifactPayload('console.log(import.meta.url);'), {
    ok: true,
  });
});

void test('validateJsArtifactPayload rejects empty payloads', () => {
  assert.deepEqual(validateJsArtifactPayload('  '), {
    ok: false,
    code: 'boot_failed',
    detail: 'js artifact payload is empty',
  });
});

void test('validateJsArtifactPayload leaves malformed js to the sandbox runtime', () => {
  assert.deepEqual(validateJsArtifactPayload('function broken('), {
    ok: true,
  });
});
