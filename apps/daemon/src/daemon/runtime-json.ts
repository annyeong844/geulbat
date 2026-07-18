import {
  isPlainRecord as isProtocolPlainRecord,
  isRecord as isProtocolRecord,
  tryDecodeJson as tryDecodeProtocolJson,
  tryParseJson as tryParseProtocolJson,
  tryParseJsonRecord as tryParseProtocolJsonRecord,
  type JsonParseResult,
} from '@geulbat/protocol/runtime-utils';
import {
  isJsonValue as isProtocolJsonValue,
  type JsonValue,
} from '@geulbat/protocol/runtime-persistence';

export type { JsonValue };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return isProtocolRecord(value);
}

export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  return isProtocolPlainRecord(value);
}

export function isJsonValue(value: unknown): value is JsonValue {
  return isProtocolJsonValue(value);
}

export function tryParseJson(text: string): JsonParseResult<unknown> {
  return tryParseProtocolJson(text);
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
