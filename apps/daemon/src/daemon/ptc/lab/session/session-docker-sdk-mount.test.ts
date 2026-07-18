import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPtcSessionDockerCreateArgs } from './session-docker-create-args.js';
import {
  createPtcSessionDockerLocalBatchCommandPolicy,
  PTC_SESSION_DOCKER_HOST_USER_POLICY_ID,
  PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_SDK_PROJECTION_MOUNT_POLICY_ID,
  type PtcSessionDockerIdentity,
  type PtcSessionDockerSdkProjectionMount,
} from './session-docker-contract.js';
import { normalizePtcSessionDockerReuseKey } from './session-docker.js';

const SDK_HASH =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;

void test('session Docker identity binds one exact SDK projection read-only', () => {
  const baseIdentity: PtcSessionDockerIdentity = {
    threadId: 'thread-sdk-mount',
    stateRoot: '/workspace/project',
    trustContextId: 'ptc-test',
  };
  const sdkProjectionMount: PtcSessionDockerSdkProjectionMount = {
    hostRootPath: '/private/tool-library/projections/sha256-a',
    containerRootPath: PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT,
    mountPolicyId: PTC_SESSION_DOCKER_SDK_PROJECTION_MOUNT_POLICY_ID,
    sdkVersion: 'geulbat-tool-library-sdk-v1',
    sdkProjectionHash: SDK_HASH,
    policyId: 'ptc-sdk-read-tools-v1',
    importSpecifier: 'geulbat-sdk',
  };
  const withSdkIdentity: PtcSessionDockerIdentity = {
    ...baseIdentity,
    sdkProjectionMount,
  };
  const normalize = (identity: PtcSessionDockerIdentity) =>
    normalizePtcSessionDockerReuseKey({
      identity,
      stateRootRealpath: '/workspace/project',
      policy: createPtcSessionDockerLocalBatchCommandPolicy(),
      hostUser: {
        hostUserPolicyId: PTC_SESSION_DOCKER_HOST_USER_POLICY_ID,
        uid: 1000,
        gid: 1000,
      },
    });

  const withoutSdk = normalize(baseIdentity);
  const withSdk = normalize(withSdkIdentity);
  assert.notEqual(withSdk.identityHash, withoutSdk.identityHash);
  assert.equal(
    withSdk.packageCacheIdentityHash,
    withoutSdk.packageCacheIdentityHash,
  );

  const createArgs = buildPtcSessionDockerCreateArgs({
    reuseKey: withSdk,
    runtimeRoot: '/private/ptc-runtime',
  });
  assert.ok(
    createArgs.includes(
      `type=bind,src=${sdkProjectionMount.hostRootPath},dst=${PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT},readonly`,
    ),
  );
  assert.equal(
    createArgs.some(
      (arg) => arg.includes('/workspace/project') || arg.includes('.git'),
    ),
    false,
  );
  assert.equal(
    createArgs.some((arg) => arg.includes('hostRootPath')),
    false,
  );

  const drifted = normalize({
    ...withSdkIdentity,
    sdkProjectionMount: {
      ...sdkProjectionMount,
      sdkProjectionHash:
        'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  });
  assert.notEqual(drifted.identityHash, withSdk.identityHash);
  assert.equal(
    drifted.packageCacheIdentityHash,
    withSdk.packageCacheIdentityHash,
  );
});
