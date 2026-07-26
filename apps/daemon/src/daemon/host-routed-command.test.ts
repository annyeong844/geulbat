import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { HostCommandRuntime } from '../command-host/contract.js';
import { createCommandSessionHost } from '../command-host/session-core.js';
import { runHostRoutedSystemCommand } from './host-routed-command.js';

const OUTPUT = 'abcdefghijklmnopqrstuvwxyz012345';

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
