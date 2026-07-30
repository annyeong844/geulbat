import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildHostCommandOutputRef,
  buildHostCommandPaths,
  collectUnreferencedHostCommandOutputs,
  SYSTEM_SESSION_OWNER,
} from '../daemon/host-command-output-store.js';
import { buildCommandHostJournalPath, readSpawnJournal } from './journal.js';
import { buildCommandHostWorkerLogPath } from './worker-log.js';
import {
  registerHostCommandActiveSessions,
  releaseClaimedOutputRefs,
  resolvePreservedHostCommandRefs,
  retainClaimedOutputRef,
} from './reachability.js';
import {
  createDaemonHostCommandRuntime,
  resolveCommandHostModeFromEnv,
} from './runtime-selection.js';
import {
  removeCommandHostWorkspace,
  stopCommandHostWorker,
} from '../test-support/command-host-workspace.js';
import {
  isProcessAlive,
  readCommandHostLock,
  resolveCommandHostPaths,
  type CommandHostLockRecord,
} from './runtime-paths.js';

const THREAD_ID = 'thread-selection';

async function makeStateRoot(t: {
  after(fn: () => Promise<void> | void): void;
}): Promise<string> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-mode-fencing-'));
  // 워커를 먼저 세우고 지운다 — 쓰는 중인 디렉터리를 지우면 ENOTEMPTY다.
  t.after(async () => {
    await removeCommandHostWorkspace(stateRoot);
  });
  return stateRoot;
}

/** 살아 있지만 우리가 아닌 owner를 흉내내기 위한 장수 프로세스. */
function spawnSleeper(t: {
  after(fn: () => Promise<void> | void): void;
}): ChildProcess {
  const child = spawn(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 30_000)'],
    {
      stdio: 'ignore',
    },
  );
  t.after(() => {
    child.kill('SIGKILL');
  });
  return child;
}

async function seedLock(
  stateRoot: string,
  record: Omit<CommandHostLockRecord, 'lockFormatVersion'>,
): Promise<void> {
  const paths = await resolveCommandHostPaths(stateRoot);
  await writeFile(
    paths.lockPath,
    JSON.stringify({ lockFormatVersion: 1, ...record }),
    { mode: 0o600 },
  );
}

function makeRuntime(
  requestedMode: 'inline' | 'worker',
): ReturnType<typeof createDaemonHostCommandRuntime> {
  return createDaemonHostCommandRuntime({
    config: { inlineMaxBytes: 1024, tailRingBytes: 4096 },
    requestedMode,
  });
}

void test('the command host mode defaults to worker with an explicit way back', () => {
  assert.equal(resolveCommandHostModeFromEnv({}), 'worker');
  assert.equal(
    resolveCommandHostModeFromEnv({ GEULBAT_COMMAND_HOST: 'worker' }),
    'worker',
  );
  // 되돌리는 길은 명시적이어야 한다 — 배포에서 손댈 수 있는 유일한 손잡이다.
  assert.equal(
    resolveCommandHostModeFromEnv({ GEULBAT_COMMAND_HOST: 'inline' }),
    'inline',
  );
  assert.equal(
    resolveCommandHostModeFromEnv({ GEULBAT_COMMAND_HOST: 'nonsense' }),
    'worker',
    'an unreadable value falls back to the default, not to the other mode',
  );
});

void test('a lock read failure other than absence is classified as unparsable', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-lock-read-'));
  t.after(async () => {
    await rm(stateRoot, { recursive: true, force: true });
  });
  const paths = await resolveCommandHostPaths(stateRoot);
  await mkdir(paths.lockPath);

  assert.equal(await readCommandHostLock(paths.lockPath), 'unparsable');
});

void test('§6.2: an unowned state root is leased inline and recovered', async (t) => {
  const stateRoot = await makeStateRoot(t);
  const runtime = makeRuntime('inline');
  t.after(async () => {
    await runtime.closeAll();
  });

  const state = await runtime.describeState(stateRoot);
  assert.deepEqual(state, { mode: 'inline', diagnostic: null });

  const paths = await resolveCommandHostPaths(stateRoot);
  const lock: unknown = JSON.parse(await readFile(paths.lockPath, 'utf8'));
  assert.equal((lock as CommandHostLockRecord).ownerMode, 'inline');
  assert.equal((lock as CommandHostLockRecord).pid, process.pid);
});

