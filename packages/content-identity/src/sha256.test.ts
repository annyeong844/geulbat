import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256Digest, sha256Hex } from './sha256.js';

void test('sha256Hex hashes UTF-8 strings and bytes consistently', () => {
  const expected =
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

  assert.equal(sha256Hex('hello'), expected);
  assert.equal(sha256Hex(Buffer.from('hello', 'utf8')), expected);
});

void test('sha256Digest returns the canonical sha256-prefixed digest', () => {
  assert.equal(
    sha256Digest('hello'),
    'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  );
});
