import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectId, ThreadId } from '@geulbat/protocol/ids';

import { ApiFetchError } from '../../../lib/api/client.js';
import {
  createArtifactRuntimePersistenceBridgeResponder,
  createArtifactRuntimePersistenceScopeHandle,
  createArtifactRuntimePersistenceScopeKey,
  readPersistenceErrorCode,
  readPersistenceErrorMessage,
} from './artifact-runtime-persistence.js';

const PROJECT_ID = 'workspace' as ProjectId;
const THREAD_ID = '00000000-0000-4000-8000-000000000001' as ThreadId;
const ARTIFACT_ID = 'art_demo_js';

function createScope(overrides: Record<string, unknown> = {}) {
  return {
    projectId: PROJECT_ID,
    threadId: THREAD_ID,
    renderer: 'js' as const,
    artifactId: ARTIFACT_ID,
    persistenceEpoch: 0,
    ...overrides,
  };
}

void test('readPersistenceErrorCode reads canonical persistence api errors', () => {
  const error = new ApiFetchError(
    409,
    JSON.stringify({
      code: 'persistence_conflict',
      message: 'stale revision',
    }),
  );

  assert.equal(readPersistenceErrorCode(error), 'persistence_conflict');
  assert.equal(readPersistenceErrorMessage(error), 'stale revision');
});

void test('readPersistenceErrorCode falls back for non-persistence api errors', () => {
  const error = new ApiFetchError(
    500,
    JSON.stringify({
      code: 'internal',
      message: 'internal server error',
    }),
  );

  assert.equal(readPersistenceErrorCode(error), 'persistence_unavailable');
  assert.equal(
    readPersistenceErrorMessage(error),
    'API 500: {"code":"internal","message":"internal server error"}',
  );
});

void test('createArtifactRuntimePersistenceScopeKey returns the canonical host-owned scope identity', () => {
  assert.equal(createArtifactRuntimePersistenceScopeKey(null), null);
  assert.equal(
    createArtifactRuntimePersistenceScopeKey(createScope()),
    JSON.stringify([PROJECT_ID, THREAD_ID, ARTIFACT_ID, 0]),
  );
});

void test('createArtifactRuntimePersistenceScopeHandle returns a deterministic owner-provided handle', () => {
  assert.equal(
    createArtifactRuntimePersistenceScopeHandle('rev2-deadbeef'),
    'scope-rev2-deadbeef',
  );
});

void test('createArtifactRuntimePersistenceScopeHandle rejects empty scope seeds', () => {
  assert.throws(
    () => createArtifactRuntimePersistenceScopeHandle(''),
    /scopeSeed must be non-empty/,
  );
});

void test('runtime persistence bridge responder serves load_state for matching source and scopeHandle', async () => {
  const source = {} as MessageEventSource;
  const scopeHandle = 'scope-rev2-demo-load';
  const responder = createArtifactRuntimePersistenceBridgeResponder({
    expectedSource: () => source,
    scope: createScope(),
    scopeHandle,
    client: {
      loadState: async () => ({ state: { count: 1 }, revision: 'rev-1' }),
      saveState: async () => ({ revision: 'rev-2' }),
      clearState: async () => ({ revision: null }),
    },
  });

  const response = await responder.handleMessage(source, {
    kind: 'geulbat.runtime.persistence.request',
    version: 1,
    requestId: 'req-1',
    scopeHandle: responder.scopeHandle,
    verb: 'load_state',
  });

  assert.deepEqual(response, {
    kind: 'geulbat.shell.persistence.response',
    version: 1,
    requestId: 'req-1',
    scopeHandle,
    verb: 'load_state',
    ok: true,
    state: { count: 1 },
    revision: 'rev-1',
  });
});

void test('runtime persistence bridge responder blocks mismatched scopeHandle', async () => {
  const source = {} as MessageEventSource;
  const scopeHandle = 'scope-rev2-demo-mismatch';
  const responder = createArtifactRuntimePersistenceBridgeResponder({
    expectedSource: () => source,
    scope: createScope(),
    scopeHandle,
    client: {
      loadState: async () => ({ state: null, revision: null }),
      saveState: async () => ({ revision: 'rev-2' }),
      clearState: async () => ({ revision: null }),
    },
  });

  const response = await responder.handleMessage(source, {
    kind: 'geulbat.runtime.persistence.request',
    version: 1,
    requestId: 'req-2',
    scopeHandle: 'wrong-scope',
    verb: 'load_state',
  });

  assert.deepEqual(response, {
    kind: 'geulbat.shell.persistence.response',
    version: 1,
    requestId: 'req-2',
    scopeHandle,
    verb: 'load_state',
    ok: false,
    errorCode: 'persistence_blocked',
    message: 'runtime persistence scopeHandle mismatch',
  });
});

