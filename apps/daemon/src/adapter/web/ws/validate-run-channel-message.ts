import type { RunChannelClientMessage } from '@geulbat/protocol/run-channel';
import {
  isRunApproveMessage,
  isRunAuthMessage,
  isRunCancelMessage,
  isRunInterjectCancelEnvelope,
  isRunInterjectEnvelope,
  isRunInterjectFlushEnvelope,
  isRunStartMessage,
  isRunToolEnvelope,
} from '@geulbat/protocol/run-channel';

type RunChannelClientMessageReadResult =
  | { ok: true; message: RunChannelClientMessage }
  | { ok: false; message: string };

export function readRunChannelClientMessage(
  value: unknown,
): RunChannelClientMessageReadResult {
  if (isRunAuthMessage(value)) {
    return readClientMessageWithRequestId(value);
  }
  if (isRunCancelMessage(value)) {
    return readClientMessageWithRequestId(value);
  }
  if (isRunApproveMessage(value)) {
    return readClientMessageWithRequestId(value);
  }
  if (isRunInterjectEnvelope(value)) {
    return readClientMessageWithRequestId(value);
  }
  if (isRunInterjectCancelEnvelope(value)) {
    return readClientMessageWithRequestId(value);
  }
  if (isRunInterjectFlushEnvelope(value)) {
    return readClientMessageWithRequestId(value);
  }
  if (isRunToolEnvelope(value)) {
    return readClientMessageWithRequestId(value);
  }
  if (isRunStartMessage(value)) {
    return readClientMessageWithRequestId(value);
  }
  return { ok: false, message: 'invalid websocket JSON' };
}

function readClientMessageWithRequestId(
  message: RunChannelClientMessage,
): RunChannelClientMessageReadResult {
  if (!message.requestId.trim()) {
    return { ok: false, message: 'requestId is required' };
  }
  return { ok: true, message };
}
