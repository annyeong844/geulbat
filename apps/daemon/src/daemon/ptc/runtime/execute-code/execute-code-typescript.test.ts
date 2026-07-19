import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testThreadId } from '../../../../test-support/thread-id.js';
import { makeRunContext } from '../../../../test-support/run-context.js';
import { runPtcSessionDockerCommand } from '../../lab/session/session-docker-command.js';
import { buildNodeExecuteCodeCommand } from './execute-code-batch-runtime.js';
import type { ValidatedExecuteCodeRequest } from './execute-code-runtime-contract.js';
import { createPtcExecuteCodeRuntime } from './execute-code-runtime.js';
import { buildPtcExecuteCodeSdkHelpBundle } from './execute-code-sdk.js';

const sdkHelpBundle = buildPtcExecuteCodeSdkHelpBundle({
  callbacksEnabled: false,
  sdkHelp: undefined,
});

void test('execute_code runs JavaScript and Node-native TypeScript through the same encoded CommonJS runner', async () => {
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
  assert.match(command, /--experimental-transform-types/u);
  assert.match(command, /--no-warnings=ExperimentalWarning/u);
  assert.match(command, /--input-type=commonjs-typescript/u);
  assert.match(command, /base64 --decode/u);
  assert.match(command, /<<< "\$GEULBAT_PTC_RUNNER_SOURCE"/u);
  assert.doesNotMatch(command, /\$\(node -e/u);
  assert.doesNotMatch(command, /interface Pair|const pair/u);
  assert.deepEqual(sdkHelpBundle.runtime, {
    language: 'javascript_or_node_native_typescript',
    typescript: {
      transform: 'node_experimental_transform_types',
      typeChecking: false,
      tsx: false,
      decorators: false,
      tsconfig: false,
      moduleSystem: 'commonjs',
    },
    executionSurface: 'node_via_lab_batch_command',
    sessionLifecycle: 'runtime_owned_reusable',
  });

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

void test('execute_code runs TypeScript syntax supported by the pinned Node transform', async () => {
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
  assert.equal(execution.exitCode, 0);
  assert.equal(execution.stdout, '1\n');
  assert.equal(execution.stderr, '');
});

void test('execute_code runs explicit ESM TypeScript with static package imports and restores the caller cwd', async () => {
  const packageRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-esm-package-root-'),
  );
  const packageDirectory = join(
    packageRoot,
    'node_modules',
    'geulbat-esm-fixture',
  );
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    join(packageDirectory, 'package.json'),
    JSON.stringify({
      name: 'geulbat-esm-fixture',
      type: 'module',
      exports: './index.js',
    }),
    'utf8',
  );
  await writeFile(
    join(packageDirectory, 'index.js'),
    "export const fixtureValue = 'package-esm';\n",
    'utf8',
  );

  try {
    const esmHelpBundle = buildPtcExecuteCodeSdkHelpBundle({
      callbacksEnabled: false,
      sdkHelp: undefined,
      moduleFormat: 'esm',
    });
    const originalCwd = process.cwd();
    const command = buildNodeExecuteCodeCommand(
      [
        "import { basename } from 'node:path';",
        "import { fixtureValue } from 'geulbat-esm-fixture';",
        "enum ModuleKind { Esm = 'esm' }",
        'const value: string = await Promise.resolve(fixtureValue);',
        "process.stdout.write(JSON.stringify({ moduleKind: ModuleKind.Esm, value, basename: basename('/tmp/esm'), cwd: process.cwd(), helpModuleSystem: geulbat.help().runtime.typescript.moduleSystem }));",
      ].join('\n'),
      {
        sdkHelpBundle: esmHelpBundle,
        installedPackagesNodePath: join(packageRoot, 'node_modules'),
        moduleFormat: 'esm',
      },
    );

    assert.match(command, /--input-type=module-typescript/u);
    assert.doesNotMatch(command, /--input-type=commonjs-typescript/u);
    const execution = await runPtcSessionDockerCommand({
      executable: '/bin/bash',
      args: ['-c', command],
    });
    assert.equal(execution.kind, 'exit');
    if (execution.kind !== 'exit') {
      return;
    }
    assert.equal(execution.exitCode, 0);
    assert.deepEqual(JSON.parse(execution.stdout), {
      moduleKind: 'esm',
      value: 'package-esm',
      basename: 'esm',
      cwd: originalCwd,
      helpModuleSystem: 'esm',
    });
    assert.equal(execution.stderr, '');

    const beforeInstallCommand = buildNodeExecuteCodeCommand(
      [
        "import { basename } from 'node:path';",
        "const value: string = await Promise.resolve('before-install');",
        "process.stdout.write(JSON.stringify({ value, basename: basename('/tmp/ready'), cwd: process.cwd() }));",
      ].join('\n'),
      {
        sdkHelpBundle: esmHelpBundle,
        installedPackagesNodePath: join(
          packageRoot,
          'empty-session-prefix',
          'node_modules',
        ),
        moduleFormat: 'esm',
      },
    );
    const beforeInstallExecution = await runPtcSessionDockerCommand({
      executable: '/bin/bash',
      args: ['-c', beforeInstallCommand],
    });
    assert.equal(beforeInstallExecution.kind, 'exit');
    if (beforeInstallExecution.kind !== 'exit') {
      return;
    }
    assert.equal(beforeInstallExecution.exitCode, 0);
    assert.deepEqual(JSON.parse(beforeInstallExecution.stdout), {
      value: 'before-install',
      basename: 'ready',
      cwd: originalCwd,
    });
    assert.equal(beforeInstallExecution.stderr, '');
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});

void test('execute_code keeps TSX outside the Node-native TypeScript boundary', async () => {
  const command = buildNodeExecuteCodeCommand(
    'const view = <section>unsupported</section>;\nreturn view;',
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
  assert.match(execution.stderr, /SyntaxError|ERR_/u);
});

void test(
  'execute_code runs CommonJS and explicit ESM TypeScript through the real pinned Docker runtime',
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
          "enum Unit { Items = 'items' }",
          'type Measurement = { value: number; unit: Unit };',
          'const measurement: Measurement = { value: 7, unit: Unit.Items };',
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

      const esmRequest = {
        code: [
          "import { basename } from 'node:path';",
          "enum ModuleKind { Esm = 'esm' }",
          "const awaited: string = await Promise.resolve('ready');",
          "process.stdout.write(JSON.stringify({ awaited, basename: basename('/tmp/esm'), moduleKind: ModuleKind.Esm, helpModuleSystem: geulbat.help().runtime.typescript.moduleSystem }));",
        ].join('\n'),
        moduleFormat: 'esm',
      } satisfies Omit<ValidatedExecuteCodeRequest, 'timeoutMs'>;
      const esmResult = await runtime.executeCode({
        runContext: makeRunContext({
          threadId: testThreadId(948_1),
          stateRoot,
        }),
        request: esmRequest,
      });

      assert.equal(esmResult.ok, true);
      if (!esmResult.ok) {
        return;
      }
      assert.equal(
        esmResult.value.executionSurface,
        'node_via_lab_batch_command',
      );
      assert.equal(esmResult.value.exitCode, 0);
      assert.deepEqual(JSON.parse(esmResult.value.stdout), {
        awaited: 'ready',
        basename: 'esm',
        moduleKind: 'esm',
        helpModuleSystem: 'esm',
      });
      assert.equal(esmResult.value.stderr, '');
    } finally {
      assert.deepEqual(await runtime.closeAll(), { ok: true });
      await rm(runtimeRoot, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    }
  },
);
