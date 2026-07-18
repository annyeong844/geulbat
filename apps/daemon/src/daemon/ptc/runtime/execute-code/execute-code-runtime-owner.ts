import type {
  PtcExecuteCodeCellId,
  PtcExecuteCodeRuntimeCleanupResult,
  PtcExecuteCodeRuntimeResult,
} from './execute-code-runtime-contract.js';
import type { ExecuteCodeStateRuntime } from './execute-code-state-runtime.js';

// PTC execute_code 런타임 도메인 state owner — global-mcp-state 선례를
// 따른다. 팩토리가 공유하던 가변 상태 4개(state-root 런타임 Map, shutdown
// 3단계+epoch, cleanup 단일 비행 promise, cell invocation 중복 제거 캐시)를
// 단독 소유하며 raw Map은 밖으로 나가지 않는다. 이 owner가 소유하는
// invariant:
//
// - shutdown TOCTOU 가드: getStateRuntime은 canonicalize await 전후로
//   shutdownState를 이중 확인해, 닫히는 중에 새 state 런타임이 생기지
//   않는다.
// - cleanup 단일 비행: 동시 closeAll 호출은 같은 cleanup promise에 합류하고,
//   closing→closed 확정과 finishShutdown·clear는 finally에서 보장된다.
// - invocation 단일 비행: 같은 (threadId, invocationId)의 재호출은 살아 있는
//   cell의 결과에 합류하고, settle·비활성·throw 경로에서 entry가 정리된다.
//
// state 런타임 구성·canonicalize·cell 활성 판정·cell 일괄 종료는 정책으로
// 주입받는다. 전이 순서는 owner가, 효과는 정책이 갖는다.
interface PtcExecuteCodeStateRuntimeUnavailable {
  ok: false;
  reasonCode: 'ptc_lab_session_unavailable';
  message: string;
  diagnostics: Record<string, string | number | boolean>;
}

interface PtcExecuteCodeCellInvocationResultEntry {
  result: Promise<PtcExecuteCodeRuntimeResult>;
  threadId: string;
  cellId?: PtcExecuteCodeCellId;
}

interface PtcExecuteCodeCellInvocationSettleHooks {
  onRunningCellSettled?: (args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  }) => Promise<void> | void;
}

interface PtcExecuteCodeRuntimeStatePolicies {
  /** state root의 canonical 경로 해석. 실패 시 throw — owner가
   * `stateRootRealpathFailed` 진단으로 확정한다. */
  canonicalizeStateRoot(stateRoot: string): Promise<string>;
  /** canonical state root의 런타임 번들 구성. throw는 그대로 전파한다. */
  buildStateRuntime(canonicalStateRoot: string): ExecuteCodeStateRuntime;
  /** invocation 캐시의 cell이 아직 세션을 잡고 있는지 판정. */
  isCellActive(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  }): boolean;
  /** shutdown 시 detached cell 일괄 종료(cell 레인이 켜진 경우만 주입). */
  closeCells?(): Promise<void>;
}

interface PtcExecuteCodeRuntimeStateOwner {
  getStateRuntime(
    stateRoot: string,
  ): Promise<
    | { ok: true; value: ExecuteCodeStateRuntime }
    | PtcExecuteCodeStateRuntimeUnavailable
  >;
  runDedupedCellInvocation(args: {
    threadId: string;
    invocationId: string | undefined;
    attempt(
      hooks: PtcExecuteCodeCellInvocationSettleHooks,
    ): Promise<PtcExecuteCodeRuntimeResult>;
  }): Promise<PtcExecuteCodeRuntimeResult>;
  releaseSettledCellInvocation(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
  }): void;
  refreshQueuedPlacements(): void;
  closeAll(args?: {
    signal?: AbortSignal;
  }): Promise<PtcExecuteCodeRuntimeCleanupResult>;
}

