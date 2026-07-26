import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { withActivityScope } from './activity-scope.js';
import {
  registerProcessFatalLogging,
  type DaemonFatalRecord,
} from './process-fatal-logging.js';

type Listener = (...listenerArgs: never[]) => void;

class FakeProcess {
  readonly listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }

  emit(event: string, ...emitted: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...values: unknown[]) => void)(...emitted);
    }
  }
}

interface Harness {
  target: FakeProcess;
  exits: number[];
  logs: Array<[string, unknown]>;
  recordPath: string;
}

function makeHarness(options: { recordPath?: string } = {}): Harness {
  const target = new FakeProcess();
  const exits: number[] = [];
  const logs: Array<[string, unknown]> = [];
  const recordPath = options.recordPath ?? join(tmpdir(), 'unused-fatal.jsonl');
  registerProcessFatalLogging({
    process: target,
    logger: {
      error: (message: string, meta?: unknown) => {
        logs.push([message, meta]);
      },
    },
    recordPath: () => recordPath,
    now: () => new Date('2026-07-25T00:00:00.000Z'),
    pid: () => 4242,
    exit: (code) => {
      exits.push(code);
    },
  });
  return { target, exits, logs, recordPath };
}

async function readRecords(path: string): Promise<DaemonFatalRecord[]> {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as DaemonFatalRecord);
}

void test('registration observes fatal events and never swallows them', () => {
  const harness = makeHarness();

  // 관찰용 monitor는 그대로 남는다(사람이 읽는 한 줄), 그리고 두 치명적
  // 사건을 직접 소유한다 — 소유해야 소유자를 기록하고 죽을 수 있다.
  assert.deepEqual(
    [...harness.target.listeners.keys()],
    ['uncaughtExceptionMonitor', 'uncaughtException', 'unhandledRejection'],
  );

  harness.target.emit(
    'uncaughtExceptionMonitor',
    new Error('boom'),
    'uncaughtException',
  );
  assert.deepEqual(harness.logs[0], [
    'uncaught exception:',
    { message: 'boom', origin: 'uncaughtException' },
  ]);
  assert.deepEqual(harness.exits, [], 'observing alone does not end anything');

  harness.target.emit(
    'uncaughtException',
    new Error('boom'),
    'uncaughtException',
  );
  assert.deepEqual(
    harness.exits,
    [1],
    'the exception is recorded and then still kills the process',
  );
});

void test('an uncaught exception inside a tool names that tool as the owner', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'geulbat-fatal-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const harness = makeHarness({ recordPath: join(dir, 'daemon-fatal.jsonl') });

  withActivityScope({ runId: 'run-1', threadId: 'thread-1' }, () => {
    withActivityScope(
      { toolName: 'ptc_execute_code', callId: 'call-9' },
      () => {
        harness.target.emit(
          'uncaughtException',
          new Error('cell runtime exploded'),
          'uncaughtException',
        );
      },
    );
  });

  const [record] = await readRecords(harness.recordPath);
  assert.equal(record?.kind, 'uncaught_exception');
  assert.equal(record?.message, 'cell runtime exploded');
  assert.deepEqual(record?.owner, {
    runId: 'run-1',
    threadId: 'thread-1',
    toolName: 'ptc_execute_code',
    callId: 'call-9',
  });
  assert.ok(record?.stack?.includes('cell runtime exploded'));
  assert.deepEqual(harness.exits, [1], 'fail-closed: the process still dies');
});

void test('a death with no activity in scope is the daemon own reason', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'geulbat-fatal-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const harness = makeHarness({ recordPath: join(dir, 'daemon-fatal.jsonl') });

  harness.target.emit('unhandledRejection', new Error('invariant broke'));

  const [record] = await readRecords(harness.recordPath);
  assert.equal(record?.kind, 'unhandled_rejection');
  assert.equal(record?.owner, null);
  assert.deepEqual(harness.exits, [1]);
});

void test('a record that cannot be written does not keep the process alive', () => {
  // 존재할 수 없는 경로 — 기록은 실패하지만 종료는 계약이다.
  const harness = makeHarness({
    recordPath: '/proc/self/mem/nope/fatal.jsonl',
  });

  harness.target.emit(
    'uncaughtException',
    new Error('boom'),
    'uncaughtException',
  );

  assert.deepEqual(harness.exits, [1]);
  assert.ok(
    harness.logs.some(([message]) =>
      message.includes('fatal record could not be written'),
    ),
    'the write failure is reported, not hidden',
  );
});

void test('a real process records its owner before it dies', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'geulbat-fatal-e2e-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const recordPath = join(dir, 'daemon-fatal.jsonl');
  const moduleDir = fileURLToPath(new URL('.', import.meta.url));
  const script = `
    const { registerProcessFatalLogging } = await import(${JSON.stringify(join(moduleDir, 'process-fatal-logging.js'))});
    const { withActivityScope } = await import(${JSON.stringify(join(moduleDir, 'activity-scope.js'))});
    registerProcessFatalLogging({ recordPath: () => ${JSON.stringify(recordPath)} });
    withActivityScope({ runId: 'run-e2e', threadId: 'thread-e2e' }, () => {
      withActivityScope({ toolName: 'write_file' }, () => {
        setTimeout(() => { throw new Error('detached work exploded'); }, 1);
      });
    });
  `;
  const exitCode = await new Promise<number>((resolve) => {
    execFile(
      process.execPath,
      ['--input-type=module', '-e', script],
      (error) => {
        resolve((error as { code?: number } | null)?.code ?? 0);
      },
    );
  });

  assert.equal(exitCode, 1, 'the daemon still fails closed');
  const [record] = await readRecords(recordPath);
  assert.equal(record?.message, 'detached work exploded');
  assert.deepEqual(record?.owner, {
    runId: 'run-e2e',
    threadId: 'thread-e2e',
    toolName: 'write_file',
  });
  assert.ok((record?.pid ?? 0) > 0);
});
