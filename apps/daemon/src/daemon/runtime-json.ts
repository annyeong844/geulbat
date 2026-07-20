import {
  isJsonValue as isProtocolJsonValue,
  type JsonValue,
} from '@geulbat/protocol/runtime-persistence';

export type { JsonValue };
type JsonParseResult<T> = { ok: true; value: T } | { ok: false };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isJsonValue(value: unknown): value is JsonValue {
  return isProtocolJsonValue(value);
}

export function tryParseJson(text: string): JsonParseResult<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

export function tryDecodeJson<T>(
  text: string,
  decode: (value: unknown) => T,
): JsonParseResult<T> {
  const parsed = tryParseJson(text);
  if (!parsed.ok) {
    return { ok: false };
  }
  try {
    return { ok: true, value: decode(parsed.value) };
  } catch {
    return { ok: false };
  }
}

export function tryParseJsonRecord(
  text: string,
): JsonParseResult<Record<string, unknown>> {
  const parsed = tryParseJson(text);
  if (!parsed.ok || !isRecord(parsed.value)) {
    return { ok: false };
  }
  return { ok: true, value: parsed.value };
}
