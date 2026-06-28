import test from 'node:test';
import assert from 'node:assert/strict';

import { isArtifactRuntimePersistenceStateInputRefResponse } from './runtime-persistence.js';

void test('runtime persistence state input ref response guard requires a ref and byte length', () => {
  assert.equal(
    isArtifactRuntimePersistenceStateInputRefResponse({
      ok: true,
      stateRef:
        'artifact-runtime-state-input:00000000-0000-4000-8000-000000000001',
      byteLength: 2,
    }),
    true,
  );
  assert.equal(
    isArtifactRuntimePersistenceStateInputRefResponse({
      ok: true,
      stateRef:
        'artifact-runtime-state-input:00000000-0000-4000-8000-000000000001',
      byteLength: Number.NaN,
    }),
    false,
  );
});
