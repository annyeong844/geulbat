import test from 'node:test';
import assert from 'node:assert/strict';
import { createDaemonContext } from '../../context.js';
import {
  PTC_EXECUTE_CODE_INSTALLED_PACKAGES_NODE_PATH,
  PTC_PACKAGE_INSTALL_TOOL_NAME,
  type PtcPackageInstallRuntime,
} from '../../ptc/runtime/execute-code/execute-code-runtime-contract.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { isToolObjectParameters } from '../types.js';
import { createBuiltinToolRegistryStore } from './catalog.js';
import { installPackagesTool } from './install-packages.js';

void test('install_packages metadata: strict schema, no time budget field, opt-in no-approval write surface', () => {
  assert.equal(installPackagesTool.name, PTC_PACKAGE_INSTALL_TOOL_NAME);
  assert.equal(installPackagesTool.sideEffectLevel, 'write');
  assert.equal(installPackagesTool.requiresApproval, false);
  assert.equal(installPackagesTool.mayMutateComputerFiles, false);
  const parameters = installPackagesTool.parameters;
  assert.ok(isToolObjectParameters(parameters));
  assert.deepEqual(parameters.required, ['packages']);
  assert.ok('packages' in parameters.properties);
  assert.ok(!('timeoutMs' in parameters.properties));
  assert.ok(!('registry' in parameters.properties));
  assert.ok(!('lifecycleScripts' in parameters.properties));
  assert.match(installPackagesTool.description, /CommonJS require\(\)/u);
  assert.match(installPackagesTool.description, /explicit-ESM static imports/u);
  const metadata = installPackagesTool.catalogSearchMetadata;
  assert.ok(metadata);
  assert.match(metadata.whenToUse, /explicit-ESM/u);
  assert.match(metadata.searchHints.join(' '), /esm package import/u);
  assert.doesNotMatch(metadata.notFor, /Version ranges|latest/u);
});

void test('install_packages is absent from the default registry and present only with the operator opt-in', () => {
  const defaultRegistry = createBuiltinToolRegistryStore();
  assert.equal(
    defaultRegistry
      .getAllRegisteredToolNames()
      .includes(PTC_PACKAGE_INSTALL_TOOL_NAME),
    false,
  );

  const optInRegistry = createBuiltinToolRegistryStore({
    includeInstallPackagesTool: true,
  });
  assert.equal(
    optInRegistry
      .getAllRegisteredToolNames()
      .includes(PTC_PACKAGE_INSTALL_TOOL_NAME),
    true,
  );
});

