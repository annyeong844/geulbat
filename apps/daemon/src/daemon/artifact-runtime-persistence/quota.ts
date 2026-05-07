import { PersistenceQuotaExceededError } from './errors.js';

export const MAX_RUNTIME_PERSISTENCE_FILE_BYTES = 64 * 1024;
export const MAX_RUNTIME_PERSISTENCE_TOTAL_BYTES = 256 * 1024;

export function assertRuntimePersistenceQuota(
  nextBytes: number,
  currentBytes: number,
  totalBytes: number,
): void {
  assertWithinPerArtifactQuota(nextBytes);
  const projectedBytes = totalBytes - currentBytes + nextBytes;
  if (projectedBytes > MAX_RUNTIME_PERSISTENCE_TOTAL_BYTES) {
    throw new PersistenceQuotaExceededError(
      `runtime persistence total quota exceeded (${projectedBytes} > ${MAX_RUNTIME_PERSISTENCE_TOTAL_BYTES} bytes)`,
    );
  }
}

function assertWithinPerArtifactQuota(nextBytes: number): void {
  if (nextBytes > MAX_RUNTIME_PERSISTENCE_FILE_BYTES) {
    throw new PersistenceQuotaExceededError(
      `runtime persistence state exceeds per-artifact quota (${nextBytes} > ${MAX_RUNTIME_PERSISTENCE_FILE_BYTES} bytes)`,
    );
  }
}
