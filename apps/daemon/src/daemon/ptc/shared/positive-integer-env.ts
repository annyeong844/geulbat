export function readPtcPositiveIntegerEnv(name: string, raw: string): number {
  const value = raw.trim();
  if (!/^\d+$/u.test(value)) {
    throw new Error(`invalid ${name}: ${value || 'empty'}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`invalid ${name}: ${value}`);
  }
  return parsed;
}
