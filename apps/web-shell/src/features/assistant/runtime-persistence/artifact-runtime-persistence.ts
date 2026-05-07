import {
  isJsonValue,
  type ArtifactRuntimePersistenceScopeRequest,
  type JsonValue,
} from '@geulbat/protocol/runtime-persistence';
import { isPersistenceApiError } from '@geulbat/protocol/errors';

import { ApiFetchError } from '../../../lib/api/client.js';
import {
  clearArtifactRuntimePersistenceState,
  loadArtifactRuntimePersistenceState,
  saveArtifactRuntimePersistenceState,
} from '../../../lib/api/artifact-runtime-persistence.js';
import {
  ARTIFACT_RUNTIME_PERSISTENCE_VERBS,
  type ArtifactRuntimePersistenceBridgeResponder,
  type ArtifactRuntimePersistenceClient,
  type ArtifactRuntimePersistenceErrorCode,
  type ArtifactRuntimePersistenceRequestMessage,
  type ArtifactRuntimePersistenceResponseMessage,
  PERSISTENCE_BRIDGE_VERSION,
  PERSISTENCE_RESPONSE_KIND,
  isArtifactRuntimePersistenceRequestMessage,
} from './artifact-runtime-persistence-types.js';

const defaultPersistenceClient: ArtifactRuntimePersistenceClient = {
  loadState: loadArtifactRuntimePersistenceState,
  saveState(scope, state, expectedRevision) {
    return saveArtifactRuntimePersistenceState({
      ...scope,
      state,
      expectedRevision,
    });
  },
  clearState(scope, expectedRevision) {
    return clearArtifactRuntimePersistenceState({ ...scope, expectedRevision });
  },
};

export function createArtifactRuntimePersistenceScopeKey(
  scope: ArtifactRuntimePersistenceScopeRequest | null,
): string | null {
  if (!scope) {
    return null;
  }

  return JSON.stringify([
    scope.projectId,
    scope.threadId,
    scope.artifactId,
    scope.persistenceEpoch,
  ]);
}

export function readPersistenceErrorCode(
  error: unknown,
): ArtifactRuntimePersistenceErrorCode {
  if (error instanceof ApiFetchError && isPersistenceApiError(error.bodyJson)) {
    return error.bodyJson.code;
  }
  return 'persistence_unavailable';
}

export function readPersistenceErrorMessage(error: unknown): string {
  if (error instanceof ApiFetchError) {
    if (isPersistenceApiError(error.bodyJson) && error.bodyJson.message) {
      return error.bodyJson.message;
    }
    return error.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'runtime persistence unavailable';
}

export function createArtifactRuntimePersistenceBridgeResponder(args: {
  expectedSource: () => MessageEventSource | null;
  scope: ArtifactRuntimePersistenceScopeRequest | null;
  scopeHandle: string;
  client?: ArtifactRuntimePersistenceClient;
}): ArtifactRuntimePersistenceBridgeResponder {
  const scopeHandle = args.scopeHandle;
  const client = args.client ?? defaultPersistenceClient;

  return {
    scopeHandle,
    async handleMessage(source, data) {
      if (source !== args.expectedSource()) {
        return null;
      }
      if (!isArtifactRuntimePersistenceRequestMessage(data)) {
        return null;
      }

      if (data.scopeHandle !== scopeHandle) {
        return errorResponse(
          scopeHandle,
          data,
          'persistence_blocked',
          'runtime persistence scopeHandle mismatch',
        );
      }
      if (!args.scope) {
        return errorResponse(
          scopeHandle,
          data,
          'persistence_unavailable',
          'runtime persistence scope is unavailable for this artifact',
        );
      }
      const scope = args.scope;

      try {
        switch (data.verb) {
          case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.loadState: {
            const result = await client.loadState(scope);
            return successResponse(scopeHandle, data, {
              state: result.state,
              revision: result.revision,
            });
          }
          case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.saveState: {
            const saveInput = readSaveStateInput(scopeHandle, data);
            if (!saveInput.ok) {
              return saveInput.error;
            }
            const result = await client.saveState(
              scope,
              saveInput.state,
              saveInput.expectedRevision,
            );
            return successResponse(scopeHandle, data, {
              revision: result.revision,
            });
          }
          case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.clearState: {
            const expectedRevision = readExpectedRevision(scopeHandle, data);
            if (!expectedRevision.ok) {
              return expectedRevision.error;
            }
            const result = await client.clearState(
              scope,
              expectedRevision.value,
            );
            return successResponse(scopeHandle, data, {
              revision: result.revision,
            });
          }
        }
      } catch (error: unknown) {
        return errorResponse(
          scopeHandle,
          data,
          readPersistenceErrorCode(error),
          readPersistenceErrorMessage(error),
        );
      }
    },
  };
}

export function createArtifactRuntimePersistenceScopeHandle(
  scopeSeed: string,
): string {
  if (scopeSeed.length === 0) {
    throw new Error('runtime persistence scopeSeed must be non-empty');
  }
  return `scope-${scopeSeed}`;
}

function readExpectedRevision(
  scopeHandle: string,
  request: ArtifactRuntimePersistenceRequestMessage,
):
  | { ok: true; value: string | null }
  | {
      ok: false;
      error: ArtifactRuntimePersistenceResponseMessage;
    } {
  if (!('expectedRevision' in request)) {
    return {
      ok: false,
      error: errorResponse(
        scopeHandle,
        request,
        'persistence_blocked',
        `${request.verb} requires expectedRevision`,
      ),
    };
  }

  return { ok: true, value: request.expectedRevision ?? null };
}

function readSaveStateInput(
  scopeHandle: string,
  request: ArtifactRuntimePersistenceRequestMessage,
):
  | { ok: true; expectedRevision: string | null; state: JsonValue | null }
  | { ok: false; error: ArtifactRuntimePersistenceResponseMessage } {
  const expectedRevision = readExpectedRevision(scopeHandle, request);
  if (!expectedRevision.ok) {
    return expectedRevision;
  }
  if (!('state' in request) || !isJsonValue(request.state)) {
    return {
      ok: false,
      error: errorResponse(
        scopeHandle,
        request,
        'persistence_blocked',
        'save_state requires JSON-serializable state',
      ),
    };
  }

  return {
    ok: true,
    expectedRevision: expectedRevision.value,
    state: request.state ?? null,
  };
}

function successResponse(
  scopeHandle: string,
  request: ArtifactRuntimePersistenceRequestMessage,
  payload: {
    revision: string | null;
    state?: JsonValue;
  },
): ArtifactRuntimePersistenceResponseMessage {
  return {
    kind: PERSISTENCE_RESPONSE_KIND,
    version: PERSISTENCE_BRIDGE_VERSION,
    requestId: request.requestId,
    scopeHandle,
    verb: request.verb,
    ok: true,
    ...payload,
  };
}

function errorResponse(
  scopeHandle: string,
  request: ArtifactRuntimePersistenceRequestMessage,
  errorCode: ArtifactRuntimePersistenceErrorCode,
  message: string,
): ArtifactRuntimePersistenceResponseMessage {
  return {
    kind: PERSISTENCE_RESPONSE_KIND,
    version: PERSISTENCE_BRIDGE_VERSION,
    requestId: request.requestId,
    scopeHandle,
    verb: request.verb,
    ok: false,
    errorCode,
    message,
  };
}
