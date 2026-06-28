import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  readPtcSessionDockerBindMountHostPath,
  withRealPtcSessionDockerManager,
} from '../../../../test-support/ptc-session-docker.js';
import {
  createPtcEpochCallbackChannel,
  type PtcEpochCallbackHandlerInvocation,
} from '../../callback/epoch-callback.js';
import {
  PTC_FIXED_EPOCH_EXECUTION_PROBE_SCRIPT,
  runPtcFixedEpochExecutionProbe,
  type RunPtcFixedEpochExecutionProbeArgs,
} from './fixed-epoch-execution-probe.js';
import {
  PTC_FIXED_EPOCH_EXECUTION_PROBE_CAPABILITY_ID,
  PTC_FIXED_EPOCH_EXECUTION_PROBE_POLICY_ID,
} from './fixed-probe-runtime-contract.js';
import { PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT } from '../../lab/session/session-docker-contract.js';
import type {
  PtcSessionDockerCommandInvocation,
  PtcSessionDockerCommandResult,
  PtcSessionDockerIdentity,
  PtcSessionDockerManager,
} from '../../lab/session/session-docker-contract.js';
import { createPtcSessionEpochBridge } from '../../callback/session-epoch-bridge.js';

const unixTest = process.platform === 'win32' ? test.skip : test;
const UNIX_SOCKET_TEMP_ROOT = process.platform === 'win32' ? tmpdir() : '/tmp';
const IDENTITY: PtcSessionDockerIdentity = Object.freeze({
  threadId: 'thread-fixed-probe',
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

async function withFixedProbeSession<T>(
  args: {
    commandResult?: (context: {
      callbackRootHostPath: string;
      invocation: PtcSessionDockerCommandInvocation;
    }) =>
      | PtcSessionDockerCommandResult
      | undefined
      | Promise<PtcSessionDockerCommandResult | undefined>;
  },
  fn: (fixture: {
    callbackRootHostPath(): string;
    manager: PtcSessionDockerManager;
    runner: (
      invocation: PtcSessionDockerCommandInvocation,
    ) => Promise<PtcSessionDockerCommandResult>;
  }) => Promise<T>,
): Promise<T> {
  let callbackRootHostPath = '';
  return await withRealPtcSessionDockerManager(
    {
      identity: IDENTITY,
      containerId: 'container-fixed-probe',
      commandResult: async (invocation) => {
        if (invocation.args[0] === 'create') {
          callbackRootHostPath = readPtcSessionDockerBindMountHostPath(
            invocation,
            PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT,
          );
          return undefined;
        }
        if (invocation.args[0] !== 'exec') {
          return undefined;
        }
        assert.equal(callbackRootHostPath.length > 0, true);
        return await args.commandResult?.({ callbackRootHostPath, invocation });
      },
    },
    async ({ manager, runner }) =>
      await fn({
        callbackRootHostPath: () => callbackRootHostPath,
        manager,
        runner,
      }),
  );
}

async function readProbeInputForExec(args: {
  callbackRootHostPath: string;
  invocation: PtcSessionDockerCommandInvocation;
}): Promise<{
  containerInputPath: string;
  hostInputPath: string;
  input: Record<string, unknown>;
}> {
  assert.deepEqual(args.invocation.args.slice(0, 5), [
    'exec',
    'container-fixed-probe',
    'node',
    '-e',
    PTC_FIXED_EPOCH_EXECUTION_PROBE_SCRIPT,
  ]);
  const containerInputPath = String(args.invocation.args[5] ?? '');
  assert.match(
    containerInputPath,
    new RegExp(`^${PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT}/`),
  );
  const hostInputPath = containerInputPath.replace(
    `${PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT}/`,
    `${args.callbackRootHostPath}/`,
  );
  return {
    containerInputPath,
    hostInputPath,
    input: JSON.parse(await readFile(hostInputPath, 'utf8')) as Record<
      string,
      unknown
    >,
  };
}

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
    let observedInput:
      | { containerInputPath: string; input: Record<string, unknown> }
      | undefined;

    await withFixedProbeSession(
      {
        commandResult: async ({ callbackRootHostPath, invocation }) => {
          assert.equal(invocation.timeoutMs, undefined);
          const probeInput = await readProbeInputForExec({
            callbackRootHostPath,
            invocation,
          });
          observedInput = {
            containerInputPath: probeInput.containerInputPath,
            input: probeInput.input,
          };
          assert.doesNotMatch(
            JSON.stringify(invocation.args),
            /callback\.sock/u,
          );
          return {
            kind: 'exit',
            exitCode: 0,
            stdout: '{"ok":true,"callbackResultKind":"inline"}\n',
            stderr: '',
          };
        },
      },
      async ({ manager, runner, callbackRootHostPath }) => {
        const result = await runPtcFixedEpochExecutionProbe({
          identity: IDENTITY,
          sessionManager: manager,
          callbackPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
          commandRunner: runner,
        });

        if (!result.ok) {
          assert.fail(result.message);
        }
        assert.equal(result.value.ok, true);
        assert.equal(
          result.value.capabilityId,
          PTC_FIXED_EPOCH_EXECUTION_PROBE_CAPABILITY_ID,
        );
        assert.equal(
          result.value.policyId,
          PTC_FIXED_EPOCH_EXECUTION_PROBE_POLICY_ID,
        );
        assert.equal(result.value.executionClass, 'fixed_docker_exec_probe');
        assert.equal(result.value.executionSurface, 'baked_image_node_eval');
        assert.equal(result.value.containerId, 'container-fixed-probe');
        assert.match(result.value.epochId, /^[a-f0-9]{16}$/u);
        assert.equal(result.value.callbackRoundTrip, 'observed');
        assert.equal(result.value.callbackResultKind, 'inline');
        assert.equal(result.value.exitCode, 0);
        assert.deepEqual(observedInput?.input, {
          schemaVersion: 1,
          socketPath: observedInput?.containerInputPath.replace(
            /\/fixed-probe-input\.json$/u,
            '/callback.sock',
          ),
          token: observedInput?.input.token,
          requestId: 'ptc-fixed-probe-1',
        });
        assert.equal(typeof observedInput?.input.token, 'string');
        const serialized = JSON.stringify(result);
        assert.equal(serialized.includes(callbackRootHostPath()), false);
        assert.doesNotMatch(serialized, /callback\.sock/u);
      },
    );
  },
);

