import {
  assertAgentRunId,
  assertAgentThreadId,
  type PermissionMode,
} from '../contract.js';
import type {
  ApprovalGrantContext,
  ApprovalGrantScope,
  ApprovalGrantStore,
} from '../../tools/approval-grants.js';
import type {
  RunCheckpointApproval,
  RunCheckpointStore,
} from '../../sessions/run-checkpoint-store.js';
import { runDetached } from '../../utils/run-detached.js';

type ApprovalDecision = 'approved' | 'denied' | 'aborted';
type DurableApprovalDecision = Exclude<ApprovalDecision, 'aborted'>;

interface PendingApprovalEntry {
  runId: string;
  threadId: string;
  approvalGrantContext: ApprovalGrantContext;
  onComputerSessionIdChange?: (computerSessionId: string) => void;
  onPermissionModeChange?: (permissionMode: PermissionMode) => void;
  abort: (forgetResolved: boolean) => void;
  resolve: (
    decision: ApprovalDecision,
    grantScope?: ApprovalGrantScope,
    permissionMode?: PermissionMode,
  ) => void;
  reject: (error: unknown) => void;
}

interface ResolvedApprovalEntry {
  runId: string;
  threadId: string;
  computerSessionId: string;
  decision: ApprovalDecision;
  grantScope: ApprovalGrantScope | undefined;
  permissionMode: PermissionMode | undefined;
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
  clearComputerSessionGrants(computerSessionId: string): void;
  clearComputerSessionRuntime(computerSessionId: string): void;
  clearRunRuntime(computerSessionId: string, runId: string): void;
  rebindPendingRunApprovals(
    runId: string,
    threadId: string,
    computerSessionId: string,
  ): number;
  // Existence probe only — does a pending approval entry exist for this triple.
  // NOT an authorization check: it ignores the caller's session. For any
  // authorization decision use hasApprovalDecisionAuthority, which binds the
  // exact pending/resolved entry to the caller's computer session.
  hasPendingApprovalEntry(
    callId: string,
    runId: string,
    threadId: string,
  ): boolean;
  hasApprovalDecisionAuthority(
    callId: string,
    runId: string,
    threadId: string,
    computerSessionId: string,
  ): boolean;
  waitForApproval(
    callId: string,
    runId: string,
    threadId: string,
    approvalGrantContext: ApprovalGrantContext,
    signal?: AbortSignal,
    onPending?: () => void,
    onPermissionModeChange?: (permissionMode: PermissionMode) => void,
    onComputerSessionIdChange?: (computerSessionId: string) => void,
  ): Promise<ApprovalDecision>;
  resolveApproval(
    callId: string,
    runId: string,
    threadId: string,
    decision: DurableApprovalDecision,
    grantScope?: ApprovalGrantScope,
    permissionMode?: PermissionMode,
  ): Promise<'resolved' | 'already_resolved' | 'not_found'>;
}

function approvalRuntimeIdentityKey(
  callId: string,
  runId: string,
  threadId: string,
): string {
  return JSON.stringify([callId, runId, threadId]);
}

