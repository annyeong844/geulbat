import type { ArtifactId } from '@geulbat/protocol/artifacts';
import {
  isArtifactRuntimePersistenceRenderer as isProtocolArtifactRuntimePersistenceRenderer,
  isJsonValue as isProtocolJsonValue,
  type ArtifactRuntimePersistenceClearResponse,
  type ArtifactRuntimePersistenceLoadResponse,
  type ArtifactRuntimePersistenceRenderer,
  type ArtifactRuntimePersistenceSaveResponse,
  type ArtifactRuntimePersistenceScopeRequest,
  type JsonValue,
} from '@geulbat/protocol/runtime-persistence';

export type {
  ArtifactId,
  ArtifactRuntimePersistenceClearResponse,
  ArtifactRuntimePersistenceLoadResponse,
  ArtifactRuntimePersistenceRenderer,
  ArtifactRuntimePersistenceSaveResponse,
  ArtifactRuntimePersistenceScopeRequest,
  JsonValue,
};

export function isRuntimePersistenceJsonValue(
  value: unknown,
): value is JsonValue {
  return isProtocolJsonValue(value);
}

export function isRuntimePersistenceRenderer(
  value: unknown,
): value is ArtifactRuntimePersistenceRenderer {
  return isProtocolArtifactRuntimePersistenceRenderer(value);
}
