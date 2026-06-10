import type {
  PtcSessionDockerFailureReason,
  PtcSessionDockerIdentity,
  PtcSessionDockerManager,
} from './session-docker-contract.js';

export type PtcSessionTaintCloseStatus =
  | 'succeeded'
  | 'failed_result'
  | 'threw';

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

export interface PtcSessionTaintCloseInput {
  identity: PtcSessionDockerIdentity;
  sessionManager: Pick<PtcSessionDockerManager, 'close'>;
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
