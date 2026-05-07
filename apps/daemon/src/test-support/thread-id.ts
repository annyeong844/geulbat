import type { ThreadId } from '@geulbat/protocol/ids';

export function testThreadId(seed: number): ThreadId {
  const suffix = seed.toString(16).padStart(12, '0').slice(-12);
  return `00000000-0000-4000-8000-${suffix}` as ThreadId;
}
