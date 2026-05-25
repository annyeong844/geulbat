import type { ArtifactId } from '@geulbat/protocol/artifacts';
import type {
  JsonValue,
  ArtifactRuntimePersistenceRenderer,
  ArtifactRuntimePersistenceScopeRequest,
} from '@geulbat/protocol/runtime-persistence';
import {
  isJsonValue,
  isArtifactRuntimePersistenceRenderer,
} from '@geulbat/protocol/runtime-persistence';
import { isPlainRecord } from '@geulbat/protocol/runtime-utils';

export interface PersistedRuntimeStateSchema {
  version: 1;
  scope: {
    threadId: string;
    renderer: ArtifactRuntimePersistenceRenderer;
    artifactId: ArtifactId;
    persistenceEpoch: number;
  };
  revision: string;
  state: JsonValue | null;
  updatedAt: string;
}

export function parsePersistedRuntimeState(
  value: unknown,
): PersistedRuntimeStateSchema {
  if (!isPlainRecord(value)) {
    throw new Error('invalid runtime persistence payload');
  }

  const record = value;
  if (record['version'] !== 1) {
    throw new Error('invalid runtime persistence version');
  }

  const scopeValue = record['scope'];
  if (!isPlainRecord(scopeValue)) {
    throw new Error('invalid runtime persistence scope');
  }
  const threadId = scopeValue['threadId'];
  const renderer = scopeValue['renderer'];
  const artifactId = scopeValue['artifactId'];
  const persistenceEpoch =
    typeof scopeValue['persistenceEpoch'] === 'number' &&
    Number.isInteger(scopeValue['persistenceEpoch'])
      ? scopeValue['persistenceEpoch']
      : null;
  const revision = record['revision'];
  const updatedAt = record['updatedAt'];
  const state = record['state'];

  if (
    typeof threadId !== 'string' ||
    typeof artifactId !== 'string' ||
    persistenceEpoch === null ||
    persistenceEpoch < 0 ||
    typeof revision !== 'string' ||
    typeof updatedAt !== 'string' ||
    !isArtifactRuntimePersistenceRenderer(renderer)
  ) {
    throw new Error('invalid runtime persistence payload');
  }

  if (!isJsonValue(state)) {
    throw new Error('invalid runtime persistence state');
  }

  return {
    version: 1,
    scope: {
      threadId,
      renderer,
      artifactId,
      persistenceEpoch,
    },
    revision,
    updatedAt,
    state,
  };
}

export function matchesRuntimePersistenceScope(
  persisted: PersistedRuntimeStateSchema,
  scope: ArtifactRuntimePersistenceScopeRequest,
): boolean {
  return (
    persisted.scope.threadId === scope.threadId &&
    persisted.scope.renderer === scope.renderer &&
    persisted.scope.artifactId === scope.artifactId &&
    persisted.scope.persistenceEpoch === scope.persistenceEpoch
  );
}
