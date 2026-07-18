import test from 'node:test';
import assert from 'node:assert/strict';

import { brandThreadId } from '../../../lib/id-brand-helpers.js';
import {
  createArtifactRuntimeFrameIdentity,
  resolveArtifactRuntimeParentOrigin,
} from './artifact-runtime-frame-identity.js';

void test('createArtifactRuntimeFrameIdentity derives host url, revision, and persistence scope', () => {
  const identity = createArtifactRuntimeFrameIdentity({
    renderer: 'js',
    runtimePayload: 'window.__artifact_booted__ = true;',
    locationOrigin: 'http://127.0.0.1:5173',
    sourceRef: {
      kind: 'thread-file',
      workingDirectory: 'stories/sample',
      threadId: brandThreadId('00000000-0000-4000-8000-000000000001'),
      runId: 'run-1',
      filePath: 'artifacts/demo.js',
      messageTimestamp: '2026-04-29T00:00:00.000Z',
      artifactId: 'artifact-1',
      artifactVersion: 3,
      persistenceEpoch: 5,
    },
  });

  const frameUrl = new URL(identity.runtimeFrameUrl);

  assert.equal(identity.runtimeParentOrigin, 'http://127.0.0.1:5173');
  assert.equal(identity.runtimeHostOrigin, 'http://127.0.0.1:3456');
  assert.equal(
    frameUrl.href,
    'http://127.0.0.1:3456/artifact-runtime/host?parentOrigin=http%3A%2F%2F127.0.0.1%3A5173&rev=' +
      identity.runtimeFrameRevision,
  );
  assert.match(identity.runtimeFrameRevision, /^rev2-/);
  assert.equal(identity.scopeHandle, `scope-${identity.runtimeFrameRevision}`);
  assert.deepEqual(identity.scope, {
    threadId: brandThreadId('00000000-0000-4000-8000-000000000001'),
    renderer: 'js',
    artifactId: 'artifact-1',
    persistenceEpoch: 5,
  });
});

void test('createArtifactRuntimeFrameIdentity keeps persistence scope unavailable without committed artifact identity', () => {
  const identity = createArtifactRuntimeFrameIdentity({
    renderer: 'react_bundle',
    runtimePayload: 'export default function App() { return null; }',
    sourceRef: {
      kind: null,
      workingDirectory: '',
      threadId: null,
      runId: null,
      filePath: null,
      messageTimestamp: null,
      artifactId: null,
      artifactVersion: null,
      persistenceEpoch: null,
    },
  });

  assert.equal(identity.runtimeParentOrigin, 'http://127.0.0.1:5173');
  assert.equal(identity.scope, null);
  assert.match(identity.scopeHandle, /^scope-rev2-/);
});

void test('resolveArtifactRuntimeParentOrigin uses the browser origin when present', () => {
  assert.equal(
    resolveArtifactRuntimeParentOrigin('https://workspace.example.test'),
    'https://workspace.example.test',
  );
  assert.equal(
    resolveArtifactRuntimeParentOrigin(undefined),
    'http://127.0.0.1:5173',
  );
});
