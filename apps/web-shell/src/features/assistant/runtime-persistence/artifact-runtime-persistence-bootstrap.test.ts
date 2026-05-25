import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import type { JsonValue } from '@geulbat/protocol/runtime-persistence';

import { buildJsRuntimePersistenceBootstrap } from './artifact-runtime-persistence-bootstrap.js';
import {
  ARTIFACT_RUNTIME_PERSISTENCE_VERBS,
  PERSISTENCE_BRIDGE_VERSION,
  PERSISTENCE_REQUEST_KIND,
  PERSISTENCE_RESPONSE_KIND,
  type ArtifactRuntimePersistenceErrorCode,
  type ArtifactRuntimePersistenceRequestMessage,
  type ArtifactRuntimePersistenceResponseMessage,
} from './artifact-runtime-persistence-types.js';

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

interface BootstrapWindow {
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

function createOkResponse(
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

function createErrorResponse(
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

function createBootstrapHarness(
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

function hasPersistenceCode(
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

function toComparableJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

void test('runtime persistence facade descriptor fallback warns and installs via assignment', async () => {
  const { ready, warnings, window } = createBootstrapHarness(
    (request) => createOkResponse(request, { state: null, revision: null }),
    { definePropertyThrowProperties: ['localStorage'] },
  );

  await ready;

  assert.equal(window.localStorage.getItem('missing'), null);
  assert.equal(warnings.length, 1);
  const [message, details] = warnings[0] ?? [];
  assert.match(
    String(message),
    /\[geulbat\] runtime storage facade descriptor install failed; using assignment fallback/,
  );
  assert.equal(
    (details as { property?: unknown } | undefined)?.property,
    'localStorage',
  );
  assert.equal(
    (details as { cause?: unknown } | undefined)?.cause,
    'defineProperty blocked for localStorage',
  );
});

void test('window.storage facade supports get/set/delete/list over the persistence bridge', async () => {
  let state: JsonValue | null = null;
  let revision: string | null = null;
  let revisionIndex = 0;

  const { ready, requests, targetOrigins, window } = createBootstrapHarness(
    (request) => {
      switch (request.verb) {
        case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.loadState:
          return createOkResponse(request, { state, revision });
        case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.saveState:
          state = request.state ?? null;
          revisionIndex += 1;
          revision = `rev-${revisionIndex}`;
          return createOkResponse(request, { revision });
        case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.clearState:
          state = null;
          revision = null;
          return createOkResponse(request, { revision: null });
      }
    },
  );

  await ready;
  assert.deepEqual(new Set(targetOrigins), new Set(['http://127.0.0.1:5173']));
  assert.equal(await window.storage.get('count'), null);
  await window.storage.set('count', 1);
  assert.equal(await window.storage.get('count'), 1);
  assert.deepEqual(await window.storage.list(), ['count']);
  assert.equal(await window.storage.delete('count'), true);
  assert.deepEqual(await window.storage.list(), []);
  assert.equal(await window.storage.get('count'), null);
  assert.ok(
    requests.some(
      (request) =>
        request.kind === PERSISTENCE_REQUEST_KIND &&
        request.verb === ARTIFACT_RUNTIME_PERSISTENCE_VERBS.clearState,
    ),
  );
});

void test('window.storage facade hides low-level persistence_conflict retry from callers', async () => {
  let state: JsonValue | null = {
    external: 1,
  };
  let revision: string | null = 'rev-1';
  let saveAttempts = 0;
  let loadAttempts = 0;

  const { ready, window } = createBootstrapHarness((request) => {
    switch (request.verb) {
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.loadState:
        loadAttempts += 1;
        return createOkResponse(request, { state, revision });
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.saveState:
        saveAttempts += 1;
        if (saveAttempts === 1) {
          state = {
            external: 1,
            serverOnly: 2,
          };
          revision = 'rev-2';
          return createErrorResponse(
            request,
            'persistence_conflict',
            'runtime persistence revision does not match expectedRevision',
          );
        }
        state = request.state ?? null;
        revision = 'rev-1';
        return createOkResponse(request, { revision });
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.clearState:
        state = null;
        revision = null;
        return createOkResponse(request, { revision: null });
    }
  });

  await ready;
  await window.storage.set('count', 1);
  assert.equal(saveAttempts, 2);
  assert.equal(loadAttempts, 2);
  assert.equal(await window.storage.get('count'), 1);
  assert.equal(await window.storage.get('serverOnly'), 2);
});

void test('window.storage facade refreshes authority state on persistence_conflict and retries with the latest revision', async () => {
  let state: JsonValue | null = {
    external: 1,
  };
  let revision: string | null = 'rev-1';
  let saveAttempts = 0;

  const { ready, requests, window } = createBootstrapHarness((request) => {
    switch (request.verb) {
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.loadState:
        return createOkResponse(request, { state, revision });
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.saveState:
        saveAttempts += 1;
        if (saveAttempts === 1) {
          assert.equal(request.expectedRevision, 'rev-1');
          assert.deepEqual(toComparableJson(request.state), {
            external: 1,
            count: 1,
          });
          state = {
            external: 1,
            serverOnly: 2,
          };
          revision = 'rev-2';
          return createErrorResponse(
            request,
            'persistence_conflict',
            'runtime persistence revision does not match expectedRevision',
          );
        }

        assert.equal(saveAttempts, 2);
        assert.equal(request.expectedRevision, 'rev-2');
        assert.deepEqual(toComparableJson(request.state), {
          external: 1,
          serverOnly: 2,
          count: 1,
        });
        state = request.state ?? null;
        revision = 'rev-3';
        return createOkResponse(request, { revision });
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.clearState:
        state = null;
        revision = null;
        return createOkResponse(request, { revision: null });
    }
  });

  await ready;
  await window.storage.set('count', 1);

  const saveRequests = requests.filter(
    (request) => request.verb === ARTIFACT_RUNTIME_PERSISTENCE_VERBS.saveState,
  );
  assert.equal(saveRequests.length, 2);
  assert.equal(saveRequests[0]?.expectedRevision, 'rev-1');
  assert.equal(saveRequests[1]?.expectedRevision, 'rev-2');
  assert.deepEqual(await window.storage.list(), [
    'count',
    'external',
    'serverOnly',
  ]);
  assert.equal(await window.storage.get('count'), 1);
  assert.equal(await window.storage.get('serverOnly'), 2);
});

void test('window.storage facade blocks reserved keys and top-level null values', async () => {
  const { ready, window } = createBootstrapHarness((request) => {
    return createOkResponse(request, { state: null, revision: null });
  });

  await ready;
  await assert.rejects(window.storage.set('__proto__', 1), (error) =>
    hasPersistenceCode(error, 'persistence_blocked'),
  );
  await assert.rejects(window.storage.set('count', null), (error) =>
    hasPersistenceCode(error, 'persistence_blocked'),
  );
});

void test('window.storage facade blocks mixed-use non-record underlying state', async () => {
  const { ready, window } = createBootstrapHarness((request) => {
    switch (request.verb) {
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.loadState:
        return createOkResponse(request, {
          state: ['unexpected'],
          revision: 'rev-1',
        });
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.saveState:
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.clearState:
        return createOkResponse(request, { revision: 'rev-1' });
    }
  });

  await ready;
  await assert.rejects(window.storage.get('count'), (error) =>
    hasPersistenceCode(error, 'persistence_blocked'),
  );
});

void test('window.storage facade ignores mismatched bridge responses until verb and scopeHandle match', async () => {
  const { ready, window } = createBootstrapHarness((request) => {
    if (request.verb === ARTIFACT_RUNTIME_PERSISTENCE_VERBS.loadState) {
      return [
        {
          ...createOkResponse(request, {
            state: { count: 999 },
            revision: 'rev-wrong',
          }),
          scopeHandle: 'wrong-scope',
        },
        {
          ...createOkResponse(request, {
            state: { count: 1 },
            revision: 'rev-1',
          }),
          verb: ARTIFACT_RUNTIME_PERSISTENCE_VERBS.saveState,
        },
        createOkResponse(request, {
          state: { count: 2 },
          revision: 'rev-2',
        }),
      ];
    }

    return createOkResponse(request, { revision: null });
  });

  await ready;
  assert.equal(await window.storage.get('count'), 2);
});

void test('window.storage facade ignores bridge responses from unexpected source and origin', async () => {
  const foreignSource = {};
  const { ready, window } = createBootstrapHarness((request) => {
    if (request.verb === ARTIFACT_RUNTIME_PERSISTENCE_VERBS.loadState) {
      return [
        {
          eventSource: foreignSource,
          eventData: createOkResponse(request, {
            state: { count: 999 },
            revision: 'rev-wrong-source',
          }),
        },
        {
          eventOrigin: 'http://malicious.example.test',
          eventData: createOkResponse(request, {
            state: { count: 998 },
            revision: 'rev-wrong-origin',
          }),
        },
        createOkResponse(request, {
          state: { count: 2 },
          revision: 'rev-2',
        }),
      ];
    }

    return createOkResponse(request, { revision: null });
  });

  await ready;
  assert.equal(await window.storage.get('count'), 2);
});

void test('window.storage facade degrades malformed bridge success responses', async () => {
  const { ready, window } = createBootstrapHarness((request) => {
    switch (request.verb) {
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.loadState:
        return {
          ...createOkResponse(request, {
            state: { count: 1 },
            revision: 'rev-1',
          }),
          revision: 1,
        };
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.saveState:
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.clearState:
        return createOkResponse(request, { revision: null });
    }
  });

  await ready;
  await assert.rejects(window.storage.get('count'), (error) =>
    hasPersistenceCode(error, 'persistence_unavailable'),
  );
});

void test('window.localStorage shim preloads scoped snapshot and shares source of truth with window.storage', async () => {
  let state: JsonValue | null = {
    persisted: 'yes',
  };
  let revision: string | null = 'rev-1';

  const { ready, window } = createBootstrapHarness((request) => {
    switch (request.verb) {
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.loadState:
        return createOkResponse(request, { state, revision });
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.saveState:
        state = request.state ?? null;
        revision = 'rev-2';
        return createOkResponse(request, { revision });
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.clearState:
        state = null;
        revision = null;
        return createOkResponse(request, { revision: null });
    }
  });

  await ready;
  assert.equal(window.localStorage.getItem('persisted'), 'yes');
  assert.equal(window.localStorage.length, 1);
  assert.equal(window.localStorage.key(0), 'persisted');

  window.localStorage.setItem('count', 2);
  assert.equal(await window.storage.get('count'), '2');
  assert.deepEqual(await window.storage.list(), ['count', 'persisted']);
});

void test('window.sessionStorage shim is ephemeral and isolated from persistent storage', async () => {
  const respond = (request: ArtifactRuntimePersistenceRequestMessage) => {
    switch (request.verb) {
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.loadState:
        return createOkResponse(request, { state: null, revision: null });
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.saveState:
        return createOkResponse(request, { revision: 'rev-1' });
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.clearState:
        return createOkResponse(request, { revision: null });
    }
  };

  const firstHarness = createBootstrapHarness(respond);
  await firstHarness.ready;

  assert.equal(firstHarness.window.sessionStorage.length, 0);
  assert.equal(firstHarness.window.sessionStorage.getItem('draft'), null);

  firstHarness.window.sessionStorage.setItem('draft', '1');
  assert.equal(firstHarness.window.sessionStorage.getItem('draft'), '1');
  assert.equal(firstHarness.window.sessionStorage.length, 1);
  assert.equal(firstHarness.window.sessionStorage.key(0), 'draft');
  assert.equal(firstHarness.window.localStorage.getItem('draft'), null);
  assert.deepEqual(await firstHarness.window.storage.list(), []);

  const secondHarness = createBootstrapHarness(respond);
  await secondHarness.ready;
  assert.equal(secondHarness.window.sessionStorage.getItem('draft'), null);
  assert.equal(secondHarness.window.sessionStorage.length, 0);
});

void test('window.geulbatDB supports JSON-like records in a sibling namespace', async () => {
  const { ready, window } = createBootstrapHarness((request) => {
    switch (request.verb) {
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.loadState:
        return createOkResponse(request, { state: null, revision: null });
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.saveState:
        return createOkResponse(request, { revision: 'rev-1' });
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.clearState:
        return createOkResponse(request, { revision: null });
    }
  });

  await ready;
  await window.geulbatDB.put('profile', {
    enabled: true,
    notes: ['draft', null],
  });

  const stored = (await window.geulbatDB.get('profile')) as {
    enabled: boolean;
    notes: Array<string | null>;
  };
  assert.deepEqual(toComparableJson(stored), {
    enabled: true,
    notes: ['draft', null],
  });

  stored.notes[0] = 'mutated';
  assert.deepEqual(toComparableJson(await window.geulbatDB.get('profile')), {
    enabled: true,
    notes: ['draft', null],
  });
  assert.deepEqual(await window.geulbatDB.keys(), ['profile']);
  assert.equal(window.localStorage.length, 0);
  assert.deepEqual(await window.storage.list(), []);
});

void test('window.geulbatDB rejects top-level null but allows nested null', async () => {
  const { ready, window } = createBootstrapHarness((request) => {
    return createOkResponse(request, { state: null, revision: null });
  });

  await ready;
  await window.geulbatDB.put('draft', { maybe: null });
  assert.deepEqual(toComparableJson(await window.geulbatDB.get('draft')), {
    maybe: null,
  });
  await assert.rejects(window.geulbatDB.put('draft', null), (error) =>
    hasPersistenceCode(error, 'persistence_blocked'),
  );
});

void test('window.geulbatDB clear only clears the DB namespace', async () => {
  let state: JsonValue | null = null;
  let revision: string | null = null;
  let revisionIndex = 0;

  const { ready, window } = createBootstrapHarness((request) => {
    switch (request.verb) {
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.loadState:
        return createOkResponse(request, { state, revision });
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.saveState:
        state = request.state ?? null;
        revisionIndex += 1;
        revision = `rev-${revisionIndex}`;
        return createOkResponse(request, { revision });
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.clearState:
        state = null;
        revision = null;
        return createOkResponse(request, { revision: null });
    }
  });

  await ready;
  window.localStorage.setItem('setting', 'kept');
  await window.geulbatDB.put('profile', { count: 1 });
  await window.geulbatDB.clear();

  assert.equal(window.localStorage.getItem('setting'), 'kept');
  assert.equal(await window.storage.get('setting'), 'kept');
  assert.deepEqual(await window.geulbatDB.keys(), []);
});

void test('window.geulbatDB reads wait behind prior queued writes in FIFO order', async () => {
  let state: JsonValue | null = null;
  let revision: string | null = null;
  let revisionIndex = 0;

  const { ready, window } = createBootstrapHarness((request) => {
    switch (request.verb) {
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.loadState:
        return createOkResponse(request, { state, revision });
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.saveState:
        state = request.state ?? null;
        revisionIndex += 1;
        revision = `rev-${revisionIndex}`;
        return createOkResponse(request, { revision });
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.clearState:
        state = null;
        revision = null;
        return createOkResponse(request, { revision: null });
    }
  });

  await ready;
  const writeA = window.geulbatDB.put('A', { value: 1 });
  const writeB = window.geulbatDB.put('B', { value: 2 });
  const trailingRead = window.geulbatDB.get('A');

  await writeA;
  await writeB;
  assert.deepEqual(toComparableJson(await trailingRead), { value: 1 });
  assert.deepEqual(await window.geulbatDB.keys(), ['A', 'B']);
});

void test('window.localStorage shim enters shared degraded truth after preload failure', async () => {
  const { ready, window } = createBootstrapHarness((request) => {
    switch (request.verb) {
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.loadState:
        return createErrorResponse(
          request,
          'persistence_unavailable',
          'runtime storage preload failed',
        );
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.saveState:
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.clearState:
        return createOkResponse(request, { revision: null });
    }
  });

  await ready;
  assert.throws(
    () => window.localStorage.getItem('count'),
    (error) => hasPersistenceCode(error, 'persistence_unavailable'),
  );
  assert.throws(
    () => window.localStorage.length,
    (error) => hasPersistenceCode(error, 'persistence_unavailable'),
  );
  await assert.rejects(window.storage.get('count'), (error) =>
    hasPersistenceCode(error, 'persistence_unavailable'),
  );
});

void test('window.sessionStorage stays available when shared persistent storage degrades', async () => {
  const { ready, window } = createBootstrapHarness((request) => {
    switch (request.verb) {
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.loadState:
        return createErrorResponse(
          request,
          'persistence_unavailable',
          'runtime storage preload failed',
        );
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.saveState:
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.clearState:
        return createOkResponse(request, { revision: null });
    }
  });

  await ready;
  window.sessionStorage.setItem('count', 1);
  assert.equal(window.sessionStorage.getItem('count'), '1');
  assert.equal(window.sessionStorage.length, 1);
  assert.throws(
    () => window.localStorage.getItem('count'),
    (error) => hasPersistenceCode(error, 'persistence_unavailable'),
  );
});

void test('later commit failure degrades both window.localStorage and window.storage surfaces', async () => {
  let state: JsonValue | null = null;
  let revision: string | null = null;

  const { ready, window } = createBootstrapHarness((request) => {
    switch (request.verb) {
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.loadState:
        return createOkResponse(request, { state, revision });
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.saveState:
        return createErrorResponse(
          request,
          'persistence_unavailable',
          'runtime storage commit failed',
        );
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.clearState:
        return createOkResponse(request, { revision: null });
    }
  });

  await ready;
  window.localStorage.setItem('count', 1);
  await assert.rejects(window.storage.get('count'), (error) =>
    hasPersistenceCode(error, 'persistence_unavailable'),
  );
  assert.throws(
    () => window.localStorage.getItem('count'),
    (error) => hasPersistenceCode(error, 'persistence_unavailable'),
  );
});

void test('window.geulbatDB shares degraded authority truth after commit failure', async () => {
  const { ready, window } = createBootstrapHarness((request) => {
    switch (request.verb) {
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.loadState:
        return createOkResponse(request, { state: null, revision: null });
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.saveState:
        return createErrorResponse(
          request,
          'persistence_unavailable',
          'runtime storage commit failed',
        );
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.clearState:
        return createOkResponse(request, { revision: null });
    }
  });

  await ready;
  await assert.rejects(window.geulbatDB.put('profile', { count: 1 }), (error) =>
    hasPersistenceCode(error, 'persistence_unavailable'),
  );
  await assert.rejects(window.geulbatDB.get('profile'), (error) =>
    hasPersistenceCode(error, 'persistence_unavailable'),
  );
  await assert.rejects(window.storage.get('count'), (error) =>
    hasPersistenceCode(error, 'persistence_unavailable'),
  );
  assert.throws(
    () => window.localStorage.getItem('count'),
    (error) => hasPersistenceCode(error, 'persistence_unavailable'),
  );
});

void test('window.geulbatDB restores only the last durable commit on rerun/reopen', async () => {
  let state: JsonValue | null = null;
  let revision: string | null = null;
  let shouldFailNextSave = false;
  let revisionIndex = 0;

  const respond = (request: ArtifactRuntimePersistenceRequestMessage) => {
    switch (request.verb) {
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.loadState:
        return createOkResponse(request, { state, revision });
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.saveState:
        if (shouldFailNextSave) {
          shouldFailNextSave = false;
          return createErrorResponse(
            request,
            'persistence_unavailable',
            'runtime storage commit failed',
          );
        }
        state = request.state ?? null;
        revisionIndex += 1;
        revision = `rev-${revisionIndex}`;
        return createOkResponse(request, { revision });
      case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.clearState:
        state = null;
        revision = null;
        return createOkResponse(request, { revision: null });
    }
  };

  const firstHarness = createBootstrapHarness(respond);
  await firstHarness.ready;
  await firstHarness.window.geulbatDB.put('profile', { count: 1 });

  shouldFailNextSave = true;
  await assert.rejects(
    firstHarness.window.geulbatDB.put('profile', { count: 2 }),
    (error) => hasPersistenceCode(error, 'persistence_unavailable'),
  );

  const secondHarness = createBootstrapHarness(respond);
  await secondHarness.ready;
  assert.deepEqual(
    toComparableJson(await secondHarness.window.geulbatDB.get('profile')),
    {
      count: 1,
    },
  );
});

void test('window.storage facade times out hung save requests instead of waiting forever', async () => {
  const { ready, window } = createBootstrapHarness(
    (request) => {
      switch (request.verb) {
        case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.loadState:
          return createOkResponse(request, { state: null, revision: null });
        case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.saveState:
          return undefined;
        case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.clearState:
          return createOkResponse(request, { revision: null });
      }
    },
    { requestTimeoutMs: 1 },
  );

  await ready;
  await assert.rejects(window.storage.set('count', 1), (error) =>
    hasPersistenceCode(error, 'persistence_unavailable'),
  );
  await assert.rejects(window.storage.get('count'), (error) =>
    hasPersistenceCode(error, 'persistence_unavailable'),
  );
});

void test('window.storage facade degrades when bridge postMessage throws before dispatch', async () => {
  const { ready, window } = createBootstrapHarness(
    (request) => {
      switch (request.verb) {
        case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.loadState:
          return createOkResponse(request, { state: null, revision: null });
        case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.saveState:
        case ARTIFACT_RUNTIME_PERSISTENCE_VERBS.clearState:
          return createOkResponse(request, { revision: null });
      }
    },
    {
      postMessageThrowVerb: ARTIFACT_RUNTIME_PERSISTENCE_VERBS.saveState,
      postMessageThrowMessage: 'bridge dispatch blocked',
    },
  );

  await ready;
  await assert.rejects(window.storage.set('count', 1), (error) =>
    hasPersistenceCode(error, 'persistence_unavailable'),
  );
  await assert.rejects(window.storage.get('count'), (error) =>
    hasPersistenceCode(error, 'persistence_unavailable'),
  );
});
