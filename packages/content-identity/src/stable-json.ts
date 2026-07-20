import { sha256Hex } from './sha256.js';

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
    return `{${Object.keys(value)
      .filter(
        (key) =>
          !options.omitUndefinedObjectKeys ||
          Reflect.get(value, key) !== undefined,
      )
      .sort()
      .map((key) => {
        const propertyValue: unknown = Reflect.get(value, key);
        return `${JSON.stringify(key)}:${stableStringify(propertyValue, options)}`;
      })
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function sha256StableJson(
  value: unknown,
  options: StableJsonOptions = {},
): string {
  return sha256Hex(stableStringify(value, options));
}
