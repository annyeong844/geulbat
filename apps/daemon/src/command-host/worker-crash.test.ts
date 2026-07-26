import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  createDaemonHostCommandRuntime,
  type DaemonHostCommandRuntime,
} from './runtime-selection.js';
import { COMMAND_HOST_STARTUP_GRACE_MS } from './protocol.js';
import { removeCommandHostWorkspace } from '../test-support/command-host-workspace.js';

import {
  isProcessAlive,
  readCommandHostLock,
  resolveCommandHostPaths,
} from './runtime-paths.js';

// P7.5 spec v4 §8.2 — "워커 크래시 (claim 후): 링 유실, 메타 잔존 →
// command_host_interrupted, journal reap". 인프로세스 테스트는 서버와
// 클라이언트가 같은 프로세스라 이 줄을 증명할 수 없다: 워커를 진짜로
// 죽여야 링이 사라지고 소켓이 끊긴다. 여기서만 실제 워커를 spawn하고
// SIGKILL한다.

const THREAD_ID = 'thread-crash';

interface Fixture {
  runtime: DaemonHostCommandRuntime;
  stateRoot: string;
  lockPath: string;
}

async function makeFixture(t: {
  after(fn: () => Promise<void> | void): void;
}): Promise<Fixture> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-crash-'));
  const paths = await resolveCommandHostPaths(stateRoot);
  const runtime = createDaemonHostCommandRuntime({
    config: { inlineMaxBytes: 65536 },
    requestedMode: 'worker',
  });
  t.after(async () => {
    await runtime.closeAll();
    await removeCommandHostWorkspace(stateRoot);
  });
  return { runtime, stateRoot, lockPath: paths.lockPath };
}

async function workerPid(lockPath: string): Promise<number | undefined> {
  const lock = await readCommandHostLock(lockPath);
  return lock === 'missing' || lock === 'unparsable' ? undefined : lock.pid;
}

async function killWorker(
  lockPath: string,
  signal: 'SIGKILL' | 'SIGTERM',
): Promise<number | undefined> {
  const pid = await workerPid(lockPath);
  if (pid === undefined) {
    return undefined;
  }
  try {
    process.kill(pid, signal);
  } catch {
    return undefined;
  }
  for (let attempt = 0; attempt < 50 && isProcessAlive(pid); attempt += 1) {
    await delay(20);
  }
  return pid;
}

/** 워커가 낳은 첫 자식 pid — 고아 reap 관측용. 못 찾으면 undefined. */
function firstChildPid(parentPid: number): number | undefined {
  try {
    const raw = execFileSync(
      'ps',
      ['-o', 'pid=', '--ppid', String(parentPid)],
      {
        encoding: 'utf8',
      },
    );
    const first = raw.trim().split('\n')[0]?.trim();
    return first === undefined || first.length === 0
      ? undefined
      : Number(first);
  } catch {
    return undefined;
  }
}

function startArgs(
  fixture: Fixture,
  code: string,
): Parameters<DaemonHostCommandRuntime['start']>[0] {
  return {
    executable: '/bin/sh',
    args: ['-c', code],
    cwd: fixture.stateRoot,
    env: process.env,
    stateRoot: fixture.stateRoot,
    threadId: THREAD_ID,
    runId: 'run-crash',
    callId: 'call-crash',
    stdinMode: 'closed',
  };
}

void test('an in-flight wait resolves when the worker dies instead of hanging', async (t) => {
  const fixture = await makeFixture(t);
  const started = await fixture.runtime.start(
    startArgs(fixture, 'echo up; sleep 300'),
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  // yieldTimeMs 없이 기다린다 = 자식이 끝날 때까지 매달리는 long-poll.
  // 워커가 죽으면 이 약속은 반드시 값으로 끝나야 한다.
  const pending = fixture.runtime.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
  });
  await delay(200);
  await killWorker(fixture.lockPath, 'SIGKILL');

  const settled = await Promise.race([
    pending,
    delay(5_000).then(() => 'hung' as const),
  ]);
  assert.notEqual(settled, 'hung', 'a dead worker must not strand the caller');
});

void test('§8.2: after its worker dies the daemon reads the session from disk', async (t) => {
  const fixture = await makeFixture(t);
  const started = await fixture.runtime.start(
    startArgs(fixture, 'echo up; sleep 300'),
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  // claim해 두면 메타가 디스크에 남는다 — 링만 워커와 함께 사라진다.
  const claimed = await fixture.runtime.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 200,
  });
  assert.equal(claimed.ok, true);
  await killWorker(fixture.lockPath, 'SIGKILL');

  const observed = await fixture.runtime.interact({
    stateRoot: fixture.stateRoot,
    threadId: THREAD_ID,
    outputRef: started.outputRef,
  });
  assert.equal(observed.ok, true);
  if (observed.ok) {
    assert.equal(observed.value.snapshot.status, 'command_host_interrupted');
    assert.equal(
      observed.value.snapshot.terminationReason,
      'command_host_lost',
    );
  }
});

