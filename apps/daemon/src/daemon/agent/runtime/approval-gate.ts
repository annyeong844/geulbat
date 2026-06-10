import { assertThreadId as assertValidThreadId } from '@geulbat/protocol/ids';
import {
  type ApprovalGrantContext,
  type ApprovalGrantScope,
  type ApprovalGrantStore,
} from '../../tools/approval-grants.js';

type ApprovalDecision = 'approved' | 'denied' | 'aborted';

interface PendingApprovalEntry {
  runId: string;
  threadId: string;
  approvalGrantContext: ApprovalGrantContext;
  resolve: (decision: ApprovalDecision) => void;
}

const RESOLVED_TTL_MS = 30 * 60 * 1000;
const MAX_RESOLVED_APPROVALS = 1024;
const APPROVAL_WAIT_TIMEOUT_MS = 30 * 60 * 1000;

export interface ApprovalGate {
  clearApprovalSessionGrants(sessionId: string): void;
  clearApprovalSessionRuntime(sessionId: string): void;
  hasPendingApproval(callId: string, runId: string, threadId: string): boolean;
  waitForApproval(
    callId: string,
    runId: string,
    threadId: string,
    approvalGrantContext: ApprovalGrantContext,
    signal?: AbortSignal,
  ): Promise<ApprovalDecision>;
  resolveApproval(
    callId: string,
    runId: string,
    threadId: string,
    decision: ApprovalDecision,
    grantScope?: ApprovalGrantScope,
  ): 'resolved' | 'already_resolved' | 'not_found';
}

export function createApprovalGate(args: {
  approvalGrants: ApprovalGrantStore;
}): ApprovalGate {
  const { approvalGrants } = args;
  const pendingApprovals = new Map<string, PendingApprovalEntry>();
  const resolvedApprovals = new Map<string, number>();

  function pruneResolvedApprovals(now = Date.now()): void {
    for (const [callId, resolvedAt] of resolvedApprovals) {
      if (now - resolvedAt > RESOLVED_TTL_MS) {
        resolvedApprovals.delete(callId);
      }
    }

    while (resolvedApprovals.size > MAX_RESOLVED_APPROVALS) {
      const oldestKey = resolvedApprovals.keys().next().value;
      if (!oldestKey) break;
      resolvedApprovals.delete(oldestKey);
    }
  }

  return {
    clearApprovalSessionGrants(sessionId) {
      approvalGrants.clearApprovalSession(sessionId);
    },
    clearApprovalSessionRuntime(sessionId) {
      const pendingForSession = [...pendingApprovals.entries()].filter(
        ([, entry]) => entry.approvalGrantContext.sessionId === sessionId,
      );
      for (const [, entry] of pendingForSession) {
        entry.resolve('aborted');
      }
      approvalGrants.clearApprovalSession(sessionId);
    },
    hasPendingApproval(callId, runId, threadId) {
      const validThreadId = assertValidThreadId(threadId);
      const entry = pendingApprovals.get(callId);
      return (
        entry !== undefined &&
        entry.runId === runId &&
        entry.threadId === validThreadId
      );
    },
    waitForApproval(callId, runId, threadId, approvalGrantContext, signal) {
      const validThreadId = assertValidThreadId(threadId);
      pruneResolvedApprovals();
      return new Promise((resolve) => {
        let settled = false;
        let abortHandler: (() => void) | undefined;
        const resolveOnce = (decision: ApprovalDecision) => {
          if (settled) {
            return;
          }
          settled = true;
          pendingApprovals.delete(callId);
          resolvedApprovals.set(callId, Date.now());
          clearTimeout(timeout);
          if (abortHandler && signal) {
            signal.removeEventListener('abort', abortHandler);
          }
          resolve(decision);
        };

        pendingApprovals.set(callId, {
          runId,
          threadId: validThreadId,
          approvalGrantContext,
          resolve: resolveOnce,
        });
        const timeout = setTimeout(
          () => resolveOnce('aborted'),
          APPROVAL_WAIT_TIMEOUT_MS,
        );

        abortHandler = () => {
          resolveOnce('aborted');
        };
        signal?.addEventListener('abort', abortHandler, { once: true });
      });
    },
    resolveApproval(callId, runId, threadId, decision, grantScope = 'once') {
      const validThreadId = assertValidThreadId(threadId);
      pruneResolvedApprovals();
      const entry = pendingApprovals.get(callId);
      if (entry) {
        if (entry.runId !== runId || entry.threadId !== validThreadId) {
          return 'not_found';
        }
        pendingApprovals.delete(callId);
        resolvedApprovals.set(callId, Date.now());
        if (decision === 'approved') {
          approvalGrants.registerApprovalGrant(
            entry.approvalGrantContext,
            grantScope,
          );
        }
        entry.resolve(decision);
        return 'resolved';
      }
      if (resolvedApprovals.has(callId)) {
        return 'already_resolved';
      }
      return 'not_found';
    },
  };
}
