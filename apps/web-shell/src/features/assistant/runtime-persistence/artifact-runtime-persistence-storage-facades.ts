import type { ArtifactRuntimePersistenceBridge } from './artifact-runtime-persistence-bootstrap-bridge.js';
import type { PersistenceBootstrapWindow } from './artifact-runtime-persistence-bootstrap-types.js';
import type { ArtifactRuntimePersistenceStorageFacadeStore } from './artifact-runtime-persistence-storage-facade-store.js';

interface StorageFacadeDependencies {
  window: PersistenceBootstrapWindow;
  bridge: ArtifactRuntimePersistenceBridge;
  store: ArtifactRuntimePersistenceStorageFacadeStore;
  clearRecord: (record: Record<string, unknown>) => void;
  markDeferredPersistenceFailure: (error: unknown) => void;
}

export function createLocalStorageFacade({
  bridge,
  store,
  clearRecord,
  markDeferredPersistenceFailure,
}: Pick<
  StorageFacadeDependencies,
  'bridge' | 'store' | 'clearRecord' | 'markDeferredPersistenceFailure'
>) {
  return Object.freeze({
    getItem(key: unknown) {
      store.assertStorageBootstrapReady();
      store.assertSharedStorageAvailable();
      const normalizedKey = store.normalizeStorageKey(key);
      const currentStorageMap = store.readCurrentStorageMap();
      return Object.prototype.hasOwnProperty.call(
        currentStorageMap,
        normalizedKey,
      )
        ? String(currentStorageMap[normalizedKey])
        : null;
    },
    setItem(key: unknown, value: unknown) {
      store.assertStorageBootstrapReady();
      store.assertSharedStorageAvailable();
      const normalizedKey = store.normalizeStorageKey(key);
      void store
        .schedulePersistedMutation(
          bridge.rawPersistenceApi,
          ({ storageMap }) => {
            storageMap[normalizedKey] = String(value);
          },
        )
        .catch(markDeferredPersistenceFailure);
    },
    removeItem(key: unknown) {
      store.assertStorageBootstrapReady();
      store.assertSharedStorageAvailable();
      const normalizedKey = store.normalizeStorageKey(key);
      const currentStorageMap = store.readCurrentStorageMap();
      if (
        !Object.prototype.hasOwnProperty.call(currentStorageMap, normalizedKey)
      ) {
        return;
      }
      void store
        .schedulePersistedMutation(
          bridge.rawPersistenceApi,
          ({ storageMap }) => {
            delete storageMap[normalizedKey];
          },
        )
        .catch(markDeferredPersistenceFailure);
    },
    clear() {
      store.assertStorageBootstrapReady();
      store.assertSharedStorageAvailable();
      if (Object.keys(store.readCurrentStorageMap()).length === 0) {
        return;
      }
      void store
        .schedulePersistedMutation(
          bridge.rawPersistenceApi,
          ({ storageMap }) => {
            clearRecord(storageMap);
          },
        )
        .catch(markDeferredPersistenceFailure);
    },
    key(index: unknown) {
      store.assertStorageBootstrapReady();
      store.assertSharedStorageAvailable();
      const normalizedIndex = store.normalizeStorageIndex(index);
      if (normalizedIndex === null) {
        return null;
      }
      return store.listStorageKeys()[normalizedIndex] ?? null;
    },
    get length() {
      store.assertStorageBootstrapReady();
      store.assertSharedStorageAvailable();
      return store.listStorageKeys().length;
    },
  });
}

export function createSessionStorageFacade({
  store,
  clearRecord,
}: Pick<StorageFacadeDependencies, 'store' | 'clearRecord'>) {
  return Object.freeze({
    getItem(key: unknown) {
      store.assertStorageBootstrapReady();
      const normalizedKey = store.normalizeStorageKey(key);
      const currentSessionStorageMap = store.readCurrentSessionStorageMap();
      return Object.prototype.hasOwnProperty.call(
        currentSessionStorageMap,
        normalizedKey,
      )
        ? String(currentSessionStorageMap[normalizedKey])
        : null;
    },
    setItem(key: unknown, value: unknown) {
      store.assertStorageBootstrapReady();
      const normalizedKey = store.normalizeStorageKey(key);
      store.createNextSessionStorageMap((map) => {
        map[normalizedKey] = String(value);
      });
    },
    removeItem(key: unknown) {
      store.assertStorageBootstrapReady();
      const normalizedKey = store.normalizeStorageKey(key);
      const currentSessionStorageMap = store.readCurrentSessionStorageMap();
      if (
        !Object.prototype.hasOwnProperty.call(
          currentSessionStorageMap,
          normalizedKey,
        )
      ) {
        return;
      }
      store.createNextSessionStorageMap((map) => {
        delete map[normalizedKey];
      });
    },
    clear() {
      store.assertStorageBootstrapReady();
      if (Object.keys(store.readCurrentSessionStorageMap()).length === 0) {
        return;
      }
      const next = Object.create(null) as Record<string, string>;
      clearRecord(next);
      store.replaceCurrentSessionStorageMap(next);
    },
    key(index: unknown) {
      store.assertStorageBootstrapReady();
      const normalizedIndex = store.normalizeStorageIndex(index);
      if (normalizedIndex === null) {
        return null;
      }
      return store.listSessionStorageKeys()[normalizedIndex] ?? null;
    },
    get length() {
      store.assertStorageBootstrapReady();
      return store.listSessionStorageKeys().length;
    },
  });
}

export function createLogicalDatabaseFacade({
  window,
  bridge,
  store,
  clearRecord,
}: Pick<
  StorageFacadeDependencies,
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
      return Object.prototype.hasOwnProperty.call(
        currentDatabaseMap,
        normalizedKey,
      )
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
      if (
        !Object.prototype.hasOwnProperty.call(currentDatabaseMap, normalizedKey)
      ) {
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
}: Pick<StorageFacadeDependencies, 'window' | 'bridge' | 'store'>) {
  return Object.freeze({
    async get(key: unknown) {
      await store.ensureStorageReady(window);
      store.assertSharedStorageAvailable();
      const normalizedKey = store.normalizeStorageKey(key);
      await store.waitForCommittedStorageWrites();
      store.assertSharedStorageAvailable();
      const currentStorageMap = store.readCurrentStorageMap();
      return Object.prototype.hasOwnProperty.call(
        currentStorageMap,
        normalizedKey,
      )
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
      if (
        !Object.prototype.hasOwnProperty.call(currentStorageMap, normalizedKey)
      ) {
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
