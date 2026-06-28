import assert from 'node:assert/strict';
import test from 'node:test';
import { PTC_PACKAGE_INSTALL_TEST_PRIVATE_PATH } from '../../../../test-support/ptc-package-install.js';
import {
  PTC_PACKAGE_INSTALL_TEST_CACHE_TELEMETRY_POLICY_ID,
  createAdmittedNpmLabPolicy,
  createCacheOnlyPackageInstallLab,
  createNetworkPackageInstallLab,
} from '../../../../test-support/ptc-package-install.js';
import { createPtcLabOpenEgressLocalPolicy } from '../network/lab-network-policy.js';
import { admitPtcExecutionProfile } from '../profile/lab-profile.js';
import {
  PTC_LAB_PACKAGE_INSTALL_WORKDIR_EXISTS_EXIT_CODE,
  PTC_LAB_PACKAGE_INSTALL_WORKDIR_EXISTS_MARKER,
} from './lab-package-install-contract.js';
import { runPtcLabCacheOnlyNpmInstallSmoke } from './lab-package-install.js';
import type {
  PtcLabPackageInstallRunner,
  PtcLabPackageInstallSessionHandle,
} from './lab-package-install-contract.js';
import { runDefaultPackageInstallRunner } from './lab-package-install-result.js';

void test('runPtcLabCacheOnlyNpmInstallSmoke rejects unavailable or widened policies before runner invocation', async () => {
  const defaultAdmission = admitPtcExecutionProfile({
    requestedProfile: 'lab',
    labEnabled: true,
    reason: 'explicit_user_request',
  });
  if (!defaultAdmission.ok) {
    throw new Error('expected default lab admission');
  }
  const openNetworkCacheOnlyAdmission = createAdmittedNpmLabPolicy({
    policyId: 'ptc_lab_test_cache_only_open_network_policy_v1',
    telemetryPolicyId: PTC_PACKAGE_INSTALL_TEST_CACHE_TELEMETRY_POLICY_ID,
    network: createPtcLabOpenEgressLocalPolicy(),
    installMode: 'cache_only',
  }).admission;

  const cases = [
    {
      name: 'default package manager disabled',
      admission: defaultAdmission.value,
    },
    {
      name: 'open network cannot be used by cache-only smoke',
      admission: openNetworkCacheOnlyAdmission,
    },
    {
      name: 'lifecycle scripts cannot be enabled',
      admission: createCacheOnlyPackageInstallLab({
        lifecyclePolicy: {
          policy: 'allowed_with_explicit_policy',
          policyId: 'ptc_lab_lifecycle_scripts_allowed_v1',
        },
      }).admission,
    },
    {
      name: 'npm manager must be present',
      admission: createCacheOnlyPackageInstallLab({ managers: ['pip'] })
        .admission,
    },
  ];

  for (const item of cases) {
    const result = await runPtcLabCacheOnlyNpmInstallSmoke({
      admission: item.admission,
      session: createCacheOnlyPackageInstallLab().session,
      request: {
        manager: 'npm',
        installId: 'install-1',
        packages: [{ name: 'left-pad', version: '1.3.0' }],
      },
      runner: async () => {
        throw new Error(`runner should not be called for ${item.name}`);
      },
    });

    assert.equal(result.ok, false, item.name);
    assert.equal(
      result.ok ? '' : result.reasonCode,
      'ptc_lab_package_install_policy_disabled',
    );
  }
});

void test('runPtcLabCacheOnlyNpmInstallSmoke rejects session drift before runner invocation', async () => {
  const { admission, session } = createCacheOnlyPackageInstallLab();
  const mismatchedSessions: PtcLabPackageInstallSessionHandle[] = [
    createNetworkPackageInstallLab().session,
    { ...session, packageCacheMountPolicyId: 'other-mount-policy' },
    { ...session, packageCacheIdentityHash: 'not-a-cache-hash' },
  ];

  for (const mismatchedSession of mismatchedSessions) {
    const result = await runPtcLabCacheOnlyNpmInstallSmoke({
      admission,
      session: mismatchedSession,
      request: {
        manager: 'npm',
        installId: 'install-1',
        packages: [{ name: 'left-pad', version: '1.3.0' }],
      },
      runner: async () => {
        throw new Error('runner should not be called for session drift');
      },
    });

    assert.equal(result.ok, false);
    assert.equal(
      result.ok ? '' : result.reasonCode,
      'ptc_lab_package_install_policy_mismatch',
    );
  }
});

