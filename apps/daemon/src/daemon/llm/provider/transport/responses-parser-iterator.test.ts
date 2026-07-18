import test from 'node:test';
import assert from 'node:assert/strict';

import { nextResponseEvent } from './responses-parser-iterator.js';

function createPendingIterator() {
  let returnCalls = 0;
  const iterator: AsyncIterator<Record<string, unknown>> = {
    next: () => new Promise<IteratorResult<Record<string, unknown>>>(() => {}),
    async return() {
      returnCalls += 1;
      return { done: true, value: undefined };
    },
  };
  return {
    iterator,
    get returnCalls() {
      return returnCalls;
    },
  };
}

function createReturnResolvingIterator() {
  let returnCalls = 0;
  let resolvePendingNext:
    | ((result: IteratorResult<Record<string, unknown>>) => void)
    | undefined;
  const iterator: AsyncIterator<Record<string, unknown>> = {
    next: () =>
      new Promise<IteratorResult<Record<string, unknown>>>((resolve) => {
        resolvePendingNext = resolve;
      }),
    async return() {
      returnCalls += 1;
      resolvePendingNext?.({ done: true, value: undefined });
      return { done: true, value: undefined };
    },
  };
  return {
    iterator,
    get returnCalls() {
      return returnCalls;
    },
  };
}

void test('nextResponseEvent closes the iterator when the idle timeout wins', async () => {
  const subject = createPendingIterator();

  await assert.rejects(
    () =>
      nextResponseEvent(subject.iterator, {
        idleTimeoutMs: 5,
      }),
    (error: unknown) =>
      error instanceof Error &&
      (error as { llmCode?: string }).llmCode === 'llm_idle_timeout',
  );

  assert.equal(subject.returnCalls, 1);
});

void test('nextResponseEvent keeps the idle timeout fail-closed when iterator.return resolves pending next', async () => {
  const subject = createReturnResolvingIterator();

  await assert.rejects(
    () =>
      nextResponseEvent(subject.iterator, {
        idleTimeoutMs: 5,
      }),
    (error: unknown) =>
      error instanceof Error &&
      (error as { llmCode?: string }).llmCode === 'llm_idle_timeout',
  );

  assert.equal(subject.returnCalls, 1);
});

void test('nextResponseEvent closes the iterator when the caller aborts', async () => {
  const controller = new AbortController();
  const subject = createPendingIterator();

  const nextEvent = nextResponseEvent(subject.iterator, {
    signal: controller.signal,
  });
  controller.abort();

  await assert.rejects(nextEvent, /Request was aborted/);
  assert.equal(subject.returnCalls, 1);
});

void test('nextResponseEvent keeps caller abort fail-closed when iterator.return resolves pending next', async () => {
  const controller = new AbortController();
  const subject = createReturnResolvingIterator();

  const nextEvent = nextResponseEvent(subject.iterator, {
    signal: controller.signal,
  });
  controller.abort();

  await assert.rejects(nextEvent, /Request was aborted/);
  assert.equal(subject.returnCalls, 1);
});

void test('nextResponseEvent closes the iterator when the signal is already aborted', async () => {
  const controller = new AbortController();
  const subject = createPendingIterator();
  controller.abort();

  await assert.rejects(
    () => nextResponseEvent(subject.iterator, { signal: controller.signal }),
    /Request was aborted/,
  );
  assert.equal(subject.returnCalls, 1);
});
