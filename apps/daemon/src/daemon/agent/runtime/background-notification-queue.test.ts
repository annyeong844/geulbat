import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunId } from '@geulbat/protocol/ids';

import {
  createThreadBackgroundNotificationQueue,
  type BackgroundNotificationQueue,
} from './background-notification-queue.js';
import type {
  BackgroundChildResult,
  BackgroundChildResultInput,
} from '../../subagent-runtime-contracts.js';
import { testRunId } from '../../../test-support/run-id.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { createDaemonRuntimeStateStore } from '../../runtime-state-store.js';

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
type _BackgroundChildResultDoesNotExposeOk = Expect<
  Equal<'ok' extends keyof BackgroundChildResult ? true : false, false>
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
    result: 'alpha',
    completedAt: '2026-03-24T00:00:00.000Z',
  });
  queue.enqueueThreadBackgroundResult(threadId, {
    deliveryId: 'delivery-b',
    parentRunId: testRunId('parent-b'),
    childRunId: testRunId('child-b'),
    subagentType: 'explorer',
    terminalState: 'failed',
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

void test('thread background notification queue acknowledges only the persisted snapshot', () => {
  const queue = createThreadBackgroundNotificationQueue();
  const threadId = testThreadId(174011);
  const makeResult = (deliveryId: string): BackgroundChildResult => ({
    deliveryId,
    parentRunId: testRunId(`parent-${deliveryId}`),
    childRunId: testRunId(`child-${deliveryId}`),
    subagentType: 'explorer',
    terminalState: 'completed',
    result: deliveryId,
    completedAt: '2026-03-24T00:00:00.000Z',
  });

  queue.enqueueThreadBackgroundResult(threadId, makeResult('delivery-first'));
  const persistedSnapshot = queue.readThreadBackgroundResults(threadId);
  queue.enqueueThreadBackgroundResult(threadId, makeResult('delivery-later'));

  assert.deepEqual(
    queue
      .readThreadBackgroundResults(threadId)
      .map((result) => result.deliveryId),
    ['delivery-first', 'delivery-later'],
  );
  queue.acknowledgeThreadBackgroundResults(
    threadId,
    persistedSnapshot.map((result) => result.deliveryId),
  );
  assert.deepEqual(
    queue
      .consumeThreadBackgroundResults(threadId)
      .map((result) => result.deliveryId),
    ['delivery-later'],
  );
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
    result: 'later',
    completedAt: '2026-03-24T00:00:03.000Z',
  });

  assert.deepEqual(seen, [childRunId]);
});

void test('thread background notification queue ignores duplicate delivery ids for a thread', () => {
  const queue = createThreadBackgroundNotificationQueue();
  const threadId = testThreadId(174010);
  const seen: string[] = [];
  const result: BackgroundChildResult = {
    deliveryId: 'delivery-duplicate',
    parentRunId: testRunId('parent-duplicate'),
    childRunId: testRunId('child-duplicate'),
    subagentType: 'explorer',
    terminalState: 'completed',
    result: 'duplicate',
    completedAt: '2026-03-24T00:00:10.000Z',
  };

  const unsubscribe = queue.subscribeThreadBackgroundResults(
    threadId,
    (backgroundResult) => {
      seen.push(backgroundResult.deliveryId);
    },
  );

  queue.enqueueThreadBackgroundResult(threadId, result);
  queue.enqueueThreadBackgroundResult(threadId, result);
  unsubscribe();

  assert.deepEqual(seen, ['delivery-duplicate']);
  assert.deepEqual(
    queue
      .consumeThreadBackgroundResults(threadId)
      .map((backgroundResult) => backgroundResult.deliveryId),
    ['delivery-duplicate'],
  );
});