void test('runPtcLabCacheOnlyNpmInstallSmoke rejects unsafe package requests before runner invocation', async () => {
  const { admission, session } = createCacheOnlyPackageInstallLab();
  const tooManyPackages = Array.from({ length: 9 }, (_, index) => ({
    name: `pkg-${index}`,
    version: '1.0.0',
  }));
  const cases = [
    { installId: '', packages: [{ name: 'left-pad', version: '1.3.0' }] },
    {
      installId: '../escape',
      packages: [{ name: 'left-pad', version: '1.3.0' }],
    },
    { installId: 'ok', packages: [] },
    { installId: 'ok', packages: tooManyPackages },
    {
      installId: 'ok',
      packages: [{ name: 'left-pad@1.3.0', version: '1.3.0' }],
    },
    {
      installId: 'ok',
      packages: [{ name: '@scope/pkg/extra', version: '1.3.0' }],
    },
    {
      installId: 'ok',
      packages: [{ name: 'left-pad', version: '^1.3.0' }],
    },
    {
      installId: 'ok',
      packages: [{ name: 'left-pad', version: 'latest' }],
    },
    {
      installId: 'ok',
      packages: [{ name: 'left-pad', version: 'file:../pkg' }],
    },
    {
      installId: 'ok',
      packages: [
        { name: 'left-pad', version: '1.3.0' },
        { name: 'left-pad', version: '1.2.0' },
      ],
    },
  ];

  for (const request of cases) {
    const result = await runPtcLabCacheOnlyNpmInstallSmoke({
      admission,
      session,
      request: { manager: 'npm', ...request },
      runner: async () => {
        throw new Error('runner should not be called for invalid request');
      },
    });

    assert.equal(result.ok, false, JSON.stringify(request));
    assert.equal(
      result.ok ? '' : result.reasonCode,
      'ptc_lab_package_install_request_invalid',
    );
  }
});

