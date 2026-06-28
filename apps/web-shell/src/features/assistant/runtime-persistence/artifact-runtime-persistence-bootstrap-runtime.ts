import { createArtifactRuntimePersistenceBridge } from './artifact-runtime-persistence-bootstrap-bridge.js';
import { createArtifactRuntimePersistenceAuthorityIo } from './artifact-runtime-persistence-authority-io.js';
import {
  createArtifactRuntimePersistenceAuthorityState,
  type PersistenceAuthoritySnapshot,
} from './artifact-runtime-persistence-authority-state.js';
import {
  createArtifactRuntimePersistenceMutationQueue,
  type PersistenceRawApi,
} from './artifact-runtime-persistence-mutation-queue.js';
import type {
  GeulbatRuntimePersistenceError,
  PersistenceBootstrapVerbs,
  PersistenceBootstrapWindow,
} from './artifact-runtime-persistence-bootstrap-types.js';
import { createArtifactRuntimePersistenceValidation } from './artifact-runtime-persistence-validation.js';
import {
  createLocalStorageFacade,
  createSessionStorageFacade,
} from './artifact-runtime-persistence-browser-storage-facades.js';
import {
  createLogicalDatabaseFacade,
  createStorageFacade,
} from './artifact-runtime-persistence-storage-facades.js';
import type { ArtifactRuntimePersistenceStorageFacadeStore } from './artifact-runtime-persistence-storage-facade-store.js';

export type {
  PendingPersistenceRequest,
  PersistenceBootstrapMessageEvent,
  PersistenceBootstrapParent,
  PersistenceBootstrapRequestMessage,
  PersistenceBootstrapSuccessResponseMessage,
  PersistenceBootstrapTimeoutHandle,
  PersistenceBootstrapVerbs,
  PersistenceBootstrapWindow,
} from './artifact-runtime-persistence-bootstrap-types.js';

interface ArtifactRuntimePersistenceBridgeStore {
  createPersistenceError(
    code: string,
    message: string,
  ): GeulbatRuntimePersistenceError;
  assertSharedStorageAvailable(): void;
  isPlainRecord(value: unknown): value is Record<string, unknown>;
}

interface ArtifactRuntimePersistenceBootstrapLifecycle {
  markStorageUnavailable(error: unknown): GeulbatRuntimePersistenceError;
  loadCurrentAuthorityState(
    rawPersistenceApi: PersistenceRawApi,
  ): Promise<PersistenceAuthoritySnapshot>;
  replaceCurrentAuthorityState(next: PersistenceAuthoritySnapshot): void;
  setStorageBootstrapReady(next: boolean): void;
}

interface ArtifactRuntimePersistenceBootstrapServices {
  bridgeStore: ArtifactRuntimePersistenceBridgeStore;
  bootstrapLifecycle: ArtifactRuntimePersistenceBootstrapLifecycle;
  storageFacadeStore: ArtifactRuntimePersistenceStorageFacadeStore;
}

