import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPtcSessionDockerCommandFixture,
  PTC_TEST_SESSION_DOCKER_CONTAINER_ID,
  readPtcSessionDockerBindMountHostPath,
} from '../../../../test-support/ptc-session-docker.js';
import { testProjectId } from '../../../../test-support/project-id.js';
import { testThreadId } from '../../../../test-support/thread-id.js';
import { makeRunWorkspaceContext } from '../../../../test-support/run-workspace-context.js';
import { PTC_EXECUTE_CODE_TOOL_NAME } from './execute-code-runtime-contract.js';
import { createPtcExecuteCodeRuntime } from './execute-code-runtime.js';
import { PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_MAX_COMMAND_MS } from '../../lab/profile/lab-profile-contract.js';
import { createPtcSessionDockerLocalBatchCommandPolicy } from '../../lab/session/session-docker-contract.js';
import { runPtcSessionDockerCommand } from '../../lab/session/session-docker-command.js';
import { PTC_LAB_BATCH_COMMAND_MAX_COMMAND_CHARS } from '../../lab/shell/lab-command-execution.js';
import type { PtcSessionDockerCommandInvocation } from '../../lab/session/session-docker-contract.js';

const PRIVATE_TEST_PATH = '/tmp/geulbat-private/.geulbat/ptc/private-token';
const TEST_CALLBACK_TRANSPORT_POLICY = Object.freeze({
  maxFrameBytes: 8192,
  maxOpenConnections: 4,
  maxCallbacks: 20,
  callbackTimeoutMs: 30_000,
  maxResponseBytes: 8192,
});

