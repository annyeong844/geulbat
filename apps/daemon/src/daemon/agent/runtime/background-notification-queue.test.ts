import test from 'node:test';
import assert from 'node:assert/strict';
import type { RunId } from '@geulbat/protocol/ids';

import {
  createThreadBackgroundNotificationQueue,
  type BackgroundNotificationQueue,
  MAX_PENDING_BACKGROUND_THREADS,
} from './background-notification-queue.js';
import type { BackgroundChildResult } from '../../subagent-runtime-contracts.js';
import { testRunId } from '../../../test-support/run-id.js';
import { testThreadId } from '../../../test-support/thread-id.js';

type Equal<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;

type Expect<Condition extends true> = Condition;
type QueueConsumedBackgroundResult = ReturnType<
  BackgroundNotificationQueue['consumeThreadBackgroundResults']
>[number];

type _BackgroundChildResultParentRunIdIsBranded = Expect<
  Equal<BackgroundChildResult['parentRunId'], RunId>
>;
type _BackgroundChildResultChildRunIdIsBranded = Expect<
  Equal<BackgroundChildResult['childRunId'], RunId>
>;
type _QueueConsumedChildRunIdIsBranded = Expect<
  Equal<QueueConsumedBackgroundResult['childRunId'], RunId>
>;

void test('thread background notification queue retains results until the next turn consumes them', () => {
  const queue = createThreadBackgroundNotificationQueue();
  const threadId = testThreadId(174000);

  queue.enqueueThreadBackgroundResult(threadId, {
    deliveryId: 'delivery-a',
    parentRunId: testRunId('parent-a'),
    childRunId: testRunId('child-a'),
    subagentType: 'explorer',
    terminalState: 'completed',
    ok: true,
    result: 'alpha',
    completedAt: '2026-03-24T00:00:00.000Z',
  });
  queue.enqueueThreadBackgroundResult(threadId, {
    deliveryId: 'delivery-b',
    parentRunId: testRunId('parent-b'),
    childRunId: testRunId('child-b'),
    subagentType: 'explorer',
    terminalState: 'failed',
    ok: false,
    result: 'beta',
    completedAt: '2026-03-24T00:00:01.000Z',
  });

  const first = queue.consumeThreadBackgroundResults(threadId);
  assert.equal(first.length, 2);
  assert.equal(first[0]?.result, 'alpha');
  assert.equal(first[1]?.result, 'beta');

  const second = queue.consumeThreadBackgroundResults(threadId);
  assert.equal(second.length, 0);
});

void test('thread background notification queue notifies live subscribers on enqueue', () => {
  const queue = createThreadBackgroundNotificationQueue();
  const threadId = testThreadId(174001);
  const seen: string[] = [];
  const childRunId = testRunId('child-live');

  const unsubscribe = queue.subscribeThreadBackgroundResults(
    threadId,
    (result) => {
      seen.push(result.childRunId);
    },
  );

  queue.enqueueThreadBackgroundResult(threadId, {
    deliveryId: 'delivery-live',
    parentRunId: testRunId('parent-live'),
    childRunId,
    subagentType: 'explorer',
    terminalState: 'completed',
    ok: true,
    result: 'live',
    completedAt: '2026-03-24T00:00:02.000Z',
  });

  unsubscribe();
  queue.enqueueThreadBackgroundResult(threadId, {
    deliveryId: 'delivery-later',
    parentRunId: testRunId('parent-after-unsub'),
    childRunId: testRunId('child-after-unsub'),
    subagentType: 'explorer',
    terminalState: 'completed',
    ok: true,
    result: 'later',
    completedAt: '2026-03-24T00:00:03.000Z',
  });

  assert.deepEqual(seen, [childRunId]);
});

void test('thread background notification queue isolates listener failures and continues delivery', () => {
  const queue = createThreadBackgroundNotificationQueue();
  const threadId = testThreadId(174002);
  const seen: string[] = [];
  const childRunId = testRunId('child-safe');
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  try {
    const unsubscribeBad = queue.subscribeThreadBackgroundResults(
      threadId,
      () => {
        throw new Error('listener boom');
      },
    );
    const unsubscribeGood = queue.subscribeThreadBackgroundResults(
      threadId,
      (result) => {
        seen.push(result.childRunId);
      },
    );

    queue.enqueueThreadBackgroundResult(threadId, {
      deliveryId: 'delivery-safe',
      parentRunId: testRunId('parent-safe'),
      childRunId,
      subagentType: 'explorer',
      terminalState: 'completed',
      ok: true,
      result: 'safe',
      completedAt: '2026-03-24T00:00:04.000Z',
    });

    unsubscribeBad();
    unsubscribeGood();
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(seen, [childRunId]);
  assert.equal(warnings.length, 1);
});

void test('thread background notification queue replays pending results to late subscribers', () => {
  const queue = createThreadBackgroundNotificationQueue();
  const threadId = testThreadId(174009);

  queue.enqueueThreadBackgroundResult(threadId, {
    deliveryId: 'delivery-replay',
    parentRunId: testRunId('parent-replay'),
    childRunId: testRunId('child-replay'),
    subagentType: 'explorer',
    terminalState: 'completed',
    ok: true,
    result: 'replay',
    completedAt: '2026-03-24T00:00:09.000Z',
  });

  const seen: string[] = [];
  const unsubscribe = queue.subscribeThreadBackgroundResults(
    threadId,
    (result) => {
      seen.push(result.deliveryId);
    },
  );

  unsubscribe();
  assert.deepEqual(seen, ['delivery-replay']);
});

void test('thread background notification queue caps pending results per thread', () => {
  const queue = createThreadBackgroundNotificationQueue();
  const threadId = testThreadId(174003);
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  try {
    for (let i = 1; i <= 25; i += 1) {
      queue.enqueueThreadBackgroundResult(threadId, {
        deliveryId: `delivery-${i}`,
        parentRunId: testRunId('parent-cap'),
        childRunId: testRunId(`child-${i}`),
        subagentType: 'explorer',
        terminalState: 'completed',
        ok: true,
        result: `result-${i}`,
        completedAt: `2026-03-24T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
  } finally {
    console.warn = originalWarn;
  }

  const results = queue.consumeThreadBackgroundResults(threadId);
  assert.equal(results.length, 20);
  assert.equal(results[0]?.childRunId, testRunId('child-6'));
  assert.equal(results.at(-1)?.childRunId, testRunId('child-25'));
  assert.equal(warnings.length, 5);
});

void test('thread background notification queue evicts the oldest tracked thread when the thread cap is exceeded', () => {
  const queue = createThreadBackgroundNotificationQueue();
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  try {
    for (let i = 0; i <= MAX_PENDING_BACKGROUND_THREADS; i += 1) {
      const threadId = testThreadId(i);
      queue.enqueueThreadBackgroundResult(threadId, {
        deliveryId: `delivery-${i}`,
        parentRunId: testRunId(`parent-${i}`),
        childRunId: testRunId(`child-${i}`),
        subagentType: 'explorer',
        terminalState: 'completed',
        ok: true,
        result: `result-${i}`,
        completedAt: `2026-03-24T01:${String(i % 60).padStart(2, '0')}:00.000Z`,
      });
    }
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(queue.consumeThreadBackgroundResults(testThreadId(0)), []);
  assert.equal(
    queue.consumeThreadBackgroundResults(
      testThreadId(MAX_PENDING_BACKGROUND_THREADS),
    ).length,
    1,
  );
  assert.equal(warnings.length, 1);
});
