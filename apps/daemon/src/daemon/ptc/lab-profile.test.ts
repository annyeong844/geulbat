import assert from 'node:assert/strict';
import test from 'node:test';
import {
  admitPtcExecutionProfile,
  describePtcLabWorkspaceReadEgressDecision,
  PTC_LAB_LOCAL_DOCKER_POLICY_ID,
  type PtcLabPolicyProjection,
} from './lab-profile.js';
import {
  PTC_LAB_PACKAGE_CACHE_DEFAULT_MAX_BYTES,
  PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID,
} from './lab-package-cache.js';

void test('admitPtcExecutionProfile selects safe_subset for default request', () => {
  const result = admitPtcExecutionProfile({
    requestedProfile: 'default',
    labEnabled: false,
    reason: 'default_policy',
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.ok ? result.value.metadata.requestedProfile : '',
    'default',
  );
  assert.equal(
    result.ok ? result.value.metadata.selectedProfile : '',
    'safe_subset',
  );
  assert.equal(
    result.ok ? result.value.metadata.policyId : '',
    'ptc_safe_subset_default_v1',
  );
  assert.equal(result.ok ? result.value.labPolicy : null, undefined);
});

void test('admitPtcExecutionProfile rejects requested lab when lab is disabled', () => {
  const result = admitPtcExecutionProfile({
    requestedProfile: 'lab',
    labEnabled: false,
    reason: 'explicit_user_request',
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.reasonCode, 'ptc_lab_not_enabled');
  assert.match(result.ok ? '' : result.message, /not enabled/u);
});

void test('admitPtcExecutionProfile projects local docker lab policy when enabled', () => {
  const result = admitPtcExecutionProfile({
    requestedProfile: 'lab',
    labEnabled: true,
    reason: 'explicit_user_request',
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.value.metadata.requestedProfile : '', 'lab');
  assert.equal(result.ok ? result.value.metadata.selectedProfile : '', 'lab');
  assert.equal(
    result.ok ? result.value.metadata.policyId : '',
    PTC_LAB_LOCAL_DOCKER_POLICY_ID,
  );

  const policy = result.ok ? result.value.labPolicy : undefined;
  assert.ok(policy);
  assert.equal(policy.profile, 'lab');
  assert.equal(policy.boundary.kind, 'docker');
  assert.equal(policy.boundary.boundaryClaim, 'docker_containment');
  assert.equal(policy.shell.mode, 'disabled');
  assert.equal(policy.packageCache.enabled, true);
  assert.equal(policy.packageCache.cacheId, 'ptc_lab_package_cache_local_v1');
  assert.equal(
    policy.packageCache.mountPolicyId,
    PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID,
  );
  assert.equal(
    policy.packageCache.containerRoot,
    PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
  );
  assert.equal(
    policy.packageCache.quota.maxBytes,
    PTC_LAB_PACKAGE_CACHE_DEFAULT_MAX_BYTES,
  );
  assert.equal(
    policy.packageCache.quota.enforcement,
    'not_enforced_record_only',
  );
  assert.equal(policy.packageCache.quota.evictionPolicy, 'manual');
  assert.equal(policy.packageManager.enabled, false);
  assert.deepEqual(policy.packageManager.managers, []);
  assert.equal(policy.packageManager.installMode, 'disabled');
  assert.equal(policy.packageManager.lifecycleScripts.policy, 'disabled');
  assert.equal(
    policy.packageManager.lifecycleScripts.policyId,
    'ptc_lab_lifecycle_scripts_disabled_v1',
  );
  assert.equal(policy.packageManager.maxInstallMs, 0);
  assert.equal(policy.packageManager.maxInstallOutputBytes, 0);
  assert.equal(
    policy.packageManager.telemetryPolicyId,
    'ptc_lab_package_telemetry_pending_v1',
  );
  assert.equal(policy.network.mode, 'disabled');
  assert.equal(policy.browser.enabled, false);
  assert.equal(policy.mounts.artifactWorkspace.enabled, true);
});

void test('admitPtcExecutionProfile returns a fresh default lab policy for each admission', () => {
  const first = admitPtcExecutionProfile({
    requestedProfile: 'lab',
    labEnabled: true,
    reason: 'explicit_user_request',
  });
  assert.equal(first.ok, true);
  if (first.ok && first.value.labPolicy) {
    (first.value.labPolicy.network as unknown as { mode: 'open' }).mode =
      'open';
  }

  const second = admitPtcExecutionProfile({
    requestedProfile: 'lab',
    labEnabled: true,
    reason: 'explicit_user_request',
  });

  assert.equal(
    second.ok ? second.value.labPolicy?.network.mode : '',
    'disabled',
  );
});

void test('admitPtcExecutionProfile never silently downgrades requested lab to safe_subset', () => {
  const disabled = admitPtcExecutionProfile({
    requestedProfile: 'lab',
    labEnabled: false,
    reason: 'explicit_user_request',
  });

  assert.equal(disabled.ok, false);
  assert.equal(disabled.ok ? '' : disabled.reasonCode, 'ptc_lab_not_enabled');
});

void test('describePtcLabWorkspaceReadEgressDecision records combined workspace-read and egress policy', () => {
  const policy: PtcLabPolicyProjection = {
    profile: 'lab',
    policyId: 'ptc_lab_test_policy_v1',
    boundary: { kind: 'docker', boundaryClaim: 'docker_containment' },
    mounts: {
      workspaceRead: {
        enabled: true,
        roots: [{ id: 'project-root', mode: 'read_only' }],
      },
      artifactWorkspace: {
        enabled: true,
        workspaceId: 'artifact-workspace',
        exportPolicyId: 'ptc_lab_artifact_export_v1',
      },
    },
    shell: { mode: 'disabled', maxProcessCount: 0, maxCommandMs: 0 },
    packageCache: {
      enabled: true,
      cacheId: 'ptc_lab_package_cache_local_v1',
      mountPolicyId: PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID,
      containerRoot: PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
      quota: {
        maxBytes: PTC_LAB_PACKAGE_CACHE_DEFAULT_MAX_BYTES,
        enforcement: 'not_enforced_record_only',
        evictionPolicy: 'manual',
      },
    },
    packageManager: {
      enabled: false,
      managers: [],
      installMode: 'disabled',
      lifecycleScripts: {
        policy: 'disabled',
        policyId: 'ptc_lab_lifecycle_scripts_disabled_v1',
      },
      maxInstallMs: 0,
      maxInstallOutputBytes: 0,
      telemetryPolicyId: 'ptc_lab_package_telemetry_pending_v1',
    },
    network: {
      mode: 'allowlisted',
      allowlistId: 'docs-crawl-v1',
      policyVersion: 'ptc_lab_network_policy_v1',
    },
    browser: { enabled: false },
  };

  assert.deepEqual(describePtcLabWorkspaceReadEgressDecision(policy), {
    workspaceReadEnabled: true,
    egressMode: 'allowlisted',
    combinedDecision: 'workspace_read_with_allowlisted_egress',
    allowlistId: 'docs-crawl-v1',
  });
});
