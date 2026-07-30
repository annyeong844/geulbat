import { createCommandHostClient } from './daemon-client.js';
import {
  registerHostCommandActiveSessions,
  retainClaimedOutputRef,
} from './reachability.js';
import { recoverCommandHostState } from './recovery.js';
import { readProcessBirthToken } from './process-identity.js';
import {
  acquireCommandHostLock,
  isLockOwnerAlive,
  readCommandHostLock,
  resolveCommandHostPaths,
} from './runtime-paths.js';
import { createCommandSessionHost } from './session-core.js';
import type {
  CommandSessionHostConfig,
  HostCommandActiveSessions,
  HostCommandRuntime,
} from './contract.js';
import {
  parseHostCommandOutputRef,
  SYSTEM_SESSION_OWNER,
} from '../daemon/host-command-output-store.js';

// P7.5 spec v4 §6.2·§9.1 — mode fencing. 소유권은 canonical stateRoot당
// 하나이고 lock 레코드가 owner mode를 나른다. 워커는 stateRoot 하나만
// 서빙하지만 데몬의 인라인 코어는 여러 워크스페이스를 서빙하므로, lease는
// 최초 사용 시점에 stateRoot 단위로 지연 획득한다. 그 획득 시점이 곧 그
// stateRoot에 대한 기동 복구(§5.2) 시점이다.

export type CommandHostMode = 'inline' | 'worker';

const COMMAND_HOST_MODE_ENV = 'GEULBAT_COMMAND_HOST';

export function resolveCommandHostModeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CommandHostMode {
  // 기본은 worker — §9.1의 선행 조건 넷(win32 강등·크래시 복구·부하 유계·
  // 워커 진단)이 모두 닫힌 뒤의 전환이다. 되돌리려면 이 한 줄이 아니라
  // `GEULBAT_COMMAND_HOST=inline`이면 된다.
  return env[COMMAND_HOST_MODE_ENV]?.trim() === 'inline' ? 'inline' : 'worker';
}

export interface DaemonHostCommandRuntime
  extends HostCommandRuntime, HostCommandActiveSessions {
  /**
   * §6.2·§9.1 — 이 stateRoot의 소유권을 확정하고 그 결과를 보고한다.
   * lease가 아직 없으면 여기서 획득한다(= 기동 복구 시점).
   */
  describeState(stateRoot: string): Promise<{
    mode: CommandHostMode | null;
    diagnostic: string | null;
  }>;
}

interface DaemonHostCommandRuntimeOptions {
  config: CommandSessionHostConfig;
  requestedMode?: CommandHostMode;
  workerCommand?: { execPath: string; args: readonly string[] };
}

type LeaseOutcome =
  | { ok: true; placement: 'inline'; diagnostic: string | null }
  | { ok: true; placement: 'worker'; diagnostic: string | null }
  | { ok: false; reasonCode: 'command_host_mode_conflict'; message: string };

