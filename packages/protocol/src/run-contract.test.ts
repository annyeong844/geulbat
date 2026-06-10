import assert from 'node:assert/strict';
import test from 'node:test';

import { isRunRequest } from './run-contract.js';

const VALID_THREAD_ID = '11111111-1111-4111-8111-111111111111';

void test('isRunRequest requires a canonical project id', () => {
  assert.equal(
    isRunRequest({
      prompt: 'hello',
      projectId: 'workspace',
      threadId: VALID_THREAD_ID,
    }),
    true,
  );

  assert.equal(
    isRunRequest({
      prompt: 'hello',
      projectId: '../escape',
      threadId: VALID_THREAD_ID,
    }),
    false,
  );
});
