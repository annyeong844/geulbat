import type { ArtifactId } from './artifacts.js';
import type { ThreadId } from './ids.js';
import {
  isNumber,
  isPlainRecord,
  isRecord,
  isString,
} from './wire-value-guards.js';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (!isPlainRecord(value)) {
    return false;
  }
  return Object.values(value).every(isJsonValue);
}

const ARTIFACT_RUNTIME_PERSISTENCE_RENDERERS = [
  'html5',
  'js',
  'react_bundle',
] as const;

export type ArtifactRuntimePersistenceRenderer =
  (typeof ARTIFACT_RUNTIME_PERSISTENCE_RENDERERS)[number];

export function isArtifactRuntimePersistenceRenderer(
  value: unknown,
): value is ArtifactRuntimePersistenceRenderer {
  return (
    typeof value === 'string' &&
    (ARTIFACT_RUNTIME_PERSISTENCE_RENDERERS as readonly string[]).includes(
      value,
    )
  );
}

export interface ArtifactRuntimePersistenceScopeRequest {
  threadId: ThreadId;
  renderer: ArtifactRuntimePersistenceRenderer;
  artifactId: ArtifactId;
  persistenceEpoch: number;
}

export type ArtifactRuntimePersistenceLoadRequest =
  ArtifactRuntimePersistenceScopeRequest;

export interface ArtifactRuntimePersistenceLoadResponse {
  state: JsonValue | null;
  revision: string | null;
}

export type ArtifactRuntimePersistenceSaveRequest =
  ArtifactRuntimePersistenceScopeRequest & {
    expectedRevision: string | null;
  } & (
      | {
          state: JsonValue | null;
          stateRef?: never;
        }
      | {
          state?: never;
          stateRef: string;
        }
    );

export interface ArtifactRuntimePersistenceSaveResponse {
  revision: string;
}

export interface ArtifactRuntimePersistenceStateInputRefResponse {
  ok: true;
  stateRef: string;
  byteLength: number;
}

export interface ArtifactRuntimePersistenceClearRequest extends ArtifactRuntimePersistenceScopeRequest {
  expectedRevision: string | null;
}

export interface ArtifactRuntimePersistenceClearResponse {
  revision: null;
}

export function isArtifactRuntimePersistenceLoadResponse(
  value: unknown,
): value is ArtifactRuntimePersistenceLoadResponse {
  return (
    isRecord(value) &&
    ('state' in value ? isJsonValue(value.state) : false) &&
    (value.revision === null || isString(value.revision))
  );
}

export function isArtifactRuntimePersistenceSaveResponse(
  value: unknown,
): value is ArtifactRuntimePersistenceSaveResponse {
  return isRecord(value) && isString(value.revision);
}

export function isArtifactRuntimePersistenceStateInputRefResponse(
  value: unknown,
): value is ArtifactRuntimePersistenceStateInputRefResponse {
  return (
    isRecord(value) &&
    value.ok === true &&
    isString(value.stateRef) &&
    isNumber(value.byteLength)
  );
}

export function isArtifactRuntimePersistenceClearResponse(
  value: unknown,
): value is ArtifactRuntimePersistenceClearResponse {
  return isRecord(value) && value.revision === null;
}
