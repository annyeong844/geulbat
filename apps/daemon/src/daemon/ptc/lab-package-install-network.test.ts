import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PTC_PACKAGE_INSTALL_TEST_NETWORK_TELEMETRY_POLICY_ID,
  createCacheOnlyPackageInstallLab,
  createNetworkPackageInstallLab,
} from '../../test-support/ptc-package-install.js';
import { PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID } from './lab-network-policy.js';
import { admitPtcExecutionProfile } from './lab-profile.js';
import { PTC_LAB_PACKAGE_INSTALL_WORKDIR_EXISTS_MARKER } from './lab-package-install-contract.js';
import { runPtcLabNetworkNpmInstallSmoke } from './lab-package-install.js';
import type {
  PtcLabPackageInstallRunner,
  PtcLabPackageInstallSessionHandle,
} from './lab-package-install-contract.js';

void test('runPtcLabNetworkNpmInstallSmoke rejects default and cache-only policies before runner invocation', async () => {
  const defaultAdmission = admitPtcExecutionProfile({
    requestedProfile: 'lab',
    labEnabled: true,
    reason: 'explicit_user_request',
  });
  if (!defaultAdmission.ok) {
    throw new Error('expected default lab admission');
  }

  const cases = [
    {
      name: 'default lab policy',
      admission: defaultAdmission.value,
    },
    {
      name: 'cache-only lab policy',
      admission: createCacheOnlyPackageInstallLab().admission,
    },
    {
      name: 'open network with cache-only install mode',
      admission: createNetworkPackageInstallLab({ installMode: 'cache_only' })
        .admission,
    },
  ];

  for (const item of cases) {
    const result = await runPtcLabNetworkNpmInstallSmoke({
      admission: item.admission,
      session: createNetworkPackageInstallLab().session,
      request: {
        manager: 'npm',
        installId: 'network-install-1',
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

void test('runPtcLabNetworkNpmInstallSmoke rejects session identity drift before runner invocation', async () => {
  const { admission, session } = createNetworkPackageInstallLab();
  const mismatchedSessions: PtcLabPackageInstallSessionHandle[] = [
    createCacheOnlyPackageInstallLab().session,
    {
      ...session,
      networkExplicitOptInPolicyId: 'ptc_lab_open_egress_other_policy_v1',
    },
    {
      ...session,
      packageCacheMountPolicyId: 'other-mount-policy',
    },
    {
      ...session,
      packageCacheIdentityHash: 'not-a-cache-hash',
    },
  ];

  for (const mismatchedSession of mismatchedSessions) {
    const result = await runPtcLabNetworkNpmInstallSmoke({
      admission,
      session: mismatchedSession,
      request: {
        manager: 'npm',
        installId: 'network-install-1',
        packages: [{ name: 'left-pad', version: '1.3.0' }],
      },
      runner: async () => {
        throw new Error('runner should not be called for identity drift');
      },
    });

    assert.equal(result.ok, false);
    assert.equal(
      result.ok ? '' : result.reasonCode,
      'ptc_lab_package_install_policy_mismatch',
    );
  }
});

void test('runPtcLabNetworkNpmInstallSmoke keeps network argv bounded and non-offline', async () => {
  const { admission, session } = createNetworkPackageInstallLab();
  const invocations: Parameters<PtcLabPackageInstallRunner>[0][] = [];

  const result = await runPtcLabNetworkNpmInstallSmoke({
    admission,
    session,
    request: {
      manager: 'npm',
      installId: 'network-install-1',
      timeoutMs: 1500,
      packages: [
        { name: 'left-pad', version: '1.3.0' },
        { name: '@scope/pkg', version: '0.1.2-beta.1' },
      ],
    },
    runner: async (invocation) => {
      invocations.push(invocation);
      return {
        kind: 'exit',
        exitCode: 0,
        stdout: 'installed packages',
        stderr: '',
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.value.offline : true, false);
  assert.equal(
    result.ok ? result.value.telemetryPolicyId : '',
    PTC_PACKAGE_INSTALL_TEST_NETWORK_TELEMETRY_POLICY_ID,
  );
  assert.equal(
    result.ok ? result.value.networkInstallPolicyId : '',
    PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
  );
  assert.equal(
    result.ok ? result.value.networkTelemetry.metricsCoverage : '',
    'owner_outcome_only',
  );
  assert.equal(
    result.ok ? result.value.networkTelemetry.requestCount : 1,
    undefined,
  );
  const invocationArgs = invocations[0]?.args ?? [];
  assert.deepEqual(invocationArgs.slice(0, 5), [
    'exec',
    'container-network',
    'sh',
    '-eu',
    '-c',
  ]);
  assert.match(
    invocationArgs[5] ?? '',
    new RegExp(PTC_LAB_PACKAGE_INSTALL_WORKDIR_EXISTS_MARKER, 'u'),
  );
  assert.equal(invocationArgs.includes('--offline'), false);
  assert.equal(invocationArgs.includes('--prefer-online'), true);
  assert.equal(invocations[0]?.timeoutMs, 1500);
});

void test('runPtcLabNetworkNpmInstallSmoke preserves non-zero installs as failed telemetry', async () => {
  const { admission, session } = createNetworkPackageInstallLab();

  const result = await runPtcLabNetworkNpmInstallSmoke({
    admission,
    session,
    request: {
      manager: 'npm',
      installId: 'network-install-1',
      packages: [{ name: 'left-pad', version: '1.3.0' }],
    },
    runner: async () => ({
      kind: 'exit',
      exitCode: 1,
      stdout: 'npm failed',
      stderr: 'not found',
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.value.exitCode : 0, 1);
  assert.equal(
    result.ok ? result.value.networkTelemetry.outcome : '',
    'failed',
  );
});

void test('runPtcLabNetworkNpmInstallSmoke taints timeout and cancellation through the real session shape', async () => {
  const cases = [
    {
      kind: 'timeout' as const,
      reasonCode: 'ptc_lab_package_install_timeout' as const,
    },
    {
      kind: 'cancelled' as const,
      reasonCode: 'ptc_lab_package_install_cancelled' as const,
    },
  ];

  for (const item of cases) {
    const { admission, session } = createNetworkPackageInstallLab();
    const taints: Array<{
      reasonCode: string;
      installId: string;
      containerId: string;
    }> = [];
    const result = await runPtcLabNetworkNpmInstallSmoke({
      admission,
      session,
      request: {
        manager: 'npm',
        installId: 'network-install-1',
        packages: [{ name: 'left-pad', version: '1.3.0' }],
      },
      onSessionTainted: (taint) => {
        taints.push(taint);
      },
      runner: async () => ({
        kind: item.kind,
        stdout: '',
        stderr: '',
        processTerminated: false,
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.reasonCode, item.reasonCode);
    assert.deepEqual(taints, [
      {
        reasonCode: item.reasonCode,
        installId: 'network-install-1',
        containerId: 'container-network',
      },
    ]);
  }
});

void test('runPtcLabNetworkNpmInstallSmoke sanitizes network install output', async () => {
  const { admission, session } = createNetworkPackageInstallLab({
    maxInstallOutputBytes: 128,
  });

  const result = await runPtcLabNetworkNpmInstallSmoke({
    admission,
    session,
    request: {
      manager: 'npm',
      installId: 'network-install-1',
      outputExcerptByteLimit: 128,
      packages: [{ name: 'left-pad', version: '1.3.0' }],
    },
    runner: async () => ({
      kind: 'exit',
      exitCode: 0,
      stdout: `GET https://registry.npmjs.org/left-pad /tmp/geulbat-private/.npmrc NPM_TOKEN=secret ${'x'.repeat(256)}`,
      stderr: `/tmp/geulbat-private/.geulbat/provider_token=secret https://registry.npmjs.org/@scope/pkg`,
    }),
  });

  assert.equal(result.ok, true);
  const text = JSON.stringify(result);
  assert.doesNotMatch(
    text,
    /https?:\/\/|registry\.npmjs\.org|\/tmp\/geulbat-private|NPM_TOKEN|provider_token|\.npmrc/u,
  );
  assert.equal(result.ok ? result.value.stdoutTruncated : false, true);
  assert.match(result.ok ? result.value.stdout : '', /\[redacted:url\]/u);
  assert.match(result.ok ? result.value.stdout : '', /\[redacted:path\]/u);
});
