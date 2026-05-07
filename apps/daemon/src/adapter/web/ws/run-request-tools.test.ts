import test from 'node:test';
import assert from 'node:assert/strict';
import type { RunRequest } from '@geulbat/protocol/run-contract';

import { normalizeAllowedToolNames } from './run-request-tools.js';

const PROJECT_ID = 'workspace' as RunRequest['projectId'];

void test('normalizeAllowedToolNames trims, deduplicates, and drops empty hints', () => {
  const result = normalizeAllowedToolNames({
    prompt: 'hello',
    projectId: PROJECT_ID,
    allowedToolsHint: [' read_file ', 'patch_file', '', 'read_file', '  '],
  });

  assert.deepEqual(result, ['read_file', 'patch_file']);
});

void test('normalizeAllowedToolNames returns undefined when no usable hints exist', () => {
  assert.equal(
    normalizeAllowedToolNames({
      prompt: 'hello',
      projectId: PROJECT_ID,
    }),
    undefined,
  );

  assert.equal(
    normalizeAllowedToolNames({
      prompt: 'hello',
      projectId: PROJECT_ID,
      allowedToolsHint: [' ', ''],
    }),
    undefined,
  );
});