void test('§6.2: inline request + live worker owner attaches with a diagnostic', async (t) => {
  const stateRoot = await makeStateRoot(t);
  const owner = spawnSleeper(t);
  const paths = await resolveCommandHostPaths(stateRoot);
  await seedLock(stateRoot, {
    ownerMode: 'worker',
    pid: owner.pid ?? 1,
    birthTokenMs: Date.now(),
    birthToken: null,
    endpoint: paths.socketPath,
    stateRootFingerprint: paths.stateRootFingerprint,
  });
  const runtime = makeRuntime('inline');
  t.after(async () => {
    await runtime.closeAll();
  });

  assert.deepEqual(await runtime.describeState(stateRoot), {
    mode: 'worker',
    diagnostic: 'command_host_mode_conflict',
  });
});

void test('§6.2: worker request + live inline owner is refused', async (t) => {
  const stateRoot = await makeStateRoot(t);
  const owner = spawnSleeper(t);
  const paths = await resolveCommandHostPaths(stateRoot);
  await seedLock(stateRoot, {
    ownerMode: 'inline',
    pid: owner.pid ?? 1,
    birthTokenMs: Date.now(),
    birthToken: null,
    stateRootFingerprint: paths.stateRootFingerprint,
  });
  const runtime = makeRuntime('worker');
  t.after(async () => {
    await runtime.closeAll();
  });

  assert.deepEqual(await runtime.describeState(stateRoot), {
    mode: null,
    diagnostic: 'command_host_mode_conflict',
  });
  const started = await runtime.start({
    executable: process.execPath,
    args: ['-e', ''],
    cwd: stateRoot,
    env: process.env,
    stateRoot,
    threadId: THREAD_ID,
    runId: 'run',
    callId: 'call',
    stdinMode: 'closed',
  });
  assert.equal(started.ok, false);
  if (!started.ok) {
    assert.match(started.message, /forced transition/u);
  }
});

void test('§6.2: inline request + another live inline owner is a double-daemon error', async (t) => {
  const stateRoot = await makeStateRoot(t);
  const owner = spawnSleeper(t);
  const paths = await resolveCommandHostPaths(stateRoot);
  await seedLock(stateRoot, {
    ownerMode: 'inline',
    pid: owner.pid ?? 1,
    birthTokenMs: Date.now(),
    birthToken: null,
    stateRootFingerprint: paths.stateRootFingerprint,
  });
  const runtime = makeRuntime('inline');
  t.after(async () => {
    await runtime.closeAll();
  });

  const state = await runtime.describeState(stateRoot);
  assert.equal(state.mode, null);
  assert.equal(state.diagnostic, 'command_host_mode_conflict');
});

void test('§6.2: a stale lock is replaced after the owner is proven dead', async (t) => {
  const stateRoot = await makeStateRoot(t);
  const paths = await resolveCommandHostPaths(stateRoot);
  await seedLock(stateRoot, {
    ownerMode: 'worker',
    pid: 999_997,
    birthTokenMs: Date.now(),
    birthToken: null,
    stateRootFingerprint: paths.stateRootFingerprint,
  });
  const runtime = makeRuntime('inline');
  t.after(async () => {
    await runtime.closeAll();
  });

  assert.deepEqual(await runtime.describeState(stateRoot), {
    mode: 'inline',
    diagnostic: null,
  });
});

void test('an inline lease releases its ownership on closeAll', async (t) => {
  const stateRoot = await makeStateRoot(t);
  const first = makeRuntime('inline');
  await first.describeState(stateRoot);
  await first.closeAll();

  const second = makeRuntime('inline');
  t.after(async () => {
    await second.closeAll();
  });
  assert.deepEqual(await second.describeState(stateRoot), {
    mode: 'inline',
    diagnostic: null,
  });
});

void test('T17: GC is skipped when the active session set cannot be read', async (t) => {
  const stateRoot = await makeStateRoot(t);
  const detach = registerHostCommandActiveSessions({
    activeOutputRefs: async () => ({ ok: false, reason: 'worker hang' }),
  });
  t.after(() => {
    detach();
  });

  const preserved = await resolvePreservedHostCommandRefs({
    stateRoot,
    transcriptRefs: new Set(),
  });
  assert.equal(preserved.ok, false);
  if (!preserved.ok) {
    assert.equal(preserved.reason, 'worker hang');
  }
});

