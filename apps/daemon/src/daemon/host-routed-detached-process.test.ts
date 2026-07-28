import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { HostCommandRuntime } from '../command-host/contract.js';
import { createCommandSessionHost } from '../command-host/session-core.js';
import { createDaemonHostCommandRuntime } from '../command-host/runtime-selection.js';
import { removeCommandHostWorkspace } from '../test-support/command-host-workspace.js';
import {
  SYSTEM_SESSION_OWNER,
  type HostCommandOutputPage,
  type HostCommandSnapshot,
} from './host-command-output-store.js';
import {
  createHostRoutedDetachedProcessAttacher,
  createHostRoutedDetachedProcessStarter,
} from './host-routed-detached-process.js';

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

void test('host-routed detached process rechecks stdout when stderr observes a newer terminal revision', async () => {
  const outputRef = 'revision-race-output';
  const snapshot = (
    status: HostCommandSnapshot['status'],
    revision: number,
    stdoutBytes: number,
  ): HostCommandSnapshot => ({
    outputRef,
    status,
    exitCode: status === 'running' ? null : 0,
    stdout: null,
    stderr: null,
    outputComplete: false,
    stdoutBytes,
    stderrBytes: 0,
    stdoutChars: stdoutBytes,
    stderrChars: 0,
    durationMs: 1,
    firstOutputAfterMs: stdoutBytes === 0 ? null : 1,
    revision,
    stdinOpen: false,
    outputLimitExceeded: null,
    stdoutOmittedBytes: 0,
    stderrOmittedBytes: 0,
  });
  const running = snapshot('running', 0, 0);
  const terminal = snapshot('exit', 1, Buffer.byteLength('worker-owned'));
  let stdoutReads = 0;
  const hostCommands: HostCommandRuntime = {
    async start() {
      return { ok: true, outputRef };
    },
    async waitForInitialResult() {
      return { ok: true, value: running };
    },
    async interact(args) {
      if (args.page?.stream === 'stdout') {
        stdoutReads += 1;
        return {
          ok: true,
          value: {
            snapshot: stdoutReads === 1 ? running : terminal,
            page:
              stdoutReads === 1
                ? null
                : {
                    stream: 'stdout',
                    offsetBytes: 0,
                    endOffsetBytes: Buffer.byteLength('worker-owned'),
                    totalBytes: Buffer.byteLength('worker-owned'),
                    limitBytes: 1024,
                    hasMore: false,
                    nextOffsetBytes: null,
                    content: 'worker-owned',
                  },
          },
        };
      }
      return {
        ok: true,
        value: {
          snapshot: terminal,
          page: null,
        },
      };
    },
    async listThreadSessions() {
      return [];
    },
    async closeAll() {
      return { ok: true };
    },
  };
  const startDetachedProcess = createHostRoutedDetachedProcessStarter({
    hostCommands,
    stateRoot: '/workspace',
    pageLimitBytes: 1024,
    cwd: '/workspace',
    env: {},
    runId: 'revision-race',
  });

  const started = await startDetachedProcess({
    callId: 'revision-race',
    executable: process.execPath,
    args: [],
  });
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }

  assert.deepEqual(await started.handle.exit, {
    kind: 'exit',
    exitCode: 0,
    processTerminated: true,
  });
  assert.equal(stdoutReads, 2);
  assert.equal(started.handle.drainNewOutput().stdout, 'worker-owned');
});

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

