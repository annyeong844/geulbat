import assert from 'node:assert/strict';
import { posix as pathPosix } from 'node:path';
import test from 'node:test';
import type { PtcEpochOwnerContext } from './epoch-callback.js';
import {
  createPtcSessionEpochBridge,
  type PtcEpochCallbackChannelFactory,
} from './session-epoch-bridge.js';
import {
  PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_ARTIFACT_WORKSPACE_MOUNT_POLICY_ID,
  PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_DEFAULT_POLICY,
  normalizePtcSessionDockerReuseKey,
  type PtcSessionDockerHandle,
  type PtcSessionDockerIdentity,
  type PtcSessionDockerManager,
  type PtcSessionDockerReuseKey,
} from './session-docker.js';

const IDENTITY: PtcSessionDockerIdentity = Object.freeze({
  threadId: 'thread-ptc-bridge',
  workspaceRoot: '/workspace/project-a',
  trustContextId: 'trust-local-v1',
});

const REUSE_KEY: PtcSessionDockerReuseKey = Object.freeze(
  normalizePtcSessionDockerReuseKey({
    identity: IDENTITY,
    workspaceRootRealpath: '/real/workspace/project-a',
    policy: PTC_SESSION_DOCKER_DEFAULT_POLICY,
  }),
);

function readyHandle(callbackRootHostPath: string): PtcSessionDockerHandle {
  return {
    state: 'ready',
    containerId: 'container-ptc-1',
    reuseKey: REUSE_KEY,
    callbackRootHostPath,
    callbackRootContainerPath: PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT,
    artifactRootHostPath: `${callbackRootHostPath}/../artifacts`,
    artifactRootContainerPath: PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT,
    artifactWorkspaceMountPolicyId:
      PTC_SESSION_DOCKER_ARTIFACT_WORKSPACE_MOUNT_POLICY_ID,
    packageCacheRootHostPath: `${callbackRootHostPath}/../package-cache`,
    packageCacheRootContainerPath: REUSE_KEY.packageCacheRootContainerPath,
    packageCacheMountPolicyId: REUSE_KEY.packageCacheMountPolicyId,
    packageCacheId: REUSE_KEY.packageCacheId,
    packageCacheIdentityHash: REUSE_KEY.packageCacheIdentityHash,
  };
}

function fakeManager(handle: PtcSessionDockerHandle): PtcSessionDockerManager {
  return {
    getOrCreate: async (identity) => {
      assert.deepEqual(identity, IDENTITY);
      return { ok: true, value: handle };
    },
    close: async () => ({ ok: true, value: undefined }),
    closeAll: async () => ({ ok: true, value: undefined }),
  };
}

void test('createPtcSessionEpochBridge creates callback channel under session root and projects container socket path', async () => {
  const hostRoot = `/tmp/geulbat-ptc-${REUSE_KEY.identityHash}/callbacks`;
  const hostSocketPath = `${hostRoot}/ptc-epoch-123/callback.sock`;
  let closeCount = 0;
  let observedOwner: PtcEpochOwnerContext | undefined;

  const callbackFactory: PtcEpochCallbackChannelFactory = async (args) => {
    assert.equal(args.rootDir, hostRoot);
    observedOwner = args.owner;
    return {
      epochId: 'epoch-123',
      token: 'token-abc',
      epochDir: `${hostRoot}/ptc-epoch-123`,
      socketPath: hostSocketPath,
      close: async () => {
        closeCount += 1;
      },
    };
  };

  const bridge = await createPtcSessionEpochBridge({
    identity: IDENTITY,
    sessionManager: fakeManager(readyHandle(hostRoot)),
    callbackFactory,
    callbackHandler: async () => ({ ok: true, result: { kind: 'inline' } }),
  });

  if (!bridge.ok) {
    assert.fail(bridge.message);
  }
  assert.equal(bridge.value.containerId, 'container-ptc-1');
  assert.equal(bridge.value.epochId, 'epoch-123');
  assert.equal(bridge.value.token, 'token-abc');
  assert.equal(bridge.value.callbackSocketHostPath, hostSocketPath);
  assert.equal(
    bridge.value.callbackSocketContainerPath,
    `${PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT}/ptc-epoch-123/callback.sock`,
  );
  assert.equal(
    pathPosix.relative(hostRoot, bridge.value.callbackSocketHostPath),
    'ptc-epoch-123/callback.sock',
  );
  assert.deepEqual(observedOwner, {
    threadId: 'thread-ptc-bridge',
    workspaceRoot: '/real/workspace/project-a',
    approvalScope: 'run',
  });

  await bridge.value.close();
  assert.equal(closeCount, 1);
});

void test('createPtcSessionEpochBridge forwards AbortSignal to session manager', async () => {
  const hostRoot = `/tmp/geulbat-ptc-${REUSE_KEY.identityHash}/callbacks`;
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;

  const manager: PtcSessionDockerManager = {
    getOrCreate: async (_identity, options) => {
      observedSignal = options?.signal;
      return { ok: true, value: readyHandle(hostRoot) };
    },
    close: async () => ({ ok: true, value: undefined }),
    closeAll: async () => ({ ok: true, value: undefined }),
  };

  const callbackFactory: PtcEpochCallbackChannelFactory = async () => ({
    epochId: 'epoch-signal',
    token: 'token-signal',
    epochDir: `${hostRoot}/ptc-epoch-signal`,
    socketPath: `${hostRoot}/ptc-epoch-signal/callback.sock`,
    close: async () => {},
  });

  const result = await createPtcSessionEpochBridge({
    identity: IDENTITY,
    sessionManager: manager,
    callbackFactory,
    callbackHandler: async () => ({ ok: true, result: null }),
    signal: controller.signal,
  });

  assert.equal(result.ok, true);
  assert.equal(observedSignal, controller.signal);
});