void test('§5.6: live sessions and in-flight claims join the preserve set', async (t) => {
  const stateRoot = await makeStateRoot(t);
  const liveRef = buildHostCommandOutputRef({
    threadId: THREAD_ID,
    sessionId: '00000000-0000-4000-8000-000000000001',
  });
  const claimedRef = buildHostCommandOutputRef({
    threadId: THREAD_ID,
    sessionId: '00000000-0000-4000-8000-000000000002',
  });
  const transcriptRef = buildHostCommandOutputRef({
    threadId: THREAD_ID,
    sessionId: '00000000-0000-4000-8000-000000000003',
  });
  const detach = registerHostCommandActiveSessions({
    activeOutputRefs: async () => ({ ok: true, refs: new Set([liveRef]) }),
  });
  retainClaimedOutputRef(claimedRef);
  t.after(() => {
    detach();
    releaseClaimedOutputRefs([claimedRef]);
  });

  const preserved = await resolvePreservedHostCommandRefs({
    stateRoot,
    transcriptRefs: new Set([transcriptRef]),
  });
  assert.equal(preserved.ok, true);
  if (!preserved.ok) {
    return;
  }
  assert.deepEqual(
    [...preserved.refs].sort(),
    [claimedRef, liveRef, transcriptRef].sort(),
  );

  // transcript 기록이 끝나면 in-flight 보존은 해제된다.
  releaseClaimedOutputRefs([claimedRef]);
  const afterWrite = await resolvePreservedHostCommandRefs({
    stateRoot,
    transcriptRefs: new Set([transcriptRef]),
  });
  assert.equal(afterWrite.ok, true);
  if (afterWrite.ok) {
    assert.equal(afterWrite.refs.has(claimedRef), false);
  }
});

void test('§5.6: system-owned results do not become transcript claims', async (t) => {
  const stateRoot = await makeStateRoot(t);
  const runtime = makeRuntime('inline');
  let outputRef: string | undefined;
  let runtimeClosed = false;
  t.after(async () => {
    if (outputRef !== undefined) {
      releaseClaimedOutputRefs([outputRef]);
    }
    if (!runtimeClosed) {
      await runtime.closeAll();
    }
  });

  const started = await runtime.start({
    executable: process.execPath,
    args: ['-e', 'process.stdout.write("s".repeat(2048));'],
    cwd: stateRoot,
    env: process.env,
    stateRoot,
    threadId: SYSTEM_SESSION_OWNER,
    owner: 'system',
    runId: 'system',
    callId: 'system',
    stdinMode: 'closed',
  });
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  outputRef = started.outputRef;

  const settled = await runtime.waitForInitialResult({
    stateRoot,
    outputRef,
  });
  assert.equal(settled.ok, true);
  if (!settled.ok) {
    return;
  }
  assert.equal(settled.value.outputRef, outputRef);

  // Detach the runtime's active-session projection so only the in-flight claim
  // set can preserve this ref. System results have no transcript handoff and
  // therefore must not appear in that set.
  await runtime.closeAll();
  runtimeClosed = true;
  const detach = registerHostCommandActiveSessions({
    activeOutputRefs: async () => ({ ok: true, refs: new Set() }),
  });
  t.after(detach);

  const preserved = await resolvePreservedHostCommandRefs({
    stateRoot,
    transcriptRefs: new Set(),
  });
  assert.equal(preserved.ok, true);
  if (preserved.ok) {
    assert.equal(preserved.refs.has(outputRef), false);
  }
});

void test('T17: a session pinned by the preserve set is not collected', async (t) => {
  const stateRoot = await makeStateRoot(t);
  const outputRef = buildHostCommandOutputRef({
    threadId: THREAD_ID,
    sessionId: '00000000-0000-4000-8000-000000000009',
  });
  const paths = buildHostCommandPaths({
    stateRoot,
    threadId: THREAD_ID,
    outputRef,
  });
  await mkdir(paths.directory, { recursive: true });
  await writeFile(paths.metadata, '{}');

  const deleted = await collectUnreferencedHostCommandOutputs({
    stateRoot,
    threadId: THREAD_ID,
    preservedOutputRefs: new Set([outputRef]),
  });
  assert.equal(deleted, 0);
});