void test('thread background notification queue replays and acknowledges through the durable runtime store', async () => {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-background-queue-'),
  );
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const threadId = testThreadId(174012);
  const result: BackgroundChildResult = {
    deliveryId: 'delivery-durable-replay',
    parentRunId: testRunId('parent-durable-replay'),
    childRunId: testRunId('child-durable-replay'),
    childThreadId: testThreadId(174013),
    subagentType: 'worker',
    terminalState: 'completed',
    result: 'durable terminal result',
    completedAt: '2026-07-23T04:00:00.000Z',
  };
  const pendingDurableResult = {
    ...result,
    resultDeliveryState: 'pending' as const,
    resultRef: `subagent-result:${result.deliveryId}`,
    resultDigest:
      `sha256:${createHash('sha256').update(result.result).digest('hex')}` as const,
  };
  const acknowledgedDurableResult = {
    ...pendingDurableResult,
    resultDeliveryState: 'acknowledged' as const,
  };
  let store = await createDaemonRuntimeStateStore({ homeStateRoot });

  try {
    const firstQueue = createThreadBackgroundNotificationQueue();
    firstQueue.enqueueThreadBackgroundResult(threadId, result);
    firstQueue.attachDurableStore(store);
    assert.deepEqual(firstQueue.readThreadBackgroundResults(threadId), [
      pendingDurableResult,
    ]);
    firstQueue.enqueueThreadBackgroundResult(threadId, result);
    assert.deepEqual(firstQueue.readThreadBackgroundResults(threadId), [
      pendingDurableResult,
    ]);

    store.close();
    store = await createDaemonRuntimeStateStore({ homeStateRoot });
    const replayQueue = createThreadBackgroundNotificationQueue();
    replayQueue.attachDurableStore(store);
    const replayed: BackgroundChildResult[] = [];
    const unsubscribe = replayQueue.subscribeThreadBackgroundResults(
      threadId,
      (delivery) => replayed.push(delivery),
    );
    unsubscribe();
    assert.deepEqual(replayed, [pendingDurableResult]);

    replayQueue.acknowledgeThreadBackgroundResults(threadId, [
      result.deliveryId,
    ]);
    assert.deepEqual(replayQueue.readThreadBackgroundResults(threadId), []);
    assert.deepEqual(replayQueue.readThreadBackgroundResultHistory(threadId), [
      acknowledgedDurableResult,
    ]);

    store.close();
    store = await createDaemonRuntimeStateStore({ homeStateRoot });
    const reopenedQueue = createThreadBackgroundNotificationQueue();
    reopenedQueue.attachDurableStore(store);
    assert.deepEqual(reopenedQueue.readThreadBackgroundResults(threadId), []);
    assert.deepEqual(
      reopenedQueue.readThreadBackgroundResultHistory(threadId),
      [acknowledgedDurableResult],
    );
    assert.deepEqual(
      store.readSubagentTerminalOutcomeByChildRunId(result.childRunId)?.result,
      result,
    );
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('thread background notification queue publishes pending then acknowledged result delivery state', async () => {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-background-delivery-state-'),
  );
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const threadId = testThreadId(174016);
  const result: BackgroundChildResultInput = {
    deliveryId: 'delivery-state-transition',
    parentRunId: testRunId('parent-delivery-state'),
    childRunId: testRunId('child-delivery-state'),
    childThreadId: testThreadId(174017),
    subagentType: 'worker',
    terminalState: 'completed',
    result: 'durable terminal result',
    completedAt: '2026-07-28T13:10:00.000Z',
  };
  const store = await createDaemonRuntimeStateStore({ homeStateRoot });
  const queue = createThreadBackgroundNotificationQueue();
  queue.attachDurableStore(store);
  const seen: BackgroundChildResult[] = [];
  const unsubscribe = queue.subscribeThreadBackgroundResults(
    threadId,
    (delivery) => seen.push(delivery),
  );

  try {
    queue.enqueueThreadBackgroundResult(threadId, result);
    assert.deepEqual(
      seen.map((delivery) => Reflect.get(delivery, 'resultDeliveryState')),
      ['pending'],
    );

    queue.acknowledgeThreadBackgroundResults(threadId, [result.deliveryId]);

    assert.deepEqual(
      seen.map((delivery) => Reflect.get(delivery, 'resultDeliveryState')),
      ['pending', 'acknowledged'],
    );
    assert.equal(
      Reflect.get(
        queue.readThreadBackgroundResultHistory(threadId)[0] ?? {},
        'resultDeliveryState',
      ),
      'acknowledged',
    );
    assert.equal(
      Reflect.get(
        store.readSubagentTerminalOutcomeByChildRunId(result.childRunId) ?? {},
        'resultDeliveryState',
      ),
      'acknowledged',
    );
  } finally {
    unsubscribe();
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('thread background notification queue does not acknowledge a retained result before durable commit succeeds', async () => {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-background-delivery-ack-retry-'),
  );
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const threadId = testThreadId(174018);
  const result: BackgroundChildResultInput = {
    deliveryId: 'delivery-ack-before-commit',
    parentRunId: testRunId('parent-ack-before-commit'),
    childRunId: testRunId('child-ack-before-commit'),
    subagentType: 'worker',
    terminalState: 'failed',
    reason: 'persistence_error',
    result: 'retain until the durable owner accepts the exact result',
    completedAt: '2026-07-28T13:11:00.000Z',
  };
  const store = await createDaemonRuntimeStateStore({ homeStateRoot });
  const originalRecord = store.recordSubagentTerminalDelivery;
  let rejectWrites = true;
  store.recordSubagentTerminalDelivery = (args) => {
    if (rejectWrites) {
      throw new Error('terminal store unavailable');
    }
    return originalRecord(args);
  };
  const queue = createThreadBackgroundNotificationQueue();
  queue.attachDurableStore(store);
  const seen: BackgroundChildResult[] = [];
  const unsubscribe = queue.subscribeThreadBackgroundResults(
    threadId,
    (delivery) => seen.push(delivery),
  );

  try {
    assert.throws(
      () => queue.enqueueThreadBackgroundResult(threadId, result),
      /terminal store unavailable/u,
    );
    queue.acknowledgeThreadBackgroundResults(threadId, [result.deliveryId]);

    assert.deepEqual(
      seen.map((delivery) => delivery.resultDeliveryState),
      ['pending'],
    );
    assert.equal(
      store.readSubagentTerminalOutcomeByChildRunId(result.childRunId),
      undefined,
    );

    rejectWrites = false;
    assert.deepEqual(
      queue
        .readThreadBackgroundResults(threadId)
        .map((delivery) => delivery.deliveryId),
      [result.deliveryId],
    );
    queue.acknowledgeThreadBackgroundResults(threadId, [result.deliveryId]);

    assert.deepEqual(
      seen.map((delivery) => delivery.resultDeliveryState),
      ['pending', 'acknowledged'],
    );
    assert.deepEqual(queue.readThreadBackgroundResults(threadId), []);
  } finally {
    unsubscribe();
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('thread background notification queue retains live delivery and retries rejected durable writes with the same identity', async () => {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-background-queue-retry-'),
  );
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const threadId = testThreadId(174014);
  const result: BackgroundChildResultInput = {
    deliveryId: 'delivery-durable-retry',
    parentRunId: testRunId('parent-durable-retry'),
    childRunId: testRunId('child-durable-retry'),
    childThreadId: testThreadId(174015),
    subagentType: 'worker',
    terminalState: 'failed',
    reason: 'child_error',
    result: 'terminal despite the first durable write failure',
    resultReportSummary: 'retry must preserve this report',
    completedAt: '2026-07-28T11:00:00.000Z',
  };
  const store = await createDaemonRuntimeStateStore({ homeStateRoot });
  const originalRecord = store.recordSubagentTerminalDelivery;
  let recordAttempts = 0;
  store.recordSubagentTerminalDelivery = (args) => {
    recordAttempts += 1;
    if (recordAttempts <= 2) {
      throw new Error('transient terminal store failure');
    }
    return originalRecord(args);
  };
  const queue = createThreadBackgroundNotificationQueue();
  queue.attachDurableStore(store);
  const seen: BackgroundChildResult[] = [];
  const unsubscribe = queue.subscribeThreadBackgroundResults(
    threadId,
    (delivery) => seen.push(delivery),
  );

  try {
    assert.throws(
      () => queue.enqueueThreadBackgroundResult(threadId, result),
      /transient terminal store failure/u,
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.deliveryId, result.deliveryId);
    assert.equal(seen[0]?.result, result.result);
    assert.equal(seen[0]?.resultReport, undefined);

    await Promise.resolve();

    assert.equal(recordAttempts, 2);
    assert.equal(seen.length, 1);
    assert.equal(
      store.readSubagentTerminalOutcomeByChildRunId(result.childRunId),
      undefined,
    );

    const [pending] = queue.readThreadBackgroundResults(threadId);
    assert.equal(recordAttempts, 3);
    assert.equal(pending?.deliveryId, result.deliveryId);
    assert.deepEqual(pending?.resultReport, {
      summary: result.resultReportSummary,
      sourceResultRef: pending?.resultRef,
      sourceResultDigest: pending?.resultDigest,
    });
    assert.equal(
      store.readSubagentTerminalOutcomeByChildRunId(result.childRunId)?.result
        .deliveryId,
      result.deliveryId,
    );
  } finally {
    unsubscribe();
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
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

void test('thread background notification queue retains all pending results for a thread', () => {
  const queue = createThreadBackgroundNotificationQueue();
  const threadId = testThreadId(174003);

  for (let i = 1; i <= 25; i += 1) {
    queue.enqueueThreadBackgroundResult(threadId, {
      deliveryId: `delivery-${i}`,
      parentRunId: testRunId('parent-retain-all'),
      childRunId: testRunId(`child-${i}`),
      subagentType: 'explorer',
      terminalState: 'completed',
      result: `result-${i}`,
      completedAt: `2026-03-24T00:00:${String(i).padStart(2, '0')}.000Z`,
    });
  }

  const results = queue.consumeThreadBackgroundResults(threadId);
  assert.equal(results.length, 25);
  assert.equal(results[0]?.childRunId, testRunId('child-1'));
  assert.equal(results.at(-1)?.childRunId, testRunId('child-25'));
});

void test('thread background notification queue retains every pending thread until consumed', () => {
  const queue = createThreadBackgroundNotificationQueue();

  for (let i = 0; i < 130; i += 1) {
    const threadId = testThreadId(i);
    queue.enqueueThreadBackgroundResult(threadId, {
      deliveryId: `delivery-${i}`,
      parentRunId: testRunId(`parent-${i}`),
      childRunId: testRunId(`child-${i}`),
      subagentType: 'explorer',
      terminalState: 'completed',
      result: `result-${i}`,
      completedAt: `2026-03-24T01:${String(i % 60).padStart(2, '0')}:00.000Z`,
    });
  }

  assert.equal(queue.consumeThreadBackgroundResults(testThreadId(0)).length, 1);
  assert.equal(
    queue.consumeThreadBackgroundResults(testThreadId(129)).length,
    1,
  );
});

void test('thread background notification queue can clear one thread lifecycle without touching others', () => {
  const queue = createThreadBackgroundNotificationQueue();
  const firstThreadId = testThreadId(174020);
  const secondThreadId = testThreadId(174021);

  queue.enqueueThreadBackgroundResult(firstThreadId, {
    deliveryId: 'delivery-clear-first',
    parentRunId: testRunId('parent-clear-first'),
    childRunId: testRunId('child-clear-first'),
    subagentType: 'explorer',
    terminalState: 'completed',
    result: 'clear-first',
    completedAt: '2026-03-24T02:00:00.000Z',
  });
  queue.enqueueThreadBackgroundResult(secondThreadId, {
    deliveryId: 'delivery-keep-second',
    parentRunId: testRunId('parent-keep-second'),
    childRunId: testRunId('child-keep-second'),
    subagentType: 'worker',
    terminalState: 'failed',
    reason: 'child_error',
    result: 'keep-second',
    completedAt: '2026-03-24T02:00:01.000Z',
  });

  queue.clearThreadBackgroundResults(firstThreadId);

  assert.deepEqual(queue.consumeThreadBackgroundResults(firstThreadId), []);
  assert.deepEqual(
    queue
      .consumeThreadBackgroundResults(secondThreadId)
      .map((result) => result.deliveryId),
    ['delivery-keep-second'],
  );
});
