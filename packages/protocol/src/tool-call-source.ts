import { isRecord, isString } from './wire-value-guards.js';

export type ToolCallSourcePayload =
  | { kind: 'agent_loop' }
  | {
      kind: 'ptc_callback';
      parentCallId: string;
      runtimeToolCallId: string;
      cellId?: string;
    }
  | {
      kind: 'artifact_frame';
      scopeHandle: string;
      runtimeToolCallId: string;
    };

export function isToolCallSourcePayload(
  value: unknown,
): value is ToolCallSourcePayload {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === 'agent_loop') {
    return true;
  }
  if (value.kind === 'artifact_frame') {
    return isString(value.scopeHandle) && isString(value.runtimeToolCallId);
  }
  return (
    value.kind === 'ptc_callback' &&
    isString(value.parentCallId) &&
    isString(value.runtimeToolCallId) &&
    (value.cellId === undefined || isString(value.cellId))
  );
}
