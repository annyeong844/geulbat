import vm from 'node:vm';
import type { JsonValue } from '@geulbat/protocol/runtime-persistence';

import { buildJsRuntimePersistenceBootstrap } from '../features/assistant/runtime-persistence/artifact-runtime-persistence-bootstrap.js';
import {
  PERSISTENCE_BRIDGE_VERSION,
  PERSISTENCE_RESPONSE_KIND,
  type ArtifactRuntimePersistenceErrorCode,
  type ArtifactRuntimePersistenceRequestMessage,
  type ArtifactRuntimePersistenceResponseMessage,
} from '../features/assistant/runtime-persistence/artifact-runtime-persistence-types.js';

interface BootstrapStorageApi {
  get(key: unknown): Promise<unknown>;
  set(key: unknown, value: unknown): Promise<void>;
  delete(key: unknown): Promise<boolean>;
  list(prefix?: unknown): Promise<string[]>;
}

interface BootstrapLocalStorageApi {
  getItem(key: unknown): string | null;
  setItem(key: unknown, value: unknown): void;
  removeItem(key: unknown): void;
  clear(): void;
  key(index: unknown): string | null;
  readonly length: number;
}

interface BootstrapLogicalDbApi {
  get(key: unknown): Promise<unknown>;
  put(key: unknown, value: unknown): Promise<void>;
  delete(key: unknown): Promise<boolean>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
}

export interface BootstrapWindow {
  parent: {
    postMessage: (
      message: ArtifactRuntimePersistenceRequestMessage,
      targetOrigin?: string,
    ) => void;
  };
  addEventListener: (
    type: string,
    listener: (event: { source: object; data: unknown }) => void,
  ) => void;
  __GEULBAT_RUNTIME_STORAGE_READY__: Promise<void>;
  localStorage: BootstrapLocalStorageApi;
  sessionStorage: BootstrapLocalStorageApi;
  geulbatDB: BootstrapLogicalDbApi;
  storage: BootstrapStorageApi;
  geulbatPersistence: {
    loadState(): Promise<unknown>;
    saveState(
      state: unknown,
      expectedRevision: string | null,
    ): Promise<unknown>;
    clearState(expectedRevision: string | null): Promise<unknown>;
  };
}

interface BootstrapResponseEnvelope {
  eventSource?: object;
  eventOrigin?: string;
  eventData: unknown;
}

type BootstrapResponse = unknown | BootstrapResponseEnvelope;

export function createOkResponse(
  request: ArtifactRuntimePersistenceRequestMessage,
  extras: {
    state?: JsonValue | null;
    revision?: string | null;
  } = {},
): ArtifactRuntimePersistenceResponseMessage {
  return {
    kind: PERSISTENCE_RESPONSE_KIND,
    version: PERSISTENCE_BRIDGE_VERSION,
    requestId: request.requestId,
    scopeHandle: request.scopeHandle,
    verb: request.verb,
    ok: true,
    revision: extras.revision ?? null,
    ...(extras.state === undefined ? {} : { state: extras.state }),
  };
}

function isBootstrapResponseEnvelope(
  response: BootstrapResponse,
): response is BootstrapResponseEnvelope {
  return (
    !!response &&
    typeof response === 'object' &&
    !Array.isArray(response) &&
    'eventData' in response
  );
}

export function createErrorResponse(
  request: ArtifactRuntimePersistenceRequestMessage,
  code: ArtifactRuntimePersistenceErrorCode,
  message: string,
): ArtifactRuntimePersistenceResponseMessage {
  return {
    kind: PERSISTENCE_RESPONSE_KIND,
    version: PERSISTENCE_BRIDGE_VERSION,
    requestId: request.requestId,
    scopeHandle: request.scopeHandle,
    verb: request.verb,
    ok: false,
    errorCode: code,
    message,
  };
}

export function createBootstrapHarness(
  respond: (
    request: ArtifactRuntimePersistenceRequestMessage,
  ) => BootstrapResponse | BootstrapResponse[] | undefined,
  options: {
    definePropertyThrowProperties?: readonly string[];
    postMessageThrowVerb?: string;
    postMessageThrowMessage?: string;
    requestTimeoutMs?: number;
  } = {},
): {
  requests: ArtifactRuntimePersistenceRequestMessage[];
  targetOrigins: string[];
  warnings: unknown[][];
  ready: Promise<void>;
  window: BootstrapWindow;
} {
  const requests: ArtifactRuntimePersistenceRequestMessage[] = [];
  const targetOrigins: string[] = [];
  const warnings: unknown[][] = [];
  const listeners: Array<
    (event: { source: object; origin: string; data: unknown }) => void
  > = [];
  const parentOrigin = 'http://127.0.0.1:5173';

  const parent = {
    postMessage(
      message: ArtifactRuntimePersistenceRequestMessage,
      targetOrigin?: string,
    ) {
      requests.push(message);
      targetOrigins.push(targetOrigin ?? '');
      if (options.postMessageThrowVerb === message.verb) {
        throw new Error(
          options.postMessageThrowMessage ??
            'runtime persistence parent bridge postMessage failed',
        );
      }
      const responses = respond(message);
      if (responses === undefined) {
        return;
      }
      const responseList = Array.isArray(responses) ? responses : [responses];
      for (const listener of listeners) {
        for (const response of responseList) {
          const event = isBootstrapResponseEnvelope(response)
            ? {
                source: response.eventSource ?? parent,
                origin: response.eventOrigin ?? parentOrigin,
                data: response.eventData,
              }
            : { source: parent, origin: parentOrigin, data: response };
          listener(event);
        }
      }
    },
  };

  const windowObject = {
    parent,
    addEventListener(
      type: string,
      listener: (event: {
        source: object;
        origin: string;
        data: unknown;
      }) => void,
    ) {
      if (type === 'message') {
        listeners.push(listener);
      }
    },
  } as unknown as BootstrapWindow;
  const definePropertyThrowProperties = new Set(
    options.definePropertyThrowProperties ?? [],
  );
  const runtimeObject = new Proxy(Object, {
    get(target, propertyKey, receiver) {
      if (propertyKey !== 'defineProperty') {
        return Reflect.get(target, propertyKey, receiver);
      }
      return (
        targetObject: object,
        targetPropertyKey: PropertyKey,
        descriptor: PropertyDescriptor,
      ) => {
        if (
          targetObject === windowObject &&
          typeof targetPropertyKey === 'string' &&
          definePropertyThrowProperties.has(targetPropertyKey)
        ) {
          throw new Error(`defineProperty blocked for ${targetPropertyKey}`);
        }
        return Object.defineProperty(
          targetObject,
          targetPropertyKey,
          descriptor,
        );
      };
    },
  });

  vm.runInNewContext(
    buildJsRuntimePersistenceBootstrap({
      scopeHandle: 'scope-123',
      parentOrigin,
      ...(options.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: options.requestTimeoutMs }
        : {}),
    }),
    {
      window: windowObject,
      Object: runtimeObject,
      Array,
      Map,
      Set,
      Date,
      Error,
      Promise,
      JSON,
      Math,
      setTimeout,
      clearTimeout,
      console: {
        error() {},
        warn(...args: unknown[]) {
          warnings.push(args);
        },
      },
    },
  );

  return {
    requests,
    targetOrigins,
    warnings,
    ready: windowObject.__GEULBAT_RUNTIME_STORAGE_READY__,
    window: windowObject,
  };
}

export function hasPersistenceCode(
  error: unknown,
  code: ArtifactRuntimePersistenceErrorCode,
): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === code
  );
}

export function toComparableJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
