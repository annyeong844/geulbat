import type { ArtifactRuntimePersistenceScopeRequest } from '@geulbat/protocol/runtime-persistence';

export function createArtifactRuntimePersistenceScopeKey(
  scope: ArtifactRuntimePersistenceScopeRequest | null,
): string | null {
  if (!scope) {
    return null;
  }

  return JSON.stringify([
    scope.threadId,
    scope.artifactId,
    scope.persistenceEpoch,
  ]);
}

export function createArtifactRuntimePersistenceScopeHandle(
  scopeSeed: string,
): string {
  if (scopeSeed.length === 0) {
    throw new Error('runtime persistence scopeSeed must be non-empty');
  }
  return `scope-${scopeSeed}`;
}
