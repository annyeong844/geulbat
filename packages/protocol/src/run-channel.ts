import { isApprovalRequest, type ApprovalRequest } from './run-approval.js';
import { isCancelRequest, type CancelRequest } from './cancel.js';
import { isErrorCode, type ErrorCode } from './errors.js';
import { isRunId, isThreadId } from './ids.js';
import { isRunEvent, type RunEvent } from './run-events.js';
import { isRunStartRequest, type RunStartRequest } from './run-contract.js';
import { isBoolean, isNumber, isRecord, isString } from './runtime-utils.js';

interface RunAuthMessage {
  type: 'run.auth';
  requestId: string;
  token: string;
}

interface RunStartMessage {
  type: 'run.start';
  requestId: string;
  request: RunStartRequest;
}

interface RunCancelMessage {
  type: 'run.cancel';
  requestId: string;
  request: CancelRequest;
}

interface RunApproveMessage {
  type: 'run.approve';
  requestId: string;
  request: ApprovalRequest;
}

interface RunInterjectEnvelopeMessage {
  type: 'run.interject';
  requestId: string;
  request: Record<string, unknown>;
}

export interface RunInterjectRequest {
  runId: CancelRequest['runId'];
  text: string;
}

// 대기 중 스티어 취소 — 모델이 소비하기 전의 큐 항목을 receivedSeq로 지운다
interface RunInterjectCancelEnvelopeMessage {
  type: 'run.interject.cancel';
  requestId: string;
  request: Record<string, unknown>;
}

// 대기 중 스티어 즉시 반영 — 현재 라운드의 남은 도구 호출을 건너뛰고
// 다음 모델 호출 직전 소비 지점으로 최대한 빨리 도달하게 한다
interface RunInterjectFlushEnvelopeMessage {
  type: 'run.interject.flush';
  requestId: string;
  request: Record<string, unknown>;
}

// 아티팩트 프레임 발 read-only 도구 호출 — 프레임은 데이터(toolName/args)만
// 주고, 신뢰 컨텍스트(threadId, workingDirectory)는 부모(웹셸)가 자기 신뢰
// 상태에서 주입한다. 서버는 PTC와 공유하는 read-only 게이트 통과분만 실행한다.
interface RunToolEnvelopeMessage {
  type: 'run.tool';
  requestId: string;
  request: Record<string, unknown>;
}

export interface RunEventAckRequest {
  runId: RunEvent['runId'];
  threadId: RunEvent['threadId'];
  seq: number;
}

interface RunEventAckEnvelopeMessage {
  type: 'run.event.ack';
  requestId: string;
  request: RunEventAckRequest;
}

export interface RunToolRequest {
  threadId: string;
  toolName: string;
  args: Record<string, unknown>;
  scopeHandle: string;
  // 프레임이 만든 상관 id(af-N) — 결과를 프레임 pending 요청에 되돌릴 때 쓴다.
  frameRequestId: string;
  workingDirectory?: string;
}

export type RunToolResultPayload =
  | { ok: true; output: string }
  | { ok: false; errorCode: string; error: string };

export type RunChannelClientMessage =
  | RunAuthMessage
  | RunStartMessage
  | RunCancelMessage
  | RunApproveMessage
  | RunInterjectEnvelopeMessage
  | RunInterjectCancelEnvelopeMessage
  | RunInterjectFlushEnvelopeMessage
  | RunEventAckEnvelopeMessage
  | RunToolEnvelopeMessage;

interface RunAuthOkMessage {
  type: 'run.auth.ok';
  requestId: string;
  ok: true;
}

interface RunEventMessage {
  type: 'run.event';
  event: RunEvent;
}

interface RunCancelControlMessage {
  type: 'run.control';
  requestId: string;
  action: 'run.cancel';
  ok: true;
}

interface RunApproveControlMessage {
  type: 'run.control';
  requestId: string;
  action: 'run.approve';
  ok: true;
}

