import { isApprovalRequest, type ApprovalRequest } from './run-approval.js';
import { isCancelRequest, type CancelRequest } from './cancel.js';
import { isErrorCode, type ErrorCode } from './errors.js';
import { isRunEvent, type RunEvent } from './run-events.js';
import { isRunStartRequest, type RunStartRequest } from './run-contract.js';
import { isNumber, isRecord, isString } from './runtime-utils.js';

export interface RunAuthMessage {
  type: 'run.auth';
  requestId: string;
  token: string;
}

export interface RunStartMessage {
  type: 'run.start';
  requestId: string;
  request: RunStartRequest;
}

export interface RunCancelMessage {
  type: 'run.cancel';
  requestId: string;
  request: CancelRequest;
}

export interface RunApproveMessage {
  type: 'run.approve';
  requestId: string;
  request: ApprovalRequest;
}

export interface RunInterjectEnvelopeMessage {
  type: 'run.interject';
  requestId: string;
  request: Record<string, unknown>;
}

export interface RunInterjectRequest {
  runId: CancelRequest['runId'];
  text: string;
}

export type RunChannelClientMessage =
  | RunAuthMessage
  | RunStartMessage
  | RunCancelMessage
  | RunApproveMessage
  | RunInterjectEnvelopeMessage;

export interface RunAuthOkMessage {
  type: 'run.auth.ok';
  requestId: string;
  ok: true;
}

export interface RunEventMessage {
  type: 'run.event';
  event: RunEvent;
}

export interface RunCancelControlMessage {
  type: 'run.control';
  requestId: string;
  action: 'run.cancel';
  ok: true;
}

export interface RunApproveControlMessage {
  type: 'run.control';
  requestId: string;
  action: 'run.approve';
  ok: true;
}

export interface RunInterjectControlMessage {
  type: 'run.control';
  requestId: string;
  action: 'run.interject';
  ok: true;
  receivedSeq: number;
  bufferDepth: number;
}

export type RunControlMessage =
  | RunCancelControlMessage
  | RunApproveControlMessage
  | RunInterjectControlMessage;

export interface RunErrorMessage {
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

export function isRunChannelClientMessage(
  value: unknown,
): value is RunChannelClientMessage {
  return (
    isRunAuthMessage(value) ||
    isRunCancelMessage(value) ||
    isRunApproveMessage(value) ||
    isRunStartMessage(value) ||
    isRunInterjectEnvelope(value)
  );
}

const RUN_CONTROL_ACTIONS = new Set([
  'run.cancel',
  'run.approve',
  'run.interject',
]);

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
        !RUN_CONTROL_ACTIONS.has(value.action) ||
        value.ok !== true
      ) {
        return false;
      }
      if (value.action !== 'run.interject') {
        return true;
      }
      return (
        isNumber(value.receivedSeq) &&
        Number.isInteger(value.receivedSeq) &&
        value.receivedSeq > 0 &&
        isNumber(value.bufferDepth) &&
        Number.isInteger(value.bufferDepth) &&
        value.bufferDepth >= 0
      );
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