void test('worker mode drives a real detached worker over the socket', async (t) => {
  const stateRoot = await makeStateRoot(t);
  const runtime = makeRuntime('worker');
  const thread = THREAD_ID;
  t.after(async () => {
    await runtime.closeAll();
    await stopCommandHostWorker(stateRoot);
  });

  assert.deepEqual(await runtime.describeState(stateRoot), {
    mode: 'worker',
    diagnostic: null,
  });

  const started = await runtime.start({
    executable: process.execPath,
    args: [
      '-e',
      'setTimeout(() => process.stdout.write("w".repeat(4000)), 40);',
    ],
    cwd: stateRoot,
    env: process.env,
    stateRoot,
    threadId: thread,
    runId: 'run-worker',
    callId: 'call-worker',
    stdinMode: 'closed',
  });
  assert.equal(started.ok, true, 'the worker accepted the command');
  if (!started.ok) {
    return;
  }

  const claimed = await runtime.waitForInitialResult({
    stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 0,
  });
  assert.equal(claimed.ok, true);
  if (claimed.ok) {
    assert.equal(claimed.value.outputRef, started.outputRef);
  }

  // 워커가 실제로 소유하고 있으므로 §5.6 보존 집합에 나타나야 한다.
  const active = await runtime.activeOutputRefs(stateRoot);
  assert.equal(active.ok, true);
  if (active.ok) {
    assert.equal(active.refs.has(started.outputRef), true);
  }

  for (;;) {
    const observed = await runtime.interact({
      stateRoot,
      threadId: thread,
      outputRef: started.outputRef,
      yieldTimeMs: 20,
      page: { stream: 'stdout', offsetBytes: 0, limitBytes: 8 },
    });
    assert.equal(observed.ok, true);
    if (!observed.ok) {
      return;
    }
    if (observed.value.snapshot.status !== 'running') {
      assert.equal(observed.value.page?.content, 'w'.repeat(8));
      break;
    }
  }

  // §9.3 — stdio가 ignore인 프로세스의 유일한 흔적. 수명의 갈림길이
  // 남아 있어야 사후 진단이 가능하다.
  const log = await readFile(buildCommandHostWorkerLogPath(stateRoot), 'utf8');
  const events = log
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { event: string });
  const seen = events.map((entry) => entry.event);
  for (const expected of [
    'worker_start',
    'lock_acquired',
    'recovery',
    'listening',
  ]) {
    assert.ok(
      seen.includes(expected),
      `worker log must record ${expected}, saw ${JSON.stringify(seen)}`,
    );
  }

  // 워커가 open 행을 내구화했고 종료 후 닫았다 — 저널은 워커 소유다.
  const journal = await readSpawnJournal(
    buildCommandHostJournalPath(stateRoot),
  );
  assert.equal(journal.ok, true);
  if (journal.ok) {
    assert.equal(journal.open.length, 0, 'the finished session is retired');
    assert.equal(journal.closed.size, 1);
  }
});

void test('a closed daemon runtime cannot reattach its surviving worker session', async (t) => {
  const stateRoot = await makeStateRoot(t);
  const runtime = makeRuntime('worker');
  const started = await runtime.start({
    executable: process.execPath,
    args: ['-e', 'process.stdin.resume()'],
    cwd: stateRoot,
    env: process.env,
    stateRoot,
    threadId: THREAD_ID,
    runId: 'run-closed-runtime',
    callId: 'call-closed-runtime',
    stdinMode: 'open',
  });
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  const claimed = await runtime.waitForInitialResult({
    stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 0,
  });
  assert.equal(claimed.ok, true);
  if (!claimed.ok) {
    return;
  }

  assert.deepEqual(await runtime.closeAll(), { ok: true });
  assert.deepEqual(
    await runtime.interact({
      stateRoot,
      threadId: THREAD_ID,
      outputRef: started.outputRef,
      yieldTimeMs: 0,
    }),
    {
      ok: false,
      reasonCode: 'output_store_failed',
      message: 'command-host connection was lost.',
    },
  );
});

