import {
  isPlainRecord as isProtocolPlainRecord,
  isRecord as isProtocolRecord,
  tryDecodeJson as tryDecodeProtocolJson,
  tryParseJson as tryParseProtocolJson,
  tryParseJsonRecord as tryParseProtocolJsonRecord,
  tryParseJsonWithGuard as tryParseProtocolJsonWithGuard,
  type JsonParseResult,
} from '@geulbat/protocol/runtime-utils';

export type { JsonParseResult };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return isProtocolRecord(value);
}

export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  return isProtocolPlainRecord(value);
}

export function tryParseJson(text: string): JsonParseResult<unknown> {
  return tryParseProtocolJson(text);
}

export function tryParseJsonWithGuard<T>(
  text: string,
  guard: (value: unknown) => value is T,
): JsonParseResult<T> {
  return tryParseProtocolJsonWithGuard(text, guard);
}

export function tryDecodeJson<T>(
  text: string,
  decode: (value: unknown) => T,
): JsonParseResult<T> {
  return tryDecodeProtocolJson(text, decode);
}

export function tryParseJsonRecord(
  text: string,
): JsonParseResult<Record<string, unknown>> {
  return tryParseProtocolJsonRecord(text);
}