void test('host-routed detached process re-adopts from the retained output base without replaying released bytes', async (t) => {
  const fixture = await makeFixture(t);
  const started = await fixture.host.start({
    executable: process.execPath,
    args: [
      '-e',
      [
        "process.stdin.setEncoding('utf8');",
        "process.stdout.write('before\\n');",
        "process.stdin.once('data', () => {",
        "  process.stdout.write('after\\n');",
        '  process.exit(0);',
        '});',
      ].join(''),
    ],
    cwd: fixture.stateRoot,
    env: process.env,
    stateRoot: fixture.stateRoot,
    threadId: SYSTEM_SESSION_OWNER,
    owner: 'system',
    streamMode: 'lossless',
    requiresDeferredOutputRelease: true,
    runId: 'detached-process-readoption-test',
    callId: 'detached_process_readoption_test',
    stdinMode: 'open',
  });
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }

  let firstPage: HostCommandOutputPage | null | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const observed = await fixture.host.interact({
      stateRoot: fixture.stateRoot,
      threadId: SYSTEM_SESSION_OWNER,
      owner: 'system',
      outputRef: started.outputRef,
      yieldTimeMs: 10,
      page: {
        stream: 'stdout',
        offsetBytes: 0,
        limitBytes: fixture.pageLimitBytes,
        deferRelease: true,
      },
    });
    assert.equal(observed.ok, true);
    if (!observed.ok) {
      return;
    }
    firstPage = observed.value.page;
    if (firstPage?.content === 'before\n') {
      break;
    }
  }
  assert.equal(firstPage?.content, 'before\n');
  const releasedOffset = firstPage?.endOffsetBytes;
  assert.equal(typeof releasedOffset, 'number');
  if (releasedOffset === undefined) {
    return;
  }
  const released = await fixture.host.interact({
    stateRoot: fixture.stateRoot,
    threadId: SYSTEM_SESSION_OWNER,
    owner: 'system',
    outputRef: started.outputRef,
    yieldTimeMs: 0,
    page: {
      stream: 'stdout',
      offsetBytes: releasedOffset,
      limitBytes: fixture.pageLimitBytes,
      deferRelease: true,
      releaseUpToBytes: releasedOffset,
    },
  });
  assert.equal(released.ok, true);
  if (!released.ok) {
    return;
  }
  assert.equal(released.value.snapshot.stdoutOmittedBytes, releasedOffset);

  const attach = createHostRoutedDetachedProcessAttacher({
    hostCommands: fixture.host,
    stateRoot: fixture.stateRoot,
    pageLimitBytes: fixture.pageLimitBytes,
  });
  const stale = await attach({
    outputRef: started.outputRef,
    outputReadOffsets: { stdoutBytes: 0, stderrBytes: 0 },
  });
  assert.equal(stale.ok, true);
  if (!stale.ok) {
    return;
  }
  const staleExit = await stale.handle.exit;
  assert.equal(staleExit.kind, 'spawn_failed');
  assert.match(
    staleExit.kind === 'spawn_failed' ? staleExit.message : '',
    /output gap: requested 0, received 7/u,
  );

  const adopted = await attach({
    outputRef: started.outputRef,
    outputReadOffsets: {
      stdoutBytes: releasedOffset,
      stderrBytes: 0,
    },
  });
  assert.equal(adopted.ok, true);
  if (!adopted.ok) {
    return;
  }
  assert.equal(adopted.handle.outputRef, started.outputRef);
  assert.deepEqual(await adopted.handle.writeInput('continue\n'), { ok: true });
  assert.equal((await adopted.handle.exit).kind, 'exit');
  assert.deepEqual(adopted.handle.drainNewOutput(), {
    stdout: 'after\n',
    stderr: '',
  });
});

