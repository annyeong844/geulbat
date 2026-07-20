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
