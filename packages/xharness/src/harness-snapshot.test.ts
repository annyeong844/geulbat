import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createHarnessConfigSnapshot,
  createHarnessToolCapabilityPolicy,
  parseHarnessConfigSnapshot,
  parseHarnessToolCapabilityPolicy,
  serializeHarnessConfigSnapshot,
  serializeHarnessToolCapabilityPolicy,
  type HarnessConfigJsonValue,
} from './harness-snapshot.js';

void test('creates canonical immutable per-run tool capability policies', () => {
  const first = createHarnessToolCapabilityPolicy({
    directRegistryNames: ['read_file', 'list_files', 'read_file'],
    allowedRegistryNames: ['search_files', 'read_file', 'list_files'],
    callbackRegistryNames: ['search_files', 'read_file'],
    writeCallbackEnabled: false,
  });
  const same = createHarnessToolCapabilityPolicy({
    directRegistryNames: ['list_files', 'read_file'],
    allowedRegistryNames: ['list_files', 'read_file', 'search_files'],
    callbackRegistryNames: ['read_file', 'search_files'],
    writeCallbackEnabled: false,
  });
  const changed = createHarnessToolCapabilityPolicy({
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

  const serialized = serializeHarnessToolCapabilityPolicy(first);
  const parsed = parseHarnessToolCapabilityPolicy(serialized);
  assert.deepEqual(parsed, first);
  assert.equal(serializeHarnessToolCapabilityPolicy(parsed), serialized);
  assert.equal(
    serializeHarnessToolCapabilityPolicy({
      ...first,
      directRegistryNames: [...first.directRegistryNames].reverse(),
      allowedRegistryNames: [...first.allowedRegistryNames].reverse(),
      callbackRegistryNames: [...first.callbackRegistryNames].reverse(),
    }),
    serialized,
  );
});

void test('binds the full tool capability policy into the harness snapshot', () => {
  const toolCapabilityPolicy = createHarnessToolCapabilityPolicy({
    directRegistryNames: ['read_file'],
    allowedRegistryNames: ['read_file', 'search_files'],
    callbackRegistryNames: ['search_files'],
    writeCallbackEnabled: false,
  });
  const snapshot = createHarnessConfigSnapshot({
    harnessId: 'writer',
    harnessVersion: 'v1',
    config: { toolCapabilityPolicy },
  });
  const changedSnapshot = createHarnessConfigSnapshot({
    harnessId: 'writer',
    harnessVersion: 'v1',
    config: {
      toolCapabilityPolicy: createHarnessToolCapabilityPolicy({
        directRegistryNames: ['read_file'],
        allowedRegistryNames: ['read_file', 'search_files'],
        callbackRegistryNames: ['read_file', 'search_files'],
        writeCallbackEnabled: false,
      }),
    },
  });

  const parsed = parseHarnessConfigSnapshot(
    serializeHarnessConfigSnapshot(snapshot),
  );
  assert.deepEqual(parsed, snapshot);
  assert.notEqual(
    snapshot.harnessSnapshotId,
    changedSnapshot.harnessSnapshotId,
  );
  assert.equal(Object.isFrozen(snapshot.config.toolCapabilityPolicy), true);
  assert.equal(
    Object.isFrozen(snapshot.config.toolCapabilityPolicy.allowedRegistryNames),
    true,
  );
});

void test('rejects invalid or tampered tool capability policies', () => {
  assert.throws(
    () =>
      createHarnessToolCapabilityPolicy({
        directRegistryNames: ['write_file'],
        allowedRegistryNames: ['read_file'],
        callbackRegistryNames: [],
        writeCallbackEnabled: false,
      }),
    /directRegistryNames must be a subset/u,
  );
  assert.throws(
    () =>
      createHarnessToolCapabilityPolicy({
        directRegistryNames: [],
        allowedRegistryNames: ['read_file'],
        callbackRegistryNames: ['search_files'],
        writeCallbackEnabled: false,
      }),
    /callbackRegistryNames must be a subset/u,
  );
  assert.throws(
    () =>
      createHarnessToolCapabilityPolicy({
        directRegistryNames: [' '],
        allowedRegistryNames: [' '],
        callbackRegistryNames: [],
        writeCallbackEnabled: false,
      }),
    /must contain only non-blank strings/u,
  );

  const policy = createHarnessToolCapabilityPolicy({
    directRegistryNames: ['read_file'],
    allowedRegistryNames: ['read_file', 'search_files'],
    callbackRegistryNames: ['search_files'],
    writeCallbackEnabled: false,
  });
  const serialized = serializeHarnessToolCapabilityPolicy(policy);
  assert.throws(
    () =>
      parseHarnessToolCapabilityPolicy(
        serialized.replace(
          '"writeCallbackEnabled":false',
          '"writeCallbackEnabled":true',
        ),
      ),
    /toolCapabilityPolicyId does not match/u,
  );
  const contaminatedPolicy = { ...policy, ambientEnvironmentGate: true };
  assert.throws(
    () => serializeHarnessToolCapabilityPolicy(contaminatedPolicy),
    /unexpected fields/u,
  );
});

void test('creates stable immutable identities from canonical harness config', () => {
  const first = createHarnessConfigSnapshot({
    harnessId: 'writer',
    harnessVersion: 'v1',
    config: {
      promptProfile: { contextBuilderId: 'default', systemPromptId: 'writer' },
      processors: ['before_model', 'after_model'],
    },
  });
  const same = createHarnessConfigSnapshot({
    harnessId: 'writer',
    harnessVersion: 'v1',
    config: {
      processors: ['before_model', 'after_model'],
      promptProfile: { systemPromptId: 'writer', contextBuilderId: 'default' },
    },
  });
  const changed = createHarnessConfigSnapshot({
    harnessId: 'writer',
    harnessVersion: 'v2',
    config: {
      processors: ['before_model', 'after_model'],
      promptProfile: { systemPromptId: 'writer', contextBuilderId: 'default' },
    },
  });

  assert.match(first.harnessSnapshotId, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(first.harnessSnapshotId, same.harnessSnapshotId);
  assert.notEqual(first.harnessSnapshotId, changed.harnessSnapshotId);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.config), true);
  assert.equal(Object.isFrozen(first.config.promptProfile), true);
});

void test('serializes and parses canonical immutable harness snapshots', () => {
  const snapshot = createHarnessConfigSnapshot({
    harnessId: 'writer',
    harnessVersion: 'v1',
    config: {
      promptProfile: { contextBuilderId: 'default', systemPromptId: 'writer' },
      processors: ['before_model', 'after_model'],
    },
  });

  const serialized = serializeHarnessConfigSnapshot(snapshot);
  const parsed = parseHarnessConfigSnapshot(serialized);

  assert.deepEqual(parsed, snapshot);
  assert.equal(serializeHarnessConfigSnapshot(parsed), serialized);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.config), true);
  assert.equal(Object.isFrozen(parsed.config.promptProfile), true);
  const contaminatedSnapshot = {
    ...snapshot,
    rawPrompt: 'must not cross the harness snapshot boundary',
  };
  assert.throws(
    () => serializeHarnessConfigSnapshot(contaminatedSnapshot),
    /unexpected fields/u,
  );
});

