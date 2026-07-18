import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testThreadId } from '../../../../test-support/thread-id.js';
import { makeRunContext } from '../../../../test-support/run-context.js';
import { runPtcSessionDockerCommand } from '../../lab/session/session-docker-command.js';
import {
  buildNodeExecuteCodeCommand,
  type ValidatedExecuteCodeRequest,
} from './execute-code-batch-runtime.js';
import { createPtcExecuteCodeRuntime } from './execute-code-runtime.js';
import { buildPtcExecuteCodeSdkHelpBundle } from './execute-code-sdk.js';

const sdkHelpBundle = buildPtcExecuteCodeSdkHelpBundle({
  callbacksEnabled: false,
  sdkHelp: undefined,
});

void test('execute_code runs JavaScript and erasable TypeScript through the same encoded CommonJS runner', async () => {
  const code = [
    'interface Pair { left: number; right: number }',
    'type Result = { total: number; nodePath?: string };',
    'const pair: Pair = { left: 2, right: 5 };',
    'const result: Result = { total: pair.left + pair.right };',
    'result.nodePath = process.env.NODE_PATH;',
    'return result;',
  ].join('\n');
  const command = buildNodeExecuteCodeCommand(code, {
    sdkHelpBundle,
    installedPackagesNodePath: '/tmp/geulbat-installed-packages',
  });

  assert.match(command, /GEULBAT_PTC_RUNNER_B64/u);
  assert.match(command, /exec node/u);
  assert.match(command, /--input-type=commonjs-typescript/u);
  assert.doesNotMatch(command, /interface Pair|const pair/u);

  const execution = await runPtcSessionDockerCommand({
    executable: '/bin/bash',
    args: ['-c', command],
  });
  assert.equal(execution.kind, 'exit');
  if (execution.kind !== 'exit') {
    return;
  }
  assert.equal(execution.exitCode, 0);
  assert.equal(
    execution.stdout,
    '{"total":7,"nodePath":"/tmp/geulbat-installed-packages"}\n',
  );
  assert.equal(execution.stderr, '');
});

void test('execute_code refuses TypeScript syntax that requires transformation', async () => {
  const command = buildNodeExecuteCodeCommand(
    'enum Direction { Left, Right }\nreturn Direction.Right;',
    { sdkHelpBundle },
  );
  const execution = await runPtcSessionDockerCommand({
    executable: '/bin/bash',
    args: ['-c', command],
  });
  assert.equal(execution.kind, 'exit');
  if (execution.kind !== 'exit') {
    return;
  }
  assert.equal(execution.exitCode, 1);
  assert.match(execution.stderr, /ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX/u);
});

void test(
  'execute_code runs erasable TypeScript through the real pinned Docker runtime',
  { skip: process.env.GEULBAT_RUN_DOCKER_E2E !== '1' },
  async () => {
    const stateRoot = await mkdtemp(
      join(tmpdir(), 'geulbat-ptc-typescript-workspace-'),
    );
    const runtimeRoot = await mkdtemp(
      join(tmpdir(), 'geulbat-ptc-typescript-runtime-'),
    );
    const runtime = createPtcExecuteCodeRuntime({
      realpathStateRoot: async () => stateRoot,
      runtimeRootForState: () => runtimeRoot,
    });

    try {
      const request = {
        code: [
          'type Measurement = { value: number; unit: string };',
          "const measurement: Measurement = { value: 7, unit: 'items' };",
          'return measurement;',
        ].join('\n'),
      } satisfies Omit<ValidatedExecuteCodeRequest, 'timeoutMs'>;
      const result = await runtime.executeCode({
        runContext: makeRunContext({
          threadId: testThreadId(948_1),
          stateRoot,
        }),
        request,
      });

      assert.equal(result.ok, true);
      if (!result.ok) {
        return;
      }
      assert.equal(result.value.executionSurface, 'node_via_lab_batch_command');
      assert.equal(result.value.exitCode, 0);
      assert.equal(result.value.stdout, '{"value":7,"unit":"items"}\n');
      assert.equal(result.value.stderr, '');
    } finally {
      assert.deepEqual(await runtime.closeAll(), { ok: true });
      await rm(runtimeRoot, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    }
  },
);
