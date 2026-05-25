export type PersistenceRecord = Record<string, unknown>;
export type SessionStorageRecord = Record<string, string>;
export type PersistenceBootstrapTimeoutHandle = ReturnType<
  typeof globalThis.setTimeout
>;

export interface PersistenceBootstrapVerbs {
  loadVerb: string;
  saveVerb: string;
  clearVerb: string;
}

export interface PersistenceBootstrapRequestMessage {
  kind: string;
  version: string | number;
  requestId: string;
  scopeHandle: string;
  verb: string;
  state?: unknown;
  expectedRevision?: string | null;
}

export interface PersistenceBootstrapSuccessResponseMessage {
  kind: string;
  version: string | number;
  requestId: string;
  scopeHandle: string;
  verb: string;
  ok: true;
  revision?: string | null;
  state?: unknown;
}

export interface PendingPersistenceRequest {
  resolve: (message: PersistenceBootstrapSuccessResponseMessage) => void;
  reject: (reason?: unknown) => void;
  verb: string;
  timeoutHandle: PersistenceBootstrapTimeoutHandle;
}

export interface PersistenceBootstrapMessageEvent {
  source: object;
  origin: string;
  data: unknown;
}

export interface PersistenceBootstrapParent {
  postMessage(
    message: PersistenceBootstrapRequestMessage,
    targetOrigin: string,
  ): void;
}

export interface GeulbatRuntimePersistenceError extends Error {
  code: string;
}

export interface PersistenceBootstrapWindow {
  parent?: PersistenceBootstrapParent | PersistenceBootstrapWindow;
  addEventListener(
    type: string,
    listener: (event: PersistenceBootstrapMessageEvent) => void,
  ): void;
  setTimeout?(
    handler: () => void,
    timeoutMs?: number,
  ): PersistenceBootstrapTimeoutHandle;
  clearTimeout?(handle: PersistenceBootstrapTimeoutHandle): void;
  __GEULBAT_PERSISTENCE_BRIDGE_VERSION__: string | number;
  __GEULBAT_PERSISTENCE_SCOPE_HANDLE__: string;
  __GEULBAT_PERSISTENCE_PARENT_ORIGIN__: string;
  __GEULBAT_PERSISTENCE_REQUEST_KIND__: string;
  __GEULBAT_PERSISTENCE_RESPONSE_KIND__: string;
  __GEULBAT_PERSISTENCE_REQUEST_TIMEOUT_MS__?: number;
  __GEULBAT_RUNTIME_STORAGE_READY__?: Promise<void>;
  localStorage?: unknown;
  sessionStorage?: unknown;
  geulbatDB?: unknown;
  storage?: unknown;
  geulbatPersistence?: unknown;
}
