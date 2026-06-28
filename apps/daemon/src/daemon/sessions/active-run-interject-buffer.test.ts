import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRunInterjectBuffer,
  dropPendingInterjectFront,
  hasPendingInterject,
  peekPendingInterject,
  pushPendingInterject,
  restorePendingInterjectFront,
  takePendingInterject,
} from './active-run-interject-buffer.js';

void test('pushPendingInterject allocates monotonic receivedSeq and reports bufferDepth', () => {
  const buffer = createRunInterjectBuffer();

  assert.deepEqual(pushPendingInterject(buffer, 'a'), {
    receivedSeq: 1,
    bufferDepth: 1,
  });
  assert.deepEqual(pushPendingInterject(buffer, 'b'), {
    receivedSeq: 2,
    bufferDepth: 2,
  });
  assert.equal(hasPendingInterject(buffer), true);
});

void test('takePendingInterject drains all items in FIFO order', () => {
  const buffer = createRunInterjectBuffer();
  pushPendingInterject(buffer, 'a');
  pushPendingInterject(buffer, 'b');

  const drained = takePendingInterject(buffer);

  assert.deepEqual(
    drained.map((interject) => interject.text),
    ['a', 'b'],
  );
  assert.equal(hasPendingInterject(buffer), false);
  assert.deepEqual(takePendingInterject(buffer), []);
});

void test('restorePendingInterjectFront preserves FIFO against later appends', () => {
  const buffer = createRunInterjectBuffer();
  pushPendingInterject(buffer, 'a');
  pushPendingInterject(buffer, 'b');
  const drained = takePendingInterject(buffer);
  pushPendingInterject(buffer, 'c');

  restorePendingInterjectFront(buffer, drained);

  assert.deepEqual(
    takePendingInterject(buffer).map((interject) => interject.text),
    ['a', 'b', 'c'],
  );
});

void test('peek and drop operate on the front item only', () => {
  const buffer = createRunInterjectBuffer();
  pushPendingInterject(buffer, 'a');
  pushPendingInterject(buffer, 'b');

  assert.deepEqual(peekPendingInterject(buffer), {
    text: 'a',
    receivedSeq: 1,
  });
  assert.deepEqual(dropPendingInterjectFront(buffer), {
    text: 'a',
    receivedSeq: 1,
  });
  assert.deepEqual(peekPendingInterject(buffer), {
    text: 'b',
    receivedSeq: 2,
  });
});
