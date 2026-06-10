import { createHash } from 'node:crypto';

export interface StableJsonOptions {
  omitUndefinedObjectKeys?: boolean;
}

export function stableStringify(
  value: unknown,
  options: StableJsonOptions = {},
): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item, options)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter(
        (key) => !options.omitUndefinedObjectKeys || record[key] !== undefined,
      )
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify(record[key], options)}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function sha256StableJson(
  value: unknown,
  options: StableJsonOptions = {},
): string {
  return createHash('sha256')
    .update(stableStringify(value, options), 'utf8')
    .digest('hex');
}
