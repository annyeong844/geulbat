import { unlink } from 'node:fs/promises';
import net from 'node:net';

import { readProcessBirthToken } from './process-identity.js';
import { recoverCommandHostState } from './recovery.js';
import { createCommandSessionHost } from './session-core.js';
import { startCommandHostServer } from './worker-server.js';
import { COMMAND_HOST_STARTUP_GRACE_MS } from './protocol.js';
import {
  buildCommandHostWorkerLogPath,
  openWorkerLog,
  type WorkerLog,
} from './worker-log.js';
import {
  acquireCommandHostLock,
  resolveCommandHostPaths,
} from './runtime-paths.js';

// P7.5 spec v4 §6 — command-host 워커 엔트리. stateRoot당 1개, 데몬보다
// 오래 산다. argv: <stateRoot> <inlineMaxBytes> <tailRingBytes|0>
// <maxYieldTimeMs|0>.
// 종료는 이벤트 구동(연결 0 ∧ 코어 quiescent)이며 linger 타이머가 없다.
//
// stdio는 ignore이므로 이 프로세스의 유일한 흔적은 §9.3 워커 로그다.
// 수명의 모든 갈림길이 로그에 한 줄씩 남는다 — 특히 조용히 죽을 수 있는
// 경로(lock 패배·main 거부·uncaught)가 그렇다.

/** 최상위 실패 경로가 쓸 수 있도록 열리는 즉시 여기 둔다. */
let activeLog: WorkerLog | undefined;

