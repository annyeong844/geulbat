import { isPersistenceBootstrapSuccessResponseMessage } from './artifact-runtime-persistence-bootstrap-types.js';
import type {
  PendingPersistenceRequest,
  PersistenceBootstrapMessageEvent,
  PersistenceBootstrapRequestMessage,
  PersistenceBootstrapSuccessResponseMessage,
  PersistenceBootstrapVerbs,
  PersistenceBootstrapWindow,
} from './artifact-runtime-persistence-bootstrap-types.js';

interface BridgeStore {
  createPersistenceError(code: string, message: string): Error;
  stabilizePersistenceError(error: unknown): Error;
  assertSharedStorageAvailable(): void;
  isPlainRecord(value: unknown): value is Record<string, unknown>;
}

interface PersistenceResponseRouterArgs {
  window: PersistenceBootstrapWindow;
  verbs: PersistenceBootstrapVerbs;
  store: BridgeStore;
  pendingPersistenceRequests: Map<string, PendingPersistenceRequest>;
  clearPendingPersistenceRequest(
    this: void,
    requestId: string,
  ): PendingPersistenceRequest | null;
}

function createPersistenceResponseRouter({
  window,
  verbs,
  store,
  pendingPersistenceRequests,
  clearPendingPersistenceRequest,
}: PersistenceResponseRouterArgs): (
  event: PersistenceBootstrapMessageEvent,
) => void {
  return (event) => {
    if (
      event.source !== window.parent ||
      event.origin !== window.__GEULBAT_PERSISTENCE_PARENT_ORIGIN__
    ) {
      return;
    }

    const message = event.data;
    if (!store.isPlainRecord(message)) {
      return;
    }
    const response = message as Record<string, unknown>;
    if (
      response.kind !== window.__GEULBAT_PERSISTENCE_RESPONSE_KIND__ ||
      response.version !== window.__GEULBAT_PERSISTENCE_BRIDGE_VERSION__ ||
      typeof response.requestId !== 'string' ||
      response.scopeHandle !== window.__GEULBAT_PERSISTENCE_SCOPE_HANDLE__ ||
      (response.verb !== verbs.loadVerb &&
        response.verb !== verbs.saveVerb &&
        response.verb !== verbs.clearVerb)
    ) {
      return;
    }

    const pending = pendingPersistenceRequests.get(response.requestId);
    if (!pending || pending.verb !== response.verb) {
      return;
    }
    clearPendingPersistenceRequest(response.requestId);

    if (response.ok) {
      if (!isPersistenceBootstrapSuccessResponseMessage(response)) {
        pending.reject(
          store.createPersistenceError(
            'persistence_unavailable',
            'runtime persistence response was malformed',
          ),
        );
        return;
      }
      pending.resolve(response);
      return;
    }

    pending.reject(
      store.createPersistenceError(
        typeof response.errorCode === 'string'
          ? response.errorCode
          : 'persistence_unavailable',
        typeof response.message === 'string' && response.message
          ? response.message
          : 'runtime persistence request failed',
      ),
    );
  };
}

