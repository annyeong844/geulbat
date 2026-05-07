import { isRunId, type RunId } from './ids.js';
import { isBoolean, isRecord, isString } from './runtime-utils.js';

export interface CancelRequest {
  runId: RunId;
}

export interface CancelResponse {
  ok: boolean;
}

export function isCancelRequest(value: unknown): value is CancelRequest {
  return isRecord(value) && isString(value.runId) && isRunId(value.runId);
}

export function isCancelResponse(value: unknown): value is CancelResponse {
  return isRecord(value) && isBoolean(value.ok);
}
