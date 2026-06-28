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
  type ArtifactRuntimePersistenceRequestMessage,
} from './artifact-runtime-persistence-types.js';

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