interface RunInterjectControlMessage {
  type: 'run.control';
  requestId: string;
  action: 'run.interject';
  ok: true;
  receivedSeq: number;
  bufferDepth: number;
}

interface RunInterjectCancelControlMessage {
  type: 'run.control';
  requestId: string;
  action: 'run.interject.cancel';
  ok: true;
  cancelled: boolean;
}

interface RunInterjectFlushControlMessage {
  type: 'run.control';
  requestId: string;
  action: 'run.interject.flush';
  ok: true;
  // 큐에 항목이 있어 플러시가 예약되면 true, 큐가 비어 무의미하면 false
  flushed: boolean;
}

interface RunToolControlMessage {
  type: 'run.control';
  requestId: string;
  action: 'run.tool';
  ok: true;
  // 도구 결과 v1 — 스트리밍 없이 requestId 상관 단일 응답
  result: RunToolResultPayload;
}

interface RunEventAckControlMessage {
  type: 'run.control';
  requestId: string;
  action: 'run.event.ack';
  ok: true;
  seq: number;
}

export type RunControlMessage =
  | RunCancelControlMessage
  | RunApproveControlMessage
  | RunInterjectControlMessage
  | RunInterjectCancelControlMessage
  | RunInterjectFlushControlMessage
  | RunEventAckControlMessage
  | RunToolControlMessage;

interface RunErrorMessage {
  type: 'run.error';
  requestId?: string;
  code: ErrorCode;
  message: string;
  status: number;
}

export type RunChannelServerMessage =
  | RunAuthOkMessage
  | RunEventMessage
  | RunControlMessage
  | RunErrorMessage;

export function isRunAuthMessage(value: unknown): value is RunAuthMessage {
  return (
    isRecord(value) &&
    value.type === 'run.auth' &&
    isString(value.requestId) &&
    isString(value.token)
  );
}

export function isRunCancelMessage(value: unknown): value is RunCancelMessage {
  return (
    isRecord(value) &&
    value.type === 'run.cancel' &&
    isString(value.requestId) &&
    isCancelRequest(value.request)
  );
}

export function isRunApproveMessage(
  value: unknown,
): value is RunApproveMessage {
  return (
    isRecord(value) &&
    value.type === 'run.approve' &&
    isString(value.requestId) &&
    isApprovalRequest(value.request)
  );
}

export function isRunStartMessage(value: unknown): value is RunStartMessage {
  return (
    isRecord(value) &&
    value.type === 'run.start' &&
    isString(value.requestId) &&
    isRunStartRequest(value.request)
  );
}

export function isRunInterjectEnvelope(
  value: unknown,
): value is RunInterjectEnvelopeMessage {
  return (
    isRecord(value) &&
    value.type === 'run.interject' &&
    isString(value.requestId) &&
    isRecord(value.request)
  );
}

export function isRunInterjectCancelEnvelope(
  value: unknown,
): value is RunInterjectCancelEnvelopeMessage {
  return (
    isRecord(value) &&
    value.type === 'run.interject.cancel' &&
    isString(value.requestId) &&
    isRecord(value.request)
  );
}

export function isRunInterjectFlushEnvelope(
  value: unknown,
): value is RunInterjectFlushEnvelopeMessage {
  return (
    isRecord(value) &&
    value.type === 'run.interject.flush' &&
    isString(value.requestId) &&
    isRecord(value.request)
  );
}

export function isRunToolEnvelope(
  value: unknown,
): value is RunToolEnvelopeMessage {
  return (
    isRecord(value) &&
    value.type === 'run.tool' &&
    isString(value.requestId) &&
    isRecord(value.request)
  );
}

function isRunEventSequence(value: unknown): value is number {
  return isNumber(value) && Number.isSafeInteger(value) && value >= 0;
}

function isRunEventAckRequest(value: unknown): value is RunEventAckRequest {
  return (
    isRecord(value) &&
    isString(value.runId) &&
    isRunId(value.runId) &&
    isString(value.threadId) &&
    isThreadId(value.threadId) &&
    isRunEventSequence(value.seq)
  );
}

