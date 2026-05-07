import test from 'node:test';
import assert from 'node:assert/strict';

import { isThreadId } from '@geulbat/protocol/ids';

import { brandThreadId } from '../id-brand-helpers.js';

const THREAD_ID = '00000000-0000-4000-8000-000000000001';

void test('isThreadId accepts canonical UUID-like ids and rejects legacy thread names', () => {
  assert.equal(isThreadId(THREAD_ID), true);
  assert.equal(isThreadId('thread-1'), false);
});

void test('brandThreadId rejects invalid thread ids', () => {
  assert.equal(brandThreadId(THREAD_ID), THREAD_ID);
  assert.throws(() => brandThreadId('thread-1'), /invalid threadId/i);
});
