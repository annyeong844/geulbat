import test from 'node:test';
import assert from 'node:assert/strict';
import type { JsonValue } from '@geulbat/protocol/runtime-persistence';

import {
  createBootstrapHarness,
  createErrorResponse,
  createOkResponse,
  hasPersistenceCode,
} from '../../../test-support/runtime-persistence-bootstrap-harness.js';
import {
  ARTIFACT_RUNTIME_PERSISTENCE_VERBS,
  type ArtifactRuntimePersistenceRequestMessage,
} from './artifact-runtime-persistence-types.js';

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
