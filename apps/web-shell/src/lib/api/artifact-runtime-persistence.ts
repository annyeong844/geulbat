import {
  isArtifactRuntimePersistenceClearResponse,
  isArtifactRuntimePersistenceLoadResponse,
  isArtifactRuntimePersistenceSaveResponse,
} from '@geulbat/protocol/runtime-persistence';
import type {
  ArtifactRuntimePersistenceClearRequest,
  ArtifactRuntimePersistenceClearResponse,
  ArtifactRuntimePersistenceLoadRequest,
  ArtifactRuntimePersistenceLoadResponse,
  ArtifactRuntimePersistenceSaveRequest,
  ArtifactRuntimePersistenceSaveResponse,
} from '@geulbat/protocol/runtime-persistence';

import { apiFetch } from './client.js';

export function loadArtifactRuntimePersistenceState(
  request: ArtifactRuntimePersistenceLoadRequest,
): Promise<ArtifactRuntimePersistenceLoadResponse> {
  return apiFetch(
    '/api/artifact-runtime-persistence/load',
    {
      method: 'POST',
      body: JSON.stringify(request),
    },
    isArtifactRuntimePersistenceLoadResponse,
  );
}

export function saveArtifactRuntimePersistenceState(
  request: ArtifactRuntimePersistenceSaveRequest,
): Promise<ArtifactRuntimePersistenceSaveResponse> {
  return apiFetch(
    '/api/artifact-runtime-persistence/save',
    {
      method: 'POST',
      body: JSON.stringify(request),
    },
    isArtifactRuntimePersistenceSaveResponse,
  );
}

export function clearArtifactRuntimePersistenceState(
  request: ArtifactRuntimePersistenceClearRequest,
): Promise<ArtifactRuntimePersistenceClearResponse> {
  return apiFetch(
    '/api/artifact-runtime-persistence/clear',
    {
      method: 'POST',
      body: JSON.stringify(request),
    },
    isArtifactRuntimePersistenceClearResponse,
  );
}
