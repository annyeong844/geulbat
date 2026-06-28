import { rm } from 'node:fs/promises';
import type {
  JsonValue,
  ArtifactRuntimePersistenceClearResponse,
  ArtifactRuntimePersistenceLoadResponse,
  ArtifactRuntimePersistenceSaveResponse,
  ArtifactRuntimePersistenceScopeRequest,
} from './contract.js';

import { writeAtomically } from '../runtime-persistence-file-access.js';
import { classifyRuntimePersistenceError } from './errors.js';
import {
  assertExpectedRuntimePersistenceRevision,
  buildPersistedRuntimeState,
  readPersistedRuntimeState,
} from './stored-state.js';
import {
  resolveRuntimePersistenceTarget,
  withRuntimePersistenceLock,
} from './access.js';

export {
  PersistenceBlockedError,
  PersistenceConflictError,
  PersistenceQuotaExceededError,
  PersistenceUnavailableError,
} from './errors.js';

export async function loadArtifactRuntimePersistenceState(
  workspaceRoot: string,
  scope: ArtifactRuntimePersistenceScopeRequest,
): Promise<ArtifactRuntimePersistenceLoadResponse> {
  const access = await resolveRuntimePersistenceTarget(workspaceRoot, scope);
  const persisted = await readPersistedRuntimeState(access.filePath, scope);
  if (!persisted) {
    return emptyArtifactRuntimePersistenceState();
  }
  return {
    state: persisted.payload.state,
    revision: persisted.payload.revision,
  };
}

export async function saveArtifactRuntimePersistenceState(
  workspaceRoot: string,
  scope: ArtifactRuntimePersistenceScopeRequest,
  state: JsonValue | null,
  expectedRevision: string | null,
): Promise<ArtifactRuntimePersistenceSaveResponse> {
  const access = await resolveRuntimePersistenceTarget(workspaceRoot, scope);
  return withRuntimePersistenceLock(
    workspaceRoot,
    access.filePath,
    async () => {
      await assertExpectedRuntimePersistenceRevision(
        access.filePath,
        scope,
        expectedRevision,
      );
      const next = buildPersistedRuntimeState(scope, state);
      try {
        await writeAtomically(access.target, next.serialized);
      } catch (error: unknown) {
        throw classifyRuntimePersistenceError(
          'runtime persistence write failed',
          error,
        );
      }
      return { revision: next.payload.revision };
    },
  );
}

export async function clearArtifactRuntimePersistenceState(
  workspaceRoot: string,
  scope: ArtifactRuntimePersistenceScopeRequest,
  expectedRevision: string | null,
): Promise<ArtifactRuntimePersistenceClearResponse> {
  const access = await resolveRuntimePersistenceTarget(workspaceRoot, scope);
  return withRuntimePersistenceLock(
    workspaceRoot,
    access.filePath,
    async () => {
      const current = await assertExpectedRuntimePersistenceRevision(
        access.filePath,
        scope,
        expectedRevision,
      );
      if (current) {
        try {
          await rm(access.filePath, { force: true });
        } catch (error: unknown) {
          throw classifyRuntimePersistenceError(
            'runtime persistence clear failed',
            error,
          );
        }
      }
      return { revision: null };
    },
  );
}

function emptyArtifactRuntimePersistenceState(): ArtifactRuntimePersistenceLoadResponse {
  return {
    state: null,
    revision: null,
  };
}
