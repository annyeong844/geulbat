import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ARTIFACT_RUNTIME_HOST_ORIGIN,
  resolveArtifactRuntimeHostOrigin,
  resolveArtifactRuntimeHostUrl,
} from './artifact-runtime-host.js';

/**
 * 데몬이 화면을 서빙하므로 아티팩트 런타임 호스트는 언제나 same-origin이다.
 * 포트를 고정값과 비교하면 OS가 고른 포트에서 틀린 origin을 만든다.
 */
void test('the runtime host lives at the shell own origin whatever the port is', () => {
  assert.equal(
    resolveArtifactRuntimeHostOrigin('http://127.0.0.1:3456'),
    'http://127.0.0.1:3456',
  );
  assert.equal(
    resolveArtifactRuntimeHostOrigin('http://127.0.0.1:41234'),
    'http://127.0.0.1:41234',
  );
  assert.equal(
    resolveArtifactRuntimeHostOrigin('https://canvas.geulbat.local'),
    'https://canvas.geulbat.local',
  );
});

void test('an unusable shell origin falls back to the documented daemon origin', () => {
  assert.equal(
    resolveArtifactRuntimeHostOrigin(undefined),
    DEFAULT_ARTIFACT_RUNTIME_HOST_ORIGIN,
  );
  assert.equal(
    resolveArtifactRuntimeHostOrigin('   '),
    DEFAULT_ARTIFACT_RUNTIME_HOST_ORIGIN,
  );
});

void test('resolveArtifactRuntimeHostUrl builds the dedicated artifact runtime host path', () => {
  assert.equal(
    resolveArtifactRuntimeHostUrl('http://127.0.0.1:41234'),
    'http://127.0.0.1:41234/artifact-runtime/host',
  );
  assert.equal(
    resolveArtifactRuntimeHostUrl('https://canvas.geulbat.local'),
    'https://canvas.geulbat.local/artifact-runtime/host',
  );
});
