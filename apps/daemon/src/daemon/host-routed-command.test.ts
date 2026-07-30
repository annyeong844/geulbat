import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { HostCommandRuntime } from '../command-host/contract.js';
import { createCommandSessionHost } from '../command-host/session-core.js';
import {
  runHostRoutedSystemCommand,
  runHostRoutedSystemCommandBytes,
} from './host-routed-command.js';

const OUTPUT = 'abcdefghijklmnopqrstuvwxyz012345';
const RAW_STDOUT = Buffer.from([0x00, 0xff, 0xc3, 0x28, 0x41, 0x00]);
const RAW_STDERR = Buffer.from([0xfe, 0x80, 0x00, 0x42]);

interface Fixture {
  host: ReturnType<typeof createCommandSessionHost>;
  stateRoot: string;
}

async function makeFixture(t: {
  after(fn: () => Promise<void> | void): void;
}): Promise<Fixture> {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-host-routed-command-'),
  );
  const host = createCommandSessionHost({
    inlineMaxBytes: 8,
    tailRingBytes: 1024,
  });
  t.after(async () => {
    await host.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
  });
  return { host, stateRoot };
}

function failPageRead(
  host: HostCommandRuntime,
  pageReadToFail: number,
): HostCommandRuntime {
  let pageReads = 0;
  return {
    start: host.start,
    waitForInitialResult: host.waitForInitialResult,
    async interact(args) {
      if (args.page !== undefined) {
        pageReads += 1;
        if (pageReads === pageReadToFail) {
          return {
            ok: false,
            reasonCode: 'output_store_failed',
            message: 'injected output page read failure',
          };
        }
      }
      return await host.interact(args);
    },
    listThreadSessions: host.listThreadSessions,
    closeAll: host.closeAll,
  };
}

function omitRawPage(host: HostCommandRuntime): HostCommandRuntime {
  return {
    start: host.start,
    waitForInitialResult: host.waitForInitialResult,
    async interact(args) {
      const observed = await host.interact(args);
      if (
        observed.ok &&
        args.page?.encoding === 'base64' &&
        observed.value.page !== null
      ) {
        return {
          ok: true,
          value: {
            snapshot: observed.value.snapshot,
            page: null,
          },
        };
      }
      return observed;
    },
    listThreadSessions: host.listThreadSessions,
    closeAll: host.closeAll,
  };
}

async function runFixture(fixture: Fixture, hostCommands: HostCommandRuntime) {
  return await runHostRoutedSystemCommand({
    hostCommands,
    stateRoot: fixture.stateRoot,
    pageLimitBytes: 8,
    invocation: {
      executable: process.execPath,
      args: ['-e', `process.stdout.write(${JSON.stringify(OUTPUT)});`],
      cwd: fixture.stateRoot,
      env: process.env,
    },
  });
}

void test('output recovery fails when the first page cannot be read', async (t) => {
  const fixture = await makeFixture(t);
  const result = await runFixture(fixture, failPageRead(fixture.host, 1));

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.message, 'injected output page read failure');
  }
});

void test('output recovery never turns a later page failure into partial success', async (t) => {
  const fixture = await makeFixture(t);
  const result = await runFixture(fixture, failPageRead(fixture.host, 2));

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.message, 'injected output page read failure');
  }
});

void test('output recovery joins every persisted page byte-exactly', async (t) => {
  const fixture = await makeFixture(t);
  const result = await runFixture(fixture, fixture.host);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.stdout, OUTPUT);
    assert.equal(result.stderr, '');
  }
});

void test('raw output recovery preserves stdout and stderr bytes across pages', async (t) => {
  const fixture = await makeFixture(t);
  const result = await runHostRoutedSystemCommandBytes({
    hostCommands: fixture.host,
    stateRoot: fixture.stateRoot,
    pageLimitBytes: 8,
    invocation: {
      executable: process.execPath,
      args: [
        '-e',
        [
          `process.stdout.write(Buffer.from(${JSON.stringify([...RAW_STDOUT])}));`,
          `process.stderr.write(Buffer.from(${JSON.stringify([...RAW_STDERR])}));`,
        ].join(''),
      ],
      cwd: fixture.stateRoot,
      env: process.env,
      maxOutputBytesPerStream: 1024,
    },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.stdout, RAW_STDOUT);
    assert.deepEqual(result.stderr, RAW_STDERR);
  }
});

void test('raw command input reaches stdin without UTF-8 coercion', async (t) => {
  const fixture = await makeFixture(t);
  const expected = Buffer.from([0x00, 0xff, 0xc3, 0x28, 0x41, 0x00]);
  const result = await runHostRoutedSystemCommandBytes({
    hostCommands: fixture.host,
    stateRoot: fixture.stateRoot,
    pageLimitBytes: 8,
    invocation: {
      executable: process.execPath,
      args: ['-e', 'process.stdin.pipe(process.stdout);'],
      cwd: fixture.stateRoot,
      env: process.env,
      initialStdin: expected,
      maxOutputBytesPerStream: 1024,
    },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.stdout, expected);
    assert.deepEqual(result.stderr, Buffer.alloc(0));
  }
});

void test('raw output recovery preserves a small non-UTF-8 result', async (t) => {
  const fixture = await makeFixture(t);
  const expected = Buffer.from([0xff, 0x00]);
  const result = await runHostRoutedSystemCommandBytes({
    hostCommands: fixture.host,
    stateRoot: fixture.stateRoot,
    pageLimitBytes: 8,
    invocation: {
      executable: process.execPath,
      args: [
        '-e',
        `process.stdout.write(Buffer.from(${JSON.stringify([...expected])}));`,
      ],
      cwd: fixture.stateRoot,
      env: process.env,
      maxOutputBytesPerStream: 1024,
    },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.stdout, expected);
    assert.deepEqual(result.stderr, Buffer.alloc(0));
  }
});

void test('raw output recovery fails closed when an available page is omitted', async (t) => {
  const fixture = await makeFixture(t);
  const result = await runHostRoutedSystemCommandBytes({
    hostCommands: omitRawPage(fixture.host),
    stateRoot: fixture.stateRoot,
    pageLimitBytes: 8,
    invocation: {
      executable: process.execPath,
      args: ['-e', 'process.stdout.write(Buffer.from([255, 0]));'],
      cwd: fixture.stateRoot,
      env: process.env,
      maxOutputBytesPerStream: 1024,
    },
  });

  assert.deepEqual(result, {
    ok: false,
    aborted: false,
    message: 'host command stdout raw output page was invalid.',
  });
});
