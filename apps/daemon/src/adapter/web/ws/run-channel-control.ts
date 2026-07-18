import type WebSocket from 'ws';
import type { ApprovalRequest } from '@geulbat/protocol/run-approval';
import type { CancelRequest } from '@geulbat/protocol/cancel';

import { sendError, sendMessage } from './run-channel-socket.js';
import type { RunChannelControlContext } from './run-channel-runtime-context.js';
import { getSocketState, socketOwnsRun } from './run-channel-socket-runtime.js';
import {
  readRunApproveRequest,
  readRunCancelRequest,
  readRunInterjectCancelRequest,
  readRunInterjectFlushRequest,
  readRunInterjectRequest,
} from './run-channel-control-request.js';
import { isMidRunSteerEnabled } from '../../../daemon/agent/mid-run-steer-flag.js';

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
  const approvalSessionId = getSocketState(socket).approvalSessionId;
  const canResolveApproval =
    socketOwnsRun(socket, runId) ||
    controlContext.approvalGate.hasPendingApprovalForSession(
      callId,
      runId,
      threadId,
      approvalSessionId,
    );
  if (!canResolveApproval) {
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

export function handleRunInterject(
  socket: WebSocket,
  requestId: string,
  request: unknown,
  controlContext: RunChannelControlContext,
): void {
  if (!isMidRunSteerEnabled()) {
    sendError(
      socket,
      requestId,
      503,
      'bad_request',
      'mid-run steer is not enabled',
    );
    return;
  }

  const parsedRequest = readRunInterjectRequest(request);
  if (!parsedRequest.ok) {
    sendError(socket, requestId, 400, 'invalid_args', parsedRequest.message);
    return;
  }

  const { runId, text } = parsedRequest;
  const run = controlContext.activeRuns.getRunById(runId);
  if (!run || run.aborted) {
    sendError(socket, requestId, 404, 'not_found', `no active run: ${runId}`);
    return;
  }

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

  const appendResult = controlContext.activeRuns.appendPendingInterject(runId, {
    text,
  });
  if (!appendResult.ok) {
    sendError(socket, requestId, 404, 'not_found', `no active run: ${runId}`);
    return;
  }

  sendMessage(socket, {
    type: 'run.control',
    requestId,
    action: 'run.interject',
    ok: true,
    receivedSeq: appendResult.receivedSeq,
    bufferDepth: appendResult.bufferDepth,
  });
}

// 대기 중 스티어 취소 — 소비 전이면 큐에서 제거(cancelled=true), 이미
// 소비됐거나 없으면 cancelled=false로 응답한다(경합은 정상 흐름).
export function handleRunInterjectCancel(
  socket: WebSocket,
  requestId: string,
  request: unknown,
  controlContext: RunChannelControlContext,
): void {
  if (!isMidRunSteerEnabled()) {
    sendError(
      socket,
      requestId,
      503,
      'bad_request',
      'mid-run steer is not enabled',
    );
    return;
  }

  const parsedRequest = readRunInterjectCancelRequest(request);
  if (!parsedRequest.ok) {
    sendError(socket, requestId, 400, 'invalid_args', parsedRequest.message);
    return;
  }

  const { runId, receivedSeq } = parsedRequest;
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

  const result = controlContext.activeRuns.cancelPendingInterject(
    runId,
    receivedSeq,
  );
  if (!result.ok) {
    sendError(socket, requestId, 404, 'not_found', `no active run: ${runId}`);
    return;
  }

  sendMessage(socket, {
    type: 'run.control',
    requestId,
    action: 'run.interject.cancel',
    ok: true,
    cancelled: result.cancelled,
  });
}

// 대기 중 스티어 즉시 반영 — 큐가 비어 있으면 flushed=false(경합은 정상
// 흐름), 큐가 있으면 루프가 다음 체크포인트에서 남은 도구 호출을 건너뛴다.
export function handleRunInterjectFlush(
  socket: WebSocket,
  requestId: string,
  request: unknown,
  controlContext: RunChannelControlContext,
): void {
  if (!isMidRunSteerEnabled()) {
    sendError(
      socket,
      requestId,
      503,
      'bad_request',
      'mid-run steer is not enabled',
    );
    return;
  }

  const parsedRequest = readRunInterjectFlushRequest(request);
  if (!parsedRequest.ok) {
    sendError(socket, requestId, 400, 'invalid_args', parsedRequest.message);
    return;
  }

  const { runId } = parsedRequest;
  const run = controlContext.activeRuns.getRunById(runId);
  if (!run || run.aborted) {
    sendError(socket, requestId, 404, 'not_found', `no active run: ${runId}`);
    return;
  }

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

  const result = controlContext.activeRuns.requestPendingInterjectFlush(runId);
  if (!result.ok) {
    sendError(socket, requestId, 404, 'not_found', `no active run: ${runId}`);
    return;
  }

  sendMessage(socket, {
    type: 'run.control',
    requestId,
    action: 'run.interject.flush',
    ok: true,
    flushed: result.flushed,
  });
}