void test('a fresh attachment adopts the retained output base from the first page', async (t) => {
  const fixture = await makeFixture(t);
  const started = await fixture.host.start({
    executable: process.execPath,
    args: [
      '-e',
      [
        "process.stdin.setEncoding('utf8');",
        "process.stdout.write('released\\n');",
        "process.stdin.once('data', () => {",
        "  process.stdout.write('continued\\n');",
        '  process.exit(0);',
        '});',
      ].join(''),
    ],
    cwd: fixture.stateRoot,
    env: process.env,
    stateRoot: fixture.stateRoot,
    threadId: SYSTEM_SESSION_OWNER,
    owner: 'system',
    streamMode: 'lossless',
    requiresDeferredOutputRelease: true,
    runId: 'detached-process-fresh-attach-test',
    callId: 'detached_process_fresh_attach_test',
    stdinMode: 'open',
  });
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }

  let releasedOffset: number | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const observed = await fixture.host.interact({
      stateRoot: fixture.stateRoot,
      threadId: SYSTEM_SESSION_OWNER,
      owner: 'system',
      outputRef: started.outputRef,
      yieldTimeMs: 10,
      page: {
        stream: 'stdout',
        offsetBytes: 0,
        limitBytes: fixture.pageLimitBytes,
        deferRelease: true,
      },
    });
    assert.equal(observed.ok, true);
    if (!observed.ok) {
      return;
    }
    if (observed.value.page?.content === 'released\n') {
      releasedOffset = observed.value.page.endOffsetBytes;
      break;
    }
  }
  assert.equal(typeof releasedOffset, 'number');
  if (releasedOffset === undefined) {
    return;
  }
  const released = await fixture.host.interact({
    stateRoot: fixture.stateRoot,
    threadId: SYSTEM_SESSION_OWNER,
    owner: 'system',
    outputRef: started.outputRef,
    yieldTimeMs: 0,
    page: {
      stream: 'stdout',
      offsetBytes: releasedOffset,
      limitBytes: fixture.pageLimitBytes,
      deferRelease: true,
      releaseUpToBytes: releasedOffset,
    },
  });
  assert.equal(released.ok, true);

  const attach = createHostRoutedDetachedProcessAttacher({
    hostCommands: fixture.host,
    stateRoot: fixture.stateRoot,
    pageLimitBytes: fixture.pageLimitBytes,
  });
  const adopted = await attach({ outputRef: started.outputRef });
  assert.equal(adopted.ok, true);
  if (!adopted.ok) {
    return;
  }
  assert.deepEqual(await adopted.handle.writeInput('continue\n'), { ok: true });
  assert.equal((await adopted.handle.exit).kind, 'exit');
  assert.deepEqual(adopted.handle.drainNewOutput(), {
    stdout: 'continued\n',
    stderr: '',
  });
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
  let stdout = '';
  let stderr = '';
  let revision = started.handle.getOutputRevision();
  let exitKind: string | undefined;
  while (exitKind === undefined) {
    const output = started.handle.drainNewOutput();
    stdout += output.stdout;
    stderr += output.stderr;
    const observed = await Promise.race([
      started.handle.exit.then((exit) => ({
        kind: 'exit' as const,
        exit,
      })),
      started.handle.waitForOutputChange(revision).then((nextRevision) => ({
        kind: 'output' as const,
        nextRevision,
      })),
    ]);
    if (observed.kind === 'exit') {
      exitKind = observed.exit.kind;
    } else {
      revision = observed.nextRevision;
    }
  }
  const finalOutput = started.handle.drainNewOutput();
  stdout += finalOutput.stdout;
  stderr += finalOutput.stderr;

  assert.equal(exitKind, 'exit');
  assert.equal(stdout, `${'o'.repeat(80 * 1024)}${replacement}`);
  assert.equal(stderr, `${'e'.repeat(80 * 1024)}${replacement}`);
  assert.equal(stdout.includes(marker), false);
  assert.equal(stderr.includes(marker), false);
  assert.doesNotMatch(stdout, /\[truncated\]/u);
  assert.doesNotMatch(stderr, /\[truncated\]/u);
});

