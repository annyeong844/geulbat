import test from 'node:test';
import assert from 'node:assert/strict';
import type { ThreadId } from '@geulbat/protocol/ids';

import {
  createArtifactRuntimePersistenceScopeHandle,
  createArtifactRuntimePersistenceScopeKey,
} from './artifact-runtime-persistence-scope.js';

const THREAD_ID = '00000000-0000-4000-8000-000000000001' as ThreadId;
const ARTIFACT_ID = 'art_demo_js';

function createScope(overrides: Record<string, unknown> = {}) {
  return {
    threadId: THREAD_ID,
    renderer: 'js' as const,
    artifactId: ARTIFACT_ID,
    persistenceEpoch: 0,
    ...overrides,
  };
}

void test('createArtifactRuntimePersistenceScopeKey returns the canonical host-owned scope identity', () => {
  assert.equal(createArtifactRuntimePersistenceScopeKey(null), null);
  assert.equal(
    createArtifactRuntimePersistenceScopeKey(createScope()),
    JSON.stringify([THREAD_ID, ARTIFACT_ID, 0]),
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
