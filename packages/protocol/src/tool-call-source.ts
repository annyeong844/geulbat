import { isRecord, isString } from './runtime-utils.js';

export type ToolCallSourcePayload =
  | { kind: 'agent_loop' }
  | {
      kind: 'ptc_callback';
      parentCallId: string;
      runtimeToolCallId: string;
      cellId?: string;
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
  return (
    value.kind === 'ptc_callback' &&
    isString(value.parentCallId) &&
    isString(value.runtimeToolCallId) &&
    (value.cellId === undefined || isString(value.cellId))
  );
}
