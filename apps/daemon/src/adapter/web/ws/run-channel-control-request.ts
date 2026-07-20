import type { ApprovalRequest } from '@geulbat/protocol/run-approval';
import { isApprovalGrantScope } from '@geulbat/protocol/run-approval';
import type { CancelRequest } from '@geulbat/protocol/cancel';
import { isRunId, isThreadId } from '@geulbat/protocol/ids';
import type {
  RunInterjectRequest,
  RunToolRequest,
} from '@geulbat/protocol/run-channel';
import { isRecord, isString } from '../../../daemon/runtime-json.js';

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
    return {
      ok: false,
      message: 'grantScope must be once, run, or session',
    };
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

export function readRunInterjectRequest(request: unknown):
  | {
      ok: true;
      runId: RunInterjectRequest['runId'];
      text: RunInterjectRequest['text'];
    }
  | { ok: false; message: string } {
  if (!isRecord(request)) {
    return { ok: false, message: 'request must be an object' };
  }
  if (!hasOnlyKeys(request, ['runId', 'text'])) {
    return { ok: false, message: 'request contains unknown fields' };
  }
  const { runId, text } = request;
  if (!isString(runId) || !isRunId(runId)) {
    return { ok: false, message: 'runId is required' };
  }
  if (!isString(text) || text.trim().length === 0) {
    return { ok: false, message: 'text is required' };
  }
  return { ok: true, runId, text };
}

export function readRunInterjectCancelRequest(
  request: unknown,
):
  | { ok: true; runId: RunInterjectRequest['runId']; receivedSeq: number }
  | { ok: false; message: string } {
  if (!isRecord(request)) {
    return { ok: false, message: 'request must be an object' };
  }
  if (!hasOnlyKeys(request, ['runId', 'receivedSeq'])) {
    return { ok: false, message: 'request contains unknown fields' };
  }
  const { runId, receivedSeq } = request;
  if (!isString(runId) || !isRunId(runId)) {
    return { ok: false, message: 'runId is required' };
  }
  if (
    typeof receivedSeq !== 'number' ||
    !Number.isInteger(receivedSeq) ||
    receivedSeq <= 0
  ) {
    return { ok: false, message: 'receivedSeq must be a positive integer' };
  }
  return { ok: true, runId, receivedSeq };
}

// run.tool — 아티팩트 프레임 발 read-only 도구 호출. threadId/workingDirectory
// 는 부모(웹셸)가 주입한 신뢰 컨텍스트이고, toolName/args만 프레임 데이터다.
export function readRunToolRequest(
  request: unknown,
): { ok: true; value: RunToolRequest } | { ok: false; message: string } {
  if (!isRecord(request)) {
    return { ok: false, message: 'request must be an object' };
  }
  if (
    !hasOnlyKeys(request, [
      'threadId',
      'toolName',
      'args',
      'scopeHandle',
      'frameRequestId',
      'workingDirectory',
    ])
  ) {
    return { ok: false, message: 'request contains unknown fields' };
  }
  const { threadId, toolName, args, scopeHandle, frameRequestId } = request;
  if (!isString(threadId) || !isThreadId(threadId)) {
    return { ok: false, message: 'threadId is required' };
  }
  if (!isString(toolName) || toolName.trim().length === 0) {
    return { ok: false, message: 'toolName is required' };
  }
  if (!isRecord(args)) {
    return { ok: false, message: 'args must be an object' };
  }
  if (!isString(scopeHandle) || scopeHandle.trim().length === 0) {
    return { ok: false, message: 'scopeHandle is required' };
  }
  if (!isString(frameRequestId) || frameRequestId.trim().length === 0) {
    return { ok: false, message: 'frameRequestId is required' };
  }
  const workingDirectory = request.workingDirectory;
  if (workingDirectory !== undefined && !isString(workingDirectory)) {
    return { ok: false, message: 'workingDirectory must be a string' };
  }
  return {
    ok: true,
    value: {
      threadId,
      toolName,
      args,
      scopeHandle,
      frameRequestId,
      ...(workingDirectory !== undefined ? { workingDirectory } : {}),
    },
  };
}

export function readRunInterjectFlushRequest(
  request: unknown,
):
  | { ok: true; runId: RunInterjectRequest['runId'] }
  | { ok: false; message: string } {
  if (!isRecord(request)) {
    return { ok: false, message: 'request must be an object' };
  }
  if (!hasOnlyKeys(request, ['runId'])) {
    return { ok: false, message: 'request contains unknown fields' };
  }
  const { runId } = request;
  if (!isString(runId) || !isRunId(runId)) {
    return { ok: false, message: 'runId is required' };
  }
  return { ok: true, runId };
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}