void test('createPtcExecuteCodeRuntime runs model code through lab batch command without raw shell interpolation', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-runtime-'),
  );
  const code = 'console.log("hello from execute_code; $(touch /host-owned)")';
  const encodedCode = Buffer.from(code, 'utf8').toString('base64');
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code',
    commandResult: (invocation) => {
      if (invocation.args[0] === 'exec') {
        assertLabNodeExec(invocation);
        assert.equal(invocation.timeoutMs, 1234);
        const command = invocation.args[4];
        assert.ok(typeof command === 'string');
        assert.ok(command.includes(encodedCode));
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
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(901),
        projectId: testProjectId('project'),
        workspaceRoot,
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
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime keeps callback tools disabled when no callback transport policy is configured', async () => {
  const workspaceRoot = await mkdtemp(
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
        assert.match(command, /GEULBAT_PTC_CODE_B64/u);
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
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(9011),
        projectId: testProjectId('project'),
        workspaceRoot,
      }),
      request: { code: 'console.log("no callback policy")' },
      sdkHelp: {
        callbackTools: [
          {
            name: 'read_file',
            description: 'Read a workspace file.',
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
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime reuses a clean session until explicit runtime cleanup', async () => {
  const workspaceRoot = await mkdtemp(
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
    runtimeRootForWorkspace: () => runtimeRoot,
  });
  const runContext = makeRunWorkspaceContext({
    threadId: testThreadId(905),
    projectId: testProjectId('project'),
    workspaceRoot,
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
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime preserves callback bridge session diagnostics', async () => {
  const workspaceRoot = await mkdtemp(
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
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(950),
        projectId: testProjectId('project'),
        workspaceRoot,
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
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime clears workspace runtime tracking after closeAll failure', async () => {
  const workspaceRoot = await mkdtemp(
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
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(909),
        projectId: testProjectId('project'),
        workspaceRoot,
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
        workspaceRuntimeCount: 1,
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
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime keys workspace runtimes by canonical workspace realpath', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-realpath-workspace-'),
  );
  const workspaceAlias = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-realpath-alias-parent-'),
  );
  const workspaceAliasPath = join(workspaceAlias, 'workspace-link');
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-realpath-runtime-'),
  );
  await symlink(workspaceRoot, workspaceAliasPath, 'dir');
  const canonicalWorkspaceRoot = await realpath(workspaceRoot);
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
    runtimeRootForWorkspace: (workspaceRootInput) => {
      runtimeRootInputs.push(workspaceRootInput);
      assert.equal(workspaceRootInput, canonicalWorkspaceRoot);
      return runtimeRoot;
    },
  });

  try {
    const first = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(907),
        projectId: testProjectId('project'),
        workspaceRoot,
      }),
      request: { code: 'console.log("canonical")' },
    });
    const second = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(907),
        projectId: testProjectId('project'),
        workspaceRoot: workspaceAliasPath,
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
    assert.deepEqual(runtimeRootInputs, [canonicalWorkspaceRoot]);
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
    await rm(workspaceAlias, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime returns user-code non-zero exit as a result summary', async () => {
  const workspaceRoot = await mkdtemp(
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
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(906),
        projectId: testProjectId('project'),
        workspaceRoot,
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
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime exposes geulbat.callTool through an epoch callback socket without leaking callback secrets', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-callback-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-callback-runtime-'),
  );
  let callbackCount = 0;
  let fixture: ReturnType<typeof createPtcSessionDockerCommandFixture>;
  fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-callback',
    commandResult: async (invocation) => {
      if (invocation.args[0] === 'exec') {
        const command = invocation.args[4];
        assert.ok(typeof command === 'string');
        const localCommand = command.replaceAll(
          '/geulbat/callbacks',
          readCallbackHostRoot(fixture.invocations),
        );
        return await runPtcSessionDockerCommand({
          executable: '/bin/bash',
          args: ['-lc', localCommand],
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
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(904),
        projectId: testProjectId('project'),
        workspaceRoot,
      }),
      request: {
        code: [
          'const help = geulbat.help();',
          'console.log(help.protocolVersion);',
          'console.log(help.callbacks.tools.map((tool) => tool.name).join(","));',
          "const result = await geulbat.callTool('read_file', { path: 'note.txt' });",
          'console.log(JSON.parse(result.output).message);',
          "const aliasResult = await geulbat.tools.readFile({ path: 'note.txt' });",
          'console.log(JSON.parse(aliasResult.output).message);',
          'console.log(process._eval);',
        ].join('\n'),
        timeoutMs: 5_000,
      },
      sdkHelp: {
        callbackTools: [
          {
            name: 'read_file',
            description: 'Read a workspace file.',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
              additionalProperties: false,
            },
          },
        ],
      },
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
    assert.equal(callbackCount, 2);
    assert.equal(result.value.toolCallbacks.enabled, true);
    assert.equal(result.value.toolCallbacks.observed, 2);
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
    assert.match(result.value.stdout, /callback says hello/u);
    assert.doesNotMatch(
      result.value.stdout,
      /\/geulbat\/callbacks|callback\.sock|write_file/u,
    );
  } finally {
    await runtime.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime accepts large generated code without a hidden input cap', async () => {
  const workspaceRoot = await mkdtemp(
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
  const encodedCode = Buffer.from(code, 'utf8').toString('base64');
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-large',
    commandResult: (invocation) => {
      if (invocation.args[0] === 'exec') {
        const command = invocation.args[4];
        assert.ok(typeof command === 'string');
        assert.ok(command.includes(encodedCode));
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
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(902),
        projectId: testProjectId('project'),
        workspaceRoot,
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
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime closes callback session when command envelope is too large', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-envelope-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-envelope-runtime-'),
  );
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-envelope',
    commandResult: (invocation) => {
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
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const code = 'console.log("command envelope guard stays separate");';
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(908),
        projectId: testProjectId('project'),
        workspaceRoot,
      }),
      request: { code },
      sdkHelp: {
        callbackTools: [
          {
            name: 'read_file',
            description: `Read a workspace file. ${'x'.repeat(PTC_LAB_BATCH_COMMAND_MAX_COMMAND_CHARS)}`,
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

    assert.equal(result.ok, false);
    assert.equal(
      result.ok ? '' : result.reasonCode,
      'ptc_execute_code_invalid',
    );
    assert.deepEqual(result.ok ? undefined : result.diagnostics, {
      cleanupReasonCode: 'container_remove_failed',
    });
    assert.equal(
      fixture.invocations.filter((invocation) => invocation.args[0] === 'exec')
        .length,
      0,
    );
    assert.deepEqual(
      fixture.invocations
        .filter((invocation) => invocation.args[0] === 'rm')
        .map((invocation) => invocation.args),
      [['rm', '-f', 'container-agent-ptc-execute-code-envelope']],
    );
  } finally {
    await runtime.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('createPtcExecuteCodeRuntime closes tainted session on timeout without leaking command output paths', async () => {
  const workspaceRoot = await mkdtemp(
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
    runtimeRootForWorkspace: () => runtimeRoot,
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunWorkspaceContext({
        threadId: testThreadId(903),
        projectId: testProjectId('project'),
        workspaceRoot,
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
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

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
  const createInvocation = invocations.find(
    (invocation) => invocation.args[0] === 'create',
  );
  assert.ok(createInvocation);
  return readPtcSessionDockerBindMountHostPath(
    createInvocation,
    '/geulbat/callbacks',
  );
}
