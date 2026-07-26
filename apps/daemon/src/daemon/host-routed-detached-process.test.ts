import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createCommandSessionHost } from '../command-host/session-core.js';
import { createDaemonHostCommandRuntime } from '../command-host/runtime-selection.js';
import { removeCommandHostWorkspace } from '../test-support/command-host-workspace.js';
import { createHostRoutedDetachedProcessStarter } from './host-routed-detached-process.js';

interface Fixture {
  host: ReturnType<typeof createCommandSessionHost>;
  stateRoot: string;
  pageLimitBytes: number;
}

interface TestDetachedProcessInvocation {
  executable: string;
  args: string[];
  timeoutMs?: number;
  redactionMarkers?: readonly string[];
  redactionReplacement?: string;
  outputBufferPolicy?: { maxBufferedBytesPerStream: number };
}

async function makeFixture(t: {
  after(fn: () => Promise<void> | void): void;
}): Promise<Fixture> {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-host-routed-detached-process-'),
  );
  const pageLimitBytes = 1024;
  const host = createCommandSessionHost({
    inlineMaxBytes: pageLimitBytes,
    tailRingBytes: 4096,
  });
  t.after(async () => {
    await host.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
  });
  return { host, stateRoot, pageLimitBytes };
}

async function start(
  fixture: Fixture,
  invocation: TestDetachedProcessInvocation,
) {
  const startDetachedProcess = createHostRoutedDetachedProcessStarter({
    hostCommands: fixture.host,
    stateRoot: fixture.stateRoot,
    pageLimitBytes: fixture.pageLimitBytes,
    cwd: fixture.stateRoot,
    env: process.env,
    runId: 'detached-process-test',
  });
  return await startDetachedProcess({
    callId: 'detached_process_test',
    ...invocation,
  });
}

