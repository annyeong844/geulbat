import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createCommandSessionHost } from '../command-host/session-core.js';
import { readGitRevision } from './extensions/plugin-marketplace-git.js';
import { runSystemCommand } from './system-command.js';

// P7.6 item 3 — 데몬 자신이 부르는 명령(git 등)이 데몬의 자식이 아니라
// command-host 세션에서 돈다. 실제 git으로 잰다: 대역으로는 "자식을 누가
// 소유하는가"가 바뀌었는지 알 수 없다.

interface Fixture {
  host: ReturnType<typeof createCommandSessionHost>;
  stateRoot: string;
}

async function makeFixture(
  t: {
    after(fn: () => Promise<void> | void): void;
  },
  config: {
    inlineMaxBytes?: number;
    tailRingBytes?: number;
    maxYieldTimeMs?: number;
  } = {},
): Promise<Fixture> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-system-command-'));
  const host = createCommandSessionHost({
    inlineMaxBytes: config.inlineMaxBytes ?? 64 * 1024,
    tailRingBytes: config.tailRingBytes ?? 64 * 1024,
    ...(config.maxYieldTimeMs === undefined
      ? {}
      : { maxYieldTimeMs: config.maxYieldTimeMs }),
  });
  t.after(async () => {
    await host.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
  });
  return { host, stateRoot };
}

function runner(fixture: Fixture) {
  return async (commandArgs: {
    executable: string;
    args: readonly string[];
    env: NodeJS.ProcessEnv;
  }) => {
    const result = await runSystemCommand({
      hostCommands: fixture.host,
      stateRoot: fixture.stateRoot,
      executable: commandArgs.executable,
      args: commandArgs.args,
      env: commandArgs.env,
      maxOutputBytes: 64 * 1024,
    });
    return { exitCode: result.exitCode, stdout: result.stdout };
  };
}

void test('P7.6: a system command returns its exit code and output', async (t) => {
  const fixture = await makeFixture(t);
  const result = await runSystemCommand({
    hostCommands: fixture.host,
    stateRoot: fixture.stateRoot,
    executable: process.execPath,
    args: ['-e', 'process.stdout.write("from the session"); process.exit(3);'],
    env: { PATH: process.env['PATH'] ?? '' },
    maxOutputBytes: 64 * 1024,
  });
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, 'from the session');
  assert.equal(result.status, 'exit');
});

void test('P7.6: a system command rejoins after the per-request wait ceiling', async (t) => {
  const fixture = await makeFixture(t, { maxYieldTimeMs: 20 });
  const result = await runSystemCommand({
    hostCommands: fixture.host,
    stateRoot: fixture.stateRoot,
    executable: process.execPath,
    args: [
      '-e',
      'setTimeout(() => process.stdout.write("after-ceiling"), 80);',
    ],
    env: { PATH: process.env['PATH'] ?? '' },
    maxOutputBytes: 64 * 1024,
  });

  assert.equal(result.status, 'exit');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'after-ceiling');
});

void test('P7.6: a system command never enters a thread enumeration', async (t) => {
  const fixture = await makeFixture(t);
  await runSystemCommand({
    hostCommands: fixture.host,
    stateRoot: fixture.stateRoot,
    executable: process.execPath,
    args: ['-e', 'process.stdout.write("quiet");'],
    env: { PATH: process.env['PATH'] ?? '' },
    maxOutputBytes: 64 * 1024,
  });
  const listed = await fixture.host.listThreadSessions({
    stateRoot: fixture.stateRoot,
    threadId: '00000000-0000-4000-8000-000000000001',
  });
  assert.deepEqual(listed, []);
});

void test('P7.6: a system command reports output page recovery failure', async (t) => {
  const fixture = await makeFixture(t, {
    inlineMaxBytes: 64,
    tailRingBytes: 1024,
  });
  const hostCommands: typeof fixture.host = {
    ...fixture.host,
    async interact(args) {
      if (args.page !== undefined) {
        return {
          ok: false,
          reasonCode: 'output_store_failed',
          message: 'injected output page read failure',
        };
      }
      return await fixture.host.interact(args);
    },
  };

  await assert.rejects(
    runSystemCommand({
      hostCommands,
      stateRoot: fixture.stateRoot,
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("x".repeat(128));'],
      env: process.env,
      maxOutputBytes: 64,
    }),
    /injected output page read failure/u,
  );
});

void test('P7.6: a system command never returns a truncated output as success', async (t) => {
  const fixture = await makeFixture(t, {
    inlineMaxBytes: 64,
    tailRingBytes: 1024,
  });

  await assert.rejects(
    runSystemCommand({
      hostCommands: fixture.host,
      stateRoot: fixture.stateRoot,
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("y".repeat(128));'],
      env: process.env,
      maxOutputBytes: 64,
    }),
    /exceeds the configured recovery limit/u,
  );
});

void test('P7.6: marketplace git reads a revision through the session', async (t) => {
  const fixture = await makeFixture(t);
  const repositoryRoot = join(fixture.stateRoot, 'repo');
  const runCommand = runner(fixture);

  // 실제 저장소를 만든다 — 세션을 통해 도는 git이 진짜 git이어야 의미가 있다.
  for (const args of [
    ['init', '--quiet', repositoryRoot],
    ['-C', repositoryRoot, 'config', 'user.email', 'probe@example.com'],
    ['-C', repositoryRoot, 'config', 'user.name', 'Probe'],
    ['-C', repositoryRoot, 'commit', '--allow-empty', '-m', 'first', '--quiet'],
  ]) {
    const outcome = await runCommand({
      executable: 'git',
      args,
      env: { PATH: process.env['PATH'] ?? '', HOME: fixture.stateRoot },
    });
    assert.equal(outcome.exitCode, 0, `git ${args[0]} should succeed`);
  }

  const revision = await readGitRevision(
    repositoryRoot,
    'probe-marketplace',
    runCommand,
  );
  assert.match(revision, /^git:[a-f0-9]{40,64}$/u);
});
