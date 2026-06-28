import assert from 'node:assert/strict';
import { posix as pathPosix } from 'node:path';
import test from 'node:test';
import {
  PTC_TEST_SESSION_DOCKER_CONTAINER_ID,
  withRealPtcSessionDockerManager,
  type PtcSessionDockerManagerFixture,
} from '../../../test-support/ptc-session-docker.js';
import {
  createPtcSessionEpochBridge,
  PTC_EPOCH_CALLBACK_MAX_CALLBACKS_ENV,
  PTC_EPOCH_CALLBACK_MAX_FRAME_BYTES_ENV,
  PTC_EPOCH_CALLBACK_MAX_OPEN_CONNECTIONS_ENV,
  PTC_EPOCH_CALLBACK_MAX_RESPONSE_BYTES_ENV,
  PTC_EPOCH_CALLBACK_TIMEOUT_MS_ENV,
  resolvePtcSessionEpochBridgeCallbackPolicyFromEnv,
} from './session-epoch-bridge.js';
import type { PtcEpochCallbackChannelFactory } from './session-epoch-bridge.js';
import { PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT } from '../lab/session/session-docker-contract.js';
import type {
  PtcSessionDockerCommandInvocation,
  PtcSessionDockerCommandResult,
  PtcSessionDockerIdentity,
} from '../lab/session/session-docker-contract.js';

const IDENTITY: PtcSessionDockerIdentity = Object.freeze({
  threadId: 'thread-ptc-bridge',
  workspaceRoot: '/workspace/project-a',
  trustContextId: 'trust-local-v1',
});
const TEST_CALLBACK_TRANSPORT_POLICY = Object.freeze({
  maxFrameBytes: 8192,
  maxOpenConnections: 4,
  maxCallbacks: 20,
  callbackTimeoutMs: 30_000,
  maxResponseBytes: 8192,
});

void test('resolvePtcSessionEpochBridgeCallbackPolicyFromEnv returns undefined when env is absent', () => {
  assert.equal(
    resolvePtcSessionEpochBridgeCallbackPolicyFromEnv({}),
    undefined,
  );
});

void test('resolvePtcSessionEpochBridgeCallbackPolicyFromEnv accepts explicit policy settings', () => {
  assert.deepEqual(
    resolvePtcSessionEpochBridgeCallbackPolicyFromEnv({
      [PTC_EPOCH_CALLBACK_MAX_FRAME_BYTES_ENV]: ' 8192 ',
      [PTC_EPOCH_CALLBACK_MAX_OPEN_CONNECTIONS_ENV]: ' 4 ',
      [PTC_EPOCH_CALLBACK_MAX_CALLBACKS_ENV]: ' 20 ',
      [PTC_EPOCH_CALLBACK_TIMEOUT_MS_ENV]: ' 30000 ',
      [PTC_EPOCH_CALLBACK_MAX_RESPONSE_BYTES_ENV]: ' 16384 ',
    }),
    {
      maxFrameBytes: 8192,
      maxOpenConnections: 4,
      maxCallbacks: 20,
      callbackTimeoutMs: 30000,
      maxResponseBytes: 16384,
    },
  );
});

void test('resolvePtcSessionEpochBridgeCallbackPolicyFromEnv rejects partial or invalid policy settings', () => {
  assert.throws(
    () =>
      resolvePtcSessionEpochBridgeCallbackPolicyFromEnv({
        [PTC_EPOCH_CALLBACK_MAX_FRAME_BYTES_ENV]: '8192',
      }),
    new RegExp(
      `${PTC_EPOCH_CALLBACK_MAX_OPEN_CONNECTIONS_ENV} is required when PTC callback transport policy is configured`,
    ),
  );

  assert.throws(
    () =>
      resolvePtcSessionEpochBridgeCallbackPolicyFromEnv({
        [PTC_EPOCH_CALLBACK_MAX_FRAME_BYTES_ENV]: '8192',
        [PTC_EPOCH_CALLBACK_MAX_OPEN_CONNECTIONS_ENV]: '4',
        [PTC_EPOCH_CALLBACK_MAX_CALLBACKS_ENV]: '20',
        [PTC_EPOCH_CALLBACK_TIMEOUT_MS_ENV]: '30000',
      }),
    new RegExp(
      `${PTC_EPOCH_CALLBACK_MAX_RESPONSE_BYTES_ENV} is required when PTC callback transport policy is configured`,
    ),
  );

  for (const value of ['', ' ', '0', '-1', '+1', '1.5', '1e3']) {
    assert.throws(
      () =>
        resolvePtcSessionEpochBridgeCallbackPolicyFromEnv({
          [PTC_EPOCH_CALLBACK_MAX_FRAME_BYTES_ENV]: value,
          [PTC_EPOCH_CALLBACK_MAX_OPEN_CONNECTIONS_ENV]: '4',
          [PTC_EPOCH_CALLBACK_MAX_CALLBACKS_ENV]: '20',
          [PTC_EPOCH_CALLBACK_TIMEOUT_MS_ENV]: '30000',
          [PTC_EPOCH_CALLBACK_MAX_RESPONSE_BYTES_ENV]: '16384',
        }),
      new RegExp(`invalid ${PTC_EPOCH_CALLBACK_MAX_FRAME_BYTES_ENV}`),
    );
  }
});

