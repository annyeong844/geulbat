import { isRecord } from '../../../lib/json.js';

import type {
  PersistenceRecord,
  SessionStorageRecord,
} from './artifact-runtime-persistence-bootstrap-types.js';

export interface PersistenceAuthoritySnapshot {
  storageMap: PersistenceRecord;
  databaseMap: PersistenceRecord;
  revision: string | null;
}

export interface PersistenceStateMutation {
  id: number;
  apply(next: {
    storageMap: PersistenceRecord;
    databaseMap: PersistenceRecord;
  }): void;
}

export const STORAGE_NAMESPACE_KEY = '__geulbat_storage_namespace_v1__';
export const DATABASE_NAMESPACE_KEY = '__geulbat_db_namespace_v1__';

export function createArtifactRuntimePersistenceAuthorityState() {
  const createNullPrototypeMap = <T>(): Record<string, T> => {
    const next: Record<string, T> = {};
    Object.setPrototypeOf(next, null);
    return next;
  };

  const cloneToNullPrototypeMap = <T>(
    record: Record<string, T>,
  ): Record<string, T> => {
    const next = createNullPrototypeMap<T>();
    for (const [key, value] of Object.entries(record)) {
      next[key] = value;
    }
    return next;
  };

  let currentStorageMap: PersistenceRecord = createNullPrototypeMap();
  let currentSessionStorageMap: SessionStorageRecord = createNullPrototypeMap();
  let currentDatabaseMap: PersistenceRecord = createNullPrototypeMap();
  let committedStorageMap: PersistenceRecord = createNullPrototypeMap();
  let committedDatabaseMap: PersistenceRecord = createNullPrototypeMap();
  let currentStorageRevision: string | null = null;

  const toPersistedStorageState = (record: PersistenceRecord) => {
    const next: PersistenceRecord = {};
    for (const key of Object.keys(record)) {
      next[key] = record[key];
    }
    return next;
  };

  const cloneJsonValue = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map((entry: unknown) => cloneJsonValue(entry));
    }
    if (!isRecord(value)) {
      return value;
    }
    const next: PersistenceRecord = {};
    for (const key of Object.keys(value)) {
      next[key] = cloneJsonValue(value[key]);
    }
    return next;
  };

  const listStorageKeys = () =>
    Object.keys(currentStorageMap).sort((left, right) =>
      left.localeCompare(right),
    );

  const listSessionStorageKeys = () =>
    Object.keys(currentSessionStorageMap).sort((left, right) =>
      left.localeCompare(right),
    );

  const listDatabaseKeys = () =>
    Object.keys(currentDatabaseMap).sort((left, right) =>
      left.localeCompare(right),
    );

  const buildPersistedAuthorityState = (
    storageRecord: PersistenceRecord,
    databaseRecord: PersistenceRecord,
  ) => {
    const hasStorageEntries = Object.keys(storageRecord).length > 0;
    const hasDatabaseEntries = Object.keys(databaseRecord).length > 0;

    if (!hasStorageEntries && !hasDatabaseEntries) {
      return null;
    }

    if (!hasDatabaseEntries) {
      return toPersistedStorageState(storageRecord);
    }

    const next: PersistenceRecord = {
      [DATABASE_NAMESPACE_KEY]: toPersistedStorageState(databaseRecord),
    };
    if (hasStorageEntries) {
      next[STORAGE_NAMESPACE_KEY] = toPersistedStorageState(storageRecord);
    }
    return next;
  };

  const buildStateWithMutations = (
    storageBase: PersistenceRecord,
    databaseBase: PersistenceRecord,
    mutations: readonly PersistenceStateMutation[],
  ) => {
    const next = {
      storageMap: cloneToNullPrototypeMap(storageBase),
      databaseMap: cloneToNullPrototypeMap(databaseBase),
    };

    for (const mutation of mutations) {
      mutation.apply(next);
    }

    return next;
  };

  const refreshCurrentAuthorityState = (
    mutations: readonly PersistenceStateMutation[],
  ) => {
    const next = buildStateWithMutations(
      committedStorageMap,
      committedDatabaseMap,
      mutations,
    );
    currentStorageMap = next.storageMap;
    currentDatabaseMap = next.databaseMap;
  };

  const buildStateThroughMutation = (
    mutations: readonly PersistenceStateMutation[],
    mutationId: number,
  ) => {
    const targetIndex = mutations.findIndex(
      (mutation) => mutation.id === mutationId,
    );
    if (targetIndex < 0) {
      return null;
    }
    return buildStateWithMutations(
      committedStorageMap,
      committedDatabaseMap,
      mutations.slice(0, targetIndex + 1),
    );
  };

  const createNextSessionStorageMap = (
    mutate: (map: SessionStorageRecord) => void,
  ) => {
    const next = cloneToNullPrototypeMap(currentSessionStorageMap);
    mutate(next);
    currentSessionStorageMap = next;
    return cloneToNullPrototypeMap(next);
  };

  const replaceCommittedAuthorityState = (
    next: PersistenceAuthoritySnapshot,
  ) => {
    committedStorageMap = cloneToNullPrototypeMap(next.storageMap);
    committedDatabaseMap = cloneToNullPrototypeMap(next.databaseMap);
    currentStorageRevision = next.revision;
    refreshCurrentAuthorityState([]);
  };

  return {
    STORAGE_NAMESPACE_KEY,
    DATABASE_NAMESPACE_KEY,
    cloneToNullPrototypeMap,
    cloneJsonValue,
    listStorageKeys,
    listSessionStorageKeys,
    listDatabaseKeys,
    buildPersistedAuthorityState,
    refreshCurrentAuthorityState,
    buildStateThroughMutation,
    createNextSessionStorageMap,
    replaceCommittedAuthorityState,
    readCurrentStorageMap: () => currentStorageMap,
    readCurrentSessionStorageMap: () => currentSessionStorageMap,
    readCurrentDatabaseMap: () => currentDatabaseMap,
    readCurrentStorageRevision: () => currentStorageRevision,
  };
}

export type ArtifactRuntimePersistenceAuthorityState = ReturnType<
  typeof createArtifactRuntimePersistenceAuthorityState
>;