void unixTest(
  'runPtcFixedEpochExecutionProbe reaches the default fixed callback handler',
  async () => {
    await withFixedProbeSession(
      {
        commandResult: async ({ callbackRootHostPath, invocation }) => {
          const { hostInputPath, input } = await readProbeInputForExec({
            callbackRootHostPath,
            invocation,
          });
          const localInputPath = join(
            callbackRootHostPath,
            'local-fixed-probe-input.json',
          );
          await writeFile(
            localInputPath,
            JSON.stringify({
              ...input,
              socketPath: String(input.socketPath).replace(
                `${PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT}/`,
                `${callbackRootHostPath}/`,
              ),
            }),
            'utf8',
          );
          assert.notEqual(hostInputPath, localInputPath);
          const scriptResult = await runNodeProbeScript(localInputPath);
          return {
            kind: 'exit',
            exitCode: scriptResult.exitCode,
            stdout: scriptResult.stdout,
            stderr: scriptResult.stderr,
          };
        },
      },
      async ({ manager, runner, callbackRootHostPath }) => {
        const result = await runPtcFixedEpochExecutionProbe({
          identity: IDENTITY,
          sessionManager: manager,
          callbackPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
          commandRunner: runner,
        });

        if (!result.ok) {
          assert.fail(result.message);
        }
        assert.equal(result.value.callbackResultKind, 'inline');
        assert.equal(result.value.callbackRoundTrip, 'observed');
        assert.match(result.value.epochId, /^[a-f0-9]{16}$/u);
        const serialized = JSON.stringify(result);
        assert.equal(serialized.includes(callbackRootHostPath()), false);
        assert.doesNotMatch(serialized, /callback\.sock/u);
      },
    );
  },
);

