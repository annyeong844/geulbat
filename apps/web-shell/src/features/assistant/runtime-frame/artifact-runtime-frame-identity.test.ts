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
    locationOrigin: 'http://127.0.0.1:3456',
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

  // URL은 같은 데몬이 서빙하지만 sandbox가 프레임의 실제 origin을 opaque로
  // 만든다. 부모→프레임 전송은 exact WindowProxy와 wildcard target을 함께 쓴다.
  assert.equal(identity.runtimeParentOrigin, 'http://127.0.0.1:3456');
  assert.equal(identity.runtimeFrameMessageOrigin, 'null');
  assert.equal(identity.runtimeFrameTargetOrigin, '*');
  assert.equal(
    frameUrl.href,
    'http://127.0.0.1:3456/artifact-runtime/host?parentOrigin=http%3A%2F%2F127.0.0.1%3A3456&rev=' +
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
    // 이 테스트의 주제는 persistence scope다. locationOrigin을 주지 않으면
    // 부모 origin 미상 경로까지 함께 잠그게 되어 주제가 흐려진다.
    locationOrigin: 'http://127.0.0.1:5173',
  });

  assert.equal(identity.runtimeParentOrigin, 'http://127.0.0.1:5173');
  assert.equal(identity.scope, null);
  assert.match(identity.scopeHandle, /^scope-rev2-/);
});

void test('resolveArtifactRuntimeParentOrigin uses the browser origin when present', () => {
  assert.equal(
    resolveArtifactRuntimeParentOrigin('https://home.example.test'),
    'https://home.example.test',
  );
});

void test('an unknown parent origin is opaque so no message can be delivered', () => {
  // `window`가 없으면 전달할 부모가 없다. 동작할 것처럼 보이는 dev 주소를
  // 돌려주면 그 값이 기본 부모 origin으로 오해되고, 단일 포트 제품에서는
  // 아무 의미도 없다. opaque origin은 데몬 정규화에서 거부되어 런타임 호스트가
  // 아무것도 보내지 않는다.
  assert.equal(resolveArtifactRuntimeParentOrigin(undefined), 'null');
});
