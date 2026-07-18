import { isRunId, type RunId } from './ids.js';
import { isRecord, isString } from './runtime-utils.js';

export interface CancelRequest {
  runId: RunId;
}

export function isCancelRequest(value: unknown): value is CancelRequest {
  return isRecord(value) && isString(value.runId) && isRunId(value.runId);
}
