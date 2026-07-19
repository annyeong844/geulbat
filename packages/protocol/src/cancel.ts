import { isRunId, type RunId } from './ids.js';
import { isRecord, isString } from './runtime-utils.js';

export interface CancelRequest {
  runId: RunId;
}

// Cancellation is a mutation command. Keep its complete request exact rather
// than silently accepting a misspelled future selector.
export function isCancelRequest(value: unknown): value is CancelRequest {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    isString(value.runId) &&
    isRunId(value.runId)
  );
}
