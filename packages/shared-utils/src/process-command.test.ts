import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  buildAllowlistedProcessEnv,
  buildDockerClientProcessEnv,
  runBoundedProcessCommand,
  runDockerClientCommand,
  startBoundedProcessCommand,
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

void test('buildDockerClientProcessEnv keeps only Docker client env keys', () => {
  assert.deepEqual(
    buildDockerClientProcessEnv({
      PATH: '/bin',
      DOCKER_API_VERSION: '1.45',
      DOCKER_HOST: 'unix:///tmp/docker.sock',
      DOCKER_CONTEXT: 'remote-context',
      DOCKER_BUILDKIT: '1',
      NPM_TOKEN: 'do-not-copy',
      SSH_AUTH_SOCK: '/tmp/ssh.sock',
    }),
    {
      PATH: '/bin',
      DOCKER_API_VERSION: '1.45',
      DOCKER_HOST: 'unix:///tmp/docker.sock',
      DOCKER_CONTEXT: 'remote-context',
      DOCKER_BUILDKIT: '1',
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
  });

  assert.equal(result.kind, 'exit');
  assert.equal(result.kind === 'exit' ? result.exitCode : -1, 0);
  assert.match(result.stdout, /a b\|semi;colon/u);
});

void test('runBoundedProcessCommand runs without a timeout when timeoutMs is omitted', async () => {
  const result = await runBoundedProcessCommand({
    executable: process.execPath,
    args: ['-e', 'process.stdout.write("done")'],
    env: { PATH: process.env.PATH ?? '' },
  });

  assert.equal(result.kind, 'exit');
  assert.equal(result.kind === 'exit' ? result.exitCode : -1, 0);
  assert.equal(result.stdout, 'done');
});