void test('createPtcSessionEpochBridge closes callback channel when path projection fails', async () => {
  const hostRoot = `/tmp/geulbat-ptc-${REUSE_KEY.identityHash}/callbacks`;
  let closeCount = 0;

  const callbackFactory: PtcEpochCallbackChannelFactory = async () => ({
    epochId: 'epoch-bad',
    token: 'token-bad',
    epochDir: `${hostRoot}/ptc-epoch-bad`,
    socketPath: '/tmp/not-mounted/ptc-epoch-bad/callback.sock',
    close: async () => {
      closeCount += 1;
    },
  });

  const result = await createPtcSessionEpochBridge({
    identity: IDENTITY,
    sessionManager: fakeManager(readyHandle(hostRoot)),
    callbackFactory,
    callbackHandler: async () => ({ ok: true, result: null }),
  });

  if (result.ok) {
    assert.fail('expected callback path projection failure');
  }
  assert.equal(result.reasonCode, 'callback_path_projection_failed');
  assert.equal(closeCount, 1);
  assert.doesNotMatch(JSON.stringify(result), /\.geulbat|\/tmp\/not-mounted/u);
});

void test('createPtcSessionEpochBridge rejects escaped callback socket projections', async () => {
  const hostRoot = `/tmp/geulbat-ptc-${REUSE_KEY.identityHash}/callbacks`;
  const escapedSocketPaths = [
    `${hostRoot}-sibling/ptc-epoch/callback.sock`,
    `${hostRoot}/../outside/callback.sock`,
    hostRoot,
  ];

  for (const socketPath of escapedSocketPaths) {
    let closeCount = 0;
    const callbackFactory: PtcEpochCallbackChannelFactory = async () => ({
      epochId: 'epoch-escaped',
      token: 'token-escaped',
      epochDir: `${hostRoot}/ptc-epoch-escaped`,
      socketPath,
      close: async () => {
        closeCount += 1;
      },
    });

    const result = await createPtcSessionEpochBridge({
      identity: IDENTITY,
      sessionManager: fakeManager(readyHandle(hostRoot)),
      callbackFactory,
      callbackHandler: async () => ({ ok: true, result: null }),
    });

    if (result.ok) {
      assert.fail('expected callback path projection failure');
    }
    assert.equal(result.reasonCode, 'callback_path_projection_failed');
    assert.equal(closeCount, 1);
    assert.doesNotMatch(JSON.stringify(result), /\.geulbat|\/tmp\/geulbat/u);
  }
});

void test('createPtcSessionEpochBridge maps session failures without leaking paths', async () => {
  const manager: PtcSessionDockerManager = {
    getOrCreate: async () => ({
      ok: false,
      reasonCode: 'container_create_failed',
      message: 'failed at /tmp/private/.geulbat/socket',
      diagnostics: {
        stderr: '/tmp/private/.geulbat/socket',
      },
    }),
    close: async () => ({ ok: true, value: undefined }),
    closeAll: async () => ({ ok: true, value: undefined }),
  };

  const result = await createPtcSessionEpochBridge({
    identity: IDENTITY,
    sessionManager: manager,
    callbackHandler: async () => ({ ok: true, result: null }),
  });

  if (result.ok) {
    assert.fail('expected session failure');
  }
  assert.equal(result.reasonCode, 'session_unavailable');
  assert.deepEqual(result.diagnostics, {
    sessionReasonCode: 'container_create_failed',
  });
  assert.doesNotMatch(JSON.stringify(result), /\.geulbat|\/tmp\/private/u);
});

void test('bridge close is idempotent and does not close the long-lived session container', async () => {
  const hostRoot = `/tmp/geulbat-ptc-${REUSE_KEY.identityHash}/callbacks`;
  let channelCloseCount = 0;
  let sessionCloseCount = 0;
  const manager: PtcSessionDockerManager = {
    getOrCreate: async () => ({ ok: true, value: readyHandle(hostRoot) }),
    close: async () => {
      sessionCloseCount += 1;
      return { ok: true, value: undefined };
    },
    closeAll: async () => ({ ok: true, value: undefined }),
  };
  const callbackFactory: PtcEpochCallbackChannelFactory = async () => ({
    epochId: 'epoch-close',
    token: 'token-close',
    epochDir: `${hostRoot}/ptc-epoch-close`,
    socketPath: `${hostRoot}/ptc-epoch-close/callback.sock`,
    close: async () => {
      channelCloseCount += 1;
    },
  });

  const bridge = await createPtcSessionEpochBridge({
    identity: IDENTITY,
    sessionManager: manager,
    callbackFactory,
    callbackHandler: async () => ({ ok: true, result: null }),
  });

  if (!bridge.ok) {
    assert.fail(bridge.message);
  }
  await bridge.value.close();
  await bridge.value.close();

  assert.equal(channelCloseCount, 1);
  assert.equal(sessionCloseCount, 0);
});
