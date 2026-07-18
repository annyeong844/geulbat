export type JsonParseResult<T> = { ok: true; value: T } | { ok: false };

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

export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

export function tryParseJson(text: string): JsonParseResult<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

export function tryParseJsonWithGuard<T>(
  text: string,
  guard: (value: unknown) => value is T,
): JsonParseResult<T> {
  const parsed = tryParseJson(text);
  if (!parsed.ok || !guard(parsed.value)) {
    return { ok: false };
  }
  return { ok: true, value: parsed.value };
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
  return tryParseJsonWithGuard(text, isRecord);
}
