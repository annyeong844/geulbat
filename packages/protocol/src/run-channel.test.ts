import assert from 'node:assert/strict';
import test from 'node:test';

import { isRunChannelServerMessage } from './run-channel.js';

void test('isRunChannelServerMessage rejects run.error messages with unknown error codes', () => {
  assert.equal(
    isRunChannelServerMessage({
      type: 'run.error',
      requestId: 'req-1',
      code: 'internal',
      message: 'boom',
      status: 500,
    }),
    true,
  );

  assert.equal(
    isRunChannelServerMessage({
      type: 'run.error',
      requestId: 'req-1',
      code: 'totally_new_error',
      message: 'boom',
      status: 500,
    }),
    false,
  );
});