async function withBridgeSession<T>(
  args: {
    createResult?: PtcSessionDockerCommandResult;
    commandResult?: (
      invocation: PtcSessionDockerCommandInvocation,
    ) =>
      | PtcSessionDockerCommandResult
      | undefined
      | Promise<PtcSessionDockerCommandResult | undefined>;
  },
  fn: (fixture: PtcSessionDockerManagerFixture) => Promise<T>,
): Promise<T> {
  return await withRealPtcSessionDockerManager(
    {
      identity: IDENTITY,
      ...(args.createResult === undefined
        ? {}
        : { createResult: args.createResult }),
      ...(args.commandResult === undefined
        ? {}
        : { commandResult: args.commandResult }),
    },
    fn,
  );
}

void test('createPtcSessionEpochBridge requires explicit policy before opening the default callback channel', async () => {
  await withBridgeSession({}, async ({ manager, invocations }) => {
    const result = await createPtcSessionEpochBridge({
      identity: IDENTITY,
      sessionManager: manager,
      callbackHandler: async () => ({ ok: true, result: null }),
    });

    assert.deepEqual(result, {
      ok: false,
      reasonCode: 'callback_channel_failed',
      message: 'PTC epoch callback transport policy is required',
      diagnostics: { callbackTransportPolicyRequired: true },
    });
    assert.deepEqual(invocations, []);
  });
});

void test('createPtcSessionEpochBridge creates callback channel under session root and projects container socket path', async () => {
  await withBridgeSession({}, async ({ manager }) => {
    let hostRoot = '';
    let hostSocketPath = '';
    let closeCount = 0;

    const callbackFactory: PtcEpochCallbackChannelFactory = async (args) => {
      hostRoot = args.rootDir;
      hostSocketPath = `${args.rootDir}/ptc-epoch-123/callback.sock`;
      return {
        epochId: 'epoch-123',
        token: 'token-abc',
        epochDir: `${args.rootDir}/ptc-epoch-123`,
        socketPath: hostSocketPath,
        close: async () => {
          closeCount += 1;
        },
      };
    };

    const bridge = await createPtcSessionEpochBridge({
      identity: IDENTITY,
      sessionManager: manager,
      callbackFactory,
      callbackHandler: async () => ({ ok: true, result: { kind: 'inline' } }),
    });

    if (!bridge.ok) {
      assert.fail(bridge.message);
    }
    assert.equal(
      bridge.value.containerId,
      PTC_TEST_SESSION_DOCKER_CONTAINER_ID,
    );
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

    await bridge.value.close();
    assert.equal(closeCount, 1);
  });
});

