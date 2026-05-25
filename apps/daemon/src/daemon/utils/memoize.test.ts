import test from 'node:test';
import assert from 'node:assert/strict';

import { memoize } from './memoize.js';

void test('memoize reuses the in-flight result for matching arguments until cleared', async () => {
  let callCount = 0;
  const loadValue = memoize(async (key: string) => {
    callCount += 1;
    return `${key}:${callCount}`;
  });

  assert.equal(await loadValue('project-a'), 'project-a:1');
  assert.equal(await loadValue('project-a'), 'project-a:1');
  assert.equal(await loadValue('project-b'), 'project-b:2');
  assert.equal(callCount, 2);
  assert.equal(loadValue.cache.size(), 2);

  loadValue.cache.clear();
  assert.equal(await loadValue('project-a'), 'project-a:3');
});

void test('memoize deletes one cached argument group', async () => {
  let callCount = 0;
  const loadValue = memoize(async (projectId: string, threadId: string) => {
    callCount += 1;
    return `${projectId}/${threadId}/${callCount}`;
  });

  assert.equal(
    await loadValue('project-a', 'thread-1'),
    'project-a/thread-1/1',
  );
  assert.equal(
    await loadValue('project-a', 'thread-2'),
    'project-a/thread-2/2',
  );
  assert.equal(loadValue.cache.has('project-a', 'thread-1'), true);
  assert.equal(loadValue.cache.delete('project-a', 'thread-1'), true);
  assert.equal(loadValue.cache.has('project-a', 'thread-1'), false);
  assert.equal(
    await loadValue('project-a', 'thread-1'),
    'project-a/thread-1/3',
  );
});

void test('memoize evicts rejected results so a later call can retry', async () => {
  let callCount = 0;
  const loadValue = memoize(async () => {
    callCount += 1;
    if (callCount === 1) {
      throw new Error('first failure');
    }
    return 'ok';
  });

  await assert.rejects(() => loadValue(), /first failure/);
  assert.equal(loadValue.cache.size(), 0);
  assert.equal(await loadValue(), 'ok');
  assert.equal(callCount, 2);
});

void test('memoize expires cached values after ttl', async () => {
  let now = 100;
  let callCount = 0;
  const loadValue = memoize(
    async (key: string) => {
      callCount += 1;
      return `${key}:${callCount}`;
    },
    {
      ttlMs: 50,
      now: () => now,
    },
  );

  assert.equal(await loadValue('system'), 'system:1');
  now = 149;
  assert.equal(await loadValue('system'), 'system:1');
  now = 151;
  assert.equal(await loadValue('system'), 'system:2');
});
