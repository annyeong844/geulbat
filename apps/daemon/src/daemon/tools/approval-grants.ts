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
  sessionId: string;
  approvalClass: ApprovalClass;
  sideEffectLevel: SideEffectLevel;
  permissionMode: PermissionMode;
}

interface ApprovalGrantBucket {
  run: Set<string>;
  session: Set<string>;
}

export interface ApprovalGrantStore {
  clearApprovalSession(sessionId: string): void;
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
  const approvalGrantsBySession = new Map<string, ApprovalGrantBucket>();

  function getApprovalGrantBucket(sessionId: string): ApprovalGrantBucket {
    const existing = approvalGrantsBySession.get(sessionId);
    if (existing) {
      return existing;
    }

    const next: ApprovalGrantBucket = {
      run: new Set<string>(),
      session: new Set<string>(),
    };
    approvalGrantsBySession.set(sessionId, next);
    return next;
  }

  return {
    clearApprovalSession(sessionId) {
      approvalGrantsBySession.delete(sessionId);
    },
    registerApprovalGrant(approvalGrantContext, grantScope) {
      if (grantScope === 'once') {
        return;
      }

      const store = getApprovalGrantBucket(approvalGrantContext.sessionId);
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
      const store = approvalGrantsBySession.get(approvalGrantContext.sessionId);
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
