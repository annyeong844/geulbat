import test from 'node:test';
import assert from 'node:assert/strict';

import { settleRunEffects } from './run-session-settle.js';
import { THREAD_ID_VALUE } from '../test-support/run-session-fixtures.js';

void test('settleRunEffects continues running follow-up tasks even if one task rejects', async () => {
  const seen: string[] = [];

  const results = await settleRunEffects({
    threadId: THREAD_ID_VALUE,
    selectedFile: 'hello.txt',
    openThreadForRunSettle: async () => {
      seen.push('openThread');
      throw new Error('openThread failed');
    },
    loadThreads: async () => {
      seen.push('loadThreads');
    },
    openFile: async () => {
      seen.push('openFile');
    },
  });

  assert.deepEqual(
    seen.sort(),
    ['loadThreads', 'openFile', 'openThread'].sort(),
  );
  assert.equal(results.length, 3);
  assert.equal(results[0]?.status, 'rejected');
  assert.equal(
    results.slice(1).every((result) => result.status === 'fulfilled'),
    true,
  );
});
