import WebSocket from 'ws';
import type { ApprovalRequest } from '@geulbat/protocol/run-approval';
import type { CancelRequest } from '@geulbat/protocol/cancel';

import { sendError, sendMessage } from './run-channel-socket.js';
import type { RunChannelControlContext } from './run-channel-runtime-context.js';
import { socketOwnsRun } from './run-channel-socket-runtime.js';
import {
  readRunApproveRequest,
  readRunCancelRequest,
} from './run-channel-control-request.js';

export function handleRunCancel(
  socket: WebSocket,
  requestId: string,
  request: CancelRequest,
  controlContext: RunChannelControlContext,
): void {
  const parsedRequest = readRunCancelRequest(request);
  if (!parsedRequest.ok) {
    sendError(socket, requestId, 400, 'bad_request', parsedRequest.message);
    return;
  }
  const { runId } = parsedRequest;
  if (!socketOwnsRun(socket, runId)) {
    sendError(
      socket,
      requestId,
      403,
      'access_denied',
      `socket does not own run: ${runId}`,
    );
    return;
  }

  const run = controlContext.activeRuns.getRunById(runId);
  if (!run) {
    sendError(socket, requestId, 404, 'not_found', `no active run: ${runId}`);
    return;
  }

  controlContext.activeRuns.abortThreadTree(run.ownerThreadId);
  sendMessage(socket, {
    type: 'run.control',
    requestId,
    action: 'run.cancel',
    ok: true,
  });
}

export function handleRunApprove(
  socket: WebSocket,
  requestId: string,
  request: ApprovalRequest,
  controlContext: RunChannelControlContext,
): void {
  const parsedRequest = readRunApproveRequest(request);
  if (!parsedRequest.ok) {
    sendError(socket, requestId, 400, 'bad_request', parsedRequest.message);
    return;
  }
  const { callId, runId, threadId, approved, grantScope } = parsedRequest;
  if (
    !socketOwnsRun(socket, runId) &&
    !controlContext.approvalGate.hasPendingApproval(callId, runId, threadId)
  ) {
    sendError(
      socket,
      requestId,
      403,
      'access_denied',
      `socket does not own run: ${runId}`,
    );
    return;
  }

  const decision = approved ? 'approved' : 'denied';
  const result = controlContext.approvalGate.resolveApproval(
    callId,
    runId,
    threadId,
    decision,
    grantScope,
  );

  switch (result) {
    case 'resolved':
      sendMessage(socket, {
        type: 'run.control',
        requestId,
        action: 'run.approve',
        ok: true,
      });
      return;
    case 'already_resolved':
      sendError(
        socket,
        requestId,
        409,
        'conflict',
        `approval already processed: ${callId}`,
      );
      return;
    case 'not_found':
      sendError(
        socket,
        requestId,
        404,
        'not_found',
        `no pending approval for callId: ${callId}`,
      );
      return;
  }
}