export function createApprovalGate(args: {
  approvalGrants: ApprovalGrantStore;
  runCheckpoints: ApprovalCheckpointPort;
}): ApprovalGate {
  const { approvalGrants, runCheckpoints } = args;
  const pendingApprovals = new Map<string, PendingApprovalEntry>();
  const resolvedApprovals = new Map<string, ResolvedApprovalEntry>();

  return {
    clearComputerSessionGrants(computerSessionId) {
      approvalGrants.clearComputerSession(computerSessionId);
    },
    clearComputerSessionRuntime(computerSessionId) {
      const pendingForSession = [...pendingApprovals.entries()].filter(
        ([, entry]) =>
          entry.approvalGrantContext.computerSessionId === computerSessionId,
      );
      for (const [, entry] of pendingForSession) {
        entry.abort(true);
      }
      for (const [identityKey, entry] of resolvedApprovals.entries()) {
        if (entry.computerSessionId === computerSessionId) {
          resolvedApprovals.delete(identityKey);
        }
      }
      approvalGrants.clearComputerSession(computerSessionId);
    },
    clearRunRuntime(computerSessionId, runId) {
      const validRunId = assertAgentRunId(runId);
      const pendingForRun = [...pendingApprovals.entries()].filter(
        ([, entry]) =>
          entry.runId === validRunId &&
          entry.approvalGrantContext.computerSessionId === computerSessionId,
      );
      for (const [, entry] of pendingForRun) {
        entry.abort(true);
      }
      for (const [identityKey, entry] of resolvedApprovals.entries()) {
        if (
          entry.runId === validRunId &&
          entry.computerSessionId === computerSessionId
        ) {
          resolvedApprovals.delete(identityKey);
        }
      }
      approvalGrants.clearRun(computerSessionId, validRunId);
    },
    rebindPendingRunApprovals(runId, threadId, computerSessionId) {
      const validRunId = assertAgentRunId(runId);
      const validThreadId = assertAgentThreadId(threadId);
      let reboundCount = 0;
      for (const entry of pendingApprovals.values()) {
        if (
          entry.runId !== validRunId ||
          entry.threadId !== validThreadId ||
          entry.approvalGrantContext.computerSessionId === computerSessionId
        ) {
          continue;
        }
        const previousComputerSessionId =
          entry.approvalGrantContext.computerSessionId;
        approvalGrants.rebindRun(
          previousComputerSessionId,
          computerSessionId,
          validRunId,
        );
        entry.approvalGrantContext.computerSessionId = computerSessionId;
        entry.onComputerSessionIdChange?.(computerSessionId);
        reboundCount += 1;
      }
      return reboundCount;
    },
    hasPendingApprovalEntry(callId, runId, threadId) {
      const validThreadId = assertAgentThreadId(threadId);
      const identityKey = approvalRuntimeIdentityKey(
        callId,
        runId,
        validThreadId,
      );
      const entry = pendingApprovals.get(identityKey);
      return (
        entry !== undefined &&
        entry.runId === runId &&
        entry.threadId === validThreadId
      );
    },
    hasApprovalDecisionAuthority(callId, runId, threadId, computerSessionId) {
      const validThreadId = assertAgentThreadId(threadId);
      const identityKey = approvalRuntimeIdentityKey(
        callId,
        runId,
        validThreadId,
      );
      const pending = pendingApprovals.get(identityKey);
      if (pending !== undefined) {
        return (
          pending.runId === runId &&
          pending.threadId === validThreadId &&
          pending.approvalGrantContext.computerSessionId === computerSessionId
        );
      }
      const resolved = resolvedApprovals.get(identityKey);
      return (
        resolved !== undefined &&
        resolved.runId === runId &&
        resolved.threadId === validThreadId &&
        resolved.computerSessionId === computerSessionId
      );
    },
    async waitForApproval(
      callId,
      runId,
      threadId,
      approvalGrantContext,
      signal,
      onPending,
      onPermissionModeChange,
      onComputerSessionIdChange,
    ) {
      const validRunId = assertAgentRunId(runId);
      const validThreadId = assertAgentThreadId(threadId);
      const identityKey = approvalRuntimeIdentityKey(
        callId,
        validRunId,
        validThreadId,
      );
      let settled = false;
      let durablePendingRegistered = false;
      let abortRequested = false;
      let forgetResolvedOnSettlement = false;
      let abortSettlement: Promise<void> | undefined;
      let abortHandler: (() => void) | undefined;
      let settleWait: (decision: ApprovalDecision) => void = () => undefined;
      let rejectWait: (error: unknown) => void = () => undefined;
      const wait = new Promise<ApprovalDecision>((resolve, reject) => {
        settleWait = resolve;
        rejectWait = reject;
      });
      const resolveOnce = (
        decision: ApprovalDecision,
        grantScope?: ApprovalGrantScope,
        permissionMode?: PermissionMode,
      ) => {
        if (settled) {
          return;
        }
        settled = true;
        if (pendingApprovals.get(identityKey) === entry) {
          pendingApprovals.delete(identityKey);
        }
        if (forgetResolvedOnSettlement) {
          resolvedApprovals.delete(identityKey);
        } else {
          resolvedApprovals.set(identityKey, {
            runId: validRunId,
            threadId: validThreadId,
            computerSessionId: approvalGrantContext.computerSessionId,
            decision,
            grantScope,
            permissionMode,
          });
        }
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
        if (pendingApprovals.get(identityKey) === entry) {
          pendingApprovals.delete(identityKey);
        }
        if (abortHandler && signal) {
          signal.removeEventListener('abort', abortHandler);
        }
        rejectWait(error);
      };
      const settleDurableApproval = (
        durableApproval: RunCheckpointApproval,
      ): boolean => {
        if (durableApproval.status === 'pending') {
          return false;
        }
        if (
          durableApproval.decision === 'approved' &&
          !forgetResolvedOnSettlement
        ) {
          approvalGrants.registerApprovalGrant(
            approvalGrantContext,
            durableApproval.grantScope,
          );
        }
        resolveOnce(
          durableApproval.decision,
          durableApproval.decision === 'aborted'
            ? undefined
            : durableApproval.grantScope,
          durableApproval.decision === 'approved'
            ? approvalGrantContext.permissionMode
            : undefined,
        );
        return true;
      };
      const settleAbortDurably = (): Promise<void> => {
        if (!abortRequested || !durablePendingRegistered || settled) {
          return Promise.resolve();
        }
        if (abortSettlement !== undefined) {
          return abortSettlement;
        }
        abortSettlement = (async () => {
          try {
            const checkpointResult =
              await runCheckpoints.recordApprovalDecision({
                threadId: validThreadId,
                runId: validRunId,
                callId,
                decision: 'aborted',
              });
            if (settled) {
              return;
            }
            if (checkpointResult.ok) {
              settleDurableApproval(checkpointResult.approval);
              return;
            }
            if (
              checkpointResult.code === 'not_found' ||
              checkpointResult.code === 'terminal'
            ) {
              resolveOnce('aborted');
              return;
            }
            if (checkpointResult.code === 'approval_conflict') {
              const currentResult = await runCheckpoints.recordApprovalPending({
                threadId: validThreadId,
                runId: validRunId,
                callId,
                approvalClass: approvalGrantContext.approvalClass,
              });
              if (settled) {
                return;
              }
              if (
                currentResult.ok &&
                settleDurableApproval(currentResult.approval)
              ) {
                return;
              }
              if (
                !currentResult.ok &&
                (currentResult.code === 'not_found' ||
                  currentResult.code === 'terminal')
              ) {
                resolveOnce('aborted');
                return;
              }
            }
            rejectOnce(
              new Error(
                `approval checkpoint unavailable: ${checkpointResult.code}`,
              ),
            );
          } catch (error: unknown) {
            rejectOnce(error);
          }
        })();
        return abortSettlement;
      };
      const requestAbort = (forgetResolved: boolean) => {
        abortRequested = true;
        forgetResolvedOnSettlement ||= forgetResolved;
        runDetached('agent/approval-abort-settlement', settleAbortDurably);
      };
      const entry: PendingApprovalEntry = {
        runId: validRunId,
        threadId: validThreadId,
        approvalGrantContext,
        ...(onPermissionModeChange === undefined
          ? {}
          : { onPermissionModeChange }),
        ...(onComputerSessionIdChange === undefined
          ? {}
          : { onComputerSessionIdChange }),
        abort: requestAbort,
        resolve: resolveOnce,
        reject: rejectOnce,
      };
      pendingApprovals.set(identityKey, entry);

      abortHandler = () => requestAbort(false);
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
          if (
            abortRequested &&
            (checkpointResult.code === 'not_found' ||
              checkpointResult.code === 'terminal')
          ) {
            resolveOnce('aborted');
            return await wait;
          }
          throw new Error(
            `approval checkpoint unavailable: ${checkpointResult.code}`,
          );
        }
        durablePendingRegistered = true;
        const durableDecisionSettled = settleDurableApproval(
          checkpointResult.approval,
        );
        if (!durableDecisionSettled) {
          if (abortRequested) {
            await settleAbortDurably();
          } else if (!settled) {
            onPending?.();
          }
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
      permissionMode,
    ) {
      const validRunId = assertAgentRunId(runId);
      const validThreadId = assertAgentThreadId(threadId);
      const identityKey = approvalRuntimeIdentityKey(
        callId,
        validRunId,
        validThreadId,
      );
      const readResolvedResult = ():
        | 'resolved'
        | 'already_resolved'
        | undefined => {
        const resolved = resolvedApprovals.get(identityKey);
        if (
          resolved === undefined ||
          resolved.runId !== validRunId ||
          resolved.threadId !== validThreadId
        ) {
          return undefined;
        }
        return resolved.decision === decision &&
          resolved.grantScope === grantScope &&
          (permissionMode === undefined ||
            resolved.permissionMode === permissionMode)
          ? 'resolved'
          : 'already_resolved';
      };
      const entry = pendingApprovals.get(identityKey);
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
          ...(permissionMode === undefined ? {} : { permissionMode }),
        });
        if (!checkpointResult.ok) {
          return checkpointResult.code === 'approval_conflict'
            ? 'already_resolved'
            : 'not_found';
        }
        if (pendingApprovals.get(identityKey) !== entry) {
          return readResolvedResult() ?? 'already_resolved';
        }
        if (decision === 'approved') {
          if (permissionMode !== undefined) {
            entry.approvalGrantContext.permissionMode = permissionMode;
            entry.onPermissionModeChange?.(permissionMode);
          }
          approvalGrants.registerApprovalGrant(
            entry.approvalGrantContext,
            grantScope,
          );
        }
        entry.resolve(decision, grantScope, permissionMode);
        return 'resolved';
      }
      return readResolvedResult() ?? 'not_found';
    },
  };
}