function createArtifactRuntimePersistenceStore(): ArtifactRuntimePersistenceBootstrapServices {
  const authorityState = createArtifactRuntimePersistenceAuthorityState();
  const validation = createArtifactRuntimePersistenceValidation();
  let storageBootstrapReady = false;
  let sharedStorageAuthorityError: GeulbatRuntimePersistenceError | null = null;
  const authorityIo = createArtifactRuntimePersistenceAuthorityIo({
    authorityState,
    validation,
  });

  const getSharedStorageAuthorityError = () =>
    sharedStorageAuthorityError
      ? validation.clonePersistenceError(sharedStorageAuthorityError)
      : null;

  const markStorageUnavailable = (
    error: unknown,
  ): GeulbatRuntimePersistenceError => {
    const stabilized = validation.stabilizePersistenceError(
      error,
      'persistence_unavailable',
      'runtime storage is unavailable',
    );
    if (!sharedStorageAuthorityError) {
      sharedStorageAuthorityError = stabilized;
      if (
        typeof console !== 'undefined' &&
        console &&
        typeof console.error === 'function'
      ) {
        console.error('[geulbat] runtime storage degraded', stabilized);
      }
    }
    return (
      getSharedStorageAuthorityError() ??
      validation.createPersistenceError(
        'persistence_unavailable',
        'runtime storage is unavailable',
      )
    );
  };

  const assertStorageBootstrapReady = () => {
    if (storageBootstrapReady) {
      return;
    }
    throw validation.createPersistenceError(
      'persistence_unavailable',
      'runtime storage bootstrap is not ready',
    );
  };

  const assertSharedStorageAvailable = () => {
    const degraded = getSharedStorageAuthorityError();
    if (degraded) {
      throw degraded;
    }
  };

  const mutationQueue = createArtifactRuntimePersistenceMutationQueue({
    authorityState,
    createPersistenceError: validation.createPersistenceError,
    stabilizePersistenceError: validation.stabilizePersistenceError,
    isPersistenceConflict: validation.isPersistenceConflict,
    assertSharedStorageAvailable,
    loadCurrentAuthorityState: authorityIo.loadCurrentAuthorityState,
    persistCurrentAuthorityState: authorityIo.persistCurrentAuthorityState,
    markStorageUnavailable,
  });

  return {
    bridgeStore: {
      createPersistenceError: validation.createPersistenceError,
      assertSharedStorageAvailable,
      isPlainRecord: validation.isPlainRecord,
    },
    bootstrapLifecycle: {
      markStorageUnavailable,
      loadCurrentAuthorityState: authorityIo.loadCurrentAuthorityState,
      replaceCurrentAuthorityState:
        authorityState.replaceCommittedAuthorityState,
      setStorageBootstrapReady(next: boolean) {
        storageBootstrapReady = next;
      },
    },
    storageFacadeStore: {
      createPersistenceError: validation.createPersistenceError,
      assertStorageBootstrapReady,
      assertSharedStorageAvailable,
      ensureStorageReady: authorityIo.ensureStorageReady,
      cloneJsonValue: authorityState.cloneJsonValue,
      listStorageKeys: authorityState.listStorageKeys,
      listSessionStorageKeys: authorityState.listSessionStorageKeys,
      listDatabaseKeys: authorityState.listDatabaseKeys,
      assertStorageKey: validation.assertStorageKey,
      assertStorageValue: validation.assertStorageValue,
      assertDatabaseKey: validation.assertDatabaseKey,
      assertDatabaseValue: validation.assertDatabaseValue,
      waitForCommittedStorageWrites:
        mutationQueue.waitForCommittedStorageWrites,
      normalizeStorageKey: validation.normalizeStorageKey,
      normalizeDatabaseKey: validation.normalizeDatabaseKey,
      normalizeStorageIndex: validation.normalizeStorageIndex,
      schedulePersistedMutation: mutationQueue.schedulePersistedMutation,
      createNextSessionStorageMap: authorityState.createNextSessionStorageMap,
      replaceCurrentSessionStorageMap:
        authorityState.replaceCurrentSessionStorageMap,
      readCurrentStorageMap: authorityState.readCurrentStorageMap,
      readCurrentSessionStorageMap: authorityState.readCurrentSessionStorageMap,
      readCurrentDatabaseMap: authorityState.readCurrentDatabaseMap,
    },
  };
}

function installPersistenceFacadeProperty(
  window: PersistenceBootstrapWindow,
  property: 'localStorage' | 'sessionStorage' | 'geulbatDB',
  value: unknown,
  handleAssignmentFailure: (error: unknown) => void,
): void {
  try {
    Object.defineProperty(window, property, {
      configurable: true,
      get() {
        return value;
      },
    });
    return;
  } catch (error: unknown) {
    reportPersistenceFacadeDescriptorInstallFailure(property, error);
  }

  try {
    window[property] = value;
  } catch (error: unknown) {
    handleAssignmentFailure(error);
  }
}

