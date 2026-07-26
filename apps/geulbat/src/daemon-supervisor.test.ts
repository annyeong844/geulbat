import assert from 'node:assert/strict';
import {
  appendFile,
  mkdtemp,
  readFile,
  rm,
  watch,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  createDaemonSupervisor,
  GEULBAT_DAEMON_CHILD_ARGUMENT,
  notifyDaemonSupervisorReady,
  type DaemonShutdownSignal,
} from './daemon-supervisor.js';

const FIXTURE_LOG_ENV = 'GEULBAT_TEST_DAEMON_SUPERVISOR_LOG';
const FIXTURE_FAIL_ENV = 'GEULBAT_TEST_DAEMON_SUPERVISOR_FAIL';

if (
  process.argv.includes(GEULBAT_DAEMON_CHILD_ARGUMENT) &&
  process.env[FIXTURE_LOG_ENV] !== undefined
) {
  await runDaemonFixture(process.env[FIXTURE_LOG_ENV]);
} else {
  void test(
    'product daemon supervisor restarts an unexpectedly dead ready generation and forwards intentional shutdown',
    { timeout: 30_000 },
    async (t) => {
      const fixtureRoot = await mkdtemp(
        join(tmpdir(), 'geulbat-daemon-supervisor-'),
      );
      const logPath = join(fixtureRoot, 'generations.log');
      await writeFile(logPath, '', 'utf8');
      const unexpectedExits: Array<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }> = [];
      const supervisor = createDaemonSupervisor({
        entrypoint: fileURLToPath(import.meta.url),
        env: { ...process.env, [FIXTURE_LOG_ENV]: logPath },
        execArgv: process.execArgv.filter(
          (argument) => !argument.startsWith('--test'),
        ),
        onUnexpectedExit: (observation) => {
          unexpectedExits.push(observation);
        },
      });
      const runPromise = supervisor.run();
      void runPromise.catch(() => undefined);

      try {
        const [firstLine] = await waitForLogLines(logPath, 1, t.signal);
        const firstPid = parseStartedPid(firstLine);
        process.kill(firstPid, 'SIGKILL');

        const linesAfterRestart = await waitForLogLines(logPath, 2, t.signal);
        const secondPid = parseStartedPid(linesAfterRestart[1]);
        assert.notEqual(secondPid, firstPid);
        assert.deepEqual(unexpectedExits, [{ code: null, signal: 'SIGKILL' }]);

        supervisor.shutdown('SIGTERM');
        await runPromise;
        const finalLines = await readLogLines(logPath);
        assert.ok(finalLines.includes(`stopped:${String(secondPid)}:SIGTERM`));
      } finally {
        supervisor.shutdown('SIGTERM');
        await runPromise.catch(() => undefined);
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  void test(
    'product daemon supervisor does not restart a generation that never reached listen readiness',
    { timeout: 30_000 },
    async () => {
      const fixtureRoot = await mkdtemp(
        join(tmpdir(), 'geulbat-daemon-startup-failure-'),
      );
      const logPath = join(fixtureRoot, 'generations.log');
      await writeFile(logPath, '', 'utf8');
      const supervisor = createDaemonSupervisor({
        entrypoint: fileURLToPath(import.meta.url),
        env: {
          ...process.env,
          [FIXTURE_LOG_ENV]: logPath,
          [FIXTURE_FAIL_ENV]: '1',
        },
        execArgv: process.execArgv.filter(
          (argument) => !argument.startsWith('--test'),
        ),
      });

      try {
        await assert.rejects(
          supervisor.run(),
          /daemon exited before listen readiness/u,
        );
        const lines = await readLogLines(logPath);
        assert.equal(lines.length, 1);
        assert.match(lines[0] ?? '', /^failed:\d+$/u);
      } finally {
        supervisor.shutdown('SIGTERM');
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    },
  );
}

async function runDaemonFixture(logPath: string): Promise<void> {
  if (process.env[FIXTURE_FAIL_ENV] === '1') {
    await appendFile(logPath, `failed:${String(process.pid)}\n`, 'utf8');
    process.exitCode = 23;
    return;
  }
  process.channel?.ref();
  const shutdownSignal = new Promise<DaemonShutdownSignal>((resolve) => {
    process.once('SIGINT', () => resolve('SIGINT'));
    process.once('SIGTERM', () => resolve('SIGTERM'));
  });
  await notifyDaemonSupervisorReady();
  await appendFile(logPath, `started:${String(process.pid)}\n`, 'utf8');
  const signal = await shutdownSignal;
  await appendFile(
    logPath,
    `stopped:${String(process.pid)}:${signal}\n`,
    'utf8',
  );
  if (process.connected) {
    process.disconnect();
  }
}

async function waitForLogLines(
  logPath: string,
  count: number,
  signal: AbortSignal,
): Promise<string[]> {
  const watcher = watch(logPath, { signal });
  try {
    let lines = await readLogLines(logPath);
    if (lines.length >= count) {
      return lines;
    }
    for await (const _event of watcher) {
      lines = await readLogLines(logPath);
      if (lines.length >= count) {
        return lines;
      }
    }
    throw new Error('daemon supervisor fixture watch ended before readiness');
  } finally {
    await watcher.return?.();
  }
}

async function readLogLines(logPath: string): Promise<string[]> {
  return (await readFile(logPath, 'utf8'))
    .split('\n')
    .filter((line) => line.length > 0);
}

function parseStartedPid(line: string | undefined): number {
  assert.match(line ?? '', /^started:\d+$/u);
  const pid = Number(line?.slice('started:'.length));
  assert.equal(Number.isSafeInteger(pid), true);
  return pid;
}