void test('worker mode routes the initial wait to the owning workspace', async (t) => {
  const first = await makeStateRoot(t);
  const second = await makeStateRoot(t);
  const runtime = makeRuntime('worker');
  const paths = await Promise.all([
    resolveCommandHostPaths(first),
    resolveCommandHostPaths(second),
  ]);
  t.after(async () => {
    await runtime.closeAll();
    for (const path of paths) {
      const lock = await readCommandHostLock(path.lockPath);
      if (lock !== 'missing' && lock !== 'unparsable') {
        try {
          process.kill(lock.pid, 'SIGTERM');
        } catch {
          // 이미 스스로 나갔다.
        }
      }
    }
  });

  function startOn(stateRoot: string) {
    return runtime.start({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("w".repeat(3000));'],
      cwd: stateRoot,
      env: process.env,
      stateRoot,
      threadId: THREAD_ID,
      runId: 'run-routing',
      callId: 'call-routing',
      stdinMode: 'closed',
    });
  }

  const startedFirst = await startOn(first);
  const startedSecond = await startOn(second);
  assert.equal(startedFirst.ok, true);
  assert.equal(startedSecond.ok, true);
  if (!startedFirst.ok || !startedSecond.ok) {
    return;
  }

  // 두 번째 워크스페이스의 세션은 두 번째 워커에만 있다 — 라우팅이
  // "살아 있는 링크 아무 것"이면 여기서 not_found가 난다.
  const claimedSecond = await runtime.waitForInitialResult({
    outputRef: startedSecond.outputRef,
    stateRoot: second,
  });
  assert.equal(claimedSecond.ok, true);
  if (claimedSecond.ok) {
    assert.equal(claimedSecond.value.outputRef, startedSecond.outputRef);
  }

  const claimedFirst = await runtime.waitForInitialResult({
    outputRef: startedFirst.outputRef,
    stateRoot: first,
  });
  assert.equal(claimedFirst.ok, true);
});

void test('worker mode degrades to inline where a worker cannot stand', async (t) => {
  // stateRoot가 사라진 상태 — 소켓·lock 경로를 세울 수 없는 환경의 대역이다
  // (Windows 비지원과 같은 부류). 배치를 못 세운다고 명령이 죽어서는 안 된다.
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-no-host-'));
  await rm(stateRoot, { recursive: true, force: true });
  const runtime = makeRuntime('worker');
  t.after(async () => {
    await runtime.closeAll();
  });

  assert.deepEqual(await runtime.describeState(stateRoot), {
    mode: 'inline',
    diagnostic: 'command_host_worker_unsupported',
  });
});

void test('inline mode degrades silently in the same environment', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-no-host-'));
  await rm(stateRoot, { recursive: true, force: true });
  const runtime = makeRuntime('inline');
  t.after(async () => {
    await runtime.closeAll();
  });

  assert.deepEqual(await runtime.describeState(stateRoot), {
    mode: 'inline',
    diagnostic: null,
  });
});

void test('a worker that never appears fails with a reachability diagnostic', async (t) => {
  const stateRoot = await makeStateRoot(t);
  const runtime = createDaemonHostCommandRuntime({
    config: { inlineMaxBytes: 1024, tailRingBytes: 4096 },
    requestedMode: 'worker',
    workerCommand: { execPath: process.execPath, args: ['--version'] },
  });
  t.after(async () => {
    await runtime.closeAll();
  });

  // `node --version`은 워커가 아니므로 소켓이 절대 뜨지 않는다. 엔트리
  // 자체는 실행 가능하므로(= fail-fast 대상이 아님) 백오프를 끝까지 돌고
  // 진단과 함께 실패해야 한다. 엔트리가 아예 없을 때의 즉시 포기는 별개
  // 경로이며 빌드 레이아웃이 필요해 E2E에서 확인한다.
  const startedAt = Date.now();
  const started = await runtime.start({
    executable: process.execPath,
    args: ['-e', ''],
    cwd: stateRoot,
    env: process.env,
    stateRoot,
    threadId: THREAD_ID,
    runId: 'run-missing',
    callId: 'call-missing',
    stdinMode: 'closed',
  });
  const elapsed = Date.now() - startedAt;
  assert.equal(started.ok, false);
  if (!started.ok) {
    assert.equal(started.reasonCode, 'spawn_failed');
    assert.match(started.message, /did not become reachable/u);
  }
  assert.ok(
    elapsed >= 1000,
    'a worker that merely never appears still gets the full backoff',
  );
});

