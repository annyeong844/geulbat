import type {
  PtcSessionDockerFailureReason,
  PtcSessionDockerIdentity,
  PtcSessionDockerManager,
} from './session-docker-contract.js';

export type PtcSessionTaintCloseOutcome =
  | {
      closeAttempted: true;
      closeProven: true;
      closeStatus: 'succeeded';
      reuseAllowed: false;
      sessionTainted: true;
    }
  | {
      closeAttempted: true;
      closeProven: false;
      closeStatus: 'failed_result';
      reuseAllowed: false;
      sessionReasonCode: PtcSessionDockerFailureReason;
      sessionTainted: true;
    }
  | {
      closeAttempted: true;
      closeProven: false;
      closeStatus: 'threw';
      reuseAllowed: false;
      sessionTainted: true;
    };

export type PtcSessionTaintCloseDiagnostics = {
  sessionCloseFailed: true;
  sessionTainted: true;
  sessionReasonCode?: PtcSessionDockerFailureReason;
};

export interface PtcSessionTaintCloseInput {
  identity: PtcSessionDockerIdentity;
  sessionManager: Pick<PtcSessionDockerManager, 'close'>;
}

export type PtcSessionTaintCloseCommandDecision =
  | { kind: 'exit' }
  | {
      kind: 'timeout' | 'cancelled';
      processTerminated?: boolean;
    }
  | {
      kind: 'output_limit_exceeded';
      processTerminated?: boolean;
    }
  | { kind: 'crash' };

export function shouldCloseTaintedPtcDockerSessionForCommandResult(
  result: PtcSessionTaintCloseCommandDecision,
): boolean {
  if (result.kind === 'exit') {
    return false;
  }
  if (result.kind === 'crash') {
    return true;
  }
  return result.processTerminated !== true;
}

export function toPtcSessionTaintCloseDiagnostics(
  outcome: PtcSessionTaintCloseOutcome,
): PtcSessionTaintCloseDiagnostics | undefined {
  if (outcome.closeProven) {
    return undefined;
  }
  return {
    sessionCloseFailed: true,
    sessionTainted: true,
    ...(outcome.closeStatus === 'failed_result'
      ? { sessionReasonCode: outcome.sessionReasonCode }
      : {}),
  };
}

export async function closeTaintedPtcDockerSession(
  args: PtcSessionTaintCloseInput,
): Promise<PtcSessionTaintCloseOutcome> {
  try {
    const close = await args.sessionManager.close(args.identity);
    if (close.ok) {
      return {
        closeAttempted: true,
        closeProven: true,
        closeStatus: 'succeeded',
        reuseAllowed: false,
        sessionTainted: true,
      };
    }
    return {
      closeAttempted: true,
      closeProven: false,
      closeStatus: 'failed_result',
      reuseAllowed: false,
      sessionReasonCode: close.reasonCode,
      sessionTainted: true,
    };
  } catch {
    return {
      closeAttempted: true,
      closeProven: false,
      closeStatus: 'threw',
      reuseAllowed: false,
      sessionTainted: true,
    };
  }
}