export function isRunEventAckEnvelope(
  value: unknown,
): value is RunEventAckEnvelopeMessage {
  return (
    isRecord(value) &&
    value.type === 'run.event.ack' &&
    isString(value.requestId) &&
    isRunEventAckRequest(value.request)
  );
}

function isRunToolResultPayload(value: unknown): value is RunToolResultPayload {
  if (!isRecord(value)) {
    return false;
  }
  if (value.ok === true) {
    return isString(value.output);
  }
  return (
    value.ok === false && isString(value.errorCode) && isString(value.error)
  );
}

export function isRunChannelClientMessage(
  value: unknown,
): value is RunChannelClientMessage {
  return (
    isRunAuthMessage(value) ||
    isRunCancelMessage(value) ||
    isRunApproveMessage(value) ||
    isRunStartMessage(value) ||
    isRunInterjectEnvelope(value) ||
    isRunInterjectCancelEnvelope(value) ||
    isRunInterjectFlushEnvelope(value) ||
    isRunEventAckEnvelope(value) ||
    isRunToolEnvelope(value)
  );
}

type RunControlAction = RunControlMessage['action'];
type RunControlEnvelopeField = 'type' | 'requestId' | 'action' | 'ok';
type RunControlMessageFor<TAction extends RunControlAction> = Extract<
  RunControlMessage,
  { action: TAction }
>;
// Adding an action or a required action-specific field must also add a
// compatible runtime guard, or this mapped type fails compilation.
type RunControlFieldGuardMap = {
  [TAction in RunControlAction]: {
    [TField in Exclude<
      keyof RunControlMessageFor<TAction>,
      RunControlEnvelopeField
    >]: (value: unknown) => value is RunControlMessageFor<TAction>[TField];
  };
};

const RUN_CONTROL_FIELD_GUARDS = {
  'run.cancel': {},
  'run.approve': {},
  'run.interject': {
    receivedSeq: (value: unknown): value is number =>
      isNumber(value) && Number.isInteger(value) && value > 0,
    bufferDepth: (value: unknown): value is number =>
      isNumber(value) && Number.isInteger(value) && value >= 0,
  },
  'run.interject.cancel': {
    cancelled: isBoolean,
  },
  'run.interject.flush': {
    flushed: isBoolean,
  },
  'run.event.ack': {
    seq: isRunEventSequence,
  },
  'run.tool': {
    result: isRunToolResultPayload,
  },
} satisfies RunControlFieldGuardMap;

function isRunControlAction(value: string): value is RunControlAction {
  return Object.hasOwn(RUN_CONTROL_FIELD_GUARDS, value);
}

function hasValidRunControlFields(
  action: RunControlAction,
  value: Record<string, unknown>,
): boolean {
  const fieldGuards: Readonly<
    Record<string, (fieldValue: unknown) => boolean>
  > = RUN_CONTROL_FIELD_GUARDS[action];
  return Object.entries(fieldGuards).every(([field, isValid]) =>
    isValid(value[field]),
  );
}

export function isRunChannelServerMessage(
  value: unknown,
): value is RunChannelServerMessage {
  if (!isRecord(value) || !isString(value.type)) {
    return false;
  }

  switch (value.type) {
    case 'run.auth.ok':
      return isString(value.requestId) && value.ok === true;
    case 'run.event':
      return isRunEvent(value.event);
    case 'run.control': {
      if (
        !isString(value.requestId) ||
        !isString(value.action) ||
        !isRunControlAction(value.action) ||
        value.ok !== true
      ) {
        return false;
      }
      return hasValidRunControlFields(value.action, value);
    }
    case 'run.error':
      return (
        (value.requestId === undefined || isString(value.requestId)) &&
        isErrorCode(value.code) &&
        isString(value.message) &&
        isNumber(value.status)
      );
    default:
      return false;
  }
}
