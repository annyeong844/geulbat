import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PTC_LAB_LIFECYCLE_SCRIPTS_DISABLED_POLICY_ID,
  PTC_LAB_NETWORK_INSTALL_DISABLED_POLICY_ID,
  PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID,
} from './lab-package-cache.js';
import {
  admitPtcExecutionProfile,
  createPtcLabLocalDockerPolicyProjection,
  type PtcLabAdmittedProfile,
  type PtcLabPolicyProjection,
} from './lab-profile.js';
import {
  runPtcLabCacheOnlyNpmInstallSmoke,
  type PtcLabPackageInstallRunner,
  type PtcLabPackageInstallSessionHandle,
} from './lab-package-install.js';

const TELEMETRY_POLICY_ID = 'ptc_lab_package_telemetry_cache_only_v1';
const CACHE_ID = 'ptc_lab_package_cache_local_v1';
const CACHE_HASH = 'a'.repeat(64);
const PRIVATE_PATH = ['', 'home', 'user', '.geulbat', 'secret'].join('/');

function cacheOnlyLab(args?: {
  networkMode?: PtcLabPolicyProjection['network'];
  lifecyclePolicy?: PtcLabPolicyProjection['packageManager']['lifecycleScripts'];
  managers?: PtcLabPolicyProjection['packageManager']['managers'];
  installMode?: PtcLabPolicyProjection['packageManager']['installMode'];
  maxInstallMs?: number;
  maxInstallOutputBytes?: number;
}): {
  admission: PtcLabAdmittedProfile;
  session: PtcLabPackageInstallSessionHandle;
} {
  const base = createPtcLabLocalDockerPolicyProjection();
  const labPolicy: PtcLabPolicyProjection = {
    ...base,
    policyId: 'ptc_lab_test_cache_only_install_policy_v1',
    packageManager: {
      enabled: true,
      managers: args?.managers ?? ['npm'],
      installMode: args?.installMode ?? 'cache_only',
      lifecycleScripts: args?.lifecyclePolicy ?? {
        policy: 'disabled',
        policyId: PTC_LAB_LIFECYCLE_SCRIPTS_DISABLED_POLICY_ID,
      },
      maxInstallMs: args?.maxInstallMs ?? 5000,
      maxInstallOutputBytes: args?.maxInstallOutputBytes ?? 8192,
      telemetryPolicyId: TELEMETRY_POLICY_ID,
    },
    network: args?.networkMode ?? {
      mode: 'disabled',
      policyVersion: PTC_LAB_NETWORK_INSTALL_DISABLED_POLICY_ID,
    },
  };
  const admission = admitPtcExecutionProfile({
    requestedProfile: 'lab',
    labEnabled: true,
    reason: 'explicit_user_request',
    labPolicy,
  });
  if (!admission.ok) {
    throw new Error('expected admitted lab policy');
  }

  return {
    admission: admission.value,
    session: {
      profile: 'lab',
      policyId: labPolicy.policyId,
      labSessionId: 'lab-session-1',
      containerId: 'container-1',
      packageCacheRootContainerPath:
        PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
      packageCacheMountPolicyId:
        PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID,
      packageCacheId: CACHE_ID,
      packageCacheIdentityHash: CACHE_HASH,
    },
  };
}

