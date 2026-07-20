import {
  isArtifactRuntimePersistenceClearResponse,
  isArtifactRuntimePersistenceLoadResponse,
  isArtifactRuntimePersistenceSaveResponse,
  isArtifactRuntimePersistenceStateInputRefResponse,
} from '@geulbat/protocol/runtime-persistence';
import type {
  ArtifactRuntimePersistenceClearRequest,
  ArtifactRuntimePersistenceClearResponse,
  ArtifactRuntimePersistenceLoadRequest,
  ArtifactRuntimePersistenceLoadResponse,
  ArtifactRuntimePersistenceSaveRequest,
  ArtifactRuntimePersistenceSaveResponse,
  JsonValue,
} from '@geulbat/protocol/runtime-persistence';
import { getErrorMessage } from '../error-message.js';
import { createLogger } from '@geulbat/structured-logger/logger';

import { apiFetch, isApiOkResponse } from './client.js';

const ARTIFACT_RUNTIME_STATE_INPUT_CONTENT_TYPE = 'application/octet-stream';
const logger = createLogger('api/artifact-runtime-persistence');

export function loadArtifactRuntimePersistenceState(
  request: ArtifactRuntimePersistenceLoadRequest,
): Promise<ArtifactRuntimePersistenceLoadResponse> {
  return apiFetch(
    '/api/artifact-runtime-persistence/load',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
    isArtifactRuntimePersistenceLoadResponse,
  );
}

export async function saveArtifactRuntimePersistenceState(
  request: ArtifactRuntimePersistenceSaveRequest,
): Promise<ArtifactRuntimePersistenceSaveResponse> {
  if ('stateRef' in request) {
    return postArtifactRuntimePersistenceSaveRequest(request);
  }

  const stateRef = await uploadArtifactRuntimePersistenceState(request.state);
  try {
    return await postArtifactRuntimePersistenceSaveRequest({
      threadId: request.threadId,
      renderer: request.renderer,
      artifactId: request.artifactId,
      persistenceEpoch: request.persistenceEpoch,
      expectedRevision: request.expectedRevision,
      stateRef,
    });
  } catch (error: unknown) {
    await cleanupArtifactRuntimePersistenceStateRefAfterFailure(
      stateRef,
      error,
    );
    throw error;
  }
}

function deleteArtifactRuntimePersistenceStateRef(
  stateRef: string,
): Promise<unknown> {
  return apiFetch(
    `/api/artifact-runtime-persistence/state-inputs?stateRef=${encodeURIComponent(stateRef)}`,
    { method: 'DELETE' },
    isApiOkResponse,
  );
}

async function cleanupArtifactRuntimePersistenceStateRefAfterFailure(
  stateRef: string,
  originalError: unknown,
): Promise<void> {
  try {
    await deleteArtifactRuntimePersistenceStateRef(stateRef);
  } catch (cleanupError: unknown) {
    logger.warn(
      'failed to delete uploaded runtime persistence state ref after failure:',
      {
        stateRef,
        originalError: getErrorMessage(originalError),
        cleanupError: getErrorMessage(cleanupError),
      },
    );
  }
}

function postArtifactRuntimePersistenceSaveRequest(
  request: ArtifactRuntimePersistenceSaveRequest,
): Promise<ArtifactRuntimePersistenceSaveResponse> {
  return apiFetch(
    '/api/artifact-runtime-persistence/save',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
    isArtifactRuntimePersistenceSaveResponse,
  );
}

async function uploadArtifactRuntimePersistenceState(
  state: JsonValue | null,
): Promise<string> {
  const response = await apiFetch(
    '/api/artifact-runtime-persistence/state-inputs',
    {
      method: 'POST',
      headers: { 'Content-Type': ARTIFACT_RUNTIME_STATE_INPUT_CONTENT_TYPE },
      body: new Blob([JSON.stringify(state)], {
        type: ARTIFACT_RUNTIME_STATE_INPUT_CONTENT_TYPE,
      }),
    },
    isArtifactRuntimePersistenceStateInputRefResponse,
  );
  return response.stateRef;
}

export function clearArtifactRuntimePersistenceState(
  request: ArtifactRuntimePersistenceClearRequest,
): Promise<ArtifactRuntimePersistenceClearResponse> {
  return apiFetch(
    '/api/artifact-runtime-persistence/clear',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
    isArtifactRuntimePersistenceClearResponse,
  );
}
