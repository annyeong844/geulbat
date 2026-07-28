import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearInterjectFlushRequest,
  closeInterjectBuffer,
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

void test('restorePendingInterjectFront restores the durable receive sequence', () => {
  const buffer = createRunInterjectBuffer();

  restorePendingInterjectFront(
    buffer,
    [{ receivedSeq: 4, text: 'restored' }],
    7,
  );

  assert.deepEqual(pushPendingInterject(buffer, 'new'), {
    receivedSeq: 8,
    bufferDepth: 2,
  });
});

void test('closeInterjectBuffer marks terminal admission closed', () => {
  const buffer = createRunInterjectBuffer();

  closeInterjectBuffer(buffer);

  assert.equal(buffer.accepting, false);
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

// 에이전트 루프는 모델 라운드마다 새로 구독한다. 중단 신호가 요청 1건당 여러
// 라운드에 전달되면, 사용자가 누르지 않은 라운드까지 즉시 끊겨 답변과 실행 중인
// 도구가 사라진다.
void test('a flush interrupt reaches only the round that was listening', () => {
  const buffer = createRunInterjectBuffer();
  pushPendingInterject(buffer, 'CSS부터요');

  let firstRoundInterrupts = 0;
  const unsubscribeFirstRound = buffer.subscribeFlush(() => {
    firstRoundInterrupts += 1;
  });
  assert.equal(requestInterjectFlush(buffer), true);
  assert.equal(firstRoundInterrupts, 1);
  unsubscribeFirstRound();

  // 큐는 아직 비지 않았고 `flushRequested`도 남아 있다(남은 도구 호출
  // 건너뛰기가 그것을 읽는다). 그래도 다음 라운드는 끊기지 않아야 한다.
  assert.equal(isInterjectFlushRequested(buffer), true);
  let secondRoundInterrupts = 0;
  const unsubscribeSecondRound = buffer.subscribeFlush(() => {
    secondRoundInterrupts += 1;
  });
  assert.equal(secondRoundInterrupts, 0);
  unsubscribeSecondRound();
});

void test('a flush requested between rounds interrupts the next round', () => {
  const buffer = createRunInterjectBuffer();
  pushPendingInterject(buffer, '먼저 이것부터요');

  // 듣는 라운드가 없는 사이에 도착한 요청은 버려지지 않는다.
  assert.equal(requestInterjectFlush(buffer), true);

  let interrupts = 0;
  const unsubscribe = buffer.subscribeFlush(() => {
    interrupts += 1;
  });
  assert.equal(interrupts, 1);
  unsubscribe();
});

void test('applying the interject drops an undelivered flush interrupt', () => {
  const buffer = createRunInterjectBuffer();
  pushPendingInterject(buffer, 'a');
  pushPendingInterject(buffer, 'b');
  requestInterjectFlush(buffer);
  // 소비가 먼저 일어나 요청이 목적을 다한 경우.
  clearInterjectFlushRequest(buffer);

  let interrupts = 0;
  const unsubscribe = buffer.subscribeFlush(() => {
    interrupts += 1;
  });
  assert.equal(interrupts, 0);
  unsubscribe();
});
