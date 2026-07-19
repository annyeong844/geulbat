import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createPtcSessionDockerCommandFixture,
  PTC_TEST_SESSION_DOCKER_CONTAINER_ID,
  readPtcSessionDockerBindMountHostPath,
} from '../../../../test-support/ptc-session-docker.js';
import { testThreadId } from '../../../../test-support/thread-id.js';
import { makeRunContext } from '../../../../test-support/run-context.js';
import {
  PTC_EXECUTE_CODE_TOOL_NAME,
  type PtcExecuteCodeModuleFormat,
  type PtcExecuteCodeRuntimeSdkProjection,
} from './execute-code-runtime-contract.js';
import { createPtcExecuteCodeRuntime } from './execute-code-runtime.js';
import { PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_MAX_COMMAND_MS } from '../../lab/profile/lab-profile-contract.js';
import {
  createPtcSessionDockerLocalBatchCommandPolicy,
  PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_SDK_PROJECTION_MOUNT_POLICY_ID,
  type PtcSessionDockerManager,
} from '../../lab/session/session-docker-contract.js';
import { runPtcSessionDockerCommand } from '../../lab/session/session-docker-command.js';
import type { PtcSessionDockerCommandInvocation } from '../../lab/session/session-docker-contract.js';
import { buildToolLibraryProjection } from '../../../tools/tool-library-projection.js';
import { createBuiltinToolRegistryStore } from '../../../tools/builtin/catalog.js';

const PRIVATE_TEST_PATH = '/tmp/geulbat-private/.geulbat/ptc/private-token';
const TEST_CALLBACK_TRANSPORT_POLICY = Object.freeze({
  maxFrameBytes: 8192,
  maxOpenConnections: 4,
  maxCallbacks: 20,
  callbackTimeoutMs: 30_000,
  maxResponseBytes: 8192,
});

void test('createPtcExecuteCodeRuntime rejects unknown module formats before opening runtime state', async () => {
  const runtime = createPtcExecuteCodeRuntime();
  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(899),
        stateRoot: '/unused/invalid-module-format',
      }),
      request: {
        code: 'console.log("must not run")',
        moduleFormat: 'amd' as PtcExecuteCodeModuleFormat,
      },
    });
    assert.deepEqual(result, {
      ok: false,
      reasonCode: 'ptc_execute_code_invalid',
      message: 'PTC execute_code module format is invalid',
    });
  } finally {
    await runtime.closeAll();
  }
});