void test('runPtcLabCacheOnlyNpmInstallSmoke keeps cache-only argv offline and disabled', async () => {
  const { admission, session } = createCacheOnlyPackageInstallLab();
  const invocations: Parameters<PtcLabPackageInstallRunner>[0][] = [];

  const result = await runPtcLabCacheOnlyNpmInstallSmoke({
    admission,
    session,
    request: {
      manager: 'npm',
      installId: 'install-1',
      timeoutMs: 1000,
      packages: [
        { name: 'left-pad', version: '1.3.0' },
        { name: '@scope/pkg', version: '0.1.2-beta.1' },
      ],
    },
    runner: async (invocation) => {
      invocations.push(invocation);
      return {
        kind: 'exit',
        exitCode: 1,
        stdout: 'npm cache miss maybe',
        stderr: 'offline cache miss',
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.value.offline : false, true);
  assert.equal(
    result.ok ? result.value.cacheObservation : '',
    'npm_reported_cache_miss_possible',
  );
  const invocationArgs = invocations[0]?.args ?? [];
  assert.deepEqual(invocationArgs.slice(0, 5), [
    'exec',
    'container-1',
    'sh',
    '-eu',
    '-c',
  ]);
  assert.match(
    invocationArgs[5] ?? '',
    new RegExp(PTC_LAB_PACKAGE_INSTALL_WORKDIR_EXISTS_MARKER, 'u'),
  );
  assert.deepEqual(invocationArgs.slice(8, 16), [
    'npm',
    'install',
    '--offline',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--cache',
    '/geulbat/package-cache/npm',
  ]);
  assert.equal(invocationArgs.includes('--prefer-online'), false);
});

void test('runPtcLabCacheOnlyNpmInstallSmoke maps boundary failures without leaking diagnostics', async () => {
  const { admission, session } = createCacheOnlyPackageInstallLab();
  const timeout = await runPtcLabCacheOnlyNpmInstallSmoke({
    admission,
    session,
    request: {
      manager: 'npm',
      installId: 'install-1',
      packages: [{ name: 'left-pad', version: '1.3.0' }],
    },
    onSessionTainted: async () => {
      throw new Error(PTC_PACKAGE_INSTALL_TEST_PRIVATE_PATH);
    },
    runner: async () => ({
      kind: 'timeout',
      stdout: '',
      stderr: '',
      processTerminated: false,
    }),
  });
  assert.equal(timeout.ok, false);
  assert.equal(
    timeout.ok ? '' : timeout.reasonCode,
    'ptc_lab_package_install_timeout',
  );
  assert.doesNotMatch(JSON.stringify(timeout), /geulbat-private|\.geulbat/u);

  for (const runnerKind of [
    'package_manager_unavailable',
    'workdir_exists',
  ] as const) {
    const result = await runPtcLabCacheOnlyNpmInstallSmoke({
      admission,
      session,
      request: {
        manager: 'npm',
        installId: 'install-1',
        packages: [{ name: 'left-pad', version: '1.3.0' }],
      },
      runner: async () => ({ kind: runnerKind, stdout: '', stderr: '' }),
    });
    assert.equal(result.ok, false);
  }
});

void test('runDefaultPackageInstallRunner maps only the package install workdir preflight marker', async () => {
  const markerScript = `process.stderr.write(${JSON.stringify(
    `${PTC_LAB_PACKAGE_INSTALL_WORKDIR_EXISTS_MARKER}\n`,
  )}); process.exit(${PTC_LAB_PACKAGE_INSTALL_WORKDIR_EXISTS_EXIT_CODE});`;
  const markerResult = await runDefaultPackageInstallRunner({
    executable: process.execPath,
    args: ['-e', markerScript],
    timeoutMs: 1000,
  });
  assert.equal(markerResult.kind, 'workdir_exists');

  const plainScript = `process.stderr.write('npm exited 73\\n'); process.exit(${PTC_LAB_PACKAGE_INSTALL_WORKDIR_EXISTS_EXIT_CODE});`;
  const plainResult = await runDefaultPackageInstallRunner({
    executable: process.execPath,
    args: ['-e', plainScript],
    timeoutMs: 1000,
  });
  assert.equal(plainResult.kind, 'exit');
  assert.equal(plainResult.kind === 'exit' ? plainResult.exitCode : 0, 73);
});

void test('runPtcLabCacheOnlyNpmInstallSmoke sanitizes output without truncating it', async () => {
  const { admission, session } = createCacheOnlyPackageInstallLab({
    maxInstallOutputBytes: 128,
  });

  const result = await runPtcLabCacheOnlyNpmInstallSmoke({
    admission,
    session,
    request: {
      manager: 'npm',
      installId: 'install-1',
      packages: [{ name: 'left-pad', version: '1.3.0' }],
    },
    runner: async () => ({
      kind: 'exit',
      exitCode: 0,
      stdout: `/geulbat/package-cache/npm /tmp/geulbat-package-installs/install-1/.npmrc NPM_TOKEN=secret ${'x'.repeat(256)}`,
      stderr: '/geulbat/callbacks/epoch/callback.sock provider_token=secret',
    }),
  });

  assert.equal(result.ok, true);
  const text = JSON.stringify(result);
  assert.doesNotMatch(
    text,
    /\/geulbat\/package-cache|\/tmp\/geulbat-package-installs|callback\.sock|NPM_TOKEN|provider_token|\.npmrc/u,
  );
  assert.match(result.ok ? result.value.stdout : '', /x{256}/u);
});
