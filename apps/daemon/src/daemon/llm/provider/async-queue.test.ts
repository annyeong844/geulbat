import test from 'node:test';
import assert from 'node:assert/strict';

import { AsyncQueue } from './async-queue.js';

void test('AsyncQueue yields queued items in order and finishes cleanly', async () => {
  const queue = new AsyncQueue<string>();
  queue.push('first');
  queue.push('second');
  queue.finish();

  const values: string[] = [];
  for await (const item of queue) {
    values.push(item);
  }

  assert.deepEqual(values, ['first', 'second']);
});

void test('AsyncQueue resolves a waiting iterator when an item arrives', async () => {
  const queue = new AsyncQueue<string>();
  const iterator = queue[Symbol.asyncIterator]();
  const nextPromise = iterator.next();

  queue.push('hello');

  assert.deepEqual(await nextPromise, {
    done: false,
    value: 'hello',
  });
});