void test('runtime persistence bridge responder requires expectedRevision for save_state', async () => {
  const source = {} as MessageEventSource;
  const scopeHandle = 'scope-rev2-demo-save';
  const responder = createArtifactRuntimePersistenceBridgeResponder({
    expectedSource: () => source,
    scope: createScope(),
    scopeHandle,
    client: {
      loadState: async () => ({ state: null, revision: null }),
      saveState: async () => ({ revision: 'rev-2' }),
      clearState: async () => ({ revision: null }),
    },
  });

  const response = await responder.handleMessage(source, {
    kind: 'geulbat.runtime.persistence.request',
    version: 1,
    requestId: 'req-3',
    scopeHandle: responder.scopeHandle,
    verb: 'save_state',
    state: { count: 1 },
  });

  assert.deepEqual(response, {
    kind: 'geulbat.shell.persistence.response',
    version: 1,
    requestId: 'req-3',
    scopeHandle,
    verb: 'save_state',
    ok: false,
    errorCode: 'persistence_blocked',
    message: 'save_state requires expectedRevision',
  });
});

void test('runtime persistence bridge responder returns persistence_unavailable when artifact scope is missing', async () => {
  const source = {} as MessageEventSource;
  const scopeHandle = 'scope-rev2-demo-missing';
  const responder = createArtifactRuntimePersistenceBridgeResponder({
    expectedSource: () => source,
    scope: null,
    scopeHandle,
  });

  const response = await responder.handleMessage(source, {
    kind: 'geulbat.runtime.persistence.request',
    version: 1,
    requestId: 'req-4',
    scopeHandle: responder.scopeHandle,
    verb: 'load_state',
  });

  assert.deepEqual(response, {
    kind: 'geulbat.shell.persistence.response',
    version: 1,
    requestId: 'req-4',
    scopeHandle,
    verb: 'load_state',
    ok: false,
    errorCode: 'persistence_unavailable',
    message: 'runtime persistence scope is unavailable for this artifact',
  });
});

void test('runtime persistence bridge responder preserves persistence_conflict from API failures', async () => {
  const source = {} as MessageEventSource;
  const scopeHandle = 'scope-rev2-demo-conflict';
  const responder = createArtifactRuntimePersistenceBridgeResponder({
    expectedSource: () => source,
    scope: createScope(),
    scopeHandle,
    client: {
      loadState: async () => ({ state: null, revision: null }),
      saveState: async () => {
        throw new ApiFetchError(
          409,
          JSON.stringify({
            code: 'persistence_conflict',
            message:
              'runtime persistence revision does not match expectedRevision',
          }),
        );
      },
      clearState: async () => ({ revision: null }),
    },
  });

  const response = await responder.handleMessage(source, {
    kind: 'geulbat.runtime.persistence.request',
    version: 1,
    requestId: 'req-5',
    scopeHandle: responder.scopeHandle,
    verb: 'save_state',
    expectedRevision: 'rev-1',
    state: { count: 2 },
  });

  assert.deepEqual(response, {
    kind: 'geulbat.shell.persistence.response',
    version: 1,
    requestId: 'req-5',
    scopeHandle,
    verb: 'save_state',
    ok: false,
    errorCode: 'persistence_conflict',
    message: 'runtime persistence revision does not match expectedRevision',
  });
});

void test('runtime persistence bridge responder preserves persistence_quota_exceeded from API failures', async () => {
  const source = {} as MessageEventSource;
  const scopeHandle = 'scope-rev2-demo-quota';
  const responder = createArtifactRuntimePersistenceBridgeResponder({
    expectedSource: () => source,
    scope: createScope(),
    scopeHandle,
    client: {
      loadState: async () => ({ state: null, revision: null }),
      saveState: async () => {
        throw new ApiFetchError(
          413,
          JSON.stringify({
            code: 'persistence_quota_exceeded',
            message: 'runtime persistence state exceeds per-artifact quota',
          }),
        );
      },
      clearState: async () => ({ revision: null }),
    },
  });

  const response = await responder.handleMessage(source, {
    kind: 'geulbat.runtime.persistence.request',
    version: 1,
    requestId: 'req-6',
    scopeHandle: responder.scopeHandle,
    verb: 'save_state',
    expectedRevision: 'rev-1',
    state: { count: 2 },
  });

  assert.deepEqual(response, {
    kind: 'geulbat.shell.persistence.response',
    version: 1,
    requestId: 'req-6',
    scopeHandle,
    verb: 'save_state',
    ok: false,
    errorCode: 'persistence_quota_exceeded',
    message: 'runtime persistence state exceeds per-artifact quota',
  });
});
