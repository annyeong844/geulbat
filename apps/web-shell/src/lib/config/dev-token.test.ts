import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfiguredDevToken } from './dev-token.js';

const DEV_TOKEN_PLACEHOLDER = '%VITE_GEULBAT_DEV_TOKEN%';

void test('normalizeConfiguredDevToken trims valid runtime bootstrap tokens', () => {
  assert.equal(
    normalizeConfiguredDevToken('  test-token-123456  '),
    'test-token-123456',
  );
});

void test('normalizeConfiguredDevToken rejects empty and unresolved vite placeholders', () => {
  assert.equal(normalizeConfiguredDevToken(''), null);
  assert.equal(normalizeConfiguredDevToken('   '), null);
  assert.equal(normalizeConfiguredDevToken(DEV_TOKEN_PLACEHOLDER), null);
});