void test('host-routed detached process drains incremental output until terminal exit', async (t) => {
  const fixture = await makeFixture(t);
  const started = await start(fixture, {
    executable: process.execPath,
    args: [
      '-e',
      [
        'process.stdout.write("first\\n");',
        'setTimeout(() => process.stderr.write("second\\n"), 30);',
        'setTimeout(() => process.exit(0), 70);',
      ].join(''),
    ],
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

  const exit = await started.handle.exit;
  assert.deepEqual(exit, {
    kind: 'exit',
    exitCode: 0,
    processTerminated: true,
  });
  const second = started.handle.drainNewOutput();
  assert.equal(first.stdout + second.stdout, 'first\n');
  assert.equal(first.stderr + second.stderr, 'second\n');
});

void test('host-routed detached process exposes an event-driven output change wait', async (t) => {
  const fixture = await makeFixture(t);
  const started = await start(fixture, {
    executable: process.execPath,
    args: [
      '-e',
      [
        'setTimeout(() => process.stdout.write("later\\n"), 30);',
        'setTimeout(() => process.exit(0), 70);',
      ].join(''),
    ],
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
  assert.equal(started.handle.drainNewOutput().stdout, 'later\n');
  assert.equal((await started.handle.exit).kind, 'exit');
});

void test('lossless host routing preserves large redacted stdout and stderr', async (t) => {
  const fixture = await makeFixture(t);
  const marker = 'private-marker-after-large-output';
  const replacement = '[redacted:ptc-callback]';
  const started = await start(fixture, {
    executable: process.execPath,
    args: [
      '-e',
      [
        `const marker = ${JSON.stringify(marker)};`,
        'process.stdout.write("o".repeat(80 * 1024));',
        'process.stderr.write("e".repeat(80 * 1024));',
        'setTimeout(() => {',
        '  process.stdout.write(marker.slice(0, 13));',
        '  process.stderr.write(marker.slice(0, 13));',
        '}, 20);',
        'setTimeout(() => {',
        '  process.stdout.write(marker.slice(13));',
        '  process.stderr.write(marker.slice(13));',
        '}, 40);',
        'setTimeout(() => process.exit(0), 70);',
      ].join(''),
    ],
    redactionMarkers: [marker],
    redactionReplacement: replacement,
  });

  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  assert.equal((await started.handle.exit).kind, 'exit');
  const output = started.handle.drainNewOutput();
  assert.equal(output.stdout, `${'o'.repeat(80 * 1024)}${replacement}`);
  assert.equal(output.stderr, `${'e'.repeat(80 * 1024)}${replacement}`);
  assert.equal(output.stdout.includes(marker), false);
  assert.equal(output.stderr.includes(marker), false);
  assert.doesNotMatch(output.stdout, /\[truncated\]/u);
  assert.doesNotMatch(output.stderr, /\[truncated\]/u);
});

void test('host-routed detached process terminates when undrained output exceeds policy', async (t) => {
  const fixture = await makeFixture(t);
  const started = await start(fixture, {
    executable: process.execPath,
    args: [
      '-e',
      'process.stdout.write("x".repeat(8192)); setInterval(() => {}, 1000);',
    ],
    outputBufferPolicy: { maxBufferedBytesPerStream: 1024 },
  });

  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  assert.deepEqual(await started.handle.exit, {
    kind: 'output_limit_exceeded',
    exitCode: null,
    processTerminated: false,
    stream: 'stdout',
    maxBufferedBytesPerStream: 1024,
  });
  assert.ok(
    Buffer.byteLength(started.handle.drainNewOutput().stdout, 'utf8') <= 1024,
  );
});

void test('host-routed detached process preserves caller timeout semantics', async (t) => {
  const fixture = await makeFixture(t);
  const started = await start(fixture, {
    executable: process.execPath,
    args: [
      '-e',
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
    ],
    timeoutMs: 30,
  });

  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  assert.deepEqual(await started.handle.exit, {
    kind: 'timeout',
    exitCode: null,
    processTerminated: false,
  });
});

void test('host-routed detached process never surfaces a marker split across child writes', async (t) => {
  const fixture = await makeFixture(t);
  const marker = 'ptc-private-bridge-token';
  const replacement = '[redacted:ptc-callback]';
  const started = await start(fixture, {
    executable: process.execPath,
    args: [
      '-e',
      [
        `const marker = ${JSON.stringify(marker)};`,
        'process.stdout.write(`visible-${marker.slice(0, 11)}`);',
        'setTimeout(() => process.stdout.write(marker.slice(11)), 40);',
        'setTimeout(() => process.exit(0), 80);',
      ].join(''),
    ],
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

  assert.equal((await started.handle.exit).kind, 'exit');
  const aggregate = first.stdout + started.handle.drainNewOutput().stdout;
  assert.equal(aggregate, `visible-${replacement}`);
  assert.doesNotMatch(aggregate, new RegExp(marker, 'u'));
});

void test('host-routed detached process terminate latches signal exit semantics', async (t) => {
  const fixture = await makeFixture(t);
  const started = await start(fixture, {
    executable: process.execPath,
    args: [
      '-e',
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
    ],
  });

  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  started.handle.terminate({ graceMs: 10 });
  assert.deepEqual(await started.handle.exit, {
    kind: 'signal',
    exitCode: null,
    processTerminated: false,
  });
});

void test('detached process runs through the real command-host worker placement', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-host-detached-worker-'),
  );
  const sourceEntry = fileURLToPath(
    new URL('../command-host/main.ts', import.meta.url),
  );
  const builtEntry = fileURLToPath(
    new URL('../command-host/main.js', import.meta.url),
  );
  const workerCommand = existsSync(sourceEntry)
    ? {
        execPath: process.execPath,
        args: ['--import', 'tsx', sourceEntry],
      }
    : { execPath: process.execPath, args: [builtEntry] };
  const runtime = createDaemonHostCommandRuntime({
    config: { inlineMaxBytes: 1024, tailRingBytes: 4096 },
    requestedMode: 'worker',
    workerCommand,
  });
  t.after(async () => {
    await runtime.closeAll();
    await removeCommandHostWorkspace(stateRoot);
  });
  const startDetachedProcess = createHostRoutedDetachedProcessStarter({
    hostCommands: runtime,
    stateRoot,
    pageLimitBytes: 1024,
    cwd: stateRoot,
    env: process.env,
    runId: 'detached-worker-placement',
  });

  const started = await startDetachedProcess({
    callId: 'detached-worker-call',
    executable: process.execPath,
    args: ['-e', 'process.stdout.write("worker-owned")'],
  });
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  assert.equal((await runtime.describeState(stateRoot)).mode, 'worker');
  assert.deepEqual(await started.handle.exit, {
    kind: 'exit',
    exitCode: 0,
    processTerminated: true,
  });
  assert.equal(started.handle.drainNewOutput().stdout, 'worker-owned');
});
