import type { RunId } from '@geulbat/protocol/ids';

export function testRunId(seed: string | number = 1): RunId {
  return `run-${seed}` as RunId;
}
