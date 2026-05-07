import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ARTIFACT_RUNTIME_HOST_ORIGIN,
  resolveArtifactRuntimeHostOrigin,
  resolveArtifactRuntimeHostUrl,
} from './artifact-runtime-host.js';

void test('resolveArtifactRuntimeHostOrigin defaults loopback shell origins to the daemon host', () => {
  assert.equal(
    resolveArtifactRuntimeHostOrigin('http://127.0.0.1:5174'),
    DEFAULT_ARTIFACT_RUNTIME_HOST_ORIGIN,
  );
  assert.equal(
    resolveArtifactRuntimeHostOrigin('http://localhost:5173'),
    DEFAULT_ARTIFACT_RUNTIME_HOST_ORIGIN,
  );
});

void test('resolveArtifactRuntimeHostOrigin keeps same-origin daemon hosts and non-loopback origins', () => {
  assert.equal(
    resolveArtifactRuntimeHostOrigin('http://127.0.0.1:3456'),
    'http://127.0.0.1:3456',
  );
  assert.equal(
    resolveArtifactRuntimeHostOrigin('https://canvas.geulbat.local'),
    'https://canvas.geulbat.local',
  );
});

void test('resolveArtifactRuntimeHostUrl builds the dedicated artifact runtime host path', () => {
  assert.equal(
    resolveArtifactRuntimeHostUrl('http://127.0.0.1:5174'),
    'http://127.0.0.1:3456/artifact-runtime/host',
  );
  assert.equal(
    resolveArtifactRuntimeHostUrl('https://canvas.geulbat.local'),
    'https://canvas.geulbat.local/artifact-runtime/host',
  );
});
