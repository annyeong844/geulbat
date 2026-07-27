import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { testThreadId } from '../../../../test-support/thread-id.js';
import { makeRunContext } from '../../../../test-support/run-context.js';
import { runHostRoutedDockerCommandForTest } from '../../../../test-support/host-routed-docker-command.js';
import { buildPythonExecuteCodeCommand } from './execute-code-batch-runtime.js';
import {
  PTC_EXECUTE_CODE_PYTHON_POLICY_ID,
  type PtcExecuteCodeRuntimeSdkHelp,
} from './execute-code-runtime-contract.js';
import { createPtcExecuteCodeRuntime } from './execute-code-runtime.js';
import { buildPtcExecuteCodeSdkHelpBundle } from './execute-code-sdk.js';

const pythonSdkHelpBundle = buildPtcExecuteCodeSdkHelpBundle({
  callbacksEnabled: false,
  language: 'python',
  sdkHelp: undefined,
});

void test('execute_code runs Python with an isolated standard-library runner', async () => {
  const code = [
    'import json',
    'runtime = geulbat.help()["runtime"]',
    'print(json.dumps({"total": sum(range(5)), "runtime": runtime}, separators=(",", ":")))',
  ].join('\n');
  const command = buildPythonExecuteCodeCommand(code, {
    sdkHelpBundle: pythonSdkHelpBundle,
  });

  assert.match(command, /GEULBAT_PTC_RUNNER_B64/u);
  assert.match(command, /exec python3 -I -u -/u);
  assert.match(command, /base64 --decode/u);
  assert.doesNotMatch(command, /sum\(range|geulbat\.help/u);
  assert.deepEqual(pythonSdkHelpBundle.runtime, {
    language: 'python',
    executionSurface: 'python_via_lab_batch_command',
    sessionLifecycle: 'runtime_owned_reusable',
  });
  assert.equal(
    pythonSdkHelpBundle.callbacks.callShape,
    'geulbat.call_tool(name, args)',
  );
  assert.equal(pythonSdkHelpBundle.sdkProjection, undefined);

  const execution = await runHostRoutedDockerCommandForTest({
    executable: '/bin/bash',
    args: ['-c', command],
  });
  assert.equal(execution.kind, 'exit');
  if (execution.kind !== 'exit') {
    return;
  }
  assert.equal(execution.exitCode, 0);
  assert.deepEqual(JSON.parse(execution.stdout), {
    total: 10,
    runtime: {
      language: 'python',
      executionSurface: 'python_via_lab_batch_command',
      sessionLifecycle: 'runtime_owned_reusable',
    },
  });
  assert.equal(execution.stderr, '');
});

void test('execute_code Python imports packages from the reusable session target', async () => {
  const packageRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-python-package-root-'),
  );
  await writeFile(
    join(packageRoot, 'geulbat_fixture.py'),
    'VALUE = "wheel-import-ok"\n',
    'utf8',
  );
  const command = buildPythonExecuteCodeCommand(
    'import geulbat_fixture\nprint(geulbat_fixture.VALUE)',
    {
      installedPackagesPythonPath: packageRoot,
      sdkHelpBundle: pythonSdkHelpBundle,
    },
  );

  try {
    const execution = await runHostRoutedDockerCommandForTest({
      executable: '/bin/bash',
      args: ['-c', command],
    });
    assert.equal(execution.kind, 'exit');
    if (execution.kind !== 'exit') {
      return;
    }
    assert.equal(execution.exitCode, 0);
    assert.equal(execution.stdout, 'wheel-import-ok\n');
    assert.equal(execution.stderr, '');
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});

void test('execute_code Python import wrappers use the canonical callback wire', async () => {
  const socketRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-python-callback-'),
  );
  const socketPath = join(socketRoot, 'callback.sock');
  const observedRequests: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex < 0) {
        return;
      }
      const observedRequest = JSON.parse(
        buffer.slice(0, newlineIndex),
      ) as Record<string, unknown>;
      observedRequests.push(observedRequest);
      const requestArgs = observedRequest['args'] as {
        args?: { path?: string };
      };
      const result =
        requestArgs.args?.path === 'large.json'
          ? {
              ok: true,
              offloaded: true,
              outputRef: 'tool-output:thread/run/call',
              summary: 'read_file returned a large result',
              fullOutputBytes: 50_000,
              fullOutputChars: 49_000,
            }
          : { ok: true, output: '{"content":"hello"}' };
      socket.end(
        `${JSON.stringify({
          requestId: observedRequest['requestId'],
          ok: true,
          result,
        })}\n`,
      );
    });
  });
  server.listen(socketPath);
  await once(server, 'listening');

  const sdkHelp: PtcExecuteCodeRuntimeSdkHelp = {
    callbackTools: [
      {
        name: 'read_file',
        description: 'Read one file.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
      },
    ],
  };
  const sdkHelpBundle = buildPtcExecuteCodeSdkHelpBundle({
    callbacksEnabled: true,
    language: 'python',
    sdkHelp,
  });
  const command = buildPythonExecuteCodeCommand(
    [
      'import json',
      'from geulbat_sdk import read_file',
      'inline = read_file({"path": "README.md"})',
      'offloaded = read_file({"path": "large.json"})',
      'print(json.dumps({"inline": inline, "offloaded": offloaded}, separators=(",", ":")))',
    ].join('\n'),
    {
      callbackConfig: { socketPath, token: 'python-callback-token' },
      sdkHelpBundle,
    },
  );

  try {
    const execution = await runHostRoutedDockerCommandForTest({
      executable: '/bin/bash',
      args: ['-c', command],
    });
    assert.equal(execution.kind, 'exit');
    if (execution.kind !== 'exit') {
      return;
    }
    assert.equal(execution.exitCode, 0);
    assert.deepEqual(JSON.parse(execution.stdout), {
      inline: {
        kind: 'inline',
        value: { ok: true, output: '{"content":"hello"}' },
      },
      offloaded: {
        kind: 'offloaded',
        outputRef: 'tool-output:thread/run/call',
        summary: 'read_file returned a large result',
        fullOutputBytes: 50_000,
        fullOutputChars: 49_000,
        raw: {
          ok: true,
          offloaded: true,
          outputRef: 'tool-output:thread/run/call',
          summary: 'read_file returned a large result',
          fullOutputBytes: 50_000,
          fullOutputChars: 49_000,
        },
      },
    });
    assert.equal(execution.stderr, '');
    assert.deepEqual(
      observedRequests.map((request) => ({
        token: request['token'],
        kind: request['kind'],
        args: request['args'],
      })),
      [
        {
          token: 'python-callback-token',
          kind: 'geulbat_tool_call',
          args: {
            toolName: 'read_file',
            args: { path: 'README.md' },
          },
        },
        {
          token: 'python-callback-token',
          kind: 'geulbat_tool_call',
          args: {
            toolName: 'read_file',
            args: { path: 'large.json' },
          },
        },
      ],
    );
  } finally {
    server.close();
    await once(server, 'close');
    await rm(socketRoot, { recursive: true, force: true });
  }
});

