import type { ErrorCode } from '@geulbat/protocol/errors';

import type { RunChannelSocketState } from './run-channel-socket-runtime.js';

interface RunStartClaimRejected {
  ok: false;
  status: number;
  code: ErrorCode;
  message: string;
}

interface RunStartClaimAccepted {
  ok: true;
  release: () => void;
}

type RunStartClaimResult = RunStartClaimRejected | RunStartClaimAccepted;

export function claimSocketRunStart(
  socketState: Pick<RunChannelSocketState, 'runStartInFlightRequestId'>,
  requestId: string,
): RunStartClaimResult {
  if (socketState.runStartInFlightRequestId !== null) {
    return {
      ok: false,
      status: 409,
      code: 'conflict_active_run',
      message: 'socket already has a run.start request in flight',
    };
  }

  socketState.runStartInFlightRequestId = requestId;
  return {
    ok: true,
    release: () => {
      if (socketState.runStartInFlightRequestId === requestId) {
        socketState.runStartInFlightRequestId = null;
      }
    },
  };
}
