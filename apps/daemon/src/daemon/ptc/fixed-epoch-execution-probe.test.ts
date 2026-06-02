import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createPtcEpochCallbackChannel,
  type PtcEpochCallbackHandlerInvocation,
} from './epoch-callback.js';
import {
  PTC_FIXED_EPOCH_EXECUTION_PROBE_CAPABILITY_ID,
  PTC_FIXED_EPOCH_EXECUTION_PROBE_POLICY_ID,
  PTC_FIXED_EPOCH_EXECUTION_PROBE_SCRIPT,
  runPtcFixedEpochExecutionProbe,
  type PtcSessionEpochBridgeFactory,
} from './fixed-epoch-execution-probe.js';
import {
  PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_ARTIFACT_WORKSPACE_MOUNT_POLICY_ID,
  PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_DEFAULT_POLICY,
  normalizePtcSessionDockerReuseKey,
  type PtcSessionDockerCommandInvocation,
  type PtcSessionDockerIdentity,
  type PtcSessionDockerManager,
  type PtcSessionDockerReuseKey,
} from './session-docker.js';
import type { PtcSessionEpochBridge } from './session-epoch-bridge.js';

const unixTest = process.platform === 'win32' ? test.skip : test;
const UNIX_SOCKET_TEMP_ROOT = process.platform === 'win32' ? tmpdir() : '/tmp';
const IDENTITY: PtcSessionDockerIdentity = Object.freeze({
  threadId: 'thread-fixed-probe',
  workspaceRoot: '/workspace/project-a',
  trustContextId: 'trust-local-v1',
});

