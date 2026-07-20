import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildAllowlistedChildProcessEnv,
  runBoundedChildProcess,
} from './bounded-child-process.js';

void test('buildAllowlistedChildProcessEnv keeps PATH and only named env keys', () => {
  assert.deepEqual(
    buildAllowlistedChildProcessEnv(['DOCKER_HOST', 'DOCKER_CONFIG'], {
      PATH: '/bin',
      DOCKER_HOST: 'unix:///tmp/docker.sock',
      DOCKER_CONFIG: '/tmp/docker-config',
      PROVIDER_SECRET: 'do-not-copy',
    }),
    {
      PATH: '/bin',
      DOCKER_HOST: 'unix:///tmp/docker.sock',
      DOCKER_CONFIG: '/tmp/docker-config',
    },
  );
});

void test('runBoundedChildProcess executes argv without shell interpolation', async () => {
  const result = await runBoundedChildProcess({
    executable: process.execPath,
    args: [
      '-e',
      'console.log(process.argv.slice(1).join("|"))',
      'a b',
      'semi;colon',
    ],
    timeoutMs: 1000,
    env: { PATH: process.env.PATH ?? '' },
  });

  assert.equal(result.kind, 'exit');
  assert.equal(result.kind === 'exit' ? result.exitCode : -1, 0);
  assert.match(result.stdout, /a b\|semi;colon/u);
});

void test('runBoundedChildProcess runs without a timeout when timeoutMs is omitted', async () => {
  const result = await runBoundedChildProcess({
    executable: process.execPath,
    args: ['-e', 'process.stdout.write("done")'],
    env: { PATH: process.env.PATH ?? '' },
  });

  assert.equal(result.kind, 'exit');
  assert.equal(result.kind === 'exit' ? result.exitCode : -1, 0);
  assert.equal(result.stdout, 'done');
});

void test('runBoundedChildProcess executes in the requested cwd', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'geulbat-process-cwd-'));
  const result = await runBoundedChildProcess({
    executable: process.execPath,
    args: ['-e', 'process.stdout.write(process.cwd())'],
    cwd,
    timeoutMs: 1000,
    env: { PATH: process.env.PATH ?? '' },
  });

  assert.equal(result.kind, 'exit');
  assert.equal(result.kind === 'exit' ? result.exitCode : -1, 0);
  assert.equal(await realpath(result.stdout), await realpath(cwd));
});

void test('runBoundedChildProcess preserves large stdout and stderr', async () => {
  const result = await runBoundedChildProcess({
    executable: process.execPath,
    args: [
      '-e',
      'process.stdout.write("o".repeat(80 * 1024)); process.stderr.write("e".repeat(80 * 1024));',
    ],
    timeoutMs: 1000,
    env: { PATH: process.env.PATH ?? '' },
  });

  assert.equal(result.kind, 'exit');
  assert.equal(Buffer.byteLength(result.stdout, 'utf8'), 80 * 1024);
  assert.equal(Buffer.byteLength(result.stderr, 'utf8'), 80 * 1024);
  assert.doesNotMatch(result.stdout, /\[truncated\]/u);
  assert.doesNotMatch(result.stderr, /\[truncated\]/u);
});

void test('runBoundedChildProcess fails closed when buffered stdout exceeds policy', async () => {
  const result = await runBoundedChildProcess({
    executable: process.execPath,
    args: [
      '-e',
      'process.stdout.write("x".repeat(8192)); setInterval(() => {}, 1000);',
    ],
    timeoutMs: 1000,
    env: { PATH: process.env.PATH ?? '' },
    outputBufferPolicy: { maxBufferedBytesPerStream: 1024 },
  });

  assert.equal(result.kind, 'output_limit_exceeded');
  assert.equal(
    result.kind === 'output_limit_exceeded' ? result.stream : '',
    'stdout',
  );
  assert.equal(
    result.kind === 'output_limit_exceeded'
      ? result.maxBufferedBytesPerStream
      : 0,
    1024,
  );
  assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= 1024);
});

void test('runBoundedChildProcess waits for timeout termination before returning', async () => {
  const result = await runBoundedChildProcess({
    executable: process.execPath,
    args: [
      '-e',
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
    ],
    timeoutMs: 20,
    env: { PATH: process.env.PATH ?? '' },
  });

  assert.equal(result.kind, 'timeout');
});

void test('runBoundedChildProcess rechecks abort after registering the listener', async () => {
  const controller = new AbortController();
  const originalAddEventListener = controller.signal.addEventListener.bind(
    controller.signal,
  );
  const signal = controller.signal as AbortSignal & {
    addEventListener: AbortSignal['addEventListener'];
  };
  signal.addEventListener = (type, listener, options): void => {
    if (type === 'abort') {
      controller.abort();
    }
    originalAddEventListener(type, listener, options);
  };

  const result = await runBoundedChildProcess({
    executable: process.execPath,
    args: [
      '-e',
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
    ],
    timeoutMs: 50,
    env: { PATH: process.env.PATH ?? '' },
    signal,
    cancelledStderr: 'child process cancelled',
  });

  assert.equal(result.kind, 'cancelled');
});

void test('runBoundedChildProcess uses caller cancellation stderr for pre-aborted signals', async () => {
  const controller = new AbortController();
  controller.abort();

  const result = await runBoundedChildProcess({
    executable: process.execPath,
    args: ['-e', 'process.exit(0)'],
    timeoutMs: 50,
    env: { PATH: process.env.PATH ?? '' },
    signal: controller.signal,
    cancelledStderr: 'child process cancelled',
  });

  assert.equal(result.kind, 'cancelled');
  assert.equal(result.stderr, 'child process cancelled');
});