void test('install_packages requires the package install runtime service', async () => {
  const result = await installPackagesTool.execute(
    { packages: [{ name: 'left-pad', version: '1.3.0' }] },
    {
      callId: 'call-install-packages-no-runtime',
      stateRoot: '/workspace/home-state',

      workingDirectory: 'project',
      threadId: testThreadId(940),
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'execution_failed');
});

void test('install_packages delegates to the runtime and returns sanitized blatant-authority output', async () => {
  const daemonContext = createDaemonContext();
  let observedPackages: unknown;
  const ptcPackageInstall: PtcPackageInstallRuntime = {
    async installPackages(args) {
      observedPackages = args.request.packages;
      return {
        ok: true,
        value: {
          ok: true,
          capabilityId: PTC_PACKAGE_INSTALL_TOOL_NAME,
          labPolicyId: 'ptc_lab_execute_code_open_network_package_install_v1',
          profile: 'lab',
          manager: 'npm',
          installMode: 'open_network',
          packages: [{ name: 'left-pad', version: '^1.3.0' }],
          resolvedPackages: [
            {
              name: 'left-pad',
              requestedSpec: '^1.3.0',
              resolvedVersion: '1.3.0',
              integrity: 'sha512-left-pad',
            },
          ],
          exitCode: 0,
          stdout: 'added 1 package\n',
          stderr: '',
          effectiveTimeoutMs: 900_000,
          durationMs: 1234,
          installedPackagesNodePath:
            PTC_EXECUTE_CODE_INSTALLED_PACKAGES_NODE_PATH,
          sessionLifecycle: {
            mode: 'runtime_owned_reusable',
            retainedAfterExecution: true,
          },
          provenance: { recorded: true, dependencyClosureCount: 2 },
        },
      };
    },
  };

  const result = await installPackagesTool.execute(
    { packages: [{ name: 'left-pad', version: '^1.3.0' }] },
    {
      callId: 'call-install-packages-success',
      stateRoot: '/workspace/home-state',

      workingDirectory: 'project',
      threadId: testThreadId(941),
      agentSpawnRuntime: { ...daemonContext, ptcPackageInstall },
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(observedPackages, [{ name: 'left-pad', version: '^1.3.0' }]);
  const output = JSON.parse(result.output) as Record<string, unknown>;
  assert.equal(output.kind, 'ptc_package_install_result');
  assert.equal(output.installMode, 'open_network');
  assert.equal(
    output.labPolicyId,
    'ptc_lab_execute_code_open_network_package_install_v1',
  );
  // Resolver evidence: requested spec resolves to an exact version.
  assert.deepEqual(output.resolvedPackages, [
    {
      name: 'left-pad',
      requestedSpec: '^1.3.0',
      resolvedVersion: '1.3.0',
      integrity: 'sha512-left-pad',
    },
  ]);
  assert.equal(Object.hasOwn(output, 'containerId'), false);
  assert.equal(Object.hasOwn(output, 'installId'), false);
});

void test('install_packages accepts a package with no version and forwards it without a version field', async () => {
  const daemonContext = createDaemonContext();
  let observed: unknown;
  const ptcPackageInstall: PtcPackageInstallRuntime = {
    async installPackages(args) {
      observed = args.request.packages;
      return {
        ok: true,
        value: {
          ok: true,
          capabilityId: PTC_PACKAGE_INSTALL_TOOL_NAME,
          labPolicyId: 'ptc_lab_execute_code_open_network_package_install_v1',
          profile: 'lab',
          manager: 'npm',
          installMode: 'open_network',
          packages: [{ name: 'express', version: 'latest' }],
          resolvedPackages: [
            {
              name: 'express',
              requestedSpec: 'latest',
              resolvedVersion: '4.21.2',
              integrity: null,
            },
          ],
          exitCode: 0,
          stdout: '',
          stderr: '',
          effectiveTimeoutMs: 900_000,
          durationMs: 1,
          installedPackagesNodePath:
            PTC_EXECUTE_CODE_INSTALLED_PACKAGES_NODE_PATH,
          sessionLifecycle: {
            mode: 'runtime_owned_reusable',
            retainedAfterExecution: true,
          },
          provenance: { recorded: true, dependencyClosureCount: 1 },
        },
      };
    },
  };

  const result = await installPackagesTool.execute(
    { packages: [{ name: 'express' }] },
    {
      callId: 'call-install-packages-latest',
      stateRoot: '/workspace/home-state',

      workingDirectory: 'project',
      threadId: testThreadId(943),
      agentSpawnRuntime: { ...daemonContext, ptcPackageInstall },
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(observed, [{ name: 'express' }]);
});

void test('install_packages surfaces the disabled opt-in as a stable classified failure', async () => {
  const daemonContext = createDaemonContext();
  const ptcPackageInstall: PtcPackageInstallRuntime = {
    async installPackages() {
      return {
        ok: false,
        reasonCode: 'ptc_package_install_disabled',
        message: 'PTC package install is not enabled',
      };
    },
  };

  const result = await installPackagesTool.execute(
    { packages: [{ name: 'left-pad', version: '1.3.0' }] },
    {
      callId: 'call-install-packages-disabled',
      stateRoot: '/workspace/home-state',

      workingDirectory: 'project',
      threadId: testThreadId(942),
      agentSpawnRuntime: { ...daemonContext, ptcPackageInstall },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'unsupported_mode');
  const output = JSON.parse(result.output ?? '{}') as Record<string, unknown>;
  assert.equal(output.kind, 'ptc_package_install_error');
  assert.equal(output.reasonCode, 'ptc_package_install_disabled');
});