function reportPersistenceFacadeDescriptorInstallFailure(
  property: 'localStorage' | 'sessionStorage' | 'geulbatDB',
  error: unknown,
): void {
  if (
    typeof console === 'undefined' ||
    !console ||
    typeof console.warn !== 'function'
  ) {
    return;
  }
  const cause =
    error instanceof Error && error.message.trim() !== ''
      ? error.message
      : typeof error === 'string' && error.trim() !== ''
        ? error
        : 'unknown error';
  console.warn(
    '[geulbat] runtime storage facade descriptor install failed; using assignment fallback',
    {
      property,
      cause,
    },
  );
}

function installArtifactRuntimePersistenceFacades(
  window: PersistenceBootstrapWindow,
  bridge: ReturnType<typeof createArtifactRuntimePersistenceBridge>,
  storageFacadeStore: ArtifactRuntimePersistenceStorageFacadeStore,
  bootstrapLifecycle: ArtifactRuntimePersistenceBootstrapLifecycle,
): void {
  const clearRecord = (record: Record<string, unknown>) => {
    for (const key of Object.keys(record)) {
      delete record[key];
    }
  };

  const markDeferredPersistenceFailure = (error: unknown): void => {
    bootstrapLifecycle.markStorageUnavailable(error);
  };

  const localStorageApi = createLocalStorageFacade({
    bridge,
    store: storageFacadeStore,
    clearRecord,
    markDeferredPersistenceFailure,
  });
  const sessionStorageApi = createSessionStorageFacade({
    store: storageFacadeStore,
    clearRecord,
  });
  const logicalDatabaseApi = createLogicalDatabaseFacade({
    window,
    bridge,
    store: storageFacadeStore,
    clearRecord,
  });
  const storageApi = createStorageFacade({
    window,
    bridge,
    store: storageFacadeStore,
  });

  window.geulbatPersistence = Object.freeze({
    ...bridge.persistenceApi,
    load() {
      return bridge.persistenceApi.loadState();
    },
    save(state: unknown, expectedRevision: string | null) {
      return bridge.persistenceApi.saveState(state, expectedRevision);
    },
    clear(expectedRevision: string | null) {
      return bridge.persistenceApi.clearState(expectedRevision);
    },
  });
  window.storage = storageApi;
  window.__GEULBAT_RUNTIME_STORAGE_READY__ = bootstrapLifecycle
    .loadCurrentAuthorityState(bridge.rawPersistenceApi)
    .then(
      (current: {
        storageMap: Record<string, unknown>;
        databaseMap: Record<string, unknown>;
        revision: string | null;
      }) => {
        bootstrapLifecycle.replaceCurrentAuthorityState(current);
      },
    )
    .catch((error: unknown) => {
      bootstrapLifecycle.markStorageUnavailable(error);
    })
    .then(() => {
      bootstrapLifecycle.setStorageBootstrapReady(true);
      installPersistenceFacadeProperty(
        window,
        'localStorage',
        localStorageApi,
        (error) => {
          bootstrapLifecycle.markStorageUnavailable(error);
        },
      );
      installPersistenceFacadeProperty(
        window,
        'sessionStorage',
        sessionStorageApi,
        (error) => {
          bootstrapLifecycle.markStorageUnavailable(error);
        },
      );
      installPersistenceFacadeProperty(
        window,
        'geulbatDB',
        logicalDatabaseApi,
        (error) => {
          bootstrapLifecycle.markStorageUnavailable(error);
        },
      );
    });
}

/**
 * Typed owner for the runtime persistence bootstrap that is later serialized
 * into the artifact HTML document.
 */
export function installArtifactRuntimePersistenceBootstrap(
  window: PersistenceBootstrapWindow,
  verbs: PersistenceBootstrapVerbs,
): void {
  const services = createArtifactRuntimePersistenceStore();
  const bridge = createArtifactRuntimePersistenceBridge(
    window,
    verbs,
    services.bridgeStore,
  );
  installArtifactRuntimePersistenceFacades(
    window,
    bridge,
    services.storageFacadeStore,
    services.bootstrapLifecycle,
  );
}