export function createDaemonHostCommandRuntime(
  options: DaemonHostCommandRuntimeOptions,
): DaemonHostCommandRuntime {
  const requestedMode =
    options.requestedMode ?? resolveCommandHostModeFromEnv();
  const inline = createCommandSessionHost(options.config);
  const client = createCommandHostClient({
    config: options.config,
    ...(options.workerCommand === undefined
      ? {}
      : { workerCommand: options.workerCommand }),
  });

  const leases = new Map<string, Promise<LeaseOutcome>>();
  const placements = new Map<string, LeaseOutcome>();
  const releases: Array<() => Promise<void>> = [];
  // This facade belongs to one daemon generation. A worker and its claimed
  // sessions may survive a disconnect, but detached work from the closed
  // facade must not acquire a new lease and reattach as if it were a
  // replacement daemon.
  let closed = false;

  function ensureLease(stateRoot: string): Promise<LeaseOutcome> {
    const existing = leases.get(stateRoot);
    if (existing !== undefined) {
      return existing;
    }
    const created = acquireLease(stateRoot).then((outcome) => {
      placements.set(stateRoot, outcome);
      return outcome;
    });
    leases.set(stateRoot, created);
    void created.catch(() => {
      leases.delete(stateRoot);
    });
    return created;
  }

  async function acquireLease(stateRoot: string): Promise<LeaseOutcome> {
    let paths: Awaited<ReturnType<typeof resolveCommandHostPaths>>;
    try {
      paths = await resolveCommandHostPaths(stateRoot);
    } catch {
      // 소켓·lock을 둘 수 없는 환경에서는 워커가 설 수 없다 — Windows
      // 비지원(§9.1)이 대표적이다. 배치를 못 세운다고 명령 자체가 실패해서는
      // 안 되므로 inline으로 강등하고, worker를 요청했을 때만 진단을 남긴다.
      // 이 강등이 없으면 worker가 기본이 되는 순간 그 환경의 exec_command가
      // 전부 죽는다.
      //
      // 강등해도 **기동 복구는 그대로 필요하다**. 복구는 순수 파일 작업이라
      // 소켓도 lock도 요구하지 않는데, 이 갈래에서 건너뛰면 그 플랫폼은
      // reap·reconcile·§5.3 승격을 영영 받지 못한다(Windows가 그 상태였다).
      // 데몬 이중 기동은 상위의 인스턴스 admission lock이 막으므로 소유권
      // lock 없이 돌려도 안전하다. 복구 실패가 명령 실행을 막아서는 안 되니
      // 여기서 삼킨다 — 청소가 안 됐을 뿐 실행은 계속돼야 한다.
      await recoverCommandHostState({ stateRoot }).catch(() => undefined);
      return {
        ok: true,
        placement: 'inline',
        diagnostic:
          requestedMode === 'worker' ? 'command_host_worker_unsupported' : null,
      };
    }

    const existing = await readCommandHostLock(paths.lockPath);
    if (existing !== 'missing' && existing !== 'unparsable') {
      const alive = await isLockOwnerAlive(existing);
      if (alive && existing.pid !== process.pid) {
        return applyOwnerModeTable(existing.ownerMode);
      }
    }

    if (requestedMode === 'worker') {
      // 워커 spawn·lock 획득은 워커 자신이 한다 — 데몬은 접속만 한다.
      return { ok: true, placement: 'worker', diagnostic: null };
    }

    const lock = await acquireCommandHostLock(paths.lockPath, {
      ownerMode: 'inline',
      pid: process.pid,
      birthTokenMs: Date.now(),
      birthToken: await readProcessBirthToken(process.pid),
      stateRootFingerprint: paths.stateRootFingerprint,
    });
    if (!lock.ok) {
      if (lock.kind === 'held') {
        return applyOwnerModeTable(lock.owner.ownerMode);
      }
      // 신선-미파싱 lock — 기록 전 창이므로 소유자가 확정될 때까지 이번
      // 요청은 lease 없이 인라인으로 진행한다 (§6.2).
      return { ok: true, placement: 'inline', diagnostic: null };
    }
    releases.push(lock.release);
    // 이 stateRoot의 새 owner가 됐다 — 이전 세대의 잔재는 우리 몫이다.
    await recoverCommandHostState({ stateRoot });
    return { ok: true, placement: 'inline', diagnostic: null };
  }

  function applyOwnerModeTable(ownerMode: 'inline' | 'worker'): LeaseOutcome {
    if (ownerMode === 'worker') {
      return requestedMode === 'worker'
        ? { ok: true, placement: 'worker', diagnostic: null }
        : {
            // inline 요청 + live worker = attach + 진단 (§6.2).
            ok: true,
            placement: 'worker',
            diagnostic: 'command_host_mode_conflict',
          };
    }
    if (requestedMode === 'inline') {
      return {
        ok: false,
        reasonCode: 'command_host_mode_conflict',
        message:
          'another live daemon already owns this state root inline (double daemon).',
      };
    }
    return {
      ok: false,
      reasonCode: 'command_host_mode_conflict',
      message:
        'an inline command host owns this state root; run the forced transition procedure before switching to worker mode.',
    };
  }

  function runtimeFor(
    outcome: LeaseOutcome & { ok: true },
  ): HostCommandRuntime {
    return outcome.placement === 'worker' ? client : inline;
  }

  return {
    async start(args) {
      if (closed) {
        return {
          ok: false,
          reasonCode: 'runtime_closed',
          message: 'host command runtime is closed.',
        };
      }
      const lease = await ensureLease(args.stateRoot);
      if (!lease.ok) {
        return {
          ok: false,
          reasonCode: 'spawn_failed',
          message: lease.message,
        };
      }
      return await runtimeFor(lease).start(args);
    },

    async waitForInitialResult(args) {
      if (closed) {
        return {
          ok: false,
          reasonCode: 'not_found',
          message: 'host command runtime is closed.',
        };
      }
      // start·interact와 같은 문을 쓴다. 이 동사만 lease를 건너뛰면, 아직
      // 이 stateRoot를 다룬 적 없는 데몬이 기존 세션을 이어받을 때 배치가
      // 확정되지 않아 인라인으로 새는 창이 생긴다.
      const lease = await ensureLease(args.stateRoot);
      if (!lease.ok) {
        return {
          ok: false,
          reasonCode: 'not_found',
          message: lease.message,
        };
      }
      const result = await runtimeFor(lease).waitForInitialResult(args);
      if (result.ok && result.value.outputRef !== null) {
        const parsedOutputRef = parseHostCommandOutputRef(
          result.value.outputRef,
        );
        // §5.6 claims bridge a model-visible result to transcript persistence.
        // System sessions are daemon-internal and never enter a transcript; their
        // active runtime/worker pin already preserves them while a caller needs
        // paging. Retaining one here would preserve its terminal artifact forever.
        if (
          !parsedOutputRef.ok ||
          parsedOutputRef.threadId !== SYSTEM_SESSION_OWNER
        ) {
          retainClaimedOutputRef(result.value.outputRef);
        }
      }
      return result;
    },

    async interact(args) {
      if (closed) {
        return {
          ok: false,
          reasonCode: 'output_store_failed',
          message: 'command-host connection was lost.',
        };
      }
      const lease = await ensureLease(args.stateRoot);
      if (!lease.ok) {
        return {
          ok: false,
          reasonCode: 'not_found',
          message: lease.message,
        };
      }
      return await runtimeFor(lease).interact(args);
    },

    async listThreadSessions(args) {
      if (closed) {
        return [];
      }
      const lease = await ensureLease(args.stateRoot);
      return lease.ok ? await runtimeFor(lease).listThreadSessions(args) : [];
    },

    async closeAll(args) {
      closed = true;
      // 워커 링크는 disconnect, 인라인 세션은 종료 — 각 배치의 규범이 다르다.
      const clientResult = await client.closeAll(args);
      const inlineResult = await inline.closeAll(args);
      for (const release of releases.splice(0)) {
        await release();
      }
      leases.clear();
      placements.clear();
      return clientResult.ok ? inlineResult : clientResult;
    },

    async activeOutputRefs(stateRoot) {
      if (closed) {
        return {
          ok: false,
          reason: 'host command runtime is closed.',
        };
      }
      const placement = placements.get(stateRoot);
      if (placement !== undefined && placement.ok) {
        return placement.placement === 'worker'
          ? await client.activeOutputRefs(stateRoot)
          : {
              ok: true,
              refs: new Set(
                inline
                  .listSessions()
                  .filter((session) => session.stateRoot === stateRoot)
                  .map((session) => session.outputRef),
              ),
            };
      }
      // 이 데몬이 아직 이 stateRoot를 다룬 적이 없다 — 워커 쪽에 살아 있는
      // 세션이 있는지는 클라이언트가 lock owner 생존으로 판정한다.
      return await client.activeOutputRefs(stateRoot);
    },

    async describeState(stateRoot) {
      if (closed) {
        return {
          mode: null,
          diagnostic: 'command_host_runtime_closed',
        };
      }
      const placement = await ensureLease(stateRoot);
      return placement.ok
        ? { mode: placement.placement, diagnostic: placement.diagnostic }
        : { mode: null, diagnostic: placement.reasonCode };
    },
  };
}

export { registerHostCommandActiveSessions };
