import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearInterjectFlushRequest,
  createRunInterjectBuffer,
  dropPendingInterjectFront,
  hasPendingInterject,
  isInterjectFlushRequested,
  peekPendingInterject,
  pushPendingInterject,
  removePendingInterjectBySeq,
  requestInterjectFlush,
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

void test('removePendingInterjectBySeq removes only the matching queued steer', () => {
  const buffer = createRunInterjectBuffer();
  const first = pushPendingInterject(buffer, '첫 스티어');
  const second = pushPendingInterject(buffer, '둘째 스티어');

  assert.equal(removePendingInterjectBySeq(buffer, first.receivedSeq), true);
  assert.deepEqual(
    buffer.items.map((item) => item.receivedSeq),
    [second.receivedSeq],
  );
  // 이미 소비/취소된 seq는 false — 경합은 정상 흐름
  assert.equal(removePendingInterjectBySeq(buffer, first.receivedSeq), false);
});

void test('requestInterjectFlush is a no-op on an empty queue and one-shot per apply', () => {
  const buffer = createRunInterjectBuffer();

  assert.equal(requestInterjectFlush(buffer), false);
  assert.equal(isInterjectFlushRequested(buffer), false);

  pushPendingInterject(buffer, 'a');
  assert.equal(requestInterjectFlush(buffer), true);
  assert.equal(isInterjectFlushRequested(buffer), true);

  clearInterjectFlushRequest(buffer);
  assert.equal(isInterjectFlushRequested(buffer), false);
});

void test('removePendingInterjectBySeq clears the flush request when the queue empties', () => {
  const buffer = createRunInterjectBuffer();
  const first = pushPendingInterject(buffer, 'a');
  const second = pushPendingInterject(buffer, 'b');
  requestInterjectFlush(buffer);

  assert.equal(removePendingInterjectBySeq(buffer, first.receivedSeq), true);
  assert.equal(isInterjectFlushRequested(buffer), true);

  assert.equal(removePendingInterjectBySeq(buffer, second.receivedSeq), true);
  assert.equal(isInterjectFlushRequested(buffer), false);
});