void test('host-routed output is released only after the detached consumer drains it', async (t) => {
  const fixture = await makeFixture(t);
  const started = await start(fixture, {
    executable: process.execPath,
    args: [
      '-e',
      'process.stdout.write("abcdef"); setInterval(() => undefined, 1_000);',
    ],
  });

  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  const initialRevision = started.handle.getOutputRevision();
  if (initialRevision === 0) {
    await started.handle.waitForOutputChange(initialRevision);
  }
  const session = fixture.host
    .listSessions()
    .find((candidate) => candidate.running);
  assert.notEqual(session, undefined);
  if (session === undefined) {
    return;
  }

  const retained = await fixture.host.interact({
    stateRoot: fixture.stateRoot,
    threadId: SYSTEM_SESSION_OWNER,
    owner: 'system',
    outputRef: session.outputRef,
    yieldTimeMs: 0,
    page: {
      stream: 'stdout',
      offsetBytes: 0,
      limitBytes: 6,
      deferRelease: true,
    },
  });
  assert.equal(retained.ok, true);
  if (!retained.ok) {
    return;
  }
  assert.equal(retained.value.page?.content, 'abcdef');
  assert.equal(retained.value.page?.earliestAvailableOffset, 0);

  assert.equal(started.handle.drainNewOutput().stdout, 'abcdef');
  let earliestAvailableOffset = 0;
  for (
    let attempt = 0;
    attempt < 100 && earliestAvailableOffset < 6;
    attempt += 1
  ) {
    const observed = await fixture.host.interact({
      stateRoot: fixture.stateRoot,
      threadId: SYSTEM_SESSION_OWNER,
      owner: 'system',
      outputRef: session.outputRef,
      yieldTimeMs: 10,
      page: {
        stream: 'stdout',
        offsetBytes: 0,
        limitBytes: 6,
        deferRelease: true,
      },
    });
    assert.equal(observed.ok, true);
    if (!observed.ok) {
      return;
    }
    earliestAvailableOffset = observed.value.page?.earliestAvailableOffset ?? 0;
  }
  assert.equal(earliestAvailableOffset, 6);

  started.handle.terminate({ graceMs: 10 });
  assert.equal((await started.handle.exit).kind, 'signal');
});

void test('host-routed prepared output remains retained until the durable consumer commits it', async (t) => {
  const fixture = await makeFixture(t);
  const started = await start(fixture, {
    executable: process.execPath,
    args: [
      '-e',
      'process.stdout.write("abcdef"); setInterval(() => undefined, 1_000);',
    ],
  });

  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  const initialRevision = started.handle.getOutputRevision();
  if (initialRevision === 0) {
    await started.handle.waitForOutputChange(initialRevision);
  }

  const prepared = started.handle.prepareOutputDelivery();
  assert.deepEqual(prepared, {
    output: { stdout: 'abcdef', stderr: '' },
    offsets: { stdoutBytes: 6, stderrBytes: 0 },
  });
  assert.deepEqual(started.handle.prepareOutputDelivery(), prepared);

  const beforeCommit = await fixture.host.interact({
    stateRoot: fixture.stateRoot,
    threadId: SYSTEM_SESSION_OWNER,
    owner: 'system',
    outputRef: started.handle.outputRef,
    yieldTimeMs: 0,
    page: {
      stream: 'stdout',
      offsetBytes: 0,
      limitBytes: 6,
      deferRelease: true,
    },
  });
  assert.equal(beforeCommit.ok, true);
  if (!beforeCommit.ok) {
    return;
  }
  assert.equal(beforeCommit.value.page?.content, 'abcdef');
  assert.equal(beforeCommit.value.page?.earliestAvailableOffset, 0);

  started.handle.commitPreparedOutputDelivery();
  let earliestAvailableOffset = 0;
  for (
    let attempt = 0;
    attempt < 100 && earliestAvailableOffset < 6;
    attempt += 1
  ) {
    const observed = await fixture.host.interact({
      stateRoot: fixture.stateRoot,
      threadId: SYSTEM_SESSION_OWNER,
      owner: 'system',
      outputRef: started.handle.outputRef,
      yieldTimeMs: 10,
      page: {
        stream: 'stdout',
        offsetBytes: 0,
        limitBytes: 6,
        deferRelease: true,
      },
    });
    assert.equal(observed.ok, true);
    if (!observed.ok) {
      return;
    }
    earliestAvailableOffset = observed.value.page?.earliestAvailableOffset ?? 0;
  }
  assert.equal(earliestAvailableOffset, 6);

  started.handle.terminate({ graceMs: 10 });
  assert.equal((await started.handle.exit).kind, 'signal');
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
