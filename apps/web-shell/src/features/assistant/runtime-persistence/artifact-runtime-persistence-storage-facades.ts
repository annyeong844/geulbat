import type { ArtifactRuntimePersistenceBridge } from './artifact-runtime-persistence-bootstrap-bridge.js';
import type { PersistenceBootstrapWindow } from './artifact-runtime-persistence-bootstrap-types.js';
import type { ArtifactRuntimePersistenceStorageFacadeStore } from './artifact-runtime-persistence-storage-facade-store.js';

interface GeulbatStorageFacadeDependencies {
  window: PersistenceBootstrapWindow;
  bridge: ArtifactRuntimePersistenceBridge;
  store: ArtifactRuntimePersistenceStorageFacadeStore;
  clearRecord: (record: Record<string, unknown>) => void;
}

export function createLogicalDatabaseFacade({
  window,
  bridge,
  store,
  clearRecord,
}: Pick<
  GeulbatStorageFacadeDependencies,
  'window' | 'bridge' | 'store' | 'clearRecord'
>) {
  return Object.freeze({
    async get(key: unknown) {
      await store.ensureStorageReady(window);
      store.assertSharedStorageAvailable();
      const normalizedKey = store.normalizeDatabaseKey(key);
      await store.waitForCommittedStorageWrites();
      store.assertSharedStorageAvailable();
      const currentDatabaseMap = store.readCurrentDatabaseMap();
      return Object.hasOwn(currentDatabaseMap, normalizedKey)
        ? store.cloneJsonValue(currentDatabaseMap[normalizedKey])
        : null;
    },
    async put(key: unknown, value: unknown) {
      await store.ensureStorageReady(window);
      store.assertSharedStorageAvailable();
      const normalizedKey = store.normalizeDatabaseKey(key);
      store.assertDatabaseValue(value);
      return store.schedulePersistedMutation(
        bridge.rawPersistenceApi,
        ({ databaseMap }) => {
          databaseMap[normalizedKey] = store.cloneJsonValue(value);
        },
      );
    },
    async delete(key: unknown) {
      await store.ensureStorageReady(window);
      store.assertSharedStorageAvailable();
      const normalizedKey = store.normalizeDatabaseKey(key);
      const currentDatabaseMap = store.readCurrentDatabaseMap();
      if (!Object.hasOwn(currentDatabaseMap, normalizedKey)) {
        return false;
      }
      await store.schedulePersistedMutation(
        bridge.rawPersistenceApi,
        ({ databaseMap }) => {
          delete databaseMap[normalizedKey];
        },
      );
      return true;
    },
    async keys() {
      await store.ensureStorageReady(window);
      store.assertSharedStorageAvailable();
      await store.waitForCommittedStorageWrites();
      store.assertSharedStorageAvailable();
      return store.listDatabaseKeys();
    },
    async clear() {
      await store.ensureStorageReady(window);
      store.assertSharedStorageAvailable();
      if (Object.keys(store.readCurrentDatabaseMap()).length === 0) {
        return;
      }
      await store.schedulePersistedMutation(
        bridge.rawPersistenceApi,
        ({ databaseMap }) => {
          clearRecord(databaseMap);
        },
      );
    },
  });
}

export function createStorageFacade({
  window,
  bridge,
  store,
}: Pick<GeulbatStorageFacadeDependencies, 'window' | 'bridge' | 'store'>) {
  return Object.freeze({
    async get(key: unknown) {
      await store.ensureStorageReady(window);
      store.assertSharedStorageAvailable();
      const normalizedKey = store.normalizeStorageKey(key);
      await store.waitForCommittedStorageWrites();
      store.assertSharedStorageAvailable();
      const currentStorageMap = store.readCurrentStorageMap();
      return Object.hasOwn(currentStorageMap, normalizedKey)
        ? currentStorageMap[normalizedKey]
        : null;
    },
    async set(key: unknown, value: unknown) {
      await store.ensureStorageReady(window);
      store.assertSharedStorageAvailable();
      const normalizedKey = store.normalizeStorageKey(key);
      store.assertStorageValue(value);
      return store.schedulePersistedMutation(
        bridge.rawPersistenceApi,
        ({ storageMap }) => {
          storageMap[normalizedKey] = value;
        },
      );
    },
    async delete(key: unknown) {
      await store.ensureStorageReady(window);
      store.assertSharedStorageAvailable();
      const normalizedKey = store.normalizeStorageKey(key);
      const currentStorageMap = store.readCurrentStorageMap();
      if (!Object.hasOwn(currentStorageMap, normalizedKey)) {
        return false;
      }
      await store.schedulePersistedMutation(
        bridge.rawPersistenceApi,
        ({ storageMap }) => {
          delete storageMap[normalizedKey];
        },
      );
      return true;
    },
    async list(prefix?: unknown) {
      await store.ensureStorageReady(window);
      store.assertSharedStorageAvailable();
      if (prefix !== undefined && typeof prefix !== 'string') {
        throw store.createPersistenceError(
          'persistence_blocked',
          'storage prefix must be a string when provided',
        );
      }
      await store.waitForCommittedStorageWrites();
      store.assertSharedStorageAvailable();
      return store
        .listStorageKeys()
        .filter((key) =>
          prefix === undefined ? true : key.startsWith(prefix),
        );
    },
  });
}