void test('runPtcLabCacheOnlyNpmInstallSmoke rejects the default lab policy before runner invocation', async () => {
  const defaultAdmission = admitPtcExecutionProfile({
    requestedProfile: 'lab',
    labEnabled: true,
    reason: 'explicit_user_request',
  });
  if (!defaultAdmission.ok) {
    throw new Error('expected default lab admission');
  }

  const result = await runPtcLabCacheOnlyNpmInstallSmoke({
    admission: defaultAdmission.value,
    session: cacheOnlyLab().session,
    request: {
      manager: 'npm',
      installId: 'install-1',
      packages: [{ name: 'left-pad', version: '1.3.0' }],
    },
    runner: async () => {
      throw new Error('runner should not be called');
    },
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? '' : result.reasonCode,
    'ptc_lab_package_install_policy_disabled',
  );
});

void test('runPtcLabCacheOnlyNpmInstallSmoke builds offline npm argv and returns completed summary', async () => {
  const { admission, session } = cacheOnlyLab();
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
    now: (() => {
      let value = 20;
      return () => {
        value += 11;
        return value;
      };
    })(),
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
  assert.equal(result.ok ? result.value.exitCode : 0, 1);
  assert.equal(result.ok ? result.value.durationMs : 0, 11);
  assert.deepEqual(result.ok ? result.value.packages : [], [
    { name: '@scope/pkg', version: '0.1.2-beta.1' },
    { name: 'left-pad', version: '1.3.0' },
  ]);
  assert.equal(
    result.ok ? result.value.cacheObservation : '',
    'npm_reported_cache_miss_possible',
  );
  assert.equal(result.ok ? result.value.offline : false, true);
  assert.equal(result.ok ? result.value.lifecycleScripts : '', 'disabled');
  assert.equal(
    result.ok ? result.value.telemetryPolicyId : '',
    TELEMETRY_POLICY_ID,
  );

  assert.equal(invocations.length, 1);
  assert.deepEqual(invocations[0]?.args, [
    'exec',
    'container-1',
    'npm',
    'install',
    '--offline',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--cache',
    '/geulbat/package-cache/npm',
    '--userconfig',
    '/tmp/geulbat-package-installs/install-1/empty-npmrc',
    '--globalconfig',
    '/tmp/geulbat-package-installs/install-1/empty-global-npmrc',
    '--prefix',
    '/tmp/geulbat-package-installs/install-1',
    '@scope/pkg@0.1.2-beta.1',
    'left-pad@1.3.0',
  ]);
  assert.equal(invocations[0]?.executable, 'docker');
  assert.equal(invocations[0]?.timeoutMs, 1000);
});

void test('runPtcLabCacheOnlyNpmInstallSmoke rejects invalid policy or session before runner invocation', async () => {
  const cases = [
    {
      name: 'network enabled',
      admission: cacheOnlyLab({
        networkMode: {
          mode: 'allowlisted',
          allowlistId: 'registry',
          policyVersion: 'ptc_lab_network_allowlisted_registry_v1',
        },
      }).admission,
      session: cacheOnlyLab().session,
      reasonCode: 'ptc_lab_package_install_policy_disabled',
    },
    {
      name: 'lifecycle enabled',
      admission: cacheOnlyLab({
        lifecyclePolicy: {
          policy: 'allowed_with_explicit_policy',
          policyId: 'ptc_lab_lifecycle_scripts_allowed_v1',
        },
      }).admission,
      session: cacheOnlyLab().session,
      reasonCode: 'ptc_lab_package_install_policy_disabled',
    },
    {
      name: 'session cache mismatch',
      admission: cacheOnlyLab().admission,
      session: {
        ...cacheOnlyLab().session,
        packageCacheMountPolicyId: 'other-mount-policy',
      },
      reasonCode: 'ptc_lab_package_install_policy_mismatch',
    },
  ];

  for (const item of cases) {
    const result = await runPtcLabCacheOnlyNpmInstallSmoke({
      admission: item.admission,
      session: item.session,
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
    assert.equal(result.ok ? '' : result.reasonCode, item.reasonCode);
  }
});

void test('runPtcLabCacheOnlyNpmInstallSmoke rejects invalid package requests before runner invocation', async () => {
  const { admission, session } = cacheOnlyLab();
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

void test('runPtcLabCacheOnlyNpmInstallSmoke maps timeout and preserves reason when taint hook throws', async () => {
  const { admission, session } = cacheOnlyLab();

  const result = await runPtcLabCacheOnlyNpmInstallSmoke({
    admission,
    session,
    request: {
      manager: 'npm',
      installId: 'install-1',
      packages: [{ name: 'left-pad', version: '1.3.0' }],
    },
    onSessionTainted: async () => {
      throw new Error(PRIVATE_PATH);
    },
    runner: async () => ({
      kind: 'timeout',
      stdout: '',
      stderr: '',
      processTerminated: false,
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? '' : result.reasonCode,
    'ptc_lab_package_install_timeout',
  );
  assert.equal(
    result.ok ? false : result.diagnostics?.sessionTaintCleanupFailed,
    true,
  );
  assert.doesNotMatch(JSON.stringify(result), /user|\.geulbat/u);
});

void test('runPtcLabCacheOnlyNpmInstallSmoke maps package manager unavailable and workdir exists', async () => {
  const { admission, session } = cacheOnlyLab();

  const unavailable = await runPtcLabCacheOnlyNpmInstallSmoke({
    admission,
    session,
    request: {
      manager: 'npm',
      installId: 'install-1',
      packages: [{ name: 'left-pad', version: '1.3.0' }],
    },
    runner: async () => ({
      kind: 'package_manager_unavailable',
      stdout: '',
      stderr: 'npm not found',
    }),
  });
  assert.equal(unavailable.ok, false);
  assert.equal(
    unavailable.ok ? '' : unavailable.reasonCode,
    'ptc_lab_package_manager_unavailable',
  );

  const workdirExists = await runPtcLabCacheOnlyNpmInstallSmoke({
    admission,
    session,
    request: {
      manager: 'npm',
      installId: 'install-1',
      packages: [{ name: 'left-pad', version: '1.3.0' }],
    },
    runner: async () => ({
      kind: 'workdir_exists',
      stdout: '',
      stderr: '',
    }),
  });
  assert.equal(workdirExists.ok, false);
  assert.equal(
    workdirExists.ok ? '' : workdirExists.reasonCode,
    'ptc_lab_package_install_workdir_exists',
  );
});

void test('runPtcLabCacheOnlyNpmInstallSmoke caps and sanitizes install output', async () => {
  const { admission, session } = cacheOnlyLab({
    maxInstallOutputBytes: 128,
  });

  const result = await runPtcLabCacheOnlyNpmInstallSmoke({
    admission,
    session,
    request: {
      manager: 'npm',
      installId: 'install-1',
      outputExcerptByteLimit: 128,
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
  assert.equal(result.ok ? result.value.stdoutTruncated : false, true);
  assert.match(result.ok ? result.value.stdout : '', /\[truncated\]/u);
  assert.match(
    result.ok ? result.value.stdout : '',
    /\[redacted:package-cache-path\]/u,
  );
  assert.match(
    result.ok ? result.value.stderr : '',
    /\[redacted:callback-path\]/u,
  );
});