void test('rejects malformed or tampered durable harness snapshots', () => {
  const snapshot = createHarnessConfigSnapshot({
    harnessId: 'writer',
    harnessVersion: 'v1',
    config: { systemPromptId: 'writer' },
  });
  const serialized = serializeHarnessConfigSnapshot(snapshot);

  assert.throws(() => parseHarnessConfigSnapshot('{'), /must be valid JSON/u);
  assert.throws(
    () =>
      parseHarnessConfigSnapshot(
        serialized.replace(
          '"systemPromptId":"writer"',
          '"systemPromptId":"critic"',
        ),
      ),
    /harnessSnapshotId does not match/u,
  );
  assert.throws(
    () =>
      parseHarnessConfigSnapshot(
        serialized.replace('"schemaVersion":1', '"schemaVersion":2'),
      ),
    /unsupported harness config snapshot schemaVersion/u,
  );
  assert.throws(
    () =>
      parseHarnessConfigSnapshot(
        serialized.replace(
          '"config":{"systemPromptId":"writer"}',
          '"config":[]',
        ),
      ),
    /harness config must be a JSON object/u,
  );
});

void test('rejects config values that cannot be represented by portable JSON', () => {
  const cyclicConfig: Record<string, HarnessConfigJsonValue> = {};
  cyclicConfig.self = cyclicConfig;
  assert.throws(
    () =>
      createHarnessConfigSnapshot({
        harnessId: 'writer',
        harnessVersion: 'v1',
        config: { invalidNumber: Number.POSITIVE_INFINITY },
      }),
    /numbers must be finite/u,
  );
  assert.throws(
    () =>
      createHarnessConfigSnapshot({
        harnessId: 'writer',
        harnessVersion: 'v1',
        config: cyclicConfig,
      }),
    /must not contain cycles/u,
  );
});
