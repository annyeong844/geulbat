import type WebSocket from 'ws';
import type { ApprovalRequest } from '@geulbat/protocol/run-approval';
import type { CancelRequest } from '@geulbat/protocol/cancel';
import type {
  RunChildCancelRequest,
  RunProviderRequestRecoveryRequest,
} from '@geulbat/protocol/run-channel';

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

  controlContext.activeRuns.abortThreadTree(
    run.ownerThreadId,
    'user_interrupt',
  );
  sendMessage(socket, {
    type: 'run.control',
    requestId,
    action: 'run.cancel',
    ok: true,
  });
}

export function handleRunChildCancel(
  socket: WebSocket,
  requestId: string,
  request: RunChildCancelRequest,
  controlContext: RunChannelControlContext,
): void {
  const { parentRunId, childRunId } = request;
  if (!socketOwnsRun(socket, parentRunId)) {
    sendError(
      socket,
      requestId,
      403,
      'access_denied',
      `socket does not own parent run: ${parentRunId}`,
    );
    return;
  }

  const childRun = controlContext.activeRuns.getRunById(childRunId);
  if (!childRun) {
    sendError(
      socket,
      requestId,
      404,
      'not_found',
      `no active child run: ${childRunId}`,
    );
    return;
  }
  if (childRun.parentRunId !== parentRunId) {
    sendError(
      socket,
      requestId,
      403,
      'access_denied',
      `run is not a child of parent run: ${parentRunId}`,
    );
    return;
  }

  controlContext.activeRuns.abortRunSubtree(childRunId, 'explicit_stop');
  sendMessage(socket, {
    type: 'run.control',
    requestId,
    action: 'run.child.cancel',
    ok: true,
  });
}

export async function handleRunApprove(
  socket: WebSocket,
  requestId: string,
  request: ApprovalRequest,
  controlContext: RunChannelControlContext,
): Promise<void> {
  const parsedRequest = readRunApproveRequest(request);
  if (!parsedRequest.ok) {
    sendError(socket, requestId, 400, 'bad_request', parsedRequest.message);
    return;
  }
  const { callId, runId, threadId, approved, grantScope, permissionMode } =
    parsedRequest;
  const computerSessionId = getSocketState(socket).computerSessionId;
  const canResolveApproval =
    controlContext.approvalGate.hasApprovalDecisionAuthority(
      callId,
      runId,
      threadId,
      computerSessionId,
    );
  if (!canResolveApproval) {
    sendError(
      socket,
      requestId,
      403,
      'access_denied',
      `computer session does not own approval: ${callId}`,
    );
    return;
  }

  const decision = approved ? 'approved' : 'denied';
  const result = await controlContext.approvalGate.resolveApproval(
    callId,
    runId,
    threadId,
    decision,
    grantScope,
    permissionMode,
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

export async function handleRunInterject(
  socket: WebSocket,
  requestId: string,
  request: unknown,
  controlContext: RunChannelControlContext,
): Promise<void> {
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

  const checkpointResult = await controlContext.runCheckpoints.enqueueInterject(
    {
      threadId: run.threadId,
      runId,
      interject: { text, receivedSeq: appendResult.receivedSeq },
    },
  );
  if (!checkpointResult.ok) {
    controlContext.activeRuns.cancelPendingInterject(
      runId,
      appendResult.receivedSeq,
    );
    const unavailable =
      checkpointResult.code === 'not_found' ||
      checkpointResult.code === 'terminal';
    sendError(
      socket,
      requestId,
      unavailable ? 404 : 409,
      unavailable ? 'not_found' : 'conflict',
      unavailable
        ? `no active run: ${runId}`
        : `interject sequence conflict: ${runId}`,
    );
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
export async function handleRunInterjectCancel(
  socket: WebSocket,
  requestId: string,
  request: unknown,
  controlContext: RunChannelControlContext,
): Promise<void> {
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

  const run = controlContext.activeRuns.getRunById(runId);
  if (!run || run.aborted) {
    sendError(socket, requestId, 404, 'not_found', `no active run: ${runId}`);
    return;
  }
  const durableResult = await controlContext.runCheckpoints.cancelInterject({
    threadId: run.threadId,
    runId,
    receivedSeq,
  });
  if (!durableResult.ok) {
    sendError(socket, requestId, 404, 'not_found', `no active run: ${runId}`);
    return;
  }
  if (durableResult.changed) {
    controlContext.activeRuns.cancelPendingInterject(runId, receivedSeq);
  }

  sendMessage(socket, {
    type: 'run.control',
    requestId,
    action: 'run.interject.cancel',
    ok: true,
    cancelled: durableResult.changed,
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

// provider 요청 결과를 확인할 수 없는 경우의 명시적 복구. 런 채널 인증으로
// 얻은 computer session identity를 감사 주체로 쓰며, 활성 run이 있는 동안은
// 좌표를 건드리지 않는다.
export async function handleRunProviderRequestRecovery(
  socket: WebSocket,
  requestId: string,
  request: RunProviderRequestRecoveryRequest,
  controlContext: RunChannelControlContext,
  authorizedByComputerSessionId: string,
): Promise<void> {
  const activeRun = controlContext.activeRuns.getRunByThreadId(
    request.threadId,
  );
  if (activeRun !== undefined) {
    sendError(
      socket,
      requestId,
      409,
      'conflict_active_run',
      'the thread still has an active run',
    );
    return;
  }

  const recovered =
    await controlContext.provider.durableRequestRecovery.recoverOutcomeUnknown({
      providerSessionId: request.threadId,
      authorizedByComputerSessionId,
      acknowledgePossibleDuplicateProviderWork:
        request.acknowledgePossibleDuplicateProviderWork,
    });
  if (!recovered.ok) {
    sendError(
      socket,
      requestId,
      recovered.code === 'not_found' ? 404 : 409,
      recovered.code,
      recovered.message,
    );
    return;
  }

  sendMessage(socket, {
    type: 'run.control',
    requestId,
    action: 'run.provider_request.recover',
    ok: true,
    disposition: recovered.disposition,
  });
}
