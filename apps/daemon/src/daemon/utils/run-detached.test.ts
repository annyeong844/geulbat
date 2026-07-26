import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import test from 'node:test';

import { withActivityScope } from './activity-scope.js';
import { runDetached } from './run-detached.js';

function captureLogger(): {
  logger: { error: (message: string, meta?: unknown) => void };
  entries: Array<[string, Record<string, unknown> | undefined]>;
} {
  const entries: Array<[string, Record<string, unknown> | undefined]> = [];
  return {
    logger: {
      error: (message, meta) => {
        entries.push([message, meta as Record<string, unknown> | undefined]);
      },
    },
    entries,
  };
}

void test('a rejected detached work is reported, not raised to the process', async () => {
  const { logger, entries } = captureLogger();

  runDetached('mcp/server-restart', () => Promise.reject(new Error('boom')), {
    logger,
  });
  await tick();

  assert.equal(entries.length, 1);
  const [message, meta] = entries[0] ?? [];
  assert.equal(message, 'detached work failed:');
  assert.equal(meta?.['label'], 'mcp/server-restart');
  assert.equal(meta?.['message'], 'boom');
});

void test('a synchronous throw before the promise exists is the same failure', async () => {
  const { logger, entries } = captureLogger();

  runDetached(
    'ptc/cell-close',
    () => {
      throw new Error('never started');
    },
    { logger },
  );
  await tick();

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.[1]?.['message'], 'never started');
});

void test('the failure carries the run and tool that owned it', async () => {
  const { logger, entries } = captureLogger();

  withActivityScope({ runId: 'run-7', threadId: 'thread-7' }, () => {
    withActivityScope({ toolName: 'ptc_execute_code' }, () => {
      runDetached('ptc/standby-refill', () => Promise.reject(new Error('x')), {
        logger,
      });
    });
  });
  await tick();

  assert.deepEqual(entries[0]?.[1]?.['owner'], {
    runId: 'run-7',
    threadId: 'thread-7',
    toolName: 'ptc_execute_code',
  });
});

void test('a failure with no activity in scope belongs to the daemon', async () => {
  const { logger, entries } = captureLogger();

  runDetached('daemon/startup-probe', () => Promise.reject(new Error('x')), {
    logger,
  });
  await tick();

  assert.equal(entries[0]?.[1]?.['owner'], 'daemon');
});

void test('work that settles cleanly reports nothing', async () => {
  const { logger, entries } = captureLogger();

  runDetached('files/browse-discovery', async () => 'done', { logger });
  await tick();

  assert.deepEqual(entries, []);
});

void test('a chain that already handles its own rejection is not reported twice', async () => {
  const { logger, entries } = captureLogger();
  const handled: string[] = [];

  runDetached(
    'auth/token-refresh',
    () =>
      Promise.reject(new Error('expired')).then(undefined, (error: unknown) => {
        handled.push((error as Error).message);
      }),
    { logger },
  );
  await tick();

  assert.deepEqual(handled, ['expired']);
  assert.deepEqual(entries, [], 'the owner already answered for it');
});