void unixTest(
  'fixed PTC epoch probe script reaches epoch callback channel and prints compact JSON',
  async () => {
    const root = await mkdtemp(
      join(UNIX_SOCKET_TEMP_ROOT, 'geulbat-ptc-fixed-probe-'),
    );
    try {
      const invocations: PtcEpochCallbackHandlerInvocation[] = [];
      const channel = await createPtcEpochCallbackChannel({
        rootDir: root,
        owner: {
          threadId: 'thread-fixed-probe',
          workspaceRoot: '/workspace/fixed-probe',
          approvalScope: 'run',
        },
        handler: async (invocation) => {
          invocations.push(invocation);
          return { ok: true, result: { kind: 'inline', value: 'pong' } };
        },
      });

      try {
        const inputPath = join(channel.epochDir, 'fixed-probe-input.json');
        await writeFile(
          inputPath,
          JSON.stringify({
            schemaVersion: 1,
            socketPath: channel.socketPath,
            token: channel.token,
            requestId: 'ptc-fixed-probe-1',
          }),
          'utf8',
        );

        const result = await runNodeProbeScript(inputPath);

        assert.equal(result.exitCode, 0);
        assert.deepEqual(JSON.parse(result.stdout), {
          ok: true,
          callbackResultKind: 'inline',
        });
        assert.equal(invocations.length, 1);
        assert.equal(invocations[0]?.requestId, 'ptc-fixed-probe-1');
        assert.equal(invocations[0]?.kind, 'ptc_fixed_probe_echo');
        assert.deepEqual(invocations[0]?.args, { message: 'ping' });
        assert.doesNotMatch(result.stdout, new RegExp(channel.token));
        assert.doesNotMatch(
          result.stdout,
          /callback\.sock|geulbat-ptc-fixed-probe/u,
        );
      } finally {
        await channel.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

void unixTest(
  'runPtcFixedEpochExecutionProbe writes private input, runs fixed docker exec, and returns sanitized summary',
  async () => {
    const root = await mkdtemp(
      join(UNIX_SOCKET_TEMP_ROOT, 'geulbat-ptc-fixed-owner-'),
    );
    try {
      const epochDir = join(root, 'ptc-epoch-owned');
      await mkdir(epochDir, { recursive: true });
      const bridge = fakeBridge({
        epochDir,
        socketHostPath: join(epochDir, 'callback.sock'),
        socketContainerPath: `${PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT}/ptc-epoch-owned/callback.sock`,
      });
      let closeCount = 0;
      bridge.close = async () => {
        closeCount += 1;
      };
      const invocations: PtcSessionDockerCommandInvocation[] = [];

      const result = await runPtcFixedEpochExecutionProbe({
        identity: IDENTITY,
        sessionManager: fakeSessionManager(),
        bridgeFactory: async () => ({ ok: true, value: bridge }),
        commandRunner: async (invocation) => {
          invocations.push(invocation);
          assert.deepEqual(invocation.args.slice(0, 3), [
            'exec',
            'container-fixed-probe',
            'node',
          ]);
          assert.equal(invocation.args[3], '-e');
          assert.equal(
            invocation.args[4],
            PTC_FIXED_EPOCH_EXECUTION_PROBE_SCRIPT,
          );
          assert.equal(
            invocation.args[5],
            `${PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT}/ptc-epoch-owned/fixed-probe-input.json`,
          );
          assert.doesNotMatch(
            JSON.stringify(invocation.args),
            /token-fixed|callback\.sock/u,
          );
          return {
            kind: 'exit',
            exitCode: 0,
            stdout: '{"ok":true,"callbackResultKind":"inline"}\n',
            stderr: '',
          };
        },
      });

      if (!result.ok) {
        assert.fail(result.message);
      }
      assert.deepEqual(result.value, {
        ok: true,
        capabilityId: PTC_FIXED_EPOCH_EXECUTION_PROBE_CAPABILITY_ID,
        policyId: PTC_FIXED_EPOCH_EXECUTION_PROBE_POLICY_ID,
        executionClass: 'fixed_docker_exec_probe',
        executionSurface: 'baked_image_node_eval',
        containerId: 'container-fixed-probe',
        epochId: 'epoch-fixed-probe',
        callbackRoundTrip: 'observed',
        callbackResultKind: 'inline',
        exitCode: 0,
      });
      assert.equal(invocations.length, 1);
      assert.equal(closeCount, 1);

      const input = JSON.parse(
        await readFile(join(epochDir, 'fixed-probe-input.json'), 'utf8'),
      );
      assert.equal(input.schemaVersion, 1);
      assert.equal(
        input.socketPath,
        `${PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT}/ptc-epoch-owned/callback.sock`,
      );
      assert.equal(input.token, 'token-fixed');
      assert.equal(input.requestId, 'ptc-fixed-probe-1');
      assert.doesNotMatch(
        JSON.stringify(result),
        /token-fixed|callback\.sock|geulbat-ptc-fixed-owner/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

void unixTest(
  'runPtcFixedEpochExecutionProbe reaches the default fixed callback handler',
  async () => {
    const root = await mkdtemp(
      join(UNIX_SOCKET_TEMP_ROOT, 'geulbat-ptc-fixed-e2e-'),
    );
    try {
      const callbackRootHostPath = join(root, 'callbacks');
      await mkdir(callbackRootHostPath, { recursive: true });
      let channelCloseCount = 0;

      const bridgeFactory: PtcSessionEpochBridgeFactory = async (args) => {
        const channel = await createPtcEpochCallbackChannel({
          rootDir: callbackRootHostPath,
          owner: {
            threadId: IDENTITY.threadId,
            workspaceRoot: '/real/workspace/project-a',
            approvalScope: 'run',
          },
          handler: args.callbackHandler,
        });
        const epochName = channel.epochDir.split('/').at(-1);
        assert.ok(epochName);
        const reuseKey = fakeReuseKey();

        return {
          ok: true,
          value: {
            containerId: 'container-fixed-probe',
            epochId: channel.epochId,
            token: channel.token,
            callbackSocketHostPath: channel.socketPath,
            callbackSocketContainerPath: `${PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT}/${epochName}/callback.sock`,
            session: {
              state: 'ready' as const,
              containerId: 'container-fixed-probe',
              reuseKey,
              callbackRootHostPath,
              callbackRootContainerPath:
                PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT,
              artifactRootHostPath: join(root, 'artifacts'),
              artifactRootContainerPath:
                PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT,
              artifactWorkspaceMountPolicyId:
                PTC_SESSION_DOCKER_ARTIFACT_WORKSPACE_MOUNT_POLICY_ID,
              packageCacheRootHostPath: join(root, 'package-cache'),
              packageCacheRootContainerPath:
                reuseKey.packageCacheRootContainerPath,
              packageCacheMountPolicyId: reuseKey.packageCacheMountPolicyId,
              packageCacheId: reuseKey.packageCacheId,
              packageCacheIdentityHash: reuseKey.packageCacheIdentityHash,
            },
            close: async () => {
              channelCloseCount += 1;
              await channel.close();
            },
          },
        };
      };

      const result = await runPtcFixedEpochExecutionProbe({
        identity: IDENTITY,
        sessionManager: fakeSessionManager(),
        bridgeFactory,
        commandRunner: async (invocation) => {
          const containerInputPath = String(invocation.args[5] ?? '');
          const hostInputPath = containerInputPath.replace(
            `${PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT}/`,
            `${callbackRootHostPath}/`,
          );
          const localInput = JSON.parse(await readFile(hostInputPath, 'utf8'));
          const localInputPath = join(root, 'local-fixed-probe-input.json');
          await writeFile(
            localInputPath,
            JSON.stringify({
              ...localInput,
              socketPath: String(localInput.socketPath).replace(
                `${PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT}/`,
                `${callbackRootHostPath}/`,
              ),
            }),
            'utf8',
          );
          const scriptResult = await runNodeProbeScript(localInputPath);
          return {
            kind: 'exit',
            exitCode: scriptResult.exitCode,
            stdout: scriptResult.stdout,
            stderr: scriptResult.stderr,
          };
        },
      });

      if (!result.ok) {
        assert.fail(result.message);
      }
      assert.equal(result.value.callbackResultKind, 'inline');
      assert.equal(result.value.callbackRoundTrip, 'observed');
      assert.equal(channelCloseCount, 1);
      assert.doesNotMatch(
        JSON.stringify(result),
        /callback\.sock|geulbat-ptc-fixed-e2e/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

void unixTest(
  'runPtcFixedEpochExecutionProbe maps bridge failure without leaking bridge diagnostics',
  async () => {
    const result = await runPtcFixedEpochExecutionProbe({
      identity: IDENTITY,
      sessionManager: fakeSessionManager(),
      bridgeFactory: async () => ({
        ok: false,
        reasonCode: 'callback_path_projection_failed',
        message: 'failed at /tmp/private/.geulbat/callback.sock',
      }),
      commandRunner: async () => {
        assert.fail('command runner should not be called when bridge fails');
      },
    });

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.reasonCode, 'bridge_unavailable');
    assert.deepEqual(result.diagnostics, {
      bridgeReasonCode: 'callback_path_projection_failed',
    });
    assert.doesNotMatch(
      JSON.stringify(result),
      /\.geulbat|\/tmp\/private|callback\.sock/u,
    );
  },
);

void unixTest(
  'runPtcFixedEpochExecutionProbe classifies thrown bridge factory failures without raw error text',
  async () => {
    const result = await runPtcFixedEpochExecutionProbe({
      identity: IDENTITY,
      sessionManager: fakeSessionManager(),
      bridgeFactory: async () => {
        throw new Error('/tmp/private/.geulbat/callback.sock');
      },
      commandRunner: async () => {
        assert.fail(
          'command runner should not be called when bridge factory throws',
        );
      },
    });

    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.reasonCode, 'bridge_unavailable');
    assert.deepEqual(result.diagnostics, {
      bridgeReasonCode: 'bridge_factory_threw',
    });
    assert.doesNotMatch(
      JSON.stringify(result),
      /\.geulbat|callback\.sock|\/tmp\/private/u,
    );
  },
);

void unixTest(
  'runPtcFixedEpochExecutionProbe closes bridge and returns sanitized diagnostics on command failure',
  async () => {
    const root = await mkdtemp(
      join(UNIX_SOCKET_TEMP_ROOT, 'geulbat-ptc-fixed-failure-'),
    );
    try {
      const epochDir = join(root, 'ptc-epoch-failure');
      await mkdir(epochDir, { recursive: true });
      const bridge = fakeBridge({
        epochDir,
        socketHostPath: join(epochDir, 'callback.sock'),
        socketContainerPath: `${PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT}/ptc-epoch-failure/callback.sock`,
      });
      let closeCount = 0;
      bridge.close = async () => {
        closeCount += 1;
      };

      const result = await runPtcFixedEpochExecutionProbe({
        identity: IDENTITY,
        sessionManager: fakeSessionManager(),
        bridgeFactory: async () => ({ ok: true, value: bridge }),
        commandRunner: async () => ({
          kind: 'exit',
          exitCode: 42,
          stdout: 'token-fixed /tmp/private/.geulbat/callback.sock',
          stderr: 'socket failed',
        }),
      });

      assert.equal(result.ok, false);
      if (result.ok) {
        return;
      }
      assert.equal(result.reasonCode, 'execution_failed');
      assert.deepEqual(result.diagnostics, {
        commandResultKind: 'exit',
        exitCode: 42,
      });
      assert.equal(closeCount, 1);
      assert.doesNotMatch(
        JSON.stringify(result),
        /token-fixed|\.geulbat|callback\.sock|socket failed/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

void unixTest(
  'runPtcFixedEpochExecutionProbe classifies thrown command runner failures without raw error text',
  async () => {
    const root = await mkdtemp(
      join(UNIX_SOCKET_TEMP_ROOT, 'geulbat-ptc-fixed-throw-'),
    );
    try {
      const epochDir = join(root, 'ptc-epoch-throw');
      await mkdir(epochDir, { recursive: true });
      const result = await runPtcFixedEpochExecutionProbe({
        identity: IDENTITY,
        sessionManager: fakeSessionManager(),
        bridgeFactory: async () => ({
          ok: true,
          value: fakeBridge({
            epochDir,
            socketHostPath: join(epochDir, 'callback.sock'),
            socketContainerPath: `${PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT}/ptc-epoch-throw/callback.sock`,
          }),
        }),
        commandRunner: async () => {
          throw new Error('token-fixed /tmp/private/.geulbat/callback.sock');
        },
      });

      assert.equal(result.ok, false);
      if (result.ok) {
        return;
      }
      assert.equal(result.reasonCode, 'execution_failed');
      assert.deepEqual(result.diagnostics, { commandResultKind: 'thrown' });
      assert.doesNotMatch(
        JSON.stringify(result),
        /token-fixed|\.geulbat|callback\.sock/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

void unixTest(
  'runPtcFixedEpochExecutionProbe rejects invalid fixed probe stdout without leaking stdout',
  async () => {
    const root = await mkdtemp(
      join(UNIX_SOCKET_TEMP_ROOT, 'geulbat-ptc-fixed-invalid-'),
    );
    try {
      const epochDir = join(root, 'ptc-epoch-invalid');
      await mkdir(epochDir, { recursive: true });
      const result = await runPtcFixedEpochExecutionProbe({
        identity: IDENTITY,
        sessionManager: fakeSessionManager(),
        bridgeFactory: async () => ({
          ok: true,
          value: fakeBridge({
            epochDir,
            socketHostPath: join(epochDir, 'callback.sock'),
            socketContainerPath: `${PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT}/ptc-epoch-invalid/callback.sock`,
          }),
        }),
        commandRunner: async () => ({
          kind: 'exit',
          exitCode: 0,
          stdout: 'not-json token-fixed /tmp/private/.geulbat',
          stderr: '',
        }),
      });

      assert.equal(result.ok, false);
      if (result.ok) {
        return;
      }
      assert.equal(result.reasonCode, 'probe_output_invalid');
      assert.doesNotMatch(
        JSON.stringify(result),
        /not-json|token-fixed|\.geulbat/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

void unixTest(
  'runPtcFixedEpochExecutionProbe rejects multiline fixed probe stdout without leaking stdout',
  async () => {
    const root = await mkdtemp(
      join(UNIX_SOCKET_TEMP_ROOT, 'geulbat-ptc-fixed-multiline-'),
    );
    try {
      const epochDir = join(root, 'ptc-epoch-multiline');
      await mkdir(epochDir, { recursive: true });
      const result = await runPtcFixedEpochExecutionProbe({
        identity: IDENTITY,
        sessionManager: fakeSessionManager(),
        bridgeFactory: async () => ({
          ok: true,
          value: fakeBridge({
            epochDir,
            socketHostPath: join(epochDir, 'callback.sock'),
            socketContainerPath: `${PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT}/ptc-epoch-multiline/callback.sock`,
          }),
        }),
        commandRunner: async () => ({
          kind: 'exit',
          exitCode: 0,
          stdout:
            '{"ok":true,"callbackResultKind":"inline"}\n{"token":"token-fixed"}',
          stderr: '',
        }),
      });

      assert.equal(result.ok, false);
      if (result.ok) {
        return;
      }
      assert.equal(result.reasonCode, 'probe_output_invalid');
      assert.doesNotMatch(
        JSON.stringify(result),
        /token-fixed|callbackResultKind/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

void unixTest(
  'runPtcFixedEpochExecutionProbe surfaces only stable probe error code on failed fixed probe result',
  async () => {
    const root = await mkdtemp(
      join(UNIX_SOCKET_TEMP_ROOT, 'geulbat-ptc-fixed-probe-failed-'),
    );
    try {
      const epochDir = join(root, 'ptc-epoch-probe-failed');
      await mkdir(epochDir, { recursive: true });
      const result = await runPtcFixedEpochExecutionProbe({
        identity: IDENTITY,
        sessionManager: fakeSessionManager(),
        bridgeFactory: async () => ({
          ok: true,
          value: fakeBridge({
            epochDir,
            socketHostPath: join(epochDir, 'callback.sock'),
            socketContainerPath: `${PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT}/ptc-epoch-probe-failed/callback.sock`,
          }),
        }),
        commandRunner: async () => ({
          kind: 'exit',
          exitCode: 0,
          stdout:
            '{"ok":false,"errorCode":"callback_connection_failed","message":"token-fixed /tmp/private/.geulbat/callback.sock"}\n',
          stderr: '',
        }),
      });

      assert.equal(result.ok, false);
      if (result.ok) {
        return;
      }
      assert.equal(result.reasonCode, 'probe_result_failed');
      assert.deepEqual(result.diagnostics, {
        probeErrorCode: 'callback_connection_failed',
      });
      assert.doesNotMatch(
        JSON.stringify(result),
        /token-fixed|\.geulbat|callback\.sock/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

void unixTest(
  'runPtcFixedEpochExecutionProbe fails closed when the private probe input file already exists',
  async () => {
    const root = await mkdtemp(
      join(UNIX_SOCKET_TEMP_ROOT, 'geulbat-ptc-fixed-input-exists-'),
    );
    try {
      const epochDir = join(root, 'ptc-epoch-input-exists');
      await mkdir(epochDir, { recursive: true });
      await writeFile(
        join(epochDir, 'fixed-probe-input.json'),
        'existing secret',
        {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        },
      );
      const bridge = fakeBridge({
        epochDir,
        socketHostPath: join(epochDir, 'callback.sock'),
        socketContainerPath: `${PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT}/ptc-epoch-input-exists/callback.sock`,
      });
      let closeCount = 0;
      bridge.close = async () => {
        closeCount += 1;
      };

      const result = await runPtcFixedEpochExecutionProbe({
        identity: IDENTITY,
        sessionManager: fakeSessionManager(),
        bridgeFactory: async () => ({ ok: true, value: bridge }),
        commandRunner: async () => {
          assert.fail(
            'command runner should not be called when input write fails',
          );
        },
      });

      assert.equal(result.ok, false);
      if (result.ok) {
        return;
      }
      assert.equal(result.reasonCode, 'probe_input_write_failed');
      assert.equal(closeCount, 1);
      assert.doesNotMatch(
        JSON.stringify(result),
        /existing secret|token-fixed|callback\.sock/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

async function runNodeProbeScript(inputPath: string): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '-e',
      PTC_FIXED_EPOCH_EXECUTION_PROBE_SCRIPT,
      inputPath,
    ]);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, stdout: stdout.trim(), stderr });
    });
  });
}

function fakeSessionManager(): PtcSessionDockerManager {
  return {
    getOrCreate: async () => {
      throw new Error(
        'bridgeFactory should own session acquisition in this test',
      );
    },
    close: async () => ({ ok: true, value: undefined }),
    closeAll: async () => ({ ok: true, value: undefined }),
  };
}

function fakeBridge(args: {
  epochDir: string;
  socketHostPath: string;
  socketContainerPath: string;
}): PtcSessionEpochBridge {
  const reuseKey = fakeReuseKey();
  return {
    containerId: 'container-fixed-probe',
    epochId: 'epoch-fixed-probe',
    token: 'token-fixed',
    callbackSocketHostPath: args.socketHostPath,
    callbackSocketContainerPath: args.socketContainerPath,
    session: {
      state: 'ready' as const,
      containerId: 'container-fixed-probe',
      reuseKey,
      callbackRootHostPath: join(args.epochDir, '..'),
      callbackRootContainerPath: PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT,
      artifactRootHostPath: join(args.epochDir, '..', '..', 'artifacts'),
      artifactRootContainerPath: PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT,
      artifactWorkspaceMountPolicyId:
        PTC_SESSION_DOCKER_ARTIFACT_WORKSPACE_MOUNT_POLICY_ID,
      packageCacheRootHostPath: join(
        args.epochDir,
        '..',
        '..',
        'package-cache',
      ),
      packageCacheRootContainerPath: reuseKey.packageCacheRootContainerPath,
      packageCacheMountPolicyId: reuseKey.packageCacheMountPolicyId,
      packageCacheId: reuseKey.packageCacheId,
      packageCacheIdentityHash: reuseKey.packageCacheIdentityHash,
    },
    close: async () => {},
  };
}

function fakeReuseKey(): PtcSessionDockerReuseKey {
  return normalizePtcSessionDockerReuseKey({
    identity: IDENTITY,
    workspaceRootRealpath: '/real/workspace/project-a',
    policy: PTC_SESSION_DOCKER_DEFAULT_POLICY,
  });
}
