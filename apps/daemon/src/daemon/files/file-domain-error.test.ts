import test from 'node:test';
import assert from 'node:assert/strict';
import { FileAccessError } from './file-domain-error.js';

void test('FileAccessError static factories preserve canonical code/path/message shapes', () => {
  const missing = FileAccessError.notFound('missing.txt');
  assert.equal(missing.code, 'not_found');
  assert.equal(missing.path, 'missing.txt');
  assert.equal(missing.message, 'file not found: missing.txt');
});