void test('execute_code Python rejects JavaScript-only module and cell options', async () => {
  const runtime = createPtcExecuteCodeRuntime();
  const runContext = makeRunContext({
    threadId: testThreadId(948_2),
    stateRoot: '/tmp/geulbat-ptc-python-validation',
  });

  const moduleResult = await runtime.executeCode({
    runContext,
    request: {
      code: 'print("hello")',
      language: 'python',
      moduleFormat: 'esm',
    },
  });
  assert.equal(moduleResult.ok, false);
  if (!moduleResult.ok) {
    assert.equal(moduleResult.reasonCode, 'ptc_execute_code_invalid');
    assert.match(moduleResult.message, /does not accept moduleFormat/u);
  }

  const yieldResult = await runtime.executeCode({
    runContext,
    request: {
      code: 'print("hello")',
      language: 'python',
      yieldTimeMs: 1_000,
    },
  });
  assert.equal(yieldResult.ok, false);
  if (!yieldResult.ok) {
    assert.equal(yieldResult.reasonCode, 'ptc_execute_code_invalid');
    assert.match(yieldResult.message, /runs as a batch/u);
  }
});

void test(
  'execute_code runs Python through the real pinned Docker runtime',
  { skip: process.env.GEULBAT_RUN_DOCKER_E2E !== '1' },
  async () => {
    const stateRoot = await mkdtemp(
      join(tmpdir(), 'geulbat-ptc-python-workspace-'),
    );
    const runtimeRoot = await mkdtemp(
      join(tmpdir(), 'geulbat-ptc-python-runtime-'),
    );
    const runtime = createPtcExecuteCodeRuntime({
      realpathStateRoot: async () => stateRoot,
      runtimeRootForState: () => runtimeRoot,
    });

    try {
      const result = await runtime.executeCode({
        runContext: makeRunContext({
          threadId: testThreadId(948_3),
          stateRoot,
        }),
        request: {
          code: 'import json\nprint(json.dumps({"answer": 6 * 7}))',
          language: 'python',
        },
      });

      assert.equal(result.ok, true);
      if (!result.ok) {
        return;
      }
      assert.equal(
        result.value.executionSurface,
        'python_via_lab_batch_command',
      );
      assert.equal(result.value.policyId, PTC_EXECUTE_CODE_PYTHON_POLICY_ID);
      assert.equal(result.value.language, 'python');
      assert.equal(result.value.exitCode, 0);
      assert.deepEqual(JSON.parse(result.value.stdout), { answer: 42 });
      assert.equal(result.value.stderr, '');
    } finally {
      assert.deepEqual(await runtime.closeAll(), { ok: true });
      await rm(runtimeRoot, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    }
  },
);
