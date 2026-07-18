import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createKeyedSerialRunner } from '../utils/keyed-serial.js';
import { testThreadId } from '../../test-support/thread-id.js';
import { createThreadIndexStore, loadThreadIndex } from './threads-index.js';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

void test('loadThreadIndex skips invalid entries and preserves valid entry order', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-thread-index-'));
  await mkdir(join(workspaceRoot, '.geulbat', 'sessions'), { recursive: true });
  const validThreadId = testThreadId(2);
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  await writeFile(
    join(workspaceRoot, '.geulbat', 'sessions', 'index.json'),
    JSON.stringify([
      { threadId: testThreadId(1) },
      { threadId: 'not-a-thread-id' },
      {
        threadId: validThreadId,
        title: 'kept',
        lastUpdated: '2026-04-04T00:00:00.000Z',
        messageCount: 2,
      },
      {
        threadId: testThreadId(3),
        projectId: 'missing-project',
        title: 'skip me',
        lastUpdated: '2026-04-04T00:00:01.000Z',
        messageCount: 1,
      },
    ]) + '\n',
    'utf8',
  );

  try {
    const entries = await loadThreadIndex(workspaceRoot);
    assert.deepEqual(entries, [
      {
        threadId: validThreadId,
        title: 'kept',
        lastUpdated: '2026-04-04T00:00:00.000Z',
        messageCount: 2,
      },
    ]);
    assert.equal(warnings.length, 1);
    const warningLine = String(warnings[0]?.[0] ?? '');
    assert.match(warningLine, /Skipped 3 malformed thread index entries/);
    assert.match(
      warningLine,
      /skippedEntryDiagnostics="0:invalid_last_updated,1:invalid_thread_id,3:legacy_project_id"/,
    );
    assert.doesNotMatch(warningLine, /not-a-thread-id|missing-project/u);
  } finally {
    console.warn = originalWarn;
  }
});

void test('loadThreadIndex reports every skipped entry diagnostic without a hidden cap', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-thread-index-'));
  await mkdir(join(workspaceRoot, '.geulbat', 'sessions'), { recursive: true });
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  const malformedEntries = Array.from({ length: 25 }, (_, index) => ({
    threadId: `not-a-thread-id-${index}`,
    title: 'skip me',
    lastUpdated: '2026-04-04T00:00:00.000Z',
    messageCount: 1,
  }));
  await writeFile(
    join(workspaceRoot, '.geulbat', 'sessions', 'index.json'),
    JSON.stringify(malformedEntries) + '\n',
    'utf8',
  );

  try {
    const entries = await loadThreadIndex(workspaceRoot);
    assert.deepEqual(entries, []);
    assert.equal(warnings.length, 1);
    const warningLine = String(warnings[0]?.[0] ?? '');
    assert.match(warningLine, /Skipped 25 malformed thread index entries/);
    assert.match(warningLine, /0:invalid_thread_id/);
    assert.match(warningLine, /24:invalid_thread_id/);
    assert.doesNotMatch(warningLine, /,\+\d+/u);
    assert.doesNotMatch(warningLine, /not-a-thread-id/u);
  } finally {
    console.warn = originalWarn;
  }
});

void test('upsertThreadSummary serializes concurrent mutations for the same workspace', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-thread-index-'));
  const releaseFirstMutation = createDeferred<void>();
  let mutationEntries = 0;
  const realRunner = createKeyedSerialRunner();
  const store = createThreadIndexStore({
    runMutationSerial: async (key, run) =>
      realRunner(key, async () => {
        mutationEntries += 1;
        if (mutationEntries === 1) {
          await releaseFirstMutation.promise;
        }
        return run();
      }),
  });

  const firstUpsert = store.upsertThreadSummary(workspaceRoot, {
    threadId: testThreadId(10),
    title: 'first',
    lastUpdated: '2026-04-14T00:00:00.000Z',
    messageCount: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const secondUpsert = store.upsertThreadSummary(workspaceRoot, {
    threadId: testThreadId(11),
    title: 'second',
    lastUpdated: '2026-04-14T00:00:01.000Z',
    messageCount: 2,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(mutationEntries, 1);
  releaseFirstMutation.resolve();

  await Promise.all([firstUpsert, secondUpsert]);

  const entries = await store.loadThreadIndex(workspaceRoot);
  assert.deepEqual(entries, [
    {
      threadId: testThreadId(10),
      title: 'first',
      lastUpdated: '2026-04-14T00:00:00.000Z',
      messageCount: 1,
    },
    {
      threadId: testThreadId(11),
      title: 'second',
      lastUpdated: '2026-04-14T00:00:01.000Z',
      messageCount: 2,
    },
  ]);
});
