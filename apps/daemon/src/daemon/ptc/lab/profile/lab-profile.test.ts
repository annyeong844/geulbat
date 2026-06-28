import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID,
  PTC_LAB_BROWSER_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_PROFILE_NONE_POLICY_ID,
  PTC_LAB_BROWSER_TELEMETRY_DISABLED_POLICY_ID,
} from '../browser/core/lab-browser-policy-ids.js';
import {
  admitPtcExecutionProfile,
  createPtcLabLocalDockerBatchCommandPolicyProjection,
  createPtcLabLocalDockerPolicyProjection,
  describePtcLabWorkspaceReadEgressDecision,
} from './lab-profile.js';
import {
  PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_MAX_COMMAND_MS,
  PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_MAX_BUFFERED_BYTES_PER_STREAM,
  PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_MAX_PROCESS_COUNT,
  PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_POLICY_ID,
  PTC_LAB_LOCAL_DOCKER_POLICY_ID,
} from './lab-profile-contract.js';
import {
  createPtcLabOpenEgressLocalPolicy,
  PTC_LAB_NETWORK_DISABLED_POLICY_ID,
} from '../network/lab-network-policy.js';
import { PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID } from '../browser/core/lab-browser-policy-ids.js';
import { PTC_LAB_PACKAGE_CACHE_DEFAULT_MAX_BYTES } from '../packages/lab-package-cache-contract.js';
import {
  PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID,
} from '../packages/lab-package-cache-contract.js';

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
  assert.equal(
    policy.network.networkPolicyId,
    PTC_LAB_NETWORK_DISABLED_POLICY_ID,
  );
  assert.deepEqual(policy.browser, {
    enabled: false,
    mode: 'disabled',
    policyVersion: 'ptc_lab_browser_policy_v1',
    browserPolicyId: PTC_LAB_BROWSER_DISABLED_POLICY_ID,
    profilePolicyId: PTC_LAB_BROWSER_PROFILE_NONE_POLICY_ID,
    cookieStorePolicyId: PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID,
    artifactExportPolicyId: PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID,
    telemetryPolicyId: PTC_LAB_BROWSER_TELEMETRY_DISABLED_POLICY_ID,
  });
  assert.equal(policy.mounts.artifactWorkspace.enabled, true);
});

void test('createPtcLabLocalDockerBatchCommandPolicyProjection opens only the batch shell surface', () => {
  const policy = createPtcLabLocalDockerBatchCommandPolicyProjection();

  assert.equal(policy.policyId, PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_POLICY_ID);
  assert.equal(policy.profile, 'lab');
  assert.equal(policy.boundary.kind, 'docker');
  assert.equal(policy.shell.mode, 'batch_command');
  assert.equal(
    policy.shell.maxCommandMs,
    PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_MAX_COMMAND_MS,
  );
  assert.equal(
    policy.shell.maxProcessCount,
    PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_MAX_PROCESS_COUNT,
  );
  assert.equal(
    policy.shell.maxBufferedBytesPerStream,
    PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_MAX_BUFFERED_BYTES_PER_STREAM,
  );
  assert.equal(policy.network.mode, 'disabled');
  assert.equal(policy.browser.enabled, false);
  assert.equal(policy.packageManager.enabled, false);
  assert.equal(policy.mounts.artifactWorkspace.enabled, true);
});

void test('admitPtcExecutionProfile returns a fresh default lab policy for each admission', () => {
  const first = admitPtcExecutionProfile({
    requestedProfile: 'lab',
    labEnabled: true,
    reason: 'explicit_user_request',
  });
  assert.equal(first.ok, true);
  assert.ok(first.ok ? first.value.labPolicy : undefined);
  if (first.ok && first.value.labPolicy) {
    first.value.labPolicy.network = createPtcLabOpenEgressLocalPolicy();
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

void test('describePtcLabWorkspaceReadEgressDecision distinguishes disabled and open egress', () => {
  const disabledPolicy = createPtcLabLocalDockerPolicyProjection();

  assert.deepEqual(describePtcLabWorkspaceReadEgressDecision(disabledPolicy), {
    workspaceReadEnabled: false,
    egressMode: 'disabled',
    combinedDecision: 'no_workspace_read',
  });

  const openPolicy = {
    ...createPtcLabLocalDockerPolicyProjection(),
    mounts: {
      ...createPtcLabLocalDockerPolicyProjection().mounts,
      workspaceRead: {
        enabled: true,
        roots: [{ id: 'workspace-root', mode: 'read_only' as const }],
      },
    },
    network: createPtcLabOpenEgressLocalPolicy(),
  };

  assert.deepEqual(describePtcLabWorkspaceReadEgressDecision(openPolicy), {
    workspaceReadEnabled: true,
    egressMode: 'open',
    combinedDecision: 'workspace_read_with_open_egress',
  });
});