void test('createPtcExecuteCodeRuntime delegates restart residue cleanup without starting a session', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-restart-cleanup-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-restart-cleanup-runtime-'),
  );
  let reapCount = 0;
  let closeAllCount = 0;
  const sessionManager: PtcSessionDockerManager = {
    async reapRestartResidue() {
      reapCount += 1;
      return { ok: true, value: undefined };
    },
    async getOrCreate() {
      throw new Error('restart cleanup must not start a session');
    },
    async close() {
      return { ok: true, value: undefined };
    },
    async closeAll() {
      closeAllCount += 1;
      return { ok: true, value: undefined };
    },
  };
  const runtime = createPtcExecuteCodeRuntime({
    createSessionManager: () => sessionManager,
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    assert.deepEqual(await runtime.reapRestartResidue?.({ stateRoot }), {
      ok: true,
    });
    assert.equal(reapCount, 1);
  } finally {
    await runtime.closeAll();
    assert.equal(closeAllCount, 1);
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime runs model code through lab batch command without raw shell interpolation', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-runtime-'),
  );
  const code = 'console.log("hello from execute_code; $(touch /host-owned)")';
  const observedModuleInputTypes: string[] = [];
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code',
    commandResult: (invocation) => {
      if (invocation.args[0] === 'exec') {
        assertLabNodeExec(invocation);
        assert.equal(invocation.timeoutMs, 1234);
        const command = invocation.args[4];
        assert.ok(typeof command === 'string');
        assert.match(command, /GEULBAT_PTC_RUNNER_B64/u);
        if (command.includes('--input-type=module-typescript')) {
          observedModuleInputTypes.push('esm');
        } else {
          assert.match(command, /--input-type=commonjs-typescript/u);
          observedModuleInputTypes.push('commonjs');
        }
        assert.doesNotMatch(command, /touch \/host-owned/u);
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'hello from execute_code\n',
          stderr: '',
        };
      }
      return undefined;
    },
  });
  const runtime = createPtcExecuteCodeRuntime({
    callbackTransportPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
    commandRunner: fixture.runner,
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(901),
        stateRoot,
      }),
      request: { code, timeoutMs: 1234 },
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.capabilityId, PTC_EXECUTE_CODE_TOOL_NAME);
    assert.equal(result.value.policyId, 'ptc_lab_execute_code_batch_node_v1');
    assert.equal(result.value.executionSurface, 'node_via_lab_batch_command');
    assert.equal(result.value.stdout, 'hello from execute_code\n');
    assert.deepEqual(result.value.toolCallbacks, {
      enabled: false,
      observed: 0,
    });
    assert.deepEqual(result.value.sessionLifecycle, {
      mode: 'runtime_owned_reusable',
      retainedAfterExecution: true,
    });
    assert.deepEqual(result.value.callbackHelp, {
      protocolVersion: 'ptc_execute_code_sdk_v1',
      helpAvailable: true,
      callbackToolCount: 0,
    });
    const esmResult = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(901),
        stateRoot,
      }),
      request: {
        code: "import { basename } from 'node:path'; process.stdout.write(basename('/tmp/esm'));",
        moduleFormat: 'esm',
        timeoutMs: 1234,
      },
    });
    assert.equal(esmResult.ok, true);
    assert.deepEqual(observedModuleInputTypes, ['commonjs', 'esm']);
    assert.equal(JSON.stringify(result).includes('container-agent'), false);
    assert.deepEqual(
      fixture.invocations
        .filter((invocation) => invocation.args[0] === 'rm')
        .map((invocation) => invocation.args),
      [],
    );
    const cleanup = await runtime.closeAll();
    assert.equal(cleanup.ok, true);
    assert.deepEqual(
      fixture.invocations
        .filter((invocation) => invocation.args[0] === 'rm')
        .map((invocation) => invocation.args),
      [['rm', '-f', 'container-agent-ptc-execute-code']],
    );
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime keeps callback tools disabled when no callback transport policy is configured', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-no-callback-policy-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-no-callback-policy-runtime-'),
  );
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-no-callback-policy',
    commandResult: (invocation) => {
      if (invocation.args[0] === 'exec') {
        const command = invocation.args[4];
        assert.ok(typeof command === 'string');
        assert.match(command, /GEULBAT_PTC_RUNNER_B64/u);
        assert.doesNotMatch(command, /callback\.sock|read_file/u);
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'no callback policy\n',
          stderr: '',
        };
      }
      return undefined;
    },
  });
  const runtime = createPtcExecuteCodeRuntime({
    commandRunner: fixture.runner,
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(9011),
        stateRoot,
      }),
      request: { code: 'console.log("no callback policy")' },
      sdkHelp: {
        callbackTools: [
          {
            name: 'read_file',
            description: 'Read a computer file.',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
              additionalProperties: false,
            },
          },
        ],
      },
      toolCallbackHandler: async () => {
        assert.fail('callback handler should not be reachable without policy');
      },
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.deepEqual(result.value.toolCallbacks, {
      enabled: false,
      observed: 0,
    });
    assert.deepEqual(result.value.callbackHelp, {
      protocolVersion: 'ptc_execute_code_sdk_v1',
      helpAvailable: true,
      callbackToolCount: 0,
    });
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime reuses a clean session until explicit runtime cleanup', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-reuse-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-reuse-runtime-'),
  );
  let execCount = 0;
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-reuse',
    commandResult: (invocation) => {
      if (invocation.args[0] === 'exec') {
        execCount += 1;
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: `run ${execCount}\n`,
          stderr: '',
        };
      }
      return undefined;
    },
  });
  const runtime = createPtcExecuteCodeRuntime({
    callbackTransportPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
    commandRunner: fixture.runner,
    runtimeRootForState: () => runtimeRoot,
  });
  const runContext = makeRunContext({
    threadId: testThreadId(905),
    stateRoot,
  });

  try {
    const first = await runtime.executeCode({
      runContext,
      request: { code: 'console.log("first")' },
    });
    const second = await runtime.executeCode({
      runContext,
      request: { code: 'console.log("second")' },
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) {
      return;
    }
    assert.equal(first.value.stdout, 'run 1\n');
    assert.equal(second.value.stdout, 'run 2\n');
    assert.deepEqual(first.value.sessionLifecycle, {
      mode: 'runtime_owned_reusable',
      retainedAfterExecution: true,
    });
    assert.equal(
      fixture.invocations.filter(
        (invocation) => invocation.args[0] === 'create',
      ).length,
      1,
    );
    assert.equal(
      fixture.invocations.filter((invocation) => invocation.args[0] === 'start')
        .length,
      1,
    );
    assert.equal(
      fixture.invocations.filter((invocation) => invocation.args[0] === 'exec')
        .length,
      2,
    );
    assert.equal(
      fixture.invocations.filter((invocation) => invocation.args[0] === 'rm')
        .length,
      0,
    );

    const cleanup = await runtime.closeAll();
    assert.equal(cleanup.ok, true);
    assert.deepEqual(
      fixture.invocations
        .filter((invocation) => invocation.args[0] === 'rm')
        .map((invocation) => invocation.args),
      [['rm', '-f', 'container-agent-ptc-execute-code-reuse']],
    );
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime preserves callback bridge session diagnostics', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-bridge-diagnostics-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-bridge-diagnostics-runtime-'),
  );
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-bridge-diagnostics',
  });
  const runtime = createPtcExecuteCodeRuntime({
    callbackTransportPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
    commandRunner: fixture.runner,
    createEpochBridge: async () => ({
      ok: false,
      reasonCode: 'session_unavailable',
      message: 'PTC session container is unavailable',
      diagnostics: { sessionReasonCode: 'docker_unavailable' },
    }),
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(950),
        stateRoot,
      }),
      request: { code: 'console.log("bridge diagnostics")' },
      toolCallbackHandler: async () => ({
        ok: true,
        result: { ok: true, output: '' },
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(
      result.ok ? '' : result.reasonCode,
      'ptc_execute_code_callback_bridge_unavailable',
    );
    assert.deepEqual(result.ok ? undefined : result.diagnostics, {
      sessionReasonCode: 'docker_unavailable',
      bridgeReasonCode: 'session_unavailable',
    });
    assert.equal(fixture.invocations.length, 0);
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime clears state runtime tracking after closeAll failure', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-closeall-failure-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-closeall-failure-runtime-'),
  );
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-closeall-failure',
    commandResult: (invocation) => {
      if (invocation.args[0] === 'exec') {
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'closeAll failure setup\n',
          stderr: '',
        };
      }
      if (invocation.args[0] === 'rm') {
        return {
          kind: 'exit',
          exitCode: 1,
          stdout: '',
          stderr: 'remove failed',
        };
      }
      return undefined;
    },
  });
  const runtime = createPtcExecuteCodeRuntime({
    callbackTransportPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
    commandRunner: fixture.runner,
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(909),
        stateRoot,
      }),
      request: { code: 'console.log("closeAll failure setup")' },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(await runtime.closeAll(), {
      ok: false,
      reasonCode: 'ptc_execute_code_session_cleanup_failed',
      message: 'PTC execute_code session cleanup failed',
      diagnostics: {
        cleanupReasonCode: 'container_remove_failed',
        stateRuntimeCount: 1,
      },
    });
    assert.deepEqual(await runtime.closeAll(), { ok: true });
    assert.equal(
      fixture.invocations.filter((invocation) => invocation.args[0] === 'rm')
        .length,
      1,
    );
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime keys state runtimes by canonical state root realpath', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-realpath-workspace-'),
  );
  const stateRootAlias = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-realpath-alias-parent-'),
  );
  const stateRootAliasPath = join(stateRootAlias, 'state-root-link');
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-realpath-runtime-'),
  );
  await symlink(stateRoot, stateRootAliasPath, 'dir');
  const canonicalStateRoot = await realpath(stateRoot);
  const runtimeRootInputs: string[] = [];
  let execCount = 0;
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-realpath',
    commandResult: (invocation) => {
      if (invocation.args[0] === 'exec') {
        execCount += 1;
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: `realpath run ${execCount}\n`,
          stderr: '',
        };
      }
      return undefined;
    },
  });
  const runtime = createPtcExecuteCodeRuntime({
    commandRunner: fixture.runner,
    runtimeRootForState: (stateRootInput) => {
      runtimeRootInputs.push(stateRootInput);
      assert.equal(stateRootInput, canonicalStateRoot);
      return runtimeRoot;
    },
  });

  try {
    const first = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(907),
        stateRoot,
      }),
      request: { code: 'console.log("canonical")' },
    });
    const second = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(907),
        stateRoot: stateRootAliasPath,
      }),
      request: { code: 'console.log("alias")' },
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) {
      return;
    }
    assert.equal(first.value.stdout, 'realpath run 1\n');
    assert.equal(second.value.stdout, 'realpath run 2\n');
    assert.deepEqual(runtimeRootInputs, [canonicalStateRoot]);
    assert.equal(
      fixture.invocations.filter(
        (invocation) => invocation.args[0] === 'create',
      ).length,
      1,
    );
    assert.equal(
      fixture.invocations.filter((invocation) => invocation.args[0] === 'exec')
        .length,
      2,
    );
  } finally {
    await runtime.closeAll();
    await rm(stateRootAlias, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime returns user-code non-zero exit as a result summary', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-user-failure-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-user-failure-runtime-'),
  );
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    commandResult: (invocation) => {
      if (invocation.args[0] === 'exec') {
        return {
          kind: 'exit',
          exitCode: 1,
          stdout: '',
          stderr: 'Error: model-authored code threw\n',
        };
      }
      return undefined;
    },
  });
  const runtime = createPtcExecuteCodeRuntime({
    callbackTransportPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
    commandRunner: fixture.runner,
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(906),
        stateRoot,
      }),
      request: { code: 'throw new Error("model-authored code threw")' },
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.executionSurface, 'node_via_lab_batch_command');
    assert.equal(result.value.exitCode, 1);
    assert.equal(result.value.stderr, 'Error: model-authored code threw\n');
    assert.equal(result.value.sessionLifecycle.retainedAfterExecution, true);
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime exposes geulbat.callTool through an epoch callback socket without leaking callback secrets', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-callback-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-callback-runtime-'),
  );
  const shadowRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-sdk-shadow-'),
  );
  const sdkRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-sdk-projection-'),
  );
  await mkdir(join(shadowRoot, 'geulbat-sdk', 'files'), { recursive: true });
  await writeFile(
    join(shadowRoot, 'geulbat-sdk', 'files', 'readFile.js'),
    "module.exports = { readFile: async () => ({ kind: 'shadowed' }) };\n",
    'utf8',
  );
  const sdkProjection = await buildReadFileSdkProjection(sdkRoot);
  let callbackCount = 0;
  let fixture: ReturnType<typeof createPtcSessionDockerCommandFixture>;
  fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-callback',
    commandResult: async (invocation) => {
      if (invocation.args[0] === 'exec') {
        const command = invocation.args[4];
        assert.ok(typeof command === 'string');
        const localCommand = remapEncodedExecuteCodeCallbackRoot(
          command,
          readCallbackHostRoot(fixture.invocations),
          readPtcSessionDockerBindMountHostPath(
            [...fixture.invocations]
              .reverse()
              .find((candidate) => candidate.args[0] === 'create') ??
              assert.fail('expected Docker create invocation'),
            PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT,
          ),
        );
        return await runPtcSessionDockerCommand({
          executable: '/bin/bash',
          args: ['-c', localCommand],
          ...(invocation.timeoutMs === undefined
            ? {}
            : { timeoutMs: invocation.timeoutMs }),
          ...(invocation.signal ? { signal: invocation.signal } : {}),
        });
      }
      return undefined;
    },
  });
  const runtime = createPtcExecuteCodeRuntime({
    callbackTransportPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
    commandRunner: fixture.runner,
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(904),
        stateRoot,
      }),
      request: {
        code: [
          'const help = geulbat.help();',
          'console.log(help.protocolVersion);',
          'console.log(help.callbacks.tools.map((tool) => tool.name).join(","));',
          'console.log(help.sdkProjection.sdkVersion);',
          "const result = await geulbat.callTool('read_file', { path: 'note.txt' });",
          'console.log(JSON.parse(result.output).message);',
          "const aliasResult = await geulbat.tools.readFile({ path: 'note.txt' });",
          'console.log(JSON.parse(aliasResult.output).message);',
          `process.env.NODE_PATH = ${JSON.stringify(shadowRoot)};`,
          "require('node:module').Module._initPaths();",
          "const sdkSpecifier = require.resolve('geulbat-sdk/files/readFile');",
          'const sdk = require(sdkSpecifier);',
          'console.log(sdk.sdkVersion);',
          "const sdkResult = await sdk.readFile({ path: 'note.txt' });",
          'console.log(JSON.parse(sdkResult.value.output).message);',
          'console.log(`${typeof __geulbatCallbackToken}:${typeof __geulbatSdkProjection}`);',
          "console.log(process.env.GEULBAT_PTC_RUNNER_B64 ?? 'runner-env-hidden');",
          'console.log(process._eval);',
        ].join('\n'),
        timeoutMs: 5_000,
      },
      sdkHelp: {
        callbackTools: [
          {
            name: 'read_file',
            description: 'Read a computer file.',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
              additionalProperties: false,
            },
          },
        ],
      },
      sdkProjection,
      toolCallbackHandler: async (invocation) => {
        callbackCount += 1;
        assert.equal(invocation.toolName, 'read_file');
        assert.deepEqual(invocation.args, { path: 'note.txt' });
        assert.equal(typeof invocation.enterLongWait, 'function');
        assert.equal(invocation.enterLongWait?.(), true);
        return {
          ok: true,
          result: {
            ok: true,
            output: JSON.stringify({ message: 'callback says hello' }),
          },
        };
      },
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(callbackCount, 3);
    assert.equal(result.value.toolCallbacks.enabled, true);
    assert.equal(result.value.toolCallbacks.observed, 3);
    assert.deepEqual(result.value.sessionLifecycle, {
      mode: 'runtime_owned_reusable',
      retainedAfterExecution: true,
    });
    assert.deepEqual(result.value.callbackHelp, {
      protocolVersion: 'ptc_execute_code_sdk_v1',
      helpAvailable: true,
      callbackToolCount: 1,
    });
    assert.match(result.value.stdout, /ptc_execute_code_sdk_v1/u);
    assert.match(result.value.stdout, /read_file/u);
    assert.match(result.value.stdout, /geulbat-tool-library-sdk-v1/u);
    assert.match(result.value.stdout, /callback says hello/u);
    assert.match(result.value.stdout, /undefined:undefined/u);
    assert.match(result.value.stdout, /runner-env-hidden/u);
    assert.doesNotMatch(result.value.stdout, /shadowed/u);
    assert.doesNotMatch(
      result.value.stdout,
      /\/geulbat\/callbacks|callback\.sock|write_file/u,
    );
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
    await rm(shadowRoot, { recursive: true, force: true });
    await rm(sdkRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime rejects SDK protocol mismatch before session or callback work', async () => {
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
  });
  const runtime = createPtcExecuteCodeRuntime({
    callbackTransportPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
    commandRunner: fixture.runner,
    runtimeRootForState: () => '/tmp/geulbat-ptc-sdk-mismatch-runtime',
  });
  let callbackCount = 0;
  const sdkRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-sdk-mismatch-projection-'),
  );
  const sdkProjection = await buildReadFileSdkProjection(sdkRoot);

  const result = await runtime.executeCode({
    runContext: makeRunContext({
      threadId: testThreadId(9041),
      stateRoot: '/tmp/geulbat-ptc-sdk-mismatch-workspace',
    }),
    request: { code: 'return "must-not-run";' },
    sdkProjection: {
      ...sdkProjection,
      runtimeCompatibilityRange: 'ptc_execute_code_sdk_v0',
    },
    toolCallbackHandler: async () => {
      callbackCount += 1;
      return { ok: true, result: undefined };
    },
  });

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail('expected SDK protocol mismatch');
  }
  assert.equal(result.reasonCode, 'ptc_sdk_protocol_mismatch');
  assert.match(result.remediation ?? '', /Refresh the thread SDK projection/u);
  assert.equal(callbackCount, 0);
  assert.deepEqual(fixture.invocations, []);
  await rm(sdkRoot, { recursive: true, force: true });
});

