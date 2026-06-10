import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAllowlistedProcessEnv,
  runBoundedProcessCommand,
} from './process-command.js';

void test('buildAllowlistedProcessEnv keeps PATH and only named env keys', () => {
  assert.deepEqual(
    buildAllowlistedProcessEnv(['DOCKER_HOST', 'DOCKER_CONFIG'], {
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

void test('runBoundedProcessCommand executes argv without shell interpolation', async () => {
  const result = await runBoundedProcessCommand({
    executable: process.execPath,
    args: [
      '-e',
      'console.log(process.argv.slice(1).join("|"))',
      'a b',
      'semi;colon',
    ],
    timeoutMs: 1000,
    env: { PATH: process.env.PATH ?? '' },
    maxOutputBytes: 64 * 1024,
  });

  assert.equal(result.kind, 'exit');
  assert.equal(result.kind === 'exit' ? result.exitCode : -1, 0);
  assert.match(result.stdout, /a b\|semi;colon/u);
});

void test('runBoundedProcessCommand caps stdout and stderr capture', async () => {
  const result = await runBoundedProcessCommand({
    executable: process.execPath,
    args: [
      '-e',
      'process.stdout.write("o".repeat(80 * 1024)); process.stderr.write("e".repeat(80 * 1024));',
    ],
    timeoutMs: 1000,
    env: { PATH: process.env.PATH ?? '' },
    maxOutputBytes: 64 * 1024,
  });

  assert.equal(result.kind, 'exit');
  assert.equal(Buffer.byteLength(result.stdout, 'utf8') <= 66 * 1024, true);
  assert.equal(Buffer.byteLength(result.stderr, 'utf8') <= 66 * 1024, true);
  assert.match(result.stdout, /\[truncated\]/u);
  assert.match(result.stderr, /\[truncated\]/u);
});

void test('runBoundedProcessCommand waits for timeout termination before returning', async () => {
  const result = await runBoundedProcessCommand({
    executable: process.execPath,
    args: [
      '-e',
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
    ],
    timeoutMs: 20,
    env: { PATH: process.env.PATH ?? '' },
    maxOutputBytes: 64 * 1024,
  });

  assert.equal(result.kind, 'timeout');
});

void test('runBoundedProcessCommand rechecks abort after registering the listener', async () => {
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

  const result = await runBoundedProcessCommand({
    executable: process.execPath,
    args: [
      '-e',
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
    ],
    timeoutMs: 50,
    env: { PATH: process.env.PATH ?? '' },
    maxOutputBytes: 64 * 1024,
    signal,
    cancelledStderr: 'docker command cancelled',
  });

  assert.equal(result.kind, 'cancelled');
});

void test('runBoundedProcessCommand uses cancellation stderr for pre-aborted signals', async () => {
  const controller = new AbortController();
  controller.abort();

  const result = await runBoundedProcessCommand({
    executable: process.execPath,
    args: ['-e', 'process.exit(0)'],
    timeoutMs: 50,
    env: { PATH: process.env.PATH ?? '' },
    maxOutputBytes: 64 * 1024,
    signal: controller.signal,
    cancelledStderr: 'docker command cancelled',
  });

  assert.equal(result.kind, 'cancelled');
  assert.equal(result.stderr, 'docker command cancelled');
});
