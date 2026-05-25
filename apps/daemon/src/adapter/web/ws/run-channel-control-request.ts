import type { ApprovalRequest } from '@geulbat/protocol/run-approval';
import { isApprovalGrantScope } from '@geulbat/protocol/run-approval';
import type { CancelRequest } from '@geulbat/protocol/cancel';

export function readRunCancelRequest(
  request: CancelRequest,
):
  | { ok: true; runId: CancelRequest['runId'] }
  | { ok: false; message: string } {
  if (!request.runId) {
    return { ok: false, message: 'runId is required' };
  }
  return { ok: true, runId: request.runId };
}

export function readRunApproveRequest(request: ApprovalRequest):
  | {
      ok: true;
      callId: string;
      runId: ApprovalRequest['runId'];
      threadId: ApprovalRequest['threadId'];
      approved: boolean;
      grantScope: ApprovalRequest['grantScope'];
    }
  | { ok: false; message: string } {
  const { callId, runId, threadId, approved, grantScope } = request;
  if (!callId) {
    return { ok: false, message: 'callId is required' };
  }
  if (!runId) {
    return { ok: false, message: 'runId is required' };
  }
  if (!threadId) {
    return { ok: false, message: 'threadId is required' };
  }
  if (typeof approved !== 'boolean') {
    return { ok: false, message: 'approved (boolean) is required' };
  }
  if (!isApprovalGrantScope(grantScope)) {
    return { ok: false, message: 'grantScope is required' };
  }
  return {
    ok: true,
    callId,
    runId,
    threadId,
    approved,
    grantScope,
  };
}