void test('createPtcExecuteCodeRuntime commits enabled store writes, discards failed writes, and survives runtime restart', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-store-workspace-'),
  );
  const storeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-store-state-'),
  );
  const firstRuntimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-store-runtime-'),
  );
  const secondRuntimeRoot = await mkdtemp(join(tmpdir(), 'g-ptc-store-r2-'));
  const threadId = testThreadId(909);
  const runContext = makeRunContext({
    threadId,
    stateRoot,
  });
  const firstFixture = createExecutableCallbackFixture(
    'container-agent-ptc-execute-code-store-first',
  );
  const firstRuntime = createPtcExecuteCodeRuntime({
    callbackTransportPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
    commandRunner: firstFixture.runner,
    runtimeRootForState: () => firstRuntimeRoot,
    storeRootForState: () => storeRoot,
    store: {
      enabled: true,
      maxKeys: 32,
      maxValueBytes: 4_096,
      maxTotalBytes: 32_768,
    },
  });

  try {
    const rejected = await firstRuntime.executeCode({
      runContext,
      request: {
        code: [
          'try {',
          "  await geulbat.store.set('too-large', 'x'.repeat(5_000));",
          '} catch (error) {',
          '  return { errorCode: error.errorCode, remediation: error.remediation };',
          '}',
        ].join('\n'),
        timeoutMs: 5_000,
      },
    });
    assert.equal(rejected.ok, true);
    if (
      rejected.ok &&
      rejected.value.executionSurface === 'node_via_lab_batch_command'
    ) {
      assert.match(rejected.value.stdout, /StoreMaxValueBytesExceeded/u);
      assert.match(rejected.value.stdout, /Reduce the serialized value size/u);
      assert.deepEqual(rejected.value.store, {
        committedKeys: [],
        revisions: {},
      });
    }

    const committed = await firstRuntime.executeCode({
      runContext,
      request: {
        code: [
          "await geulbat.store.set('note', { version: 1 });",
          "return await geulbat.store.get('note');",
        ].join('\n'),
        timeoutMs: 5_000,
      },
    });
    assert.equal(committed.ok, true);
    if (!committed.ok) {
      return;
    }
    assert.equal(
      committed.value.executionSurface,
      'node_via_lab_batch_command',
    );
    if (committed.value.executionSurface !== 'node_via_lab_batch_command') {
      return;
    }
    assert.equal(committed.value.stdout, '{"version":1}\n');
    assert.deepEqual(committed.value.store, {
      committedKeys: ['note'],
      revisions: { note: 1 },
    });
    assert.deepEqual(committed.value.toolCallbacks, {
      enabled: false,
      observed: 0,
    });

    const failed = await firstRuntime.executeCode({
      runContext,
      request: {
        code: [
          "await geulbat.store.set('note', { version: 2 });",
          "throw new Error('fail after acknowledged store write');",
        ].join('\n'),
        timeoutMs: 5_000,
      },
    });
    assert.equal(failed.ok, true);
    if (
      !failed.ok ||
      failed.value.executionSurface !== 'node_via_lab_batch_command'
    ) {
      return;
    }
    assert.equal(failed.value.exitCode, 1);
    assert.deepEqual(failed.value.store, { discardedWrites: 1 });

    const timedOut = await firstRuntime.executeCode({
      runContext,
      request: {
        code: [
          "await geulbat.store.set('note', { version: 3 });",
          'await new Promise(() => setInterval(() => {}, 1_000));',
        ].join('\n'),
        timeoutMs: 2_000,
      },
    });
    assert.equal(timedOut.ok, false);
    if (!timedOut.ok) {
      assert.equal(timedOut.reasonCode, 'ptc_lab_command_timeout');
      assert.deepEqual(timedOut.store, { discardedWrites: 1 });
    }

    const afterFailure = await firstRuntime.executeCode({
      runContext,
      request: {
        code: "return await geulbat.store.get('note');",
        timeoutMs: 5_000,
      },
    });
    assert.equal(afterFailure.ok, true);
    if (
      !afterFailure.ok ||
      afterFailure.value.executionSurface !== 'node_via_lab_batch_command'
    ) {
      return;
    }
    assert.equal(afterFailure.value.stdout, '{"version":1}\n');

    await firstRuntime.closeAll();
    const secondFixture = createExecutableCallbackFixture(
      'container-agent-ptc-execute-code-store-second',
    );
    const restartedRuntime = createPtcExecuteCodeRuntime({
      callbackTransportPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
      commandRunner: secondFixture.runner,
      runtimeRootForState: () => secondRuntimeRoot,
      storeRootForState: () => storeRoot,
      store: {
        enabled: true,
        maxKeys: 32,
        maxValueBytes: 4_096,
        maxTotalBytes: 32_768,
      },
    });
    try {
      const afterRestart = await restartedRuntime.executeCode({
        runContext,
        request: {
          code: "return await geulbat.store.get('note');",
          timeoutMs: 5_000,
        },
      });
      assert.equal(afterRestart.ok, true, JSON.stringify(afterRestart));
      if (
        afterRestart.ok &&
        afterRestart.value.executionSurface === 'node_via_lab_batch_command'
      ) {
        assert.equal(afterRestart.value.stdout, '{"version":1}\n');
        assert.deepEqual(afterRestart.value.store, {
          committedKeys: [],
          revisions: {},
        });
        assert.doesNotMatch(
          JSON.stringify(afterRestart),
          /callback\.sock|geulbat-ptc-execute-code-store-state/u,
        );
      }
    } finally {
      await restartedRuntime.closeAll();
    }
  } finally {
    await firstRuntime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(storeRoot, { recursive: true, force: true });
    await rm(firstRuntimeRoot, { recursive: true, force: true });
    await rm(secondRuntimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime turns an exit-zero store conflict into a typed final failure', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-store-conflict-workspace-'),
  );
  const storeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-store-conflict-state-'),
  );
  const slowRuntimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-store-conflict-slow-'),
  );
  const fastRuntimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-store-conflict-fast-'),
  );
  const storeConfig = {
    enabled: true,
    maxKeys: 32,
    maxValueBytes: 4_096,
    maxTotalBytes: 32_768,
  } as const;
  const slowFixture = createExecutableCallbackFixture(
    'container-agent-ptc-execute-code-store-conflict-slow',
  );
  const fastFixture = createExecutableCallbackFixture(
    'container-agent-ptc-execute-code-store-conflict-fast',
  );
  const slowRuntime = createPtcExecuteCodeRuntime({
    callbackTransportPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
    commandRunner: slowFixture.runner,
    runtimeRootForState: () => slowRuntimeRoot,
    storeRootForState: () => storeRoot,
    store: storeConfig,
  });
  const fastRuntime = createPtcExecuteCodeRuntime({
    callbackTransportPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
    commandRunner: fastFixture.runner,
    runtimeRootForState: () => fastRuntimeRoot,
    storeRootForState: () => storeRoot,
    store: storeConfig,
  });
  const runContext = makeRunContext({
    threadId: testThreadId(910),
    stateRoot,
  });

  try {
    const slowResultPromise = slowRuntime.executeCode({
      runContext,
      request: {
        code: [
          "await geulbat.store.set('shared', 'slow');",
          'await new Promise((resolve) => setTimeout(resolve, 300));',
        ].join('\n'),
        timeoutMs: 5_000,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const fastResult = await fastRuntime.executeCode({
      runContext,
      request: {
        code: "await geulbat.store.set('shared', 'fast');",
        timeoutMs: 5_000,
      },
    });
    const slowResult = await slowResultPromise;

    assert.equal(fastResult.ok, true);
    assert.equal(slowResult.ok, false);
    if (slowResult.ok) {
      return;
    }
    assert.equal(
      slowResult.reasonCode,
      'ptc_execute_code_store_commit_conflict',
    );
    assert.equal(slowResult.storeError?.errorCode, 'StoreCommitConflict');
    assert.deepEqual(slowResult.store, { discardedWrites: 1 });
    assert.equal(slowResult.execution?.exitCode, 0);
    assert.match(slowResult.storeError?.remediation ?? '', /store\.get/u);
  } finally {
    await slowRuntime.closeAll();
    await fastRuntime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(storeRoot, { recursive: true, force: true });
    await rm(slowRuntimeRoot, { recursive: true, force: true });
    await rm(fastRuntimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime accepts large generated code without a hidden input cap', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-large-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-large-runtime-'),
  );
  const generatedValueCount = 1500;
  const code = [
    'const values = [',
    Array.from(
      { length: generatedValueCount },
      (_, index) => `  ${index},`,
    ).join('\n'),
    '];',
    'console.log(values.length);',
  ].join('\n');
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-large',
    commandResult: (invocation) => {
      if (invocation.args[0] === 'exec') {
        const command = invocation.args[4];
        assert.ok(typeof command === 'string');
        assert.match(command, /GEULBAT_PTC_RUNNER_B64/u);
        assert.doesNotMatch(command, /const values/u);
        assert.equal(
          invocation.timeoutMs,
          PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_MAX_COMMAND_MS,
        );
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: `${generatedValueCount}\n`,
          stderr: '',
        };
      }
      return undefined;
    },
  });
  const runtime = createPtcExecuteCodeRuntime({
    callbackTransportPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
    commandRunner: fixture.runner,
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(902),
        stateRoot,
      }),
      request: { code },
    });

    assert.equal(result.ok, true);
    assert.equal(
      result.ok ? result.value.stdout : '',
      `${generatedValueCount}\n`,
    );
    assert.equal(
      fixture.invocations.filter((invocation) => invocation.args[0] === 'exec')
        .length,
      1,
    );
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime sends an SDK command envelope beyond the removed 32 KiB policy to the runner', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-envelope-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-envelope-runtime-'),
  );
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-envelope',
    commandResult: (invocation) => {
      if (invocation.args[0] === 'exec') {
        const command = invocation.args[4];
        assert.ok(typeof command === 'string');
        assert.ok(Buffer.byteLength(command, 'utf8') > 32 * 1024);
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'command envelope reached the runner\n',
          stderr: '',
        };
      }
      return undefined;
    },
  });
  const runtime = createPtcExecuteCodeRuntime({
    callbackTransportPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
    commandRunner: fixture.runner,
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const code = 'console.log("command envelope guard stays separate");';
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(908),
        stateRoot,
      }),
      request: { code },
      sdkHelp: {
        callbackTools: [
          {
            name: 'read_file',
            description: `Read a computer file. ${'x'.repeat(32 * 1024)}`,
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
              additionalProperties: false,
            },
          },
        ],
      },
      toolCallbackHandler: async () => ({
        ok: true,
        result: { ok: true, output: '' },
      }),
    });

    assert.equal(result.ok, true);
    assert.equal(
      result.ok ? result.value.stdout : '',
      'command envelope reached the runner\n',
    );
    assert.equal(
      fixture.invocations.filter((invocation) => invocation.args[0] === 'exec')
        .length,
      1,
    );
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime closes tainted session on timeout without leaking command output paths', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-timeout-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-timeout-runtime-'),
  );
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: PTC_TEST_SESSION_DOCKER_CONTAINER_ID,
    commandResult: (invocation) => {
      if (invocation.args[0] === 'exec') {
        return {
          kind: 'timeout',
          stdout: `stdout at ${PRIVATE_TEST_PATH}`,
          stderr: `stderr at ${PRIVATE_TEST_PATH}`,
        };
      }
      return undefined;
    },
  });
  const runtime = createPtcExecuteCodeRuntime({
    commandRunner: fixture.runner,
    runtimeRootForState: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(903),
        stateRoot,
      }),
      request: { code: 'await new Promise(() => {})', timeoutMs: 10 },
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.reasonCode, 'ptc_lab_command_timeout');
    assert.doesNotMatch(
      JSON.stringify(result),
      /geulbat-private|\.geulbat|private-token/u,
    );
    assert.deepEqual(
      fixture.invocations
        .filter((invocation) => invocation.args[0] === 'rm')
        .map((invocation) => invocation.args),
      [['rm', '-f', PTC_TEST_SESSION_DOCKER_CONTAINER_ID]],
    );
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

