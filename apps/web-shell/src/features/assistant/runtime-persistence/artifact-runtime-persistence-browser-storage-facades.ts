import type { ArtifactRuntimePersistenceBridge } from './artifact-runtime-persistence-bootstrap-bridge.js';
import type { ArtifactRuntimePersistenceStorageFacadeStore } from './artifact-runtime-persistence-storage-facade-store.js';

interface BrowserStorageFacadeDependencies {
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
}: BrowserStorageFacadeDependencies) {
  return Object.freeze({
    getItem(key: unknown) {
      store.assertStorageBootstrapReady();
      store.assertSharedStorageAvailable();
      const normalizedKey = store.normalizeStorageKey(key);
      const currentStorageMap = store.readCurrentStorageMap();
      return Object.hasOwn(currentStorageMap, normalizedKey)
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
      if (!Object.hasOwn(currentStorageMap, normalizedKey)) {
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
}: Pick<BrowserStorageFacadeDependencies, 'store' | 'clearRecord'>) {
  return Object.freeze({
    getItem(key: unknown) {
      store.assertStorageBootstrapReady();
      const normalizedKey = store.normalizeStorageKey(key);
      const currentSessionStorageMap = store.readCurrentSessionStorageMap();
      return Object.hasOwn(currentSessionStorageMap, normalizedKey)
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
      if (!Object.hasOwn(currentSessionStorageMap, normalizedKey)) {
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
      store.createNextSessionStorageMap(clearRecord);
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
