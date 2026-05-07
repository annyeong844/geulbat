export const SIDE_EFFECT_LEVELS = [
  'none',
  'read',
  'write',
  'destructive',
] as const;

export type SideEffectLevel = (typeof SIDE_EFFECT_LEVELS)[number];

export function isSideEffectLevel(value: unknown): value is SideEffectLevel {
  return (
    typeof value === 'string' &&
    (SIDE_EFFECT_LEVELS as readonly string[]).includes(value)
  );
}