async function buildReadFileSdkProjection(
  rootPath: string,
): Promise<PtcExecuteCodeRuntimeSdkProjection> {
  const projection = buildToolLibraryProjection({
    registry: createBuiltinToolRegistryStore(),
    allowedRegistryNames: ['read_file'],
    sdkVersion: 'geulbat-tool-library-sdk-v1',
    sourceRegistryVersion: 'daemon-builtin-tool-registry-v1',
    policyId: 'ptc_sdk_read_file_slice_v1',
    runtimeCompatibilityRange: 'ptc_execute_code_sdk_v1',
    rootPath,
    catalogPath: join(rootPath, 'catalog.js'),
    modelFacingCatalogRef: 'geulbat-sdk://catalog',
    importSpecifier: 'geulbat-sdk',
  });
  const tool = projection.tools.find(
    (candidate) => candidate.publicName === 'read_file',
  );
  assert.ok(tool);
  const wrapper = projection.files.find(
    (file) => file.path === tool.wrapperModule && file.role === 'wrapper',
  );
  assert.ok(wrapper);
  const manifest = projection.files.find((file) => file.role === 'manifest');
  assert.ok(manifest);
  for (const file of projection.files) {
    const filePath = join(rootPath, ...file.path.split('/'));
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, file.content, 'utf8');
  }
  return {
    sdkVersion: projection.sdkVersion,
    sdkProjectionHash: projection.sdkProjectionHash,
    policyId: projection.policyId,
    runtimeCompatibilityRange: projection.runtimeCompatibilityRange,
    importSpecifier: projection.importSpecifier,
    manifestModule: manifest.path,
    manifestSourceHash: `sha256:${createHash('sha256')
      .update(manifest.content, 'utf8')
      .digest('hex')}`,
    mount: {
      hostRootPath: rootPath,
      containerRootPath: PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT,
      mountPolicyId: PTC_SESSION_DOCKER_SDK_PROJECTION_MOUNT_POLICY_ID,
      sdkVersion: projection.sdkVersion,
      sdkProjectionHash: projection.sdkProjectionHash,
      policyId: projection.policyId,
      importSpecifier: projection.importSpecifier,
    },
    modules: [
      {
        specifier: tool.wrapperImportSpecifier,
        exportName: tool.wrapperExportName,
        modulePath: wrapper.path,
        sourceHash: `sha256:${createHash('sha256')
          .update(wrapper.content, 'utf8')
          .digest('hex')}`,
      },
    ],
  };
}

