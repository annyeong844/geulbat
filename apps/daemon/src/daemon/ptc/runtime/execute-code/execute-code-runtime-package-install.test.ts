import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPtcSessionDockerCommandFixture } from '../../../../test-support/ptc-session-docker.js';
import { testThreadId } from '../../../../test-support/thread-id.js';
import { makeRunContext } from '../../../../test-support/run-context.js';
import { PTC_LAB_OPEN_NETWORK_PACKAGE_INSTALL_POLICY_ID } from '../../lab/profile/lab-profile-contract.js';
import { PTC_LAB_DOCKER_BRIDGE_OPEN_NETWORK_NAME } from '../../lab/network/lab-network-policy.js';
import {
  createPtcSessionDockerLocalBatchCommandPolicy,
  createPtcSessionDockerOpenNetworkPackageInstallPolicy,
  PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_SDK_PROJECTION_MOUNT_POLICY_ID,
  type PtcSessionDockerCommandInvocation,
} from '../../lab/session/session-docker-contract.js';
import {
  createPtcExecuteCodeRuntime,
  isPtcExecuteCodeCellStateActive,
} from './execute-code-runtime.js';
import {
  PTC_EXECUTE_CODE_INSTALLED_PACKAGES_PREFIX,
  PTC_EXECUTE_CODE_INSTALLED_PACKAGES_NODE_PATH,
  type PtcExecuteCodeRuntimeSdkProjection,
} from './execute-code-runtime-contract.js';

void test('isPtcExecuteCodeCellStateActive treats unsettled cell states as blocking installs', () => {
  for (const active of ['admitting', 'running', 'terminating']) {
    assert.equal(isPtcExecuteCodeCellStateActive(active), true, active);
  }
  for (const settled of ['terminal_retained', 'terminal_expired']) {
    assert.equal(isPtcExecuteCodeCellStateActive(settled), false, settled);
  }
});

const TEST_CALLBACK_TRANSPORT_POLICY = Object.freeze({
  maxFrameBytes: 8192,
  maxOpenConnections: 4,
  maxCallbacks: 20,
  callbackTimeoutMs: 30_000,
  maxResponseBytes: 8192,
});

const TEST_PACKAGE_INSTALL_CONFIG = Object.freeze({
  enabled: true,
  maxInstallMs: 120_000,
  maxPackages: 4,
  tmpTmpfsSize: '512m',
  maxStdoutBytes: 16 * 1024 * 1024,
  maxStderrBytes: 16 * 1024 * 1024,
});

const TEST_SDK_PROJECTION: PtcExecuteCodeRuntimeSdkProjection = {
  sdkVersion: 'geulbat-tool-library-sdk-v1',
  sdkProjectionHash:
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  policyId: 'ptc-sdk-read-tools-v1',
  runtimeCompatibilityRange: 'ptc_execute_code_sdk_v1',
  importSpecifier: 'geulbat-sdk',
  manifestModule: 'manifest.js',
  manifestSourceHash:
    'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  mount: {
    hostRootPath: '/private/tool-library/projections/sha256-a',
    containerRootPath: PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT,
    mountPolicyId: PTC_SESSION_DOCKER_SDK_PROJECTION_MOUNT_POLICY_ID,
    sdkVersion: 'geulbat-tool-library-sdk-v1',
    sdkProjectionHash:
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    policyId: 'ptc-sdk-read-tools-v1',
    importSpecifier: 'geulbat-sdk',
  },
  modules: [],
};

const FIXTURE_DEPENDENCY_CLOSURE = [
  {
    path: 'node_modules/fixture-top',
    name: 'fixture-top',
    version: '1.0.0',
    resolved: 'https://registry.npmjs.org/fixture-top/-/fixture-top-1.0.0.tgz',
    integrity: 'sha512-top',
    role: 'prod',
  },
  {
    path: 'node_modules/fixture-transitive',
    name: 'fixture-transitive',
    version: '2.1.0',
    resolved:
      'https://registry.npmjs.org/fixture-transitive/-/fixture-transitive-2.1.0.tgz',
    integrity: 'sha512-transitive',
    role: 'prod',
  },
];