export function createPtcExecuteCodeRuntimeStateOwner(
  policies: PtcExecuteCodeRuntimeStatePolicies,
): PtcExecuteCodeRuntimeStateOwner {
  const stateRuntimes = new Map<string, ExecuteCodeStateRuntime>();
  let shutdownState: 'open' | 'closing' | 'closed' = 'open';
  let shutdownEpoch = 0;
  let cleanupPromise: Promise<PtcExecuteCodeRuntimeCleanupResult> | undefined;
  const cellInvocationResultsByKey = new Map<
    string,
    PtcExecuteCodeCellInvocationResultEntry
  >();

  function deleteCellInvocationResultsForThreadCell(args: {
    threadId: string;
    cellId: PtcExecuteCodeCellId;
    entry?: PtcExecuteCodeCellInvocationResultEntry;
  }): void {
    for (const [key, entry] of cellInvocationResultsByKey) {
      if (
        entry.threadId === args.threadId &&
        (args.entry === undefined
          ? entry.cellId === args.cellId
          : entry === args.entry)
      ) {
        cellInvocationResultsByKey.delete(key);
      }
    }
  }

  return {
    async getStateRuntime(stateRoot) {
      if (shutdownState !== 'open') {
        return {
          ok: false,
          reasonCode: 'ptc_lab_session_unavailable',
          message: 'PTC execute_code runtime is shutting down',
          diagnostics: { shutdownState, shutdownEpoch },
        };
      }
      let canonicalStateRoot: string;
      try {
        canonicalStateRoot = await policies.canonicalizeStateRoot(stateRoot);
      } catch {
        return {
          ok: false,
          reasonCode: 'ptc_lab_session_unavailable',
          message: 'PTC execute_code state root is unavailable',
          diagnostics: { stateRootRealpathFailed: true },
        };
      }

      if (shutdownState !== 'open') {
        return {
          ok: false,
          reasonCode: 'ptc_lab_session_unavailable',
          message: 'PTC execute_code runtime is shutting down',
          diagnostics: { shutdownState, shutdownEpoch },
        };
      }

      const current = stateRuntimes.get(canonicalStateRoot);
      if (current !== undefined) {
        return { ok: true, value: current };
      }

      const runtime = policies.buildStateRuntime(canonicalStateRoot);
      stateRuntimes.set(canonicalStateRoot, runtime);
      return { ok: true, value: runtime };
    },

    async runDedupedCellInvocation(args) {
      const invocationKey = buildPtcExecuteCodeInvocationKey({
        threadId: args.threadId,
        invocationId: args.invocationId,
      });
      if (invocationKey === undefined) {
        return await args.attempt({});
      }

      const currentInvocationResult =
        cellInvocationResultsByKey.get(invocationKey);
      if (currentInvocationResult !== undefined) {
        if (currentInvocationResult.cellId !== undefined) {
          if (
            policies.isCellActive({
              threadId: args.threadId,
              cellId: currentInvocationResult.cellId,
            })
          ) {
            return await currentInvocationResult.result;
          }
          cellInvocationResultsByKey.delete(invocationKey);
        } else {
          return await currentInvocationResult.result;
        }
      }

      let invocationEntry: PtcExecuteCodeCellInvocationResultEntry | undefined;
      const invocationResult = args.attempt({
        onRunningCellSettled: ({ threadId, cellId }) => {
          if (invocationEntry === undefined) {
            return;
          }
          deleteCellInvocationResultsForThreadCell({
            threadId,
            cellId,
            entry: invocationEntry,
          });
        },
      });
      invocationEntry = {
        result: invocationResult,
        threadId: args.threadId,
      };
      cellInvocationResultsByKey.set(invocationKey, invocationEntry);
      try {
        const result = await invocationResult;
        if (
          result.ok &&
          result.value.executionSurface === 'node_via_lab_detached_cell' &&
          (result.value.status === 'queued' ||
            result.value.status === 'running')
        ) {
          invocationEntry.cellId = result.value.cellId;
        } else {
          cellInvocationResultsByKey.delete(invocationKey);
        }
        return result;
      } catch (err: unknown) {
        cellInvocationResultsByKey.delete(invocationKey);
        throw err;
      }
    },

    releaseSettledCellInvocation(args) {
      deleteCellInvocationResultsForThreadCell(args);
    },

    refreshQueuedPlacements() {
      for (const stateRuntime of stateRuntimes.values()) {
        stateRuntime.placementCoordinator.refreshQueuedPlacements?.();
      }
    },

    async closeAll(args) {
      if (cleanupPromise !== undefined) {
        return await cleanupPromise;
      }
      if (shutdownState === 'closed') {
        return { ok: true };
      }

      shutdownState = 'closing';
      shutdownEpoch += 1;
      for (const runtime of stateRuntimes.values()) {
        runtime.placementCoordinator.beginShutdown();
      }

      const activeCleanup = (async () => {
        try {
          await policies.closeCells?.();
          cellInvocationResultsByKey.clear();
          let firstFailure: PtcExecuteCodeRuntimeCleanupResult | undefined;
          let stateRuntimeCount = 0;
          for (const runtime of stateRuntimes.values()) {
            stateRuntimeCount += 1;
            const placementCleanup =
              await runtime.placementCoordinator.reapPlacements?.();
            if (
              placementCleanup !== undefined &&
              !placementCleanup.ok &&
              firstFailure === undefined
            ) {
              firstFailure = placementCleanup;
            }
            const cleanup = await runtime.sessionManager.closeAll(
              args?.signal === undefined ? undefined : { signal: args.signal },
            );
            if (!cleanup.ok && firstFailure === undefined) {
              firstFailure = {
                ok: false,
                reasonCode: 'ptc_execute_code_session_cleanup_failed',
                message: 'PTC execute_code session cleanup failed',
                diagnostics: {
                  cleanupReasonCode: cleanup.reasonCode,
                  stateRuntimeCount,
                },
              };
            }
          }
          if (firstFailure !== undefined) {
            return firstFailure;
          }
          return { ok: true as const };
        } finally {
          for (const runtime of stateRuntimes.values()) {
            runtime.placementCoordinator.finishShutdown();
          }
          stateRuntimes.clear();
          shutdownState = 'closed';
        }
      })();
      cleanupPromise = activeCleanup;
      try {
        return await activeCleanup;
      } finally {
        if (cleanupPromise === activeCleanup) {
          cleanupPromise = undefined;
        }
      }
    },
  };
}

function buildPtcExecuteCodeInvocationKey(args: {
  threadId: string;
  invocationId: string | undefined;
}): string | undefined {
  if (args.invocationId === undefined || args.invocationId.length === 0) {
    return undefined;
  }
  return `${args.threadId}\u0000${args.invocationId}`;
}
