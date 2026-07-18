import type {
  PersistenceBootstrapWindow,
  PersistenceRecord,
} from './artifact-runtime-persistence-bootstrap-types.js';
import {
  DATABASE_NAMESPACE_KEY,
  STORAGE_NAMESPACE_KEY,
  type ArtifactRuntimePersistenceAuthorityState,
  type PersistenceAuthoritySnapshot,
} from './artifact-runtime-persistence-authority-state.js';
import type { PersistenceRawApi } from './artifact-runtime-persistence-mutation-queue.js';
import type { ArtifactRuntimePersistenceValidation } from './artifact-runtime-persistence-validation.js';

export function createArtifactRuntimePersistenceAuthorityIo(args: {
  authorityState: ArtifactRuntimePersistenceAuthorityState;
  validation: ArtifactRuntimePersistenceValidation;
}) {
  const { authorityState, validation } = args;

  const hasOwn = (value: object, key: string) => Object.hasOwn(value, key);

  const loadCurrentAuthorityState = async (
    rawPersistenceApi: PersistenceRawApi,
  ): Promise<PersistenceAuthoritySnapshot> => {
    const result = await rawPersistenceApi.loadState();
    if (result.state === null) {
      return {
        storageMap: authorityState.cloneToNullPrototypeMap<unknown>({}),
        databaseMap: authorityState.cloneToNullPrototypeMap<unknown>({}),
        revision: result.revision ?? null,
      };
    }
    if (!validation.isPlainRecord(result.state)) {
      throw validation.createPersistenceError(
        'persistence_blocked',
        'runtime storage scope is not a valid authority record',
      );
    }

    if (
      !hasOwn(result.state, STORAGE_NAMESPACE_KEY) &&
      !hasOwn(result.state, DATABASE_NAMESPACE_KEY)
    ) {
      return {
        storageMap: authorityState.cloneToNullPrototypeMap(result.state),
        databaseMap: authorityState.cloneToNullPrototypeMap<unknown>({}),
        revision: result.revision ?? null,
      };
    }

    const storageState = hasOwn(result.state, STORAGE_NAMESPACE_KEY)
      ? result.state[STORAGE_NAMESPACE_KEY]
      : {};
    const databaseState = hasOwn(result.state, DATABASE_NAMESPACE_KEY)
      ? result.state[DATABASE_NAMESPACE_KEY]
      : {};

    if (
      !validation.isPlainRecord(storageState) ||
      !validation.isPlainRecord(databaseState)
    ) {
      throw validation.createPersistenceError(
        'persistence_blocked',
        'runtime storage scope is not a valid authority record',
      );
    }

    for (const key of Object.keys(databaseState)) {
      const normalizedDatabaseKey = validation.normalizeDatabaseKey(key);
      validation.assertDatabaseValue(databaseState[normalizedDatabaseKey]);
    }

    return {
      storageMap: authorityState.cloneToNullPrototypeMap(storageState),
      databaseMap: authorityState.cloneToNullPrototypeMap(databaseState),
      revision: result.revision ?? null,
    };
  };

  const persistCurrentAuthorityState = async (
    rawPersistenceApi: PersistenceRawApi,
    storageRecord: PersistenceRecord,
    databaseRecord: PersistenceRecord,
    revision: string | null,
  ) => {
    const persistedState = authorityState.buildPersistedAuthorityState(
      storageRecord,
      databaseRecord,
    );
    if (persistedState === null) {
      return rawPersistenceApi.clearState(revision);
    }
    return rawPersistenceApi.saveState(persistedState, revision);
  };

  const ensureStorageReady = async (window: PersistenceBootstrapWindow) => {
    const ready = window.__GEULBAT_RUNTIME_STORAGE_READY__;
    if (!ready) {
      throw validation.createPersistenceError(
        'persistence_unavailable',
        'runtime storage bootstrap is not ready',
      );
    }
    await ready;
  };

  return {
    loadCurrentAuthorityState,
    persistCurrentAuthorityState,
    ensureStorageReady,
  };
}
