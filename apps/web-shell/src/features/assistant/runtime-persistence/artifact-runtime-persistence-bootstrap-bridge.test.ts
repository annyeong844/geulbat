import test from 'node:test';
import assert from 'node:assert/strict';

import { createArtifactRuntimePersistenceBridge } from './artifact-runtime-persistence-bootstrap-bridge.js';
import type {
  PersistenceBootstrapMessageEvent,
  PersistenceBootstrapRequestMessage,
  PersistenceBootstrapSuccessResponseMessage,
  PersistenceBootstrapVerbs,
  PersistenceBootstrapWindow,
} from './artifact-runtime-persistence-bootstrap-types.js';

const TEST_BRIDGE_VERSION = 1;
const TEST_SCOPE_HANDLE = 'scope-bridge-test';
const TEST_PARENT_ORIGIN = 'http://127.0.0.1:5173';
const TEST_REQUEST_KIND = 'geulbat:persistence-request';
const TEST_RESPONSE_KIND = 'geulbat:persistence-response';
const TEST_VERBS: PersistenceBootstrapVerbs = {
  loadVerb: 'load_state',
  saveVerb: 'save_state',
  clearVerb: 'clear_state',
};

class TestPersistenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function createOkResponse(
  request: PersistenceBootstrapRequestMessage,
  extras: {
    state?: unknown;
    revision?: string | null;
  } = {},
): PersistenceBootstrapSuccessResponseMessage {
  return {
    kind: TEST_RESPONSE_KIND,
    version: TEST_BRIDGE_VERSION,
    requestId: request.requestId,
    scopeHandle: request.scopeHandle,
    verb: request.verb,
    ok: true,
    revision: extras.revision ?? null,
    ...(extras.state === undefined ? {} : { state: extras.state }),
  };
}

function createBridgeHarness(
  options: { assertSharedStorageAvailable?: () => void } = {},
): {
  bridge: ReturnType<typeof createArtifactRuntimePersistenceBridge>;
  requests: PersistenceBootstrapRequestMessage[];
  dispatchResponse(
    response: unknown,
    overrides?: {
      source?: object;
      origin?: string;
    },
  ): void;
} {
  const requests: PersistenceBootstrapRequestMessage[] = [];
  let listener: ((event: PersistenceBootstrapMessageEvent) => void) | null =
    null;

  const parent = {
    postMessage(message: PersistenceBootstrapRequestMessage) {
      requests.push(message);
    },
  };
  const window: PersistenceBootstrapWindow = {
    parent,
    addEventListener(type, nextListener) {
      if (type === 'message') {
        listener = nextListener;
      }
    },
    setTimeout(handler, timeoutMs) {
      return globalThis.setTimeout(handler, timeoutMs);
    },
    clearTimeout(handle) {
      globalThis.clearTimeout(handle);
    },
    __GEULBAT_PERSISTENCE_BRIDGE_VERSION__: TEST_BRIDGE_VERSION,
    __GEULBAT_PERSISTENCE_SCOPE_HANDLE__: TEST_SCOPE_HANDLE,
    __GEULBAT_PERSISTENCE_PARENT_ORIGIN__: TEST_PARENT_ORIGIN,
    __GEULBAT_PERSISTENCE_REQUEST_KIND__: TEST_REQUEST_KIND,
    __GEULBAT_PERSISTENCE_RESPONSE_KIND__: TEST_RESPONSE_KIND,
    __GEULBAT_PERSISTENCE_REQUEST_TIMEOUT_MS__: 100,
  };
  const bridge = createArtifactRuntimePersistenceBridge(window, TEST_VERBS, {
    createPersistenceError(code, message) {
      return new TestPersistenceError(code, message);
    },
    stabilizePersistenceError(error) {
      return error instanceof Error
        ? error
        : new TestPersistenceError(
            'persistence_unavailable',
            `stabilized persistence error: ${String(error)}`,
          );
    },
    assertSharedStorageAvailable() {
      options.assertSharedStorageAvailable?.();
    },
    isPlainRecord(value): value is Record<string, unknown> {
      return !!value && typeof value === 'object' && !Array.isArray(value);
    },
  });

  return {
    bridge,
    requests,
    dispatchResponse(response, overrides = {}) {
      listener?.({
        source: overrides.source ?? parent,
        origin: overrides.origin ?? TEST_PARENT_ORIGIN,
        data: response,
      });
    },
  };
}

void test('persistence bridge stabilizes non-Error storage failures before rejecting', async () => {
  const harness = createBridgeHarness({
    assertSharedStorageAvailable() {
      throw 'storage is blocked';
    },
  });

  await assert.rejects(
    harness.bridge.persistenceApi.loadState(),
    (error: unknown) => {
      assert.ok(error instanceof TestPersistenceError);
      assert.equal(error.code, 'persistence_unavailable');
      assert.equal(
        error.message,
        'stabilized persistence error: storage is blocked',
      );
      return true;
    },
  );
  assert.equal(harness.requests.length, 0);
});

void test('persistence bridge response router ignores unexpected source and origin without clearing the pending request', async () => {
  const harness = createBridgeHarness();
  const loadState = harness.bridge.rawPersistenceApi.loadState();
  const request = harness.requests[0];
  assert.ok(request);

  harness.dispatchResponse(
    createOkResponse(request, {
      state: { count: 999 },
      revision: 'rev-wrong-source',
    }),
    { source: {} },
  );
  harness.dispatchResponse(
    createOkResponse(request, {
      state: { count: 998 },
      revision: 'rev-wrong-origin',
    }),
    { origin: 'http://malicious.example.test' },
  );
  harness.dispatchResponse(
    createOkResponse(request, {
      state: { count: 2 },
      revision: 'rev-2',
    }),
  );

  const response = await loadState;
  assert.deepEqual(response.state, { count: 2 });
  assert.equal(response.revision, 'rev-2');
});