void test('T6: daemons racing to spawn a worker converge on exactly one', async (t) => {
  // `after` 훅은 등록 순서로 돈다. 그래서 데몬 종료를 `makeStateRoot`보다 먼저
  // 등록해야 한다. 그렇지 않으면 세션 넷이 살아 있는 동안 작업공간 삭제가 먼저
  // 실행되어, 워커가 저널을 쓰는 도중 디렉터리가 사라지고 `ENOTEMPTY`가 난다.
  // 워커 종료와 대기는 `removeCommandHostWorkspace`가 이미 소유한다.
  const daemons = Array.from({ length: 4 }, () => makeRuntime('worker'));
  t.after(async () => {
    for (const daemon of daemons) {
      await daemon.closeAll();
    }
  });
  const stateRoot = await makeStateRoot(t);
  const paths = await resolveCommandHostPaths(stateRoot);

  const started = await Promise.all(
    daemons.map((daemon, index) =>
      daemon.start({
        executable: '/bin/sh',
        args: ['-c', `echo daemon-${index}; sleep 30`],
        cwd: stateRoot,
        env: process.env,
        stateRoot,
        threadId: THREAD_ID,
        runId: 'run-race',
        callId: `call-race-${index}`,
        stdinMode: 'closed',
      }),
    ),
  );
  for (const outcome of started) {
    assert.equal(outcome.ok, true, 'every racing daemon must get its session');
  }
  const refs = started.flatMap((outcome) =>
    outcome.ok ? [outcome.outputRef] : [],
  );
  assert.equal(new Set(refs).size, 4);

  // 승자는 하나다 — 패배한 워커들은 lock을 못 잡고 자진 종료한다(§6.2).
  const lock = await readCommandHostLock(paths.lockPath);
  if (lock === 'missing' || lock === 'unparsable') {
    assert.fail(`exactly one worker must own the lock, saw ${lock}`);
  }
  assert.equal(lock.ownerMode, 'worker');
  assert.equal(isProcessAlive(lock.pid), true);

  // 그리고 네 세션이 전부 그 하나의 워커에 있다 — 요청이 갈라지지 않았다.
  const active = await daemons[0]?.activeOutputRefs(stateRoot);
  assert.equal(active?.ok, true);
  if (active?.ok === true) {
    for (const ref of refs) {
      assert.equal(active.refs.has(ref), true, `${ref} lives on the winner`);
    }
  }
});

void test('a degraded placement still runs startup recovery', async (t) => {
  const stateRoot = await makeStateRoot(t);
  // 런타임 디렉터리 자리에 파일을 두어 경로 해석을 실패시킨다 — 소켓도
  // lock도 둘 수 없는 환경(win32가 대표적)의 대역이다.
  const blocked = join(stateRoot, 'not-a-directory');
  await writeFile(blocked, 'blocks the runtime directory');
  const previousRuntimeDir = process.env['XDG_RUNTIME_DIR'];
  process.env['XDG_RUNTIME_DIR'] = blocked;
  t.after(() => {
    if (previousRuntimeDir === undefined) {
      delete process.env['XDG_RUNTIME_DIR'];
    } else {
      process.env['XDG_RUNTIME_DIR'] = previousRuntimeDir;
    }
  });

  // 이전 세대가 남긴 running 메타 — 복구가 돌면 interrupted로 수렴한다.
  const sessionId = '00000000-0000-4000-8000-0000000000aa';
  const outputRef = buildHostCommandOutputRef({
    threadId: THREAD_ID,
    sessionId,
  });
  const paths = buildHostCommandPaths({
    stateRoot,
    threadId: THREAD_ID,
    outputRef,
  });
  await mkdir(paths.directory, { recursive: true });
  await writeFile(
    paths.metadata,
    `${JSON.stringify({
      formatVersion: 1,
      schemaVersion: 1,
      sessionId,
      outputRef,
      threadId: THREAD_ID,
      runId: 'run-old',
      callId: 'call-old',
      status: 'running',
      exitCode: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutChars: 0,
      stderrChars: 0,
      startedAtMs: 1_700_000_000_000,
      finishedAtMs: null,
      firstOutputAfterMs: null,
      revision: 1,
      stdinOpen: true,
      outputLimitExceeded: null,
    })}\n`,
  );

  const runtime = makeRuntime('worker');
  t.after(async () => {
    await runtime.closeAll();
  });
  assert.deepEqual(await runtime.describeState(stateRoot), {
    mode: 'inline',
    diagnostic: 'command_host_worker_unsupported',
  });

  // 배치를 못 세웠다고 복구까지 건너뛰면 이 세션은 영영 running으로 남는다.
  const reconciled: unknown = JSON.parse(
    await readFile(paths.metadata, 'utf8'),
  );
  assert.equal(
    (reconciled as { status: string }).status,
    'command_host_interrupted',
  );
});
