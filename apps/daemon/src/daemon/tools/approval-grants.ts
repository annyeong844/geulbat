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
  registerApprovalGrant(
    approvalGrantContext: ApprovalGrantContext,
    grantScope: ApprovalGrantScope,
  ): void;
  hasApprovalGrant(approvalGrantContext: ApprovalGrantContext): boolean;
}

function buildScopedApprovalKey(
  scopeId: string,
  approvalClass: ApprovalClass,
): string {
  return `${scopeId}::${approvalClass}`;
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
            ),
          );
          return;
        case 'session':
          store.session.add(approvalGrantContext.approvalClass);
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

      if (store.session.has(approvalGrantContext.approvalClass)) {
        return true;
      }

      return store.run.has(
        buildScopedApprovalKey(
          approvalGrantContext.runId,
          approvalGrantContext.approvalClass,
        ),
      );
    },
  };
}
