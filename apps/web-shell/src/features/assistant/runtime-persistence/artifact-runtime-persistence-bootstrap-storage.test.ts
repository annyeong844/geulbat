import test from 'node:test';
import assert from 'node:assert/strict';
import type { JsonValue } from '@geulbat/protocol/runtime-persistence';

import {
  createBootstrapHarness,
  createErrorResponse,
  createOkResponse,
  hasPersistenceCode,
  toComparableJson,
} from '../../../test-support/runtime-persistence-bootstrap-harness.js';
import {
  ARTIFACT_RUNTIME_PERSISTENCE_VERBS,
  PERSISTENCE_REQUEST_KIND,
} from './artifact-runtime-persistence-types.js';

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
