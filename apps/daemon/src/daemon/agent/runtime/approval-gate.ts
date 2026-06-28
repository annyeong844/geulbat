import { assertAgentThreadId as assertValidThreadId } from '../contract.js';
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

interface ResolvedApprovalEntry {
  runId: string;
  threadId: string;
  sessionId: string;
}

export interface ApprovalGate {
  clearApprovalSessionGrants(sessionId: string): void;
  clearApprovalSessionRuntime(sessionId: string): void;
  hasPendingApproval(callId: string, runId: string, threadId: string): boolean;
  hasPendingApprovalForSession(
    callId: string,
    runId: string,
    threadId: string,
    sessionId: string,
  ): boolean;
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
  const resolvedApprovals = new Map<string, ResolvedApprovalEntry>();

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
      for (const [callId, entry] of resolvedApprovals.entries()) {
        if (entry.sessionId === sessionId) {
          resolvedApprovals.delete(callId);
        }
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
    hasPendingApprovalForSession(callId, runId, threadId, sessionId) {
      const validThreadId = assertValidThreadId(threadId);
      const entry = pendingApprovals.get(callId);
      return (
        entry !== undefined &&
        entry.runId === runId &&
        entry.threadId === validThreadId &&
        entry.approvalGrantContext.sessionId === sessionId
      );
    },
    waitForApproval(callId, runId, threadId, approvalGrantContext, signal) {
      const validThreadId = assertValidThreadId(threadId);
      return new Promise((resolve) => {
        let settled = false;
        let abortHandler: (() => void) | undefined;
        const resolveOnce = (decision: ApprovalDecision) => {
          if (settled) {
            return;
          }
          settled = true;
          pendingApprovals.delete(callId);
          resolvedApprovals.set(callId, {
            runId,
            threadId: validThreadId,
            sessionId: approvalGrantContext.sessionId,
          });
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

        abortHandler = () => {
          resolveOnce('aborted');
        };
        if (signal?.aborted) {
          abortHandler();
          return;
        }
        signal?.addEventListener('abort', abortHandler, { once: true });
      });
    },
    resolveApproval(callId, runId, threadId, decision, grantScope = 'once') {
      const validThreadId = assertValidThreadId(threadId);
      const entry = pendingApprovals.get(callId);
      if (entry) {
        if (entry.runId !== runId || entry.threadId !== validThreadId) {
          return 'not_found';
        }
        pendingApprovals.delete(callId);
        resolvedApprovals.set(callId, {
          runId,
          threadId: validThreadId,
          sessionId: entry.approvalGrantContext.sessionId,
        });
        if (decision === 'approved') {
          approvalGrants.registerApprovalGrant(
            entry.approvalGrantContext,
            grantScope,
          );
        }
        entry.resolve(decision);
        return 'resolved';
      }
      const resolved = resolvedApprovals.get(callId);
      if (
        resolved !== undefined &&
        resolved.runId === runId &&
        resolved.threadId === validThreadId
      ) {
        return 'already_resolved';
      }
      return 'not_found';
    },
  };
}