void test('runBoundedProcessCommand preserves large stdout and stderr', async () => {
  const result = await runBoundedProcessCommand({
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

void test('runBoundedProcessCommand fails closed when buffered stdout exceeds policy', async () => {
  const result = await runBoundedProcessCommand({
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

void test('runBoundedProcessCommand waits for timeout termination before returning', async () => {
  const result = await runBoundedProcessCommand({
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
    signal,
    cancelledStderr: 'docker command cancelled',
  });

  assert.equal(result.kind, 'cancelled');
});

void test('runDockerClientCommand uses Docker cancellation stderr for pre-aborted signals', async () => {
  const controller = new AbortController();
  controller.abort();

  const result = await runDockerClientCommand({
    executable: process.execPath,
    args: ['-e', 'process.exit(0)'],
    timeoutMs: 50,
    signal: controller.signal,
  });

  assert.equal(result.kind, 'cancelled');
  assert.equal(result.stderr, 'docker command cancelled');
});

void test('runBoundedProcessCommand uses cancellation stderr for pre-aborted signals', async () => {
  const controller = new AbortController();
  controller.abort();

  const result = await runBoundedProcessCommand({
    executable: process.execPath,
    args: ['-e', 'process.exit(0)'],
    timeoutMs: 50,
    env: { PATH: process.env.PATH ?? '' },
    signal: controller.signal,
    cancelledStderr: 'docker command cancelled',
  });

  assert.equal(result.kind, 'cancelled');
  assert.equal(result.stderr, 'docker command cancelled');
});

void test('startBoundedProcessCommand drains incremental output until terminal exit', async () => {
  const started = startBoundedProcessCommand({
    executable: process.execPath,
    args: [
      '-e',
      [
        'process.stdout.write("first\\n");',
        'setTimeout(() => process.stderr.write("second\\n"), 20);',
        'setTimeout(() => process.exit(0), 40);',
      ].join(''),
    ],
    env: { PATH: process.env.PATH ?? '' },
  });

  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }

  let first = started.handle.drainNewOutput();
  for (
    let attempt = 0;
    attempt < 20 && first.stdout.length === 0;
    attempt += 1
  ) {
    await delay(10);
    first = started.handle.drainNewOutput();
  }
  assert.equal(first.stdout, 'first\n');
  assert.equal(first.stderr, '');

  const exit = await started.handle.exit;
  assert.deepEqual(exit, {
    kind: 'exit',
    exitCode: 0,
    processTerminated: true,
  });
  const second = started.handle.drainNewOutput();
  assert.equal(second.stdout, '');
  assert.equal(second.stderr, 'second\n');
});

void test('startBoundedProcessCommand exposes an output change wait', async () => {
  const started = startBoundedProcessCommand({
    executable: process.execPath,
    args: [
      '-e',
      [
        'setTimeout(() => process.stdout.write("later\\n"), 20);',
        'setTimeout(() => process.exit(0), 40);',
      ].join(''),
    ],
    env: { PATH: process.env.PATH ?? '' },
  });

  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  if (
    started.handle.getOutputRevision === undefined ||
    started.handle.waitForOutputChange === undefined
  ) {
    assert.fail('detached process handle must expose output observation');
  }

  const beforeOutput = started.handle.getOutputRevision();
  const changedRevision =
    await started.handle.waitForOutputChange(beforeOutput);
  assert.ok(changedRevision > beforeOutput);

  const output = started.handle.drainNewOutput();
  assert.equal(output.stdout, 'later\n');
  assert.equal(output.stderr, '');

  const exit = await started.handle.exit;
  assert.equal(exit.kind, 'exit');
});

void test('startBoundedProcessCommand preserves large terminal output', async () => {
  const started = startBoundedProcessCommand({
    executable: process.execPath,
    args: [
      '-e',
      'process.stdout.write("o".repeat(80 * 1024)); process.stderr.write("e".repeat(80 * 1024));',
    ],
    env: { PATH: process.env.PATH ?? '' },
  });

  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }

  const exit = await started.handle.exit;
  assert.equal(exit.kind, 'exit');
  const output = started.handle.drainNewOutput();
  assert.equal(Buffer.byteLength(output.stdout, 'utf8'), 80 * 1024);
  assert.equal(Buffer.byteLength(output.stderr, 'utf8'), 80 * 1024);
  assert.doesNotMatch(output.stdout, /\[truncated\]/u);
  assert.doesNotMatch(output.stderr, /\[truncated\]/u);
});

void test('startBoundedProcessCommand terminates when undrained output exceeds policy', async () => {
  const started = startBoundedProcessCommand({
    executable: process.execPath,
    args: [
      '-e',
      'process.stdout.write("x".repeat(8192)); setInterval(() => {}, 1000);',
    ],
    env: { PATH: process.env.PATH ?? '' },
    outputBufferPolicy: { maxBufferedBytesPerStream: 1024 },
  });

  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }

  const exit = await started.handle.exit;
  assert.deepEqual(exit, {
    kind: 'output_limit_exceeded',
    exitCode: null,
    processTerminated: false,
    stream: 'stdout',
    maxBufferedBytesPerStream: 1024,
  });
  const output = started.handle.drainNewOutput();
  assert.ok(Buffer.byteLength(output.stdout, 'utf8') <= 1024);
});

void test('startBoundedProcessCommand terminates the detached process when timeoutMs expires', async () => {
  const started = startBoundedProcessCommand({
    executable: process.execPath,
    args: [
      '-e',
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
    ],
    env: { PATH: process.env.PATH ?? '' },
    timeoutMs: 20,
  });

  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }

  const exit = await started.handle.exit;
  assert.deepEqual(exit, {
    kind: 'timeout',
    exitCode: null,
    processTerminated: false,
  });
});

void test('startBoundedProcessCommand streams safe output before a split redaction marker completes', async () => {
  const started = startBoundedProcessCommand({
    executable: process.execPath,
    args: [
      '-e',
      [
        'process.stdout.write("visible-before-");',
        'setTimeout(() => process.stdout.write("token\\n"), 200);',
        'setTimeout(() => process.exit(0), 240);',
      ].join(''),
    ],
    env: { PATH: process.env.PATH ?? '' },
    redactionMarkers: ['token'],
    redactionReplacement: '[redacted:ptc-callback]',
  });

  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }

  let first = started.handle.drainNewOutput();
  for (
    let attempt = 0;
    attempt < 20 && first.stdout.length === 0;
    attempt += 1
  ) {
    await delay(10);
    first = started.handle.drainNewOutput();
  }
  assert.ok(first.stdout.length > 0);
  assert.doesNotMatch(first.stdout, /token/u);
  assert.equal(first.stderr, '');

  const exit = await started.handle.exit;
  assert.equal(exit.kind, 'exit');
  const final = started.handle.drainNewOutput();
  assert.equal(
    first.stdout + final.stdout,
    'visible-before-[redacted:ptc-callback]\n',
  );
  assert.equal(final.stderr, '');
});

void test('startBoundedProcessCommand preserves large streamed output across redaction holdback', async () => {
  const repeatCount = 12_000;
  const marker = 'secret-marker';
  const replacement = '[redacted:ptc-callback]';
  const started = startBoundedProcessCommand({
    executable: process.execPath,
    args: [
      '-e',
      [
        `const prefix = "visible-".repeat(${repeatCount});`,
        'process.stdout.write(prefix);',
        `setTimeout(() => process.stdout.write(${JSON.stringify(marker)}), 120);`,
        'setTimeout(() => process.exit(0), 180);',
      ].join(''),
    ],
    env: { PATH: process.env.PATH ?? '' },
    redactionMarkers: [marker],
    redactionReplacement: replacement,
  });

  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }

  let first = started.handle.drainNewOutput();
  for (
    let attempt = 0;
    attempt < 20 && first.stdout.length === 0;
    attempt += 1
  ) {
    await delay(10);
    first = started.handle.drainNewOutput();
  }
  assert.ok(first.stdout.length > 0);
  assert.doesNotMatch(first.stdout, new RegExp(marker, 'u'));

  const exit = await started.handle.exit;
  assert.equal(exit.kind, 'exit');
  const final = started.handle.drainNewOutput();
  const aggregate = first.stdout + final.stdout;
  const expected = 'visible-'.repeat(repeatCount) + replacement;

  assert.equal(aggregate, expected);
  assert.equal(
    Buffer.byteLength(aggregate, 'utf8'),
    Buffer.byteLength(expected, 'utf8'),
  );
  assert.doesNotMatch(aggregate, new RegExp(marker, 'u'));
  assert.doesNotMatch(aggregate, /\[truncated\]/u);
  assert.equal(first.stderr + final.stderr, '');
});

void test('startBoundedProcessCommand terminate latches signal exit semantics', async () => {
  const started = startBoundedProcessCommand({
    executable: process.execPath,
    args: [
      '-e',
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
    ],
    env: { PATH: process.env.PATH ?? '' },
  });

  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }

  started.handle.terminate({ graceMs: 10 });
  const exit = await started.handle.exit;
  assert.deepEqual(exit, {
    kind: 'signal',
    exitCode: null,
    processTerminated: false,
  });
});