void test('the same daemon serves new commands on a fresh worker after a crash', async (t) => {
  const fixture = await makeFixture(t);
  const first = await fixture.runtime.start(
    startArgs(fixture, 'echo up; sleep 300'),
  );
  assert.equal(first.ok, true);
  if (!first.ok) {
    return;
  }
  await fixture.runtime.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: first.outputRef,
    yieldTimeMs: 200,
  });

  const deadPid = await workerPid(fixture.lockPath);
  assert.ok(deadPid !== undefined);
  const orphan = firstChildPid(deadPid);
  await killWorker(fixture.lockPath, 'SIGKILL');
  // 자식은 워커와 함께 죽지 않는다 — 다음 워커의 reap이 거둘 몫이다.
  if (orphan !== undefined) {
    assert.equal(isProcessAlive(orphan), true, 'the child outlives its worker');
  }

  // 죽은 링크를 물고 있는 같은 데몬이 새 명령을 낼 수 있어야 한다.
  const second = await fixture.runtime.start(
    startArgs(fixture, 'echo revived'),
  );
  assert.equal(second.ok, true);
  if (!second.ok) {
    return;
  }
  const revived = await fixture.runtime.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: second.outputRef,
  });
  assert.equal(revived.ok, true);
  if (revived.ok) {
    assert.equal(revived.value.stdout?.trim(), 'revived');
  }

  const livePid = await workerPid(fixture.lockPath);
  assert.notEqual(livePid, deadPid, 'a new worker took the stale lock');
  if (orphan !== undefined) {
    for (
      let attempt = 0;
      attempt < 50 && isProcessAlive(orphan);
      attempt += 1
    ) {
      await delay(20);
    }
    assert.equal(isProcessAlive(orphan), false, 'startup reap collected it');
  }
});

void test('T2: a second daemon joins the committed claim idempotently', async (t) => {
  const fixture = await makeFixture(t);
  const started = await fixture.runtime.start(
    startArgs(fixture, 'echo up; sleep 300'),
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  const first = await fixture.runtime.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 200,
  });
  assert.equal(first.ok, true);

  // 데몬이 교체된 상황 — 워커는 그대로고 연결만 새로 선다. 커밋된 claim은
  // 응답이 유실됐더라도 같은 답으로 다시 합류할 수 있어야 한다.
  const successor = createDaemonHostCommandRuntime({
    config: { inlineMaxBytes: 65536 },
    requestedMode: 'worker',
  });
  t.after(async () => {
    await successor.closeAll();
  });
  const rejoined = await successor.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 200,
  });
  assert.equal(rejoined.ok, true);
  if (rejoined.ok && first.ok) {
    assert.equal(rejoined.value.outputRef, first.value.outputRef);
    assert.equal(rejoined.value.status, first.value.status);
  }
});

void test('a worker nobody ever connects to leaves on its own', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-idle-worker-'));
  const paths = await resolveCommandHostPaths(stateRoot);
  t.after(async () => {
    await removeCommandHostWorkspace(stateRoot);
  });

  // 데몬 없이 워커만 띄운다 — spawn 경합이 다른 워커의 idle 종료와 겹쳤을
  // 때 실제로 생기는 모양이다. §6.3의 종료 이벤트가 영영 오지 않으므로
  // 기동 유예만이 이 프로세스를 거둘 수 있다.
  const entry = fileURLToPath(new URL('./main.js', import.meta.url));
  const worker = spawn(process.execPath, [entry, stateRoot, '65536', '0'], {
    detached: true,
    stdio: 'ignore',
  });
  worker.unref();

  // 먼저 정상적으로 lock을 잡고 listen까지 갔는지 확인한다 — 유예가
  // 정상 기동을 잘라먹는 것이 아니라 놀고 있는 워커만 거두는지 보려면
  // 살아서 소켓을 연 상태를 먼저 봐야 한다.
  let owner: number | undefined;
  for (let attempt = 0; attempt < 100 && owner === undefined; attempt += 1) {
    const lock = await readCommandHostLock(paths.lockPath);
    if (lock !== 'missing' && lock !== 'unparsable') {
      owner = lock.pid;
      break;
    }
    await delay(50);
  }
  assert.ok(owner !== undefined, 'the worker should have taken the lock');

  const deadline = Date.now() + COMMAND_HOST_STARTUP_GRACE_MS * 3;
  while (isProcessAlive(owner) && Date.now() < deadline) {
    await delay(100);
  }
  assert.equal(
    isProcessAlive(owner),
    false,
    'an idle worker that never served a connection must not linger',
  );
});