void unixTest(
  'runPtcFixedEpochExecutionProbe maps bridge failure without leaking bridge diagnostics',
  async () => {
    const result = await runPtcFixedEpochExecutionProbe({
      identity: IDENTITY,
      sessionManager: unusedSessionManager(),
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
      sessionManager: unusedSessionManager(),
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
    await withFixedProbeSession(
      {
        commandResult: () => ({
          kind: 'exit',
          exitCode: 42,
          stdout: 'token-fixed /tmp/private/.geulbat/callback.sock',
          stderr: 'socket failed',
        }),
      },
      async ({ manager, runner }) => {
        const result = await runPtcFixedEpochExecutionProbe({
          identity: IDENTITY,
          sessionManager: manager,
          callbackPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
          commandRunner: runner,
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
        assert.doesNotMatch(
          JSON.stringify(result),
          /token-fixed|\.geulbat|callback\.sock|socket failed/u,
        );
      },
    );
  },
);

void unixTest(
  'runPtcFixedEpochExecutionProbe classifies thrown command runner failures without raw error text',
  async () => {
    await withFixedProbeSession(
      {
        commandResult: () => {
          throw new Error('token-fixed /tmp/private/.geulbat/callback.sock');
        },
      },
      async ({ manager, runner }) => {
        const result = await runPtcFixedEpochExecutionProbe({
          identity: IDENTITY,
          sessionManager: manager,
          callbackPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
          commandRunner: runner,
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
      },
    );
  },
);

void unixTest(
  'runPtcFixedEpochExecutionProbe rejects invalid fixed probe stdout without leaking stdout',
  async () => {
    await withFixedProbeSession(
      {
        commandResult: () => ({
          kind: 'exit',
          exitCode: 0,
          stdout: 'not-json token-fixed /tmp/private/.geulbat',
          stderr: '',
        }),
      },
      async ({ manager, runner }) => {
        const result = await runPtcFixedEpochExecutionProbe({
          identity: IDENTITY,
          sessionManager: manager,
          callbackPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
          commandRunner: runner,
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
      },
    );
  },
);

void unixTest(
  'runPtcFixedEpochExecutionProbe rejects multiline fixed probe stdout without leaking stdout',
  async () => {
    await withFixedProbeSession(
      {
        commandResult: () => ({
          kind: 'exit',
          exitCode: 0,
          stdout:
            '{"ok":true,"callbackResultKind":"inline"}\n{"token":"token-fixed"}',
          stderr: '',
        }),
      },
      async ({ manager, runner }) => {
        const result = await runPtcFixedEpochExecutionProbe({
          identity: IDENTITY,
          sessionManager: manager,
          callbackPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
          commandRunner: runner,
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
      },
    );
  },
);

void unixTest(
  'runPtcFixedEpochExecutionProbe surfaces only stable probe error code on failed fixed probe result',
  async () => {
    await withFixedProbeSession(
      {
        commandResult: () => ({
          kind: 'exit',
          exitCode: 0,
          stdout:
            '{"ok":false,"errorCode":"callback_connection_failed","message":"token-fixed /tmp/private/.geulbat/callback.sock"}\n',
          stderr: '',
        }),
      },
      async ({ manager, runner }) => {
        const result = await runPtcFixedEpochExecutionProbe({
          identity: IDENTITY,
          sessionManager: manager,
          callbackPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
          commandRunner: runner,
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
      },
    );
  },
);

void unixTest(
  'runPtcFixedEpochExecutionProbe fails closed when the private probe input file already exists',
  async () => {
    let closeCount = 0;

    await withFixedProbeSession({}, async ({ manager }) => {
      const bridgeFactory: NonNullable<
        RunPtcFixedEpochExecutionProbeArgs['bridgeFactory']
      > = async (args) => {
        const bridge = await createPtcSessionEpochBridge(args);
        if (!bridge.ok) {
          return bridge;
        }
        await writeFile(
          join(
            dirname(bridge.value.callbackSocketHostPath),
            'fixed-probe-input.json',
          ),
          'existing secret',
          {
            encoding: 'utf8',
            mode: 0o600,
            flag: 'wx',
          },
        );
        const close = bridge.value.close;
        bridge.value.close = async () => {
          closeCount += 1;
          await close();
        };
        return bridge;
      };

      const result = await runPtcFixedEpochExecutionProbe({
        identity: IDENTITY,
        sessionManager: manager,
        callbackPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
        bridgeFactory,
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
        /existing secret|callback\.sock/u,
      );
    });
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

function unusedSessionManager(): PtcSessionDockerManager {
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