void test('createPtcSessionEpochBridge forwards AbortSignal to session manager', async () => {
  const controller = new AbortController();

  await withBridgeSession({}, async ({ manager, invocations }) => {
    const callbackFactory: PtcEpochCallbackChannelFactory = async (args) => ({
      epochId: 'epoch-signal',
      token: 'token-signal',
      epochDir: `${args.rootDir}/ptc-epoch-signal`,
      socketPath: `${args.rootDir}/ptc-epoch-signal/callback.sock`,
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
    assert.equal(
      invocations.every(
        (invocation) => invocation.signal === controller.signal,
      ),
      true,
    );
  });
});

void test('createPtcSessionEpochBridge reports callback channel failure diagnostics without leaking raw error text', async () => {
  await withBridgeSession({}, async ({ manager }) => {
    const callbackFactory: PtcEpochCallbackChannelFactory = async () => {
      const error = Object.assign(
        new Error('failed at /tmp/private/.geulbat/callback.sock'),
        { code: 'EACCES' },
      );
      error.name = 'SystemError';
      throw error;
    };

    const result = await createPtcSessionEpochBridge({
      identity: IDENTITY,
      sessionManager: manager,
      callbackFactory,
      callbackHandler: async () => ({ ok: true, result: null }),
    });

    if (result.ok) {
      assert.fail('expected callback channel failure');
    }
    assert.equal(result.reasonCode, 'callback_channel_failed');
    assert.deepEqual(result.diagnostics, {
      callbackChannelFailed: true,
      callbackChannelErrorName: 'SystemError',
      callbackChannelErrorCode: 'EACCES',
    });
    assert.doesNotMatch(
      JSON.stringify(result),
      /\.geulbat|\/tmp\/private|failed at/u,
    );
  });
});

void test('createPtcSessionEpochBridge closes callback channel when path projection fails', async () => {
  await withBridgeSession({}, async ({ manager }) => {
    let closeCount = 0;

    const callbackFactory: PtcEpochCallbackChannelFactory = async (args) => ({
      epochId: 'epoch-bad',
      token: 'token-bad',
      epochDir: `${args.rootDir}/ptc-epoch-bad`,
      socketPath: '/tmp/not-mounted/ptc-epoch-bad/callback.sock',
      close: async () => {
        closeCount += 1;
      },
    });

    const result = await createPtcSessionEpochBridge({
      identity: IDENTITY,
      sessionManager: manager,
      callbackFactory,
      callbackHandler: async () => ({ ok: true, result: null }),
    });

    if (result.ok) {
      assert.fail('expected callback path projection failure');
    }
    assert.equal(result.reasonCode, 'callback_path_projection_failed');
    assert.equal(closeCount, 1);
    assert.doesNotMatch(
      JSON.stringify(result),
      /\.geulbat|\/tmp\/not-mounted/u,
    );
  });
});

void test('createPtcSessionEpochBridge rejects escaped callback socket projections', async () => {
  const escapedSocketPathBuilders = [
    (rootDir: string) => `${rootDir}-sibling/ptc-epoch/callback.sock`,
    (rootDir: string) => `${rootDir}/../outside/callback.sock`,
    (rootDir: string) => rootDir,
  ];

  await withBridgeSession({}, async ({ manager }) => {
    for (const buildSocketPath of escapedSocketPathBuilders) {
      let closeCount = 0;
      const callbackFactory: PtcEpochCallbackChannelFactory = async (args) => ({
        epochId: 'epoch-escaped',
        token: 'token-escaped',
        epochDir: `${args.rootDir}/ptc-epoch-escaped`,
        socketPath: buildSocketPath(args.rootDir),
        close: async () => {
          closeCount += 1;
        },
      });

      const result = await createPtcSessionEpochBridge({
        identity: IDENTITY,
        sessionManager: manager,
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
});

void test('createPtcSessionEpochBridge maps session failures without leaking paths', async () => {
  await withBridgeSession(
    {
      createResult: {
        kind: 'exit',
        exitCode: 1,
        stdout: '',
        stderr: 'failed at /tmp/private/.geulbat/socket',
      },
    },
    async ({ manager }) => {
      const result = await createPtcSessionEpochBridge({
        identity: IDENTITY,
        sessionManager: manager,
        callbackPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
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
    },
  );
});

void test('bridge close is idempotent and does not close the long-lived session container', async () => {
  await withBridgeSession({}, async ({ manager, invocations }) => {
    let channelCloseCount = 0;
    const callbackFactory: PtcEpochCallbackChannelFactory = async (args) => ({
      epochId: 'epoch-close',
      token: 'token-close',
      epochDir: `${args.rootDir}/ptc-epoch-close`,
      socketPath: `${args.rootDir}/ptc-epoch-close/callback.sock`,
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
    assert.equal(
      invocations.some((invocation) => invocation.args[0] === 'rm'),
      false,
    );
  });
});
