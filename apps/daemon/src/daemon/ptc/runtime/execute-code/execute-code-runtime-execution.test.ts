import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createPtcSessionDockerCommandFixture,
  readPtcSessionDockerBindMountHostPath,
} from '../../../../test-support/ptc-session-docker.js';
import { testThreadId } from '../../../../test-support/thread-id.js';
import { makeRunContext } from '../../../../test-support/run-context.js';
import { runHostRoutedDockerCommandForTest } from '../../../../test-support/host-routed-docker-command.js';
import { remapEncodedExecuteCodeCallbackRoot } from '../../../../test-support/ptc-execute-code-callback-runner.js';
import { deferredTestValue as createDeferred } from '../../../../test-support/ptc-execute-code-cell-process.js';
import {
  PTC_EXECUTE_CODE_TOOL_NAME,
  type PtcExecuteCodeRuntimeSdkProjection,
} from './execute-code-runtime-contract.js';
import { createPtcExecuteCodeRuntime } from './execute-code-runtime.js';
import {
  createPtcSessionDockerLocalBatchCommandPolicy,
  PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_SDK_PROJECTION_MOUNT_POLICY_ID,
} from '../../lab/session/session-docker-contract.js';
import type { PtcSessionDockerCommandInvocation } from '../../lab/session/session-docker-contract.js';
import { buildToolLibraryProjection } from '../../../tools/tool-library-projection.js';
import { createBuiltinToolRegistryStore } from '../../../tools/builtin/catalog.js';

const TEST_CALLBACK_TRANSPORT_POLICY = Object.freeze({
  maxFrameBytes: 8192,
  maxOpenConnections: 4,
  maxCallbacks: 20,
  callbackTimeoutMs: 30_000,
  maxResponseBytes: 8192,
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
    callbackTransportPolicy: undefined,
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
        return await runHostRoutedDockerCommandForTest({
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
  const slowCommandStarted = createDeferred<void>();
  const releaseSlowCommand = createDeferred<void>();
  const slowFixture = createExecutableCallbackFixture(
    'container-agent-ptc-execute-code-store-conflict-slow',
    {
      async beforeExec() {
        slowCommandStarted.resolve();
        await releaseSlowCommand.promise;
      },
    },
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
        code: "await geulbat.store.set('shared', 'slow');",
        timeoutMs: 5_000,
      },
    });
    const slowStartOutcome = await Promise.race([
      slowCommandStarted.promise.then(() => 'started' as const),
      slowResultPromise.then(() => 'settled' as const),
    ]);
    assert.equal(slowStartOutcome, 'started');
    const fastResult = await fastRuntime
      .executeCode({
        runContext,
        request: {
          code: "await geulbat.store.set('shared', 'fast');",
          timeoutMs: 5_000,
        },
      })
      .finally(() => releaseSlowCommand.resolve());
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

function createExecutableCallbackFixture(
  containerId: string,
  options: {
    beforeExec?: () => Promise<void> | void;
  } = {},
) {
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
      await options.beforeExec?.();
      return await runHostRoutedDockerCommandForTest({
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
