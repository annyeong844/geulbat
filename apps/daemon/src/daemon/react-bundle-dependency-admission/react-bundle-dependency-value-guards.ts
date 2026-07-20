export function isReactBundleDependencyRecord(
  value: unknown,
): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isReactBundleDependencyPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (!isReactBundleDependencyRecord(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