function execCommandOf(
  invocation: PtcSessionDockerCommandInvocation,
): string | undefined {
  if (invocation.args[0] !== 'exec') {
    return undefined;
  }
  const command = invocation.args.at(-1);
  return typeof command === 'string' ? command : undefined;
}

void test('package install disabled by default: installPackages rejects and exec keeps the disabled-network batch policy', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-pkg-disabled-ws-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-pkg-disabled-rt-'),
  );
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    commandResult: (invocation) => {
      if (invocation.args[0] === 'exec') {
        return { kind: 'exit', exitCode: 0, stdout: 'ok\n', stderr: '' };
      }
      return undefined;
    },
  });
  const runtime = createPtcExecuteCodeRuntime({
    callbackTransportPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
    commandRunner: fixture.runner,
    runtimeRootForState: () => runtimeRoot,
    packageInstall: undefined,
  });

  try {
    const install = await runtime.installPackages({
      runContext: makeRunContext({
        threadId: testThreadId(921),
        stateRoot,
      }),
      request: { packages: [{ name: 'left-pad', version: '1.3.0' }] },
    });
    assert.equal(install.ok, false);
    if (install.ok) {
      return;
    }
    assert.equal(install.reasonCode, 'ptc_package_install_disabled');

    const exec = await runtime.executeCode({
      runContext: makeRunContext({
        threadId: testThreadId(921),
        stateRoot,
      }),
      request: { code: 'console.log("ok")' },
    });
    assert.equal(exec.ok, true);

    const createInvocation = fixture.invocations.find(
      (invocation) => invocation.args[0] === 'create',
    );
    assert.ok(createInvocation);
    const networkFlagIndex = createInvocation.args.indexOf('--network');
    assert.equal(createInvocation.args[networkFlagIndex + 1], 'none');
    const execCommand = fixture.invocations
      .map(execCommandOf)
      .find((command) => command !== undefined);
    assert.ok(execCommand);
    assert.doesNotMatch(execCommand, /NODE_PATH/u);
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('enabled package install exposes one shared session to CommonJS and explicit ESM package resolution', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-pkg-enabled-ws-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-pkg-enabled-rt-'),
  );
  let installCommand: string | undefined;
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerOpenNetworkPackageInstallPolicy({
      tmpTmpfsSize: TEST_PACKAGE_INSTALL_CONFIG.tmpTmpfsSize,
    }),
    commandResult: (invocation) => {
      const command = execCommandOf(invocation);
      if (command === undefined) {
        return undefined;
      }
      if (command.includes('npm install')) {
        installCommand = command;
        return {
          kind: 'exit',
          exitCode: 0,
          stdout:
            'fetched https://registry.npmjs.org/fixture-top/-/fixture-top-1.0.0.tgz\nadded 2 packages\n',
          stderr: '',
        };
      }
      if (command.includes('package-lock.json')) {
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: JSON.stringify(FIXTURE_DEPENDENCY_CLOSURE),
          stderr: '',
        };
      }
      return { kind: 'exit', exitCode: 0, stdout: 'ran\n', stderr: '' };
    },
  });
  const runtime = createPtcExecuteCodeRuntime({
    callbackTransportPolicy: TEST_CALLBACK_TRANSPORT_POLICY,
    commandRunner: fixture.runner,
    runtimeRootForState: () => runtimeRoot,
    packageInstall: TEST_PACKAGE_INSTALL_CONFIG,
  });

  try {
    const runContext = makeRunContext({
      threadId: testThreadId(922),
      stateRoot,
    });
    const install = await runtime.installPackages({
      runContext,
      // Range spec exercises the slice 2 resolver: npm resolves it and we
      // surface the resolved exact version from the closure.
      request: { packages: [{ name: 'fixture-top', version: '^1.0.0' }] },
      sdkProjection: TEST_SDK_PROJECTION,
    });
    assert.equal(install.ok, true);
    if (!install.ok) {
      return;
    }
    assert.equal(
      install.value.labPolicyId,
      PTC_LAB_OPEN_NETWORK_PACKAGE_INSTALL_POLICY_ID,
    );
    assert.equal(install.value.installMode, 'open_network');
    assert.equal(install.value.exitCode, 0);
    assert.deepEqual(install.value.resolvedPackages, [
      {
        name: 'fixture-top',
        requestedSpec: '^1.0.0',
        resolvedVersion: '1.0.0',
        integrity: 'sha512-top',
      },
    ]);
    assert.equal(
      install.value.installedPackagesNodePath,
      PTC_EXECUTE_CODE_INSTALLED_PACKAGES_NODE_PATH,
    );
    // Sanitization: no URL material in the model-visible excerpts.
    assert.doesNotMatch(install.value.stdout, /https?:\/\//u);
    assert.doesNotMatch(install.value.stdout, /registry\.npmjs\.org/u);
    assert.equal(install.value.provenance.recorded, true);
    assert.equal(
      install.value.provenance.dependencyClosureCount,
      FIXTURE_DEPENDENCY_CLOSURE.length,
    );

    assert.ok(installCommand);
    assert.ok(installCommand.includes("'fixture-top@^1.0.0'"));
    assert.ok(installCommand.includes('--ignore-scripts'));

    // Daemon-private provenance records the full dependency closure,
    // including the transitive entry the model never asked for.
    const provenanceFiles: string[] = [];
    const stack = [runtimeRoot];
    while (stack.length > 0) {
      const dir = stack.pop();
      if (dir === undefined) {
        break;
      }
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const entryPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(entryPath);
        } else if (
          entry.isFile() &&
          entryPath.includes('package-provenance') &&
          entry.name.endsWith('.json')
        ) {
          provenanceFiles.push(entryPath);
        }
      }
    }
    assert.equal(provenanceFiles.length, 1);
    const provenanceFile = provenanceFiles[0];
    assert.ok(provenanceFile !== undefined);
    const provenance = JSON.parse(await readFile(provenanceFile, 'utf8')) as {
      requestedPackages: unknown[];
      dependencyClosure: Array<{ name: string; resolved?: string }>;
      closureObservation: string;
    };
    assert.equal(provenance.requestedPackages.length, 1);
    assert.equal(provenance.closureObservation, 'observed');
    assert.equal(
      provenance.dependencyClosure.length,
      FIXTURE_DEPENDENCY_CLOSURE.length,
    );
    assert.ok(
      provenance.dependencyClosure.some(
        (entry) => entry.name === 'fixture-transitive',
      ),
    );

    // Same runtime, same session family: CommonJS uses NODE_PATH while ESM
    // starts from the package prefix so Node's standard resolver reaches the
    // same installed tree.
    const exec = await runtime.executeCode({
      runContext,
      request: { code: 'console.log(require("fixture-top"))' },
      sdkProjection: TEST_SDK_PROJECTION,
    });
    assert.equal(exec.ok, true);
    const esmExec = await runtime.executeCode({
      runContext,
      request: {
        code: "import fixture from 'fixture-top'; process.stdout.write(String(fixture));",
        moduleFormat: 'esm',
      },
      sdkProjection: TEST_SDK_PROJECTION,
    });
    assert.equal(esmExec.ok, true);

    const createInvocation = fixture.invocations.find(
      (invocation) => invocation.args[0] === 'create',
    );
    assert.ok(createInvocation);
    assert.equal(
      fixture.invocations.filter(
        (invocation) => invocation.args[0] === 'create',
      ).length,
      1,
    );
    assert.ok(
      createInvocation.args.includes(
        `type=bind,src=${TEST_SDK_PROJECTION.mount.hostRootPath},dst=${PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT},readonly`,
      ),
    );
    const networkFlagIndex = createInvocation.args.indexOf('--network');
    assert.equal(
      createInvocation.args[networkFlagIndex + 1],
      PTC_LAB_DOCKER_BRIDGE_OPEN_NETWORK_NAME,
    );
    assert.ok(
      createInvocation.args.some((arg) =>
        String(arg).includes(
          `geulbat.labPolicyId=${PTC_LAB_OPEN_NETWORK_PACKAGE_INSTALL_POLICY_ID}`,
        ),
      ),
    );
    const commonJsCommand = fixture.invocations
      .map(execCommandOf)
      .find((command) => command?.includes('NODE_PATH='));
    assert.ok(commonJsCommand);
    assert.ok(
      commonJsCommand.includes(
        `NODE_PATH='${PTC_EXECUTE_CODE_INSTALLED_PACKAGES_NODE_PATH}'`,
      ),
    );
    assert.match(commonJsCommand, /--input-type=commonjs-typescript/u);
    const esmCommand = fixture.invocations
      .map(execCommandOf)
      .find((command) => command?.includes('--input-type=module-typescript'));
    assert.ok(esmCommand);
    assert.doesNotMatch(esmCommand, /NODE_PATH=/u);
    assert.ok(
      esmCommand.includes(
        `mkdir -p '${PTC_EXECUTE_CODE_INSTALLED_PACKAGES_PREFIX}' || exit $?;`,
      ),
    );
    assert.ok(
      esmCommand.includes(
        `cd '${PTC_EXECUTE_CODE_INSTALLED_PACKAGES_PREFIX}' || exit $?;`,
      ),
    );
    assert.match(esmCommand, /GEULBAT_PTC_ORIGINAL_CWD/u);
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test('package install uses a monotonic duration clock when the wall clock does not advance', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-pkg-duration-ws-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-pkg-duration-rt-'),
  );
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerOpenNetworkPackageInstallPolicy({
      tmpTmpfsSize: TEST_PACKAGE_INSTALL_CONFIG.tmpTmpfsSize,
    }),
    commandResult: async (invocation) => {
      const command = execCommandOf(invocation);
      if (command?.includes('npm install')) {
        await delay(5);
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'added 2 packages\n',
          stderr: '',
        };
      }
      if (command?.includes('package-lock.json')) {
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: JSON.stringify(FIXTURE_DEPENDENCY_CLOSURE),
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
    packageInstall: TEST_PACKAGE_INSTALL_CONFIG,
  });
  t.mock.method(Date, 'now', () => 1_000);

  try {
    const install = await runtime.installPackages({
      runContext: makeRunContext({
        threadId: testThreadId(923),
        stateRoot,
      }),
      request: { packages: [{ name: 'fixture-top', version: '1.0.0' }] },
      sdkProjection: TEST_SDK_PROJECTION,
    });

    assert.equal(install.ok, true);
    assert.ok(install.ok && install.value.durationMs > 0);
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

void test(
  'real registry install is reachable through explicit ESM in the same Docker session',
  {
    skip: process.env.GEULBAT_RUN_PTC_PACKAGE_INSTALL_NETWORK_E2E !== '1',
  },
  async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-ptc-pkg-live-ws-'));
    const runtimeRoot = await mkdtemp(
      join(tmpdir(), 'geulbat-ptc-pkg-live-rt-'),
    );
    const runtime = createPtcExecuteCodeRuntime({
      realpathStateRoot: async () => stateRoot,
      runtimeRootForState: () => runtimeRoot,
      packageInstall: TEST_PACKAGE_INSTALL_CONFIG,
    });

    try {
      const runContext = makeRunContext({
        threadId: testThreadId(922_1),
        stateRoot,
      });
      const install = await runtime.installPackages({
        runContext,
        request: {
          packages: [{ name: 'is-number', version: '7.0.0' }],
        },
      });
      if (!install.ok) {
        assert.fail(`live package install failed: ${JSON.stringify(install)}`);
      }

      assert.equal(install.value.exitCode, 0);
      assert.equal(install.value.stderr, '');
      assert.deepEqual(
        install.value.resolvedPackages.map(
          ({ name, requestedSpec, resolvedVersion }) => ({
            name,
            requestedSpec,
            resolvedVersion,
          }),
        ),
        [
          {
            name: 'is-number',
            requestedSpec: '7.0.0',
            resolvedVersion: '7.0.0',
          },
        ],
      );
      assert.match(
        install.value.resolvedPackages[0]?.integrity ?? '',
        /^sha512-/u,
      );
      assert.equal(
        install.value.installedPackagesNodePath,
        PTC_EXECUTE_CODE_INSTALLED_PACKAGES_NODE_PATH,
      );
      assert.equal(install.value.provenance.recorded, true);
      assert.equal(install.value.provenance.dependencyClosureCount, 1);
      assert.equal(install.value.sessionLifecycle.retainedAfterExecution, true);

      const modelVisibleInstall = JSON.stringify(install.value);
      assert.doesNotMatch(modelVisibleInstall, /https?:\/\//u);
      assert.doesNotMatch(modelVisibleInstall, /registry\.npmjs\.org/u);
      assert.equal(modelVisibleInstall.includes(stateRoot), false);
      assert.equal(modelVisibleInstall.includes(runtimeRoot), false);
      assert.doesNotMatch(modelVisibleInstall, /container(?:Id)?/iu);

      const cacheIdentities = await readdir(
        join(runtimeRoot, 'ptc-package-caches'),
      );
      assert.equal(cacheIdentities.length, 1);
      const cacheIdentity = cacheIdentities[0];
      assert.ok(cacheIdentity !== undefined);
      assert.ok(
        (
          await readdir(
            join(runtimeRoot, 'ptc-package-caches', cacheIdentity, 'npm'),
            { recursive: true },
          )
        ).length > 0,
      );

      const cwdProbe = await runtime.executeCode({
        runContext,
        request: { code: 'return process.cwd();' },
      });
      if (!cwdProbe.ok) {
        assert.fail(`cwd probe failed: ${JSON.stringify(cwdProbe)}`);
      }
      assert.equal(
        cwdProbe.value.executionSurface,
        'node_via_lab_batch_command',
      );
      assert.equal(cwdProbe.value.exitCode, 0);
      const callerCwd = cwdProbe.value.stdout.trimEnd();
      assert.notEqual(callerCwd, '');

      const esmExec = await runtime.executeCode({
        runContext,
        request: {
          code: [
            "import isNumber from 'is-number';",
            "const answer: boolean = await Promise.resolve(isNumber('42'));",
            'process.stdout.write(JSON.stringify({ answer, cwd: process.cwd(), moduleSystem: geulbat.help().runtime.typescript.moduleSystem }));',
          ].join('\n'),
          moduleFormat: 'esm',
        },
      });
      if (!esmExec.ok) {
        assert.fail(`ESM package import failed: ${JSON.stringify(esmExec)}`);
      }

      assert.equal(
        esmExec.value.executionSurface,
        'node_via_lab_batch_command',
      );
      assert.equal(esmExec.value.exitCode, 0);
      assert.equal(esmExec.value.stderr, '');
      assert.deepEqual(JSON.parse(esmExec.value.stdout), {
        answer: true,
        cwd: callerCwd,
        moduleSystem: 'esm',
      });
      assert.notEqual(callerCwd, PTC_EXECUTE_CODE_INSTALLED_PACKAGES_PREFIX);
    } finally {
      assert.deepEqual(await runtime.closeAll(), { ok: true });
      await rm(runtimeRoot, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    }
  },
);

void test('open-network package install policy has a distinct session identity from the batch-command policy', () => {
  const batchPolicy = createPtcSessionDockerLocalBatchCommandPolicy();
  const openPolicy = createPtcSessionDockerOpenNetworkPackageInstallPolicy({
    tmpTmpfsSize: '512m',
  });
  assert.notEqual(openPolicy.labPolicyId, batchPolicy.labPolicyId);
  assert.equal(
    openPolicy.labPolicyId,
    PTC_LAB_OPEN_NETWORK_PACKAGE_INSTALL_POLICY_ID,
  );
  assert.notDeepEqual(openPolicy.network, batchPolicy.network);
  assert.deepEqual(openPolicy.packageManagerFamilies, ['npm']);
  assert.deepEqual(batchPolicy.packageManagerFamilies, []);
  assert.equal(openPolicy.network.mode, 'open');
  assert.equal(batchPolicy.network.mode, 'disabled');
});
