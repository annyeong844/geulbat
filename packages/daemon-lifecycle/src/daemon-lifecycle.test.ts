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

import { createDaemonLifecycleClient } from './client.js';
import { notifyDaemonLifecycleReady } from './daemon-child.js';
import {
  DAEMON_LIFECYCLE_START_COMMAND_TYPE,
  parseDaemonLifecycleCommand,
  type DaemonLifecycleEvent,
  type DaemonShutdownSignal,
} from './protocol.js';

const FIXTURE_CHILD_ARGUMENT = '--daemon-lifecycle-test-child';
const FIXTURE_LOG_ENV = 'GEULBAT_TEST_DAEMON_LIFECYCLE_LOG';
const FIXTURE_FAIL_ENV = 'GEULBAT_TEST_DAEMON_LIFECYCLE_FAIL';

if (
  process.argv.includes(FIXTURE_CHILD_ARGUMENT) &&
  process.env[FIXTURE_LOG_ENV] !== undefined
) {
  await runDaemonFixture(process.env[FIXTURE_LOG_ENV]);
} else {
  void test(
    'independent lifecycle worker restarts a dead ready generation and forwards explicit shutdown',
    { timeout: 30_000 },
    async (t) => {
      const fixtureRoot = await mkdtemp(
        join(tmpdir(), 'geulbat-daemon-lifecycle-'),
      );
      const logPath = join(fixtureRoot, 'generations.log');
      await writeFile(logPath, '', 'utf8');
      const events: DaemonLifecycleEvent[] = [];
      const lifecycle = createDaemonLifecycleClient({
        arguments: [FIXTURE_CHILD_ARGUMENT],
        env: { ...process.env, [FIXTURE_LOG_ENV]: logPath },
        execArgv: process.execArgv.filter(
          (argument) => !argument.startsWith('--test'),
        ),
        onEvent: (event) => {
          events.push(event);
        },
      });
      const runPromise = lifecycle.run();
      void runPromise.catch(() => undefined);

      try {
        const [firstLine] = await waitForLogLines(logPath, 1, t.signal);
        const firstPid = parseStartedPid(firstLine);
        process.kill(firstPid, 'SIGKILL');

        const linesAfterRestart = await waitForLogLines(logPath, 2, t.signal);
        const secondPid = parseStartedPid(linesAfterRestart[1]);
        assert.notEqual(secondPid, firstPid);

        lifecycle.shutdown('SIGTERM');
        await runPromise;
        const finalLines = await readLogLines(logPath);
        assert.ok(finalLines.includes(`stopped:${String(secondPid)}:SIGTERM`));
        assert.deepEqual(
          events.map(({ generation, state }) => ({ generation, state })),
          [
            { generation: 1, state: 'starting' },
            { generation: 1, state: 'ready' },
            { generation: 1, state: 'exited' },
            { generation: 1, state: 'restarting' },
            { generation: 2, state: 'starting' },
            { generation: 2, state: 'ready' },
            { generation: 2, state: 'exited' },
            { generation: 2, state: 'stopped' },
          ],
        );
        const unexpectedExit = events.find(
          (event) => event.generation === 1 && event.state === 'exited',
        );
        assert.equal(unexpectedExit?.expected, false);
        assert.equal(unexpectedExit?.signal, 'SIGKILL');
      } finally {
        lifecycle.shutdown('SIGTERM');
        await runPromise.catch(() => undefined);
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  void test(
    'independent lifecycle worker fails closed when a generation exits before readiness',
    { timeout: 30_000 },
    async () => {
      const fixtureRoot = await mkdtemp(
        join(tmpdir(), 'geulbat-daemon-lifecycle-failure-'),
      );
      const logPath = join(fixtureRoot, 'generations.log');
      await writeFile(logPath, '', 'utf8');
      const events: DaemonLifecycleEvent[] = [];
      const lifecycle = createDaemonLifecycleClient({
        entrypoint: fileURLToPath(import.meta.url),
        arguments: [FIXTURE_CHILD_ARGUMENT],
        env: {
          ...process.env,
          [FIXTURE_LOG_ENV]: logPath,
          [FIXTURE_FAIL_ENV]: '1',
        },
        execArgv: process.execArgv.filter(
          (argument) => !argument.startsWith('--test'),
        ),
        onEvent: (event) => {
          events.push(event);
        },
      });

      try {
        await assert.rejects(
          lifecycle.run(),
          /daemon exited before listen readiness/u,
        );
        const lines = await readLogLines(logPath);
        assert.deepEqual(lines, [`failed:${String(parseFailedPid(lines[0]))}`]);
        assert.deepEqual(
          events.map(({ generation, state }) => ({ generation, state })),
          [
            { generation: 1, state: 'starting' },
            { generation: 1, state: 'exited' },
            { generation: 1, state: 'failed' },
            { generation: 1, state: 'stopped' },
          ],
        );
      } finally {
        lifecycle.shutdown('SIGTERM');
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  void test(
    'lifecycle client orders immediate shutdown after its start command',
    { timeout: 30_000 },
    async () => {
      const fixtureRoot = await mkdtemp(
        join(tmpdir(), 'geulbat-daemon-lifecycle-immediate-stop-'),
      );
      const logPath = join(fixtureRoot, 'generations.log');
      await writeFile(logPath, '', 'utf8');
      const events: DaemonLifecycleEvent[] = [];
      const lifecycle = createDaemonLifecycleClient({
        entrypoint: fileURLToPath(import.meta.url),
        arguments: [FIXTURE_CHILD_ARGUMENT],
        env: { ...process.env, [FIXTURE_LOG_ENV]: logPath },
        execArgv: process.execArgv.filter(
          (argument) => !argument.startsWith('--test'),
        ),
        onEvent: (event) => {
          events.push(event);
        },
      });

      try {
        const runPromise = lifecycle.run();
        lifecycle.shutdown('SIGTERM');
        await runPromise;
        assert.equal(
          events.some((event) => event.state === 'failed'),
          false,
        );
        assert.equal(events.at(-1)?.state, 'stopped');
      } finally {
        lifecycle.shutdown('SIGTERM');
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  void test('lifecycle protocol rejects malformed start commands', () => {
    assert.equal(
      parseDaemonLifecycleCommand({
        type: DAEMON_LIFECYCLE_START_COMMAND_TYPE,
        lifecycleRunId: '',
        entrypoint: fileURLToPath(import.meta.url),
        arguments: [FIXTURE_CHILD_ARGUMENT],
        execArgv: [],
      }),
      undefined,
    );
  });
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
  await notifyDaemonLifecycleReady();
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
    throw new Error('daemon lifecycle fixture watch ended before readiness');
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

function parseFailedPid(line: string | undefined): number {
  assert.match(line ?? '', /^failed:\d+$/u);
  const pid = Number(line?.slice('failed:'.length));
  assert.equal(Number.isSafeInteger(pid), true);
  return pid;
}
