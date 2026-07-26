import type { HostCommandActiveSessions } from './contract.js';
import {
  isLockOwnerAlive,
  readCommandHostLock,
  resolveCommandHostPaths,
} from './runtime-paths.js';

// P7.5 spec v4 §5.6 — 도달 불가능 산출물 GC는 fail-closed다. 보존 집합은
//   transcript 참조 ∪ 워커 active(session/list) ∪ 데몬 in-flight claimed-ref
// 이고, 이 합집합을 만들 수 없으면 아무 것도 지우지 않는다.
//
// transcript 재기록은 데몬 곳곳(run 파이프라인·branch·compaction)에서
// 일어난다. 포트를 그 호출 사슬 전체에 꿰는 대신, 런타임이 자신을 등록하는
// 단일 지점을 둔다 — 이 모듈이 그 지점이다.

// 등록된 런타임 전부의 합집합을 본다. 하나만 붙들면 나중에 등록한
// 런타임이 앞의 것을 가려서 살아 있는 세션을 보존 집합에서 빠뜨릴 수
// 있다 — 보존은 많을수록 안전하고 적으면 곧바로 유실이다.
const activeSessionPorts = new Set<HostCommandActiveSessions>();

/** 데몬 런타임이 기동 시 자신을 등록한다. 반환값은 해제 함수다. */
export function registerHostCommandActiveSessions(
  port: HostCommandActiveSessions,
): () => void {
  activeSessionPorts.add(port);
  return () => {
    activeSessionPorts.delete(port);
  };
}

// claim 응답 수신 ~ transcript 기록 완료 사이의 ref. 데몬이 죽으면 함께
// 사라지고, 그때는 transcript에 없으므로 모델이 도달할 수 없다 — 수거가
// 곧 정답이다 (§5.6).
const inFlightClaimedRefs = new Set<string>();

export function retainClaimedOutputRef(outputRef: string): void {
  inFlightClaimedRefs.add(outputRef);
}

export function releaseClaimedOutputRefs(refs: Iterable<string>): void {
  for (const ref of refs) {
    inFlightClaimedRefs.delete(ref);
  }
}

export async function resolvePreservedHostCommandRefs(args: {
  stateRoot: string;
  transcriptRefs: ReadonlySet<string>;
}): Promise<
  { ok: true; refs: ReadonlySet<string> } | { ok: false; reason: string }
> {
  const preserved = new Set<string>(args.transcriptRefs);
  for (const ref of inFlightClaimedRefs) {
    preserved.add(ref);
  }
  if (activeSessionPorts.size > 0) {
    for (const port of activeSessionPorts) {
      const active = await port.activeOutputRefs(args.stateRoot);
      // 한 런타임이라도 답하지 못하면 합집합이 불완전하다 — fail-closed.
      if (!active.ok) {
        return active;
      }
      for (const ref of active.refs) {
        preserved.add(ref);
      }
    }
    return { ok: true, refs: preserved };
  }
  // 등록된 런타임이 없다. 워커 부재 판정은 lock owner 사망 확인만이다.
  const ownerAlive = await isCommandHostOwnerAlive(args.stateRoot);
  if (ownerAlive !== false) {
    return {
      ok: false,
      reason:
        ownerAlive === true
          ? 'a live command host owns this state root but is not reachable from here'
          : 'command host ownership could not be determined',
    };
  }
  return { ok: true, refs: preserved };
}

/** true=생존, false=부재 확정, undefined=판정 불가. */
async function isCommandHostOwnerAlive(
  stateRoot: string,
): Promise<boolean | undefined> {
  try {
    const paths = await resolveCommandHostPaths(stateRoot);
    const lock = await readCommandHostLock(paths.lockPath);
    if (lock === 'missing') {
      return false;
    }
    if (lock === 'unparsable') {
      // 신선-미파싱 lock은 stale이 아니다 (§6.2) — 판정 불가.
      return undefined;
    }
    return await isLockOwnerAlive(lock);
  } catch {
    return undefined;
  }
}
