import assert from 'node:assert/strict';
import test from 'node:test';

import { assertRunId, assertThreadId, isRunId, isThreadId } from './ids.js';

const THREAD_ID = '00000000-0000-4000-8000-000000000001';

void test('protocol id assertions return canonical branded ids', () => {
  assert.equal(assertRunId('run-1'), 'run-1');
  assert.equal(assertThreadId(THREAD_ID), THREAD_ID);
});

void test('protocol id assertions reject malformed ids with id-specific messages', () => {
  assert.throws(() => assertRunId('run with spaces'), /invalid runId/);
  assert.throws(() => assertThreadId('thread-1'), /invalid threadId/);
});

void test('protocol id guards accept canonical run and thread ids', () => {
  assert.equal(isRunId('run-1'), true);
  assert.equal(isThreadId(THREAD_ID), true);
});
