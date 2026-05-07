import { isRecord } from '@geulbat/protocol/runtime-utils';
import type {
  ArtifactRuntimePersistenceClearResponse,
  ArtifactRuntimePersistenceLoadResponse,
  ArtifactRuntimePersistenceScopeRequest,
  ArtifactRuntimePersistenceSaveResponse,
  JsonValue,
} from '@geulbat/protocol/runtime-persistence';

export const PERSISTENCE_BRIDGE_VERSION = 1 as const;

export const PERSISTENCE_REQUEST_KIND =
  'geulbat.runtime.persistence.request' as const;
export const PERSISTENCE_RESPONSE_KIND =
  'geulbat.shell.persistence.response' as const;

export type ArtifactRuntimePersistenceErrorCode =
  | 'persistence_unsupported'
  | 'persistence_blocked'
  | 'persistence_unavailable'
  | 'persistence_conflict'
  | 'persistence_quota_exceeded';

export const ARTIFACT_RUNTIME_PERSISTENCE_VERBS = {
  loadState: 'load_state',
  saveState: 'save_state',
  clearState: 'clear_state',
} as const;

type ArtifactRuntimePersistenceVerb =
  (typeof ARTIFACT_RUNTIME_PERSISTENCE_VERBS)[keyof typeof ARTIFACT_RUNTIME_PERSISTENCE_VERBS];

export interface ArtifactRuntimePersistenceRequestMessage {
  kind: typeof PERSISTENCE_REQUEST_KIND;
  version: typeof PERSISTENCE_BRIDGE_VERSION;
  requestId: string;
  scopeHandle: string;
  verb: ArtifactRuntimePersistenceVerb;
  state?: JsonValue | null;
  expectedRevision?: string | null;
}

export type ArtifactRuntimePersistenceResponseMessage =
  | {
      kind: typeof PERSISTENCE_RESPONSE_KIND;
      version: typeof PERSISTENCE_BRIDGE_VERSION;
      requestId: string;
      scopeHandle: string;
      verb: ArtifactRuntimePersistenceVerb;
      ok: true;
      state?: JsonValue | null;
      revision: string | null;
    }
  | {
      kind: typeof PERSISTENCE_RESPONSE_KIND;
      version: typeof PERSISTENCE_BRIDGE_VERSION;
      requestId: string;
      scopeHandle: string;
      verb: ArtifactRuntimePersistenceVerb;
      ok: false;
      errorCode: ArtifactRuntimePersistenceErrorCode;
      message: string;
    };

export interface ArtifactRuntimePersistenceClient {
  loadState: (
    scope: ArtifactRuntimePersistenceScopeRequest,
  ) => Promise<ArtifactRuntimePersistenceLoadResponse>;
  saveState: (
    scope: ArtifactRuntimePersistenceScopeRequest,
    state: JsonValue | null,
    expectedRevision: string | null,
  ) => Promise<ArtifactRuntimePersistenceSaveResponse>;
  clearState: (
    scope: ArtifactRuntimePersistenceScopeRequest,
    expectedRevision: string | null,
  ) => Promise<ArtifactRuntimePersistenceClearResponse>;
}

export interface ArtifactRuntimePersistenceBridgeResponder {
  scopeHandle: string;
  handleMessage: (
    source: MessageEventSource | null,
    data: unknown,
  ) => Promise<ArtifactRuntimePersistenceResponseMessage | null>;
}

export function isArtifactRuntimePersistenceRequestMessage(
  value: unknown,
): value is ArtifactRuntimePersistenceRequestMessage {
  if (!isRecord(value)) {
    return false;
  }
  const record = value;
  return (
    record['kind'] === PERSISTENCE_REQUEST_KIND &&
    record['version'] === PERSISTENCE_BRIDGE_VERSION &&
    typeof record['requestId'] === 'string' &&
    typeof record['scopeHandle'] === 'string' &&
    (record['verb'] === ARTIFACT_RUNTIME_PERSISTENCE_VERBS.loadState ||
      record['verb'] === ARTIFACT_RUNTIME_PERSISTENCE_VERBS.saveState ||
      record['verb'] === ARTIFACT_RUNTIME_PERSISTENCE_VERBS.clearState)
  );
}
