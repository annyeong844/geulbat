import test from 'node:test';
import assert from 'node:assert/strict';

import { getErrorMessage } from './error.js';

void test('getErrorMessage preserves non-empty Error and string messages', () => {
  assert.equal(getErrorMessage(new Error('daemon failed')), 'daemon failed');
  assert.equal(getErrorMessage('provider failed'), 'provider failed');
});

void test('getErrorMessage uses the requested fallback for unusable values', () => {
  assert.equal(getErrorMessage(new Error('')), 'unknown error');
  assert.equal(getErrorMessage('   ', 'request failed'), 'request failed');
  assert.equal(getErrorMessage({ message: 'not trusted' }), 'unknown error');
});
