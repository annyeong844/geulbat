import type {
  ApprovalClass,
  ApprovalGrantScope,
  PermissionMode,
} from '@geulbat/protocol/run-approval';
import type { SideEffectLevel } from '@geulbat/protocol/run-events';

export type { ApprovalGrantScope } from '@geulbat/protocol/run-approval';
export type { ApprovalClass } from '@geulbat/protocol/run-approval';

export interface ApprovalGrantContext {
  runId: string;
  computerSessionId: string;
  approvalClass: ApprovalClass;
  sideEffectLevel: SideEffectLevel;
  permissionMode: PermissionMode;
}

interface ApprovalGrantBucket {
  run: Set<string>;
  session: Set<string>;
}

export interface ApprovalGrantStore {
  clearComputerSession(computerSessionId: string): void;
  clearRun(computerSessionId: string, runId: string): void;
  rebindRun(
    previousComputerSessionId: string,
    nextComputerSessionId: string,
    runId: string,
  ): void;
  registerApprovalGrant(
    approvalGrantContext: ApprovalGrantContext,
    grantScope: ApprovalGrantScope,
  ): void;
  hasApprovalGrant(approvalGrantContext: ApprovalGrantContext): boolean;
}

/**
 * A reusable grant is keyed by both the approval class and the side-effect level
 * the user actually saw.
 *
 * The prompt shows `approvalClass`, `sideEffectLevel`, and an arguments preview.
 * Of those, destructiveness is the only dimension that stays meaningful across
 * later calls, so it belongs in the key: a pass granted for a `write` call must
 * not silently cover a `destructive` one. Arguments are deliberately excluded
 * because they change every call, which would collapse `run` and `session` into
 * `once`.
 *
 * Today the class and the level happen to co-vary — `resolveApprovalClass()`
 * narrows `manage_files` per operation while `resolveRuntimeSideEffectLevel()`
 * separately raises the delete operation to `destructive`. Those are two
 * independent functions, so the key must not depend on them agreeing.
 */
function buildScopedApprovalKey(
  scopeId: string,
  approvalClass: ApprovalClass,
  sideEffectLevel: SideEffectLevel,
): string {
  return `${scopeId}::${approvalClass}::${sideEffectLevel}`;
}

function buildSessionApprovalKey(
  approvalClass: ApprovalClass,
  sideEffectLevel: SideEffectLevel,
): string {
  return `${approvalClass}::${sideEffectLevel}`;
}

export function createApprovalGrantStore(): ApprovalGrantStore {
  const approvalGrantsByComputerSession = new Map<
    string,
    ApprovalGrantBucket
  >();

  function getApprovalGrantBucket(
    computerSessionId: string,
  ): ApprovalGrantBucket {
    const existing = approvalGrantsByComputerSession.get(computerSessionId);
    if (existing) {
      return existing;
    }

    const next: ApprovalGrantBucket = {
      run: new Set<string>(),
      session: new Set<string>(),
    };
    approvalGrantsByComputerSession.set(computerSessionId, next);
    return next;
  }

  return {
    clearComputerSession(computerSessionId) {
      approvalGrantsByComputerSession.delete(computerSessionId);
    },
    clearRun(computerSessionId, runId) {
      const store = approvalGrantsByComputerSession.get(computerSessionId);
      if (!store) {
        return;
      }
      const runKeyPrefix = `${runId}::`;
      for (const approvalKey of store.run) {
        if (approvalKey.startsWith(runKeyPrefix)) {
          store.run.delete(approvalKey);
        }
      }
      if (store.run.size === 0 && store.session.size === 0) {
        approvalGrantsByComputerSession.delete(computerSessionId);
      }
    },
    rebindRun(previousComputerSessionId, nextComputerSessionId, runId) {
      if (previousComputerSessionId === nextComputerSessionId) {
        return;
      }
      const previous = approvalGrantsByComputerSession.get(
        previousComputerSessionId,
      );
      if (!previous) {
        return;
      }
      const runKeyPrefix = `${runId}::`;
      const matchingRunGrants = [...previous.run].filter((approvalKey) =>
        approvalKey.startsWith(runKeyPrefix),
      );
      if (matchingRunGrants.length === 0) {
        return;
      }
      const next = getApprovalGrantBucket(nextComputerSessionId);
      for (const approvalKey of matchingRunGrants) {
        previous.run.delete(approvalKey);
        next.run.add(approvalKey);
      }
      if (previous.run.size === 0 && previous.session.size === 0) {
        approvalGrantsByComputerSession.delete(previousComputerSessionId);
      }
    },
    registerApprovalGrant(approvalGrantContext, grantScope) {
      if (grantScope === 'once') {
        return;
      }

      const store = getApprovalGrantBucket(
        approvalGrantContext.computerSessionId,
      );
      switch (grantScope) {
        case 'run':
          store.run.add(
            buildScopedApprovalKey(
              approvalGrantContext.runId,
              approvalGrantContext.approvalClass,
              approvalGrantContext.sideEffectLevel,
            ),
          );
          return;
        case 'session':
          store.session.add(
            buildSessionApprovalKey(
              approvalGrantContext.approvalClass,
              approvalGrantContext.sideEffectLevel,
            ),
          );
          return;
      }
    },
    hasApprovalGrant(approvalGrantContext) {
      const store = approvalGrantsByComputerSession.get(
        approvalGrantContext.computerSessionId,
      );
      if (!store) {
        return false;
      }

      if (
        store.session.has(
          buildSessionApprovalKey(
            approvalGrantContext.approvalClass,
            approvalGrantContext.sideEffectLevel,
          ),
        )
      ) {
        return true;
      }

      return store.run.has(
        buildScopedApprovalKey(
          approvalGrantContext.runId,
          approvalGrantContext.approvalClass,
          approvalGrantContext.sideEffectLevel,
        ),
      );
    },
  };
}
