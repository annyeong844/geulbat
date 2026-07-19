import test from 'node:test';
import assert from 'node:assert/strict';

import { getErrorMessage } from './error-message.js';

void test('getErrorMessage preserves non-empty Error and string messages', () => {
  assert.equal(getErrorMessage(new Error('request failed')), 'request failed');
  assert.equal(getErrorMessage('render failed'), 'render failed');
});

void test('getErrorMessage uses the requested fallback for unusable values', () => {
  assert.equal(getErrorMessage(new Error('')), 'unknown error');
  assert.equal(getErrorMessage('   ', 'render failed'), 'render failed');
  assert.equal(getErrorMessage({ message: 'not trusted' }), 'unknown error');
});