function remapEncodedExecuteCodeCallbackRoot(
  command: string,
  callbackHostRoot: string,
  sdkHostRoot?: string,
): string {
  const encodedRunnerMatch = /GEULBAT_PTC_RUNNER_B64='([A-Za-z0-9+/=]+)'/u.exec(
    command,
  );
  assert.ok(encodedRunnerMatch);
  const encodedRunner = encodedRunnerMatch[1];
  assert.ok(encodedRunner);
  const runnerSource = Buffer.from(encodedRunner, 'base64').toString('utf8');
  let remappedRunnerSource = runnerSource.replaceAll(
    '/geulbat/callbacks',
    callbackHostRoot,
  );
  if (sdkHostRoot !== undefined) {
    remappedRunnerSource = remappedRunnerSource.replaceAll(
      PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT,
      sdkHostRoot,
    );
  }
  assert.notEqual(remappedRunnerSource, runnerSource);
  const remappedRunner = Buffer.from(remappedRunnerSource, 'utf8').toString(
    'base64',
  );
  return command.replace(
    encodedRunnerMatch[0],
    `GEULBAT_PTC_RUNNER_B64='${remappedRunner}'`,
  );
}

function assertLabNodeExec(
  invocation: PtcSessionDockerCommandInvocation,
): void {
  assert.deepEqual(invocation.args.slice(0, 4), [
    'exec',
    'container-agent-ptc-execute-code',
    '/bin/bash',
    '-lc',
  ]);
}

function readCallbackHostRoot(
  invocations: readonly PtcSessionDockerCommandInvocation[],
): string {
  const createInvocation = [...invocations]
    .reverse()
    .find((invocation) => invocation.args[0] === 'create');
  assert.ok(createInvocation);
  return readPtcSessionDockerBindMountHostPath(
    createInvocation,
    '/geulbat/callbacks',
  );
}

function createExecutableCallbackFixture(containerId: string) {
  let fixture: ReturnType<typeof createPtcSessionDockerCommandFixture>;
  fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId,
    commandResult: async (invocation) => {
      if (invocation.args[0] !== 'exec') {
        return undefined;
      }
      const command = invocation.args[4];
      assert.ok(typeof command === 'string');
      const localCommand = remapEncodedExecuteCodeCallbackRoot(
        command,
        readCallbackHostRoot(fixture.invocations),
      );
      return await runPtcSessionDockerCommand({
        executable: '/bin/bash',
        args: ['-c', localCommand],
        ...(invocation.timeoutMs === undefined
          ? {}
          : { timeoutMs: invocation.timeoutMs }),
        ...(invocation.signal ? { signal: invocation.signal } : {}),
      });
    },
  });
  return fixture;
}