async function main(): Promise<number> {
  if (process.platform === 'win32') {
    process.stderr.write('command-host worker mode is unsupported on win32\n');
    return 1;
  }
  const [stateRoot, inlineArg, tailArg, yieldArg] = process.argv.slice(2);
  if (stateRoot === undefined || inlineArg === undefined) {
    process.stderr.write(
      'usage: command-host <stateRoot> <inlineMaxBytes> [tailRingBytes]\n',
    );
    return 2;
  }
  const inlineMaxBytes = Number(inlineArg);
  const tailRingBytes = Number(tailArg ?? '0');
  const maxYieldTimeMs = Number(yieldArg ?? '0');

  const paths = await resolveCommandHostPaths(stateRoot);
  const workerInstanceId = `${process.pid}-${Date.now()}`;
  const log = openWorkerLog({
    path: buildCommandHostWorkerLogPath(paths.canonicalStateRoot),
    workerInstanceId,
  });
  activeLog = log;
  installCrashHandlers(log);
  log.write('worker_start', {
    pid: process.pid,
    stateRoot: paths.canonicalStateRoot,
    inlineMaxBytes,
    tailRingBytes,
    nodeVersion: process.version,
  });

  const lock = await acquireCommandHostLock(paths.lockPath, {
    ownerMode: 'worker',
    pid: process.pid,
    birthTokenMs: Date.now(),
    birthToken: await readProcessBirthToken(process.pid),
    workerInstanceId,
    endpoint: paths.socketPath,
    stateRootFingerprint: paths.stateRootFingerprint,
  });
  if (!lock.ok) {
    // 패자 워커는 자진 종료 — 데몬 클라이언트가 승자에 재시도 접속한다
    // (spec §6.2). 조용히 사라지는 경로이므로 이유를 남긴다.
    log.write('lock_not_acquired', {
      kind: lock.kind,
      ownerPid: lock.kind === 'held' ? lock.owner.pid : undefined,
      ownerMode: lock.kind === 'held' ? lock.owner.ownerMode : undefined,
    });
    return 0;
  }
  const releaseLock = lock.release;
  log.write('lock_acquired', { endpoint: paths.socketPath });

  // stale 소켓 probe — lock 보유자만 unlink할 수 있다.
  if (await probeAndUnlinkStaleSocket(paths.socketPath)) {
    log.write('stale_socket_removed', { socket: paths.socketPath });
  }

  // 새 owner가 됐으니 이전 세대의 잔재는 우리 몫이다 — 소켓을 열기 전에
  // reconcile·reap을 끝낸다 (spec §5.2).
  const recovery = await recoverCommandHostState({
    stateRoot: paths.canonicalStateRoot,
  });
  log.write('recovery', { ...recovery });

  const core = createCommandSessionHost({
    inlineMaxBytes,
    ...(tailRingBytes > 0 ? { tailRingBytes } : {}),
    ...(maxYieldTimeMs > 0 ? { maxYieldTimeMs } : {}),
  });

  let exiting = false;
  let server = await listen();
  log.write('listening', { socket: paths.socketPath });

  // §6.3의 종료 게이트는 이벤트 구동이지만, 연결이 **한 번도** 오지 않은
  // 워커에게는 그 이벤트가 영영 오지 않는다(spawn 경합이 다른 워커의 idle
  // 종료와 겹치면 태어나자마자 놀고 있는 워커가 남는다). "아직 안 왔다"와
  // "영영 안 온다"는 시간 없이 구별할 수 없으므로, 접속 창의 2배를 기다린
  // 뒤 한 번만 판정한다. 그 사이 연결이 한 번이라도 있었다면 이후로는
  // 평범한 이벤트 규칙이 맡는다.
  const startupGrace = setTimeout(() => {
    if (server.hasEverServedConnection()) {
      return;
    }
    log.write('startup_grace_expired', {
      graceMs: COMMAND_HOST_STARTUP_GRACE_MS,
    });
    void shutdown();
  }, COMMAND_HOST_STARTUP_GRACE_MS);
  startupGrace.unref();

  async function listen(): Promise<
    Awaited<ReturnType<typeof startCommandHostServer>>
  > {
    return await startCommandHostServer({
      core,
      socketPath: paths.socketPath,
      stateRoot: paths.canonicalStateRoot,
      stateRootFingerprint: paths.stateRootFingerprint,
      onIdle: () => {
        void shutdown();
      },
    });
  }

  async function shutdown(): Promise<void> {
    if (exiting) {
      return;
    }
    exiting = true;
    // §6.3 종료 순서: draining → server close 완료 대기 → 전 카운터 재검사
    // → 활동 시 unlink 후 재listen → 아니면 lock 해제 → exit.
    await server.close();
    if (!core.isQuiescent()) {
      server = await listen();
      exiting = false;
      log.write('shutdown_deferred', { reason: 'activity_resumed' });
      return;
    }
    // §6.3의 종료 순서에서 lock release가 마지막이다 — lock이 사라진 것을
    // 보고 남이 작업공간을 정리해도 안전하려면, 우리가 쓸 것은 그 전에 다
    // 써야 한다.
    log.write('shutdown', { reason: 'idle' });
    await releaseLock();
    process.exit(0);
  }

  process.on('SIGTERM', () => {
    void (async () => {
      log.write('sigterm');
      await core.closeAll();
      await server.close();
      log.write('shutdown', { reason: 'sigterm' });
      await releaseLock();
      process.exit(0);
    })();
  });

  return -1; // 계속 실행 — 종료는 이벤트가 정한다.
}

function installCrashHandlers(log: WorkerLog): void {
  process.on('uncaughtException', (error: Error) => {
    log.write('uncaught_exception', {
      message: error.message,
      stack: error.stack ?? null,
    });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    log.write('unhandled_rejection', { message: describe(reason) });
    process.exit(1);
  });
}

function describe(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.stack ?? reason.message;
  }
  return typeof reason === 'string' ? reason : JSON.stringify(reason);
}

/** stale 소켓을 걷어냈으면 true. */
async function probeAndUnlinkStaleSocket(socketPath: string): Promise<boolean> {
  const alive = await new Promise<boolean>((resolve) => {
    const probe = net.connect(socketPath);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => {
      resolve(false);
    });
  });
  if (alive) {
    return false;
  }
  let removed = false;
  await unlink(socketPath).then(
    () => {
      removed = true;
    },
    () => undefined,
  );
  return removed;
}

void main().then(
  (code) => {
    if (code >= 0) {
      process.exit(code);
    }
  },
  (error: unknown) => {
    // 여기서 잡지 않으면 워커가 정말 흔적 없이 사라진다.
    activeLog?.write('start_failed', { message: describe(error) });
    process.stderr.write(
      `command-host worker failed to start: ${describe(error)}\n`,
    );
    process.exit(1);
  },
);
