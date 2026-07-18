import assert from 'node:assert/strict';
import test from 'node:test';

import { buildToolSignatureRef } from './projection-signature.js';

void test('projection signature refs encode canonical tool names', () => {
  assert.equal(
    buildToolSignatureRef('read_file'),
    'geulbat-sdk://signature/read_file',
  );
  assert.equal(
    buildToolSignatureRef('fetch url'),
    'geulbat-sdk://signature/fetch%20url',
  );
});
