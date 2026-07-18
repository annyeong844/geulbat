import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

void test('enabled package install runs exec on the open-network policy with NODE_PATH and installs into the shared session', async () => {
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

    // Same runtime, same session family: exec joins the open bridge and gets
    // NODE_PATH so require() reaches the installed tree.
    const exec = await runtime.executeCode({
      runContext,
      request: { code: 'console.log(require("fixture-top"))' },
      sdkProjection: TEST_SDK_PROJECTION,
    });
    assert.equal(exec.ok, true);

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
    const nodePathCommand = fixture.invocations
      .map(execCommandOf)
      .find((command) => command?.includes('GEULBAT_PTC_RUNNER_B64'));
    assert.ok(nodePathCommand);
    assert.ok(
      nodePathCommand.includes(
        `NODE_PATH='${PTC_EXECUTE_CODE_INSTALLED_PACKAGES_NODE_PATH}'`,
      ),
    );
  } finally {
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

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