export function createArtifactRuntimePersistenceBridge(
  window: PersistenceBootstrapWindow,
  verbs: PersistenceBootstrapVerbs,
  store: BridgeStore,
) {
  const DEFAULT_PERSISTENCE_REQUEST_TIMEOUT_MS = 5_000;
  const pendingPersistenceRequests = new Map<
    string,
    PendingPersistenceRequest
  >();
  let persistenceRequestIndex = 0;
  const requestTimeoutMs =
    typeof window.__GEULBAT_PERSISTENCE_REQUEST_TIMEOUT_MS__ === 'number' &&
    Number.isFinite(window.__GEULBAT_PERSISTENCE_REQUEST_TIMEOUT_MS__) &&
    window.__GEULBAT_PERSISTENCE_REQUEST_TIMEOUT_MS__ > 0
      ? window.__GEULBAT_PERSISTENCE_REQUEST_TIMEOUT_MS__
      : DEFAULT_PERSISTENCE_REQUEST_TIMEOUT_MS;
  const scheduleTimeout =
    typeof window.setTimeout === 'function'
      ? window.setTimeout.bind(window)
      : globalThis.setTimeout.bind(globalThis);
  const cancelTimeout =
    typeof window.clearTimeout === 'function'
      ? window.clearTimeout.bind(window)
      : globalThis.clearTimeout.bind(globalThis);

  const createRequestId = () => {
    persistenceRequestIndex += 1;
    return (
      'persistence-' +
      Date.now().toString(16) +
      '-' +
      persistenceRequestIndex.toString(16)
    );
  };

  const clearPendingPersistenceRequest = (requestId: string) => {
    const pending = pendingPersistenceRequests.get(requestId);
    if (!pending) {
      return null;
    }
    pendingPersistenceRequests.delete(requestId);
    cancelTimeout(pending.timeoutHandle);
    return pending;
  };

  const postPersistenceRequest = (
    verb: string,
    extras: Partial<PersistenceBootstrapRequestMessage> = {},
  ) =>
    new Promise<PersistenceBootstrapSuccessResponseMessage>(
      (resolve, reject) => {
        const parent = window.parent;
        if (!parent || parent === window || !('postMessage' in parent)) {
          reject(
            store.createPersistenceError(
              'persistence_unavailable',
              'runtime persistence parent bridge is unavailable',
            ),
          );
          return;
        }

        const requestId = createRequestId();
        const timeoutHandle = scheduleTimeout(() => {
          const pending = clearPendingPersistenceRequest(requestId);
          if (!pending) {
            return;
          }
          pending.reject(
            store.createPersistenceError(
              'persistence_unavailable',
              'runtime persistence request timed out',
            ),
          );
        }, requestTimeoutMs);
        pendingPersistenceRequests.set(requestId, {
          resolve,
          reject,
          verb,
          timeoutHandle,
        });

        try {
          parent.postMessage(
            {
              kind: window.__GEULBAT_PERSISTENCE_REQUEST_KIND__,
              version: window.__GEULBAT_PERSISTENCE_BRIDGE_VERSION__,
              requestId,
              scopeHandle: window.__GEULBAT_PERSISTENCE_SCOPE_HANDLE__,
              verb,
              ...extras,
            },
            window.__GEULBAT_PERSISTENCE_PARENT_ORIGIN__,
          );
        } catch (error) {
          const pending = clearPendingPersistenceRequest(requestId);
          pending?.reject(
            store.createPersistenceError(
              'persistence_unavailable',
              error instanceof Error && error.message
                ? `runtime persistence request failed before dispatch: ${error.message}`
                : 'runtime persistence request failed before dispatch',
            ),
          );
        }
      },
    );

  window.addEventListener(
    'message',
    createPersistenceResponseRouter({
      window,
      verbs,
      store,
      pendingPersistenceRequests,
      clearPendingPersistenceRequest,
    }),
  );

  const rawPersistenceApi = Object.freeze({
    loadState() {
      return postPersistenceRequest(verbs.loadVerb);
    },
    saveState(state: unknown, expectedRevision: string | null) {
      return postPersistenceRequest(verbs.saveVerb, {
        state,
        expectedRevision,
      });
    },
    clearState(expectedRevision: string | null) {
      return postPersistenceRequest(verbs.clearVerb, {
        expectedRevision,
      });
    },
  });

  const persistenceApi = Object.freeze({
    loadState() {
      try {
        store.assertSharedStorageAvailable();
      } catch (error: unknown) {
        return Promise.reject(store.stabilizePersistenceError(error));
      }
      return rawPersistenceApi.loadState();
    },
    saveState(state: unknown, expectedRevision: string | null) {
      try {
        store.assertSharedStorageAvailable();
      } catch (error: unknown) {
        return Promise.reject(store.stabilizePersistenceError(error));
      }
      return rawPersistenceApi.saveState(state, expectedRevision);
    },
    clearState(expectedRevision: string | null) {
      try {
        store.assertSharedStorageAvailable();
      } catch (error: unknown) {
        return Promise.reject(store.stabilizePersistenceError(error));
      }
      return rawPersistenceApi.clearState(expectedRevision);
    },
  });

  return {
    rawPersistenceApi,
    persistenceApi,
  };
}

export type ArtifactRuntimePersistenceBridge = ReturnType<
  typeof createArtifactRuntimePersistenceBridge
>;
