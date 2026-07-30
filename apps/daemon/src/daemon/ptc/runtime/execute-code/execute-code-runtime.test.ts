import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPtcSessionDockerCommandFixture,
  readPtcSessionDockerBindMountHostPath,
} from '../../../../test-support/ptc-session-docker.js';
import { testThreadId } from '../../../../test-support/thread-id.js';
import { makeRunContext } from '../../../../test-support/run-context.js';
import {
  type PtcExecuteCodeLanguage,
  type PtcExecuteCodeModuleFormat,
} from './execute-code-runtime-contract.js';
import { createPtcExecuteCodeRuntime } from './execute-code-runtime.js';
import { PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_MAX_COMMAND_MS } from '../../lab/profile/lab-profile-contract.js';
import { importPtcLabArtifactWorkspaceFiles } from '../../lab/artifacts/lab-artifact-workspace.js';
import {
  createPtcSessionDockerLocalBatchCommandPolicy,
  PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT,
} from '../../lab/session/session-docker-contract.js';
import { createSandboxAttemptStore } from '../../../sandbox/attempt-store.js';

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

void test('createPtcExecuteCodeRuntime rejects invalid executable request combinations before opening runtime state', async (t) => {
  type ExecuteCodeRequest = Parameters<
    ReturnType<typeof createPtcExecuteCodeRuntime>['executeCode']
  >[0]['request'];
  const cases: Array<{
    name: string;
    request: ExecuteCodeRequest;
    message: string;
  }> = [
    {
      name: 'blank code',
      request: { code: '   ' },
      message: 'PTC execute_code input is invalid',
    },
    {
      name: 'unknown language',
      request: {
        code: 'return 1',
        language: 'ruby' as PtcExecuteCodeLanguage,
      },
      message: 'PTC execute_code language is invalid',
    },
    {
      name: 'Python module format',
      request: { code: 'print(1)', language: 'python', moduleFormat: 'esm' },
      message: 'PTC Python execution does not accept moduleFormat',
    },
    {
      name: 'Python yield window',
      request: { code: 'print(1)', language: 'python', yieldTimeMs: 100 },
      message:
        'PTC Python execution currently runs as a batch and does not accept yieldTimeMs',
    },
    {
      name: 'empty artifact list',
      request: { code: 'return 1', artifacts: [] },
      message: 'PTC execute_code artifact paths are invalid',
    },
    {
      name: 'unsafe artifact path',
      request: { code: 'return 1', artifacts: ['../private.txt'] },
      message: 'PTC execute_code artifact paths are invalid',
    },
    {
      name: 'duplicate artifact path',
      request: {
        code: 'return 1',
        artifacts: ['report.txt', 'report.txt'],
      },
      message: 'PTC execute_code artifact paths are invalid',
    },
    {
      name: 'artifact export with yield',
      request: {
        code: 'return 1',
        artifacts: ['report.txt'],
        yieldTimeMs: 100,
      },
      message:
        'PTC execute_code artifact export runs to batch completion and does not accept yieldTimeMs',
    },
    {
      name: 'zero timeout',
      request: { code: 'return 1', timeoutMs: 0 },
      message: 'PTC execute_code timeout is invalid',
    },
    {
      name: 'yield below the protocol floor',
      request: { code: 'return 1', timeoutMs: 1_000, yieldTimeMs: 0 },
      message: 'PTC execute_code cell yieldTimeMs is invalid',
    },
    {
      name: 'yield beyond the execution timeout',
      request: { code: 'return 1', timeoutMs: 1_000, yieldTimeMs: 1_001 },
      message:
        'PTC execute_code cell yieldTimeMs exceeds the execution timeout',
    },
  ];
  const runtime = createPtcExecuteCodeRuntime();

  try {
    for (const scenario of cases) {
      await t.test(scenario.name, async () => {
        assert.deepEqual(
          await runtime.executeCode({
            runContext: makeRunContext({
              threadId: testThreadId(899_1),
              stateRoot: '/unused/invalid-execute-code-request',
            }),
            request: scenario.request,
          }),
          {
            ok: false,
            reasonCode: 'ptc_execute_code_invalid',
            message: scenario.message,
          },
        );
      });
    }
  } finally {
    await runtime.closeAll();
  }
});

