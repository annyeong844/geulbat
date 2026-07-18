import { assertAgentRunId, assertAgentThreadId } from '../contract.js';
import type {
  ApprovalGrantContext,
  ApprovalGrantScope,
  ApprovalGrantStore,
} from '../../tools/approval-grants.js';
import type {
  RunCheckpointApproval,
  RunCheckpointStore,
} from '../../sessions/run-checkpoint-store.js';

type ApprovalDecision = 'approved' | 'denied' | 'aborted';
type DurableApprovalDecision = Exclude<ApprovalDecision, 'aborted'>;

interface PendingApprovalEntry {
  runId: string;
  threadId: string;
  approvalGrantContext: ApprovalGrantContext;
  resolve: (decision: ApprovalDecision) => void;
  reject: (error: unknown) => void;
}

interface ResolvedApprovalEntry {
  runId: string;
  threadId: string;
  sessionId: string;
}

type ApprovalCheckpointMutationResult =
  | { ok: true; approval: RunCheckpointApproval }
  | { ok: false; code: string };

interface ApprovalCheckpointPort {
  recordApprovalPending(
    args: Parameters<RunCheckpointStore['recordApprovalPending']>[0],
  ): Promise<ApprovalCheckpointMutationResult>;
  recordApprovalDecision(
    args: Parameters<RunCheckpointStore['recordApprovalDecision']>[0],
  ): Promise<ApprovalCheckpointMutationResult>;
}

export interface ApprovalGate {
  clearApprovalSessionGrants(sessionId: string): void;
  clearApprovalSessionRuntime(sessionId: string): void;
  rebindApprovalSessionRuntime(
    previousSessionId: string,
    nextSessionId: string,
  ): void;
  // Existence probe only — does a pending approval entry exist for this triple.
  // NOT an authorization check: it ignores the caller's session. For any
  // authorization decision use hasPendingApprovalForSession, which binds the
  // pending entry to the caller's approval session.
  hasPendingApprovalEntry(
    callId: string,
    runId: string,
    threadId: string,
  ): boolean;
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
    onPending?: () => void,
  ): Promise<ApprovalDecision>;
  resolveApproval(
    callId: string,
    runId: string,
    threadId: string,
    decision: DurableApprovalDecision,
    grantScope?: ApprovalGrantScope,
  ): Promise<'resolved' | 'already_resolved' | 'not_found'>;
}

export function createApprovalGate(args: {
  approvalGrants: ApprovalGrantStore;
  runCheckpoints: ApprovalCheckpointPort;
}): ApprovalGate {
  const { approvalGrants, runCheckpoints } = args;
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
    rebindApprovalSessionRuntime(previousSessionId, nextSessionId) {
      if (previousSessionId === nextSessionId) {
        return;
      }
      for (const entry of pendingApprovals.values()) {
        if (entry.approvalGrantContext.sessionId !== previousSessionId) {
          continue;
        }
        entry.approvalGrantContext = {
          ...entry.approvalGrantContext,
          sessionId: nextSessionId,
        };
      }
      for (const entry of resolvedApprovals.values()) {
        if (entry.sessionId === previousSessionId) {
          entry.sessionId = nextSessionId;
        }
      }
      approvalGrants.rebindApprovalRunGrants(previousSessionId, nextSessionId);
    },
    hasPendingApprovalEntry(callId, runId, threadId) {
      const validThreadId = assertAgentThreadId(threadId);
      const entry = pendingApprovals.get(callId);
      return (
        entry !== undefined &&
        entry.runId === runId &&
        entry.threadId === validThreadId
      );
    },
    hasPendingApprovalForSession(callId, runId, threadId, sessionId) {
      const validThreadId = assertAgentThreadId(threadId);
      const entry = pendingApprovals.get(callId);
      return (
        entry !== undefined &&
        entry.runId === runId &&
        entry.threadId === validThreadId &&
        entry.approvalGrantContext.sessionId === sessionId
      );
    },
    async waitForApproval(
      callId,
      runId,
      threadId,
      approvalGrantContext,
      signal,
      onPending,
    ) {
      const validRunId = assertAgentRunId(runId);
      const validThreadId = assertAgentThreadId(threadId);
      let settled = false;
      let abortHandler: (() => void) | undefined;
      let settleWait: (decision: ApprovalDecision) => void = () => undefined;
      let rejectWait: (error: unknown) => void = () => undefined;
      const wait = new Promise<ApprovalDecision>((resolve, reject) => {
        settleWait = resolve;
        rejectWait = reject;
      });
      const resolveOnce = (decision: ApprovalDecision) => {
        if (settled) {
          return;
        }
        settled = true;
        if (pendingApprovals.get(callId) === entry) {
          pendingApprovals.delete(callId);
        }
        resolvedApprovals.set(callId, {
          runId: validRunId,
          threadId: validThreadId,
          sessionId: approvalGrantContext.sessionId,
        });
        if (abortHandler && signal) {
          signal.removeEventListener('abort', abortHandler);
        }
        settleWait(decision);
      };
      const rejectOnce = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        if (pendingApprovals.get(callId) === entry) {
          pendingApprovals.delete(callId);
        }
        if (abortHandler && signal) {
          signal.removeEventListener('abort', abortHandler);
        }
        rejectWait(error);
      };
      const entry: PendingApprovalEntry = {
        runId: validRunId,
        threadId: validThreadId,
        approvalGrantContext,
        resolve: resolveOnce,
        reject: rejectOnce,
      };
      pendingApprovals.set(callId, entry);

      abortHandler = () => {
        resolveOnce('aborted');
      };
      if (signal?.aborted) {
        abortHandler();
      } else {
        signal?.addEventListener('abort', abortHandler, { once: true });
      }

      try {
        const checkpointResult = await runCheckpoints.recordApprovalPending({
          threadId: validThreadId,
          runId: validRunId,
          callId,
          approvalClass: approvalGrantContext.approvalClass,
        });
        if (!checkpointResult.ok) {
          throw new Error(
            `approval checkpoint unavailable: ${checkpointResult.code}`,
          );
        }
        if (!settled && checkpointResult.approval.status === 'decided') {
          const durableApproval = checkpointResult.approval;
          if (
            durableApproval.decision === 'approved' &&
            durableApproval.grantScope === 'run'
          ) {
            approvalGrants.registerApprovalGrant(
              approvalGrantContext,
              durableApproval.grantScope,
            );
          }
          resolveOnce(durableApproval.decision);
        } else if (!settled) {
          onPending?.();
        }
      } catch (error: unknown) {
        rejectOnce(error);
      }

      return await wait;
    },
    async resolveApproval(
      callId,
      runId,
      threadId,
      decision,
      grantScope = 'once',
    ) {
      const validRunId = assertAgentRunId(runId);
      const validThreadId = assertAgentThreadId(threadId);
      const entry = pendingApprovals.get(callId);
      if (entry) {
        if (entry.runId !== validRunId || entry.threadId !== validThreadId) {
          return 'not_found';
        }
        const checkpointResult = await runCheckpoints.recordApprovalDecision({
          threadId: validThreadId,
          runId: validRunId,
          callId,
          decision,
          grantScope,
        });
        if (!checkpointResult.ok) {
          return checkpointResult.code === 'approval_conflict'
            ? 'already_resolved'
            : 'not_found';
        }
        if (pendingApprovals.get(callId) !== entry) {
          return 'already_resolved';
        }
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
        resolved.runId === validRunId &&
        resolved.threadId === validThreadId
      ) {
        return 'already_resolved';
      }
      return 'not_found';
    },
  };
}
