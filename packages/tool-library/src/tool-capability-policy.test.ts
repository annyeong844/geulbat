import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createToolCapabilityPolicy,
  parseToolCapabilityPolicy,
  serializeToolCapabilityPolicy,
  validateToolCapabilityPolicy,
} from './tool-capability-policy.js';

void test('creates one canonical immutable identity for equivalent tool capability policies', () => {
  const first = createToolCapabilityPolicy({
    directRegistryNames: ['read_file', 'list_files', 'read_file'],
    allowedRegistryNames: ['search_files', 'read_file', 'list_files'],
    callbackRegistryNames: ['search_files', 'read_file'],
    writeCallbackEnabled: false,
  });
  const same = createToolCapabilityPolicy({
    directRegistryNames: ['list_files', 'read_file'],
    allowedRegistryNames: ['list_files', 'read_file', 'search_files'],
    callbackRegistryNames: ['read_file', 'search_files'],
    writeCallbackEnabled: false,
  });
  const changed = createToolCapabilityPolicy({
    directRegistryNames: ['list_files', 'read_file'],
    allowedRegistryNames: ['list_files', 'read_file', 'search_files'],
    callbackRegistryNames: ['read_file', 'search_files'],
    writeCallbackEnabled: true,
  });

  assert.deepEqual(first.directRegistryNames, ['list_files', 'read_file']);
  assert.deepEqual(first.allowedRegistryNames, [
    'list_files',
    'read_file',
    'search_files',
  ]);
  assert.deepEqual(first.callbackRegistryNames, ['read_file', 'search_files']);
  assert.match(first.toolCapabilityPolicyId, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(first.toolCapabilityPolicyId, same.toolCapabilityPolicyId);
  assert.notEqual(first.toolCapabilityPolicyId, changed.toolCapabilityPolicyId);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.directRegistryNames), true);
  assert.equal(Object.isFrozen(first.allowedRegistryNames), true);
  assert.equal(Object.isFrozen(first.callbackRegistryNames), true);
});

void test('round-trips only an exact canonical tool capability policy', () => {
  const policy = createToolCapabilityPolicy({
    directRegistryNames: ['read_file'],
    allowedRegistryNames: ['read_file', 'search_files'],
    callbackRegistryNames: ['search_files'],
    writeCallbackEnabled: false,
  });
  const serialized = serializeToolCapabilityPolicy(policy);

  assert.deepEqual(parseToolCapabilityPolicy(serialized), policy);
  assert.deepEqual(validateToolCapabilityPolicy(policy), policy);
  assert.equal(
    serializeToolCapabilityPolicy({
      ...policy,
      allowedRegistryNames: [...policy.allowedRegistryNames].reverse(),
    }),
    serialized,
  );
  assert.throws(
    () =>
      validateToolCapabilityPolicy({
        ...policy,
        ambientEnvironmentGate: true,
      }),
    /unexpected fields/u,
  );
  assert.throws(
    () =>
      parseToolCapabilityPolicy(
        serialized.replace(
          '"writeCallbackEnabled":false',
          '"writeCallbackEnabled":true',
        ),
      ),
    /toolCapabilityPolicyId does not match/u,
  );
});

void test('rejects capability names outside the full allowed registry set', () => {
  assert.throws(
    () =>
      createToolCapabilityPolicy({
        directRegistryNames: ['write_file'],
        allowedRegistryNames: ['read_file'],
        callbackRegistryNames: [],
        writeCallbackEnabled: false,
      }),
    /directRegistryNames must be a subset/u,
  );
  assert.throws(
    () =>
      createToolCapabilityPolicy({
        directRegistryNames: [],
        allowedRegistryNames: ['read_file'],
        callbackRegistryNames: ['search_files'],
        writeCallbackEnabled: false,
      }),
    /callbackRegistryNames must be a subset/u,
  );
});