void test('createPtcExecuteCodeRuntime fails closed on unavailable, invalid, and over-limit artifact export policy', async (t) => {
  const cases = [
    {
      name: 'unconfigured',
      runtime: createPtcExecuteCodeRuntime(),
      artifacts: ['report.txt'],
      expected: {
        ok: false,
        reasonCode: 'ptc_execute_code_artifact_export_disabled',
        message: 'PTC execute_code artifact export is not configured',
        remediation:
          'Ask the operator to configure PTC artifact export limits in Settings.',
      },
    },
    {
      name: 'policy read failure',
      runtime: createPtcExecuteCodeRuntime({
        artifactExport: {
          resolvePolicy: () => {
            throw new Error('policy store unavailable');
          },
          importFiles: async () => {
            throw new Error('import must not run');
          },
        },
      }),
      artifacts: ['report.txt'],
      expected: {
        ok: false,
        reasonCode: 'ptc_execute_code_artifact_export_failed',
        message: 'PTC execute_code artifact export policy could not be read',
        diagnostics: { artifactReasonCode: 'policy_resolution_failed' },
      },
    },
    {
      name: 'disabled policy',
      runtime: createPtcExecuteCodeRuntime({
        artifactExport: {
          resolvePolicy: () => undefined,
          importFiles: async () => {
            throw new Error('import must not run');
          },
        },
      }),
      artifacts: ['report.txt'],
      expected: {
        ok: false,
        reasonCode: 'ptc_execute_code_artifact_export_disabled',
        message: 'PTC execute_code artifact export is disabled',
        remediation:
          'Ask the operator to configure PTC artifact export limits in Settings.',
      },
    },
    {
      name: 'invalid policy',
      runtime: createPtcExecuteCodeRuntime({
        artifactExport: {
          resolvePolicy: () => ({
            maxFiles: 0,
            maxFileBytes: 1024,
            maxTotalBytes: 2048,
          }),
          importFiles: async () => {
            throw new Error('import must not run');
          },
        },
      }),
      artifacts: ['report.txt'],
      expected: {
        ok: false,
        reasonCode: 'ptc_execute_code_artifact_export_failed',
        message: 'PTC execute_code artifact export policy is invalid',
        diagnostics: { artifactReasonCode: 'policy_invalid' },
      },
    },
    {
      name: 'file count exceeded',
      runtime: createPtcExecuteCodeRuntime({
        artifactExport: {
          resolvePolicy: () => ({
            maxFiles: 1,
            maxFileBytes: 1024,
            maxTotalBytes: 2048,
          }),
          importFiles: async () => {
            throw new Error('import must not run');
          },
        },
      }),
      artifacts: ['first.txt', 'second.txt'],
      expected: {
        ok: false,
        reasonCode: 'ptc_execute_code_invalid',
        message:
          'PTC execute_code artifact paths exceed the operator file count limit',
      },
    },
  ] as const;

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      try {
        assert.deepEqual(
          await scenario.runtime.executeCode({
            runContext: makeRunContext({
              threadId: testThreadId(899_2),
              stateRoot: '/unused/artifact-export-policy',
            }),
            request: {
              code: 'return 1',
              artifacts: [...scenario.artifacts],
            },
          }),
          scenario.expected,
        );
      } finally {
        await scenario.runtime.closeAll();
      }
    });
  }
});

void test('createPtcExecuteCodeRuntime exports explicitly requested artifact files as durable metadata', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-artifact-runtime-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-artifact-runtime-state-'),
  );
  let artifactRoot: string | undefined;
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    commandResult: async (invocation) => {
      if (invocation.args[0] === 'create') {
        artifactRoot = readPtcSessionDockerBindMountHostPath(
          invocation,
          PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT,
        );
        return undefined;
      }
      if (invocation.args[0] === 'exec') {
        assert.ok(artifactRoot);
        await mkdir(join(artifactRoot, 'reports'), { recursive: true });
        await writeFile(
          join(artifactRoot, 'reports', 'summary.json'),
          '{"result":"ok"}',
          'utf8',
        );
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'done\n',
          stderr: '',
        };
      }
      return undefined;
    },
  });
  const attemptStore = createSandboxAttemptStore();
  const runtime = createPtcExecuteCodeRuntime({
    commandRunner: fixture.runner,
    runtimeRootForState: () => runtimeRoot,
    artifactExport: {
      resolvePolicy: () => ({
        maxFiles: 2,
        maxFileBytes: 1024,
        maxTotalBytes: 2048,
      }),
      importFiles: (args) =>
        importPtcLabArtifactWorkspaceFiles({
          ...args,
          attemptStore,
        }),
    },
  });

  try {
    const result = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(900),
        stateRoot,
      }),
      request: {
        code: 'console.log("done")',
        artifacts: ['reports/summary.json'],
      },
    });

    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.executionSurface, 'node_via_lab_batch_command');
    assert.deepEqual(
      result.value.artifacts?.files.map((file) => file.relativePath),
      ['reports/summary.json'],
    );
    assert.match(
      result.value.artifacts?.evidenceRef ?? '',
      /^sandbox-output:/u,
    );
    const evidenceRoot =
      attemptStore.getAttempts().records[0]?.outputRef?.rootPath;
    assert.ok(evidenceRoot);
    assert.equal(
      await readFile(join(evidenceRoot, 'reports', 'summary.json'), 'utf8'),
      '{"result":"ok"}',
    );
  } finally {
    await runtime.closeAll();
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
