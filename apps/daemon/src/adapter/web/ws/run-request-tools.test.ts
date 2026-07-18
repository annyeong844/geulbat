import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAllowedPublicToolNames } from './run-request-tools.js';

void test('normalizeAllowedPublicToolNames trims, deduplicates, and drops empty hints', () => {
  const result = normalizeAllowedPublicToolNames({
    prompt: 'hello',
    allowedPublicToolNames: [
      ' read_file ',
      'apply_patch',
      '',
      'read_file',
      '  ',
    ],
  });

  assert.deepEqual(result, ['read_file', 'apply_patch']);
});

void test('normalizeAllowedPublicToolNames returns undefined when no usable hints exist', () => {
  assert.equal(
    normalizeAllowedPublicToolNames({
      prompt: 'hello',
    }),
    undefined,
  );

  assert.equal(
    normalizeAllowedPublicToolNames({
      prompt: 'hello',
      allowedPublicToolNames: [' ', ''],
    }),
    undefined,
  );
});
