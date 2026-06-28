import { normalizePtcPackageCacheIdentity } from '../daemon/ptc/lab/packages/lab-package-cache.js';
import {
  PTC_LAB_LIFECYCLE_SCRIPTS_DISABLED_POLICY_ID,
  PTC_LAB_NETWORK_INSTALL_DISABLED_POLICY_ID,
  PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID,
} from '../daemon/ptc/lab/packages/lab-package-cache-contract.js';
import {
  PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
  createPtcLabOpenEgressLocalPolicy,
} from '../daemon/ptc/lab/network/lab-network-policy.js';
import {
  admitPtcExecutionProfile,
  createPtcLabLocalDockerPolicyProjection,
  type PtcLabAdmittedProfile,
  type PtcLabPolicyProjection,
} from '../daemon/ptc/lab/profile/lab-profile.js';
import type { PtcLabPolicyId } from '../daemon/ptc/lab/profile/lab-profile-contract.js';
import type {
  PtcLabCacheOnlyPackageInstallSessionHandle,
  PtcLabNetworkPackageInstallSessionHandle,
} from '../daemon/ptc/lab/packages/lab-package-install-contract.js';
import { PTC_TEST_PRIVATE_GEULBAT_SECRET_PATH } from './ptc-private-path.js';

export const PTC_PACKAGE_INSTALL_TEST_CACHE_TELEMETRY_POLICY_ID =
  'ptc_lab_package_telemetry_cache_only_v1';
export const PTC_PACKAGE_INSTALL_TEST_NETWORK_TELEMETRY_POLICY_ID =
  'ptc_lab_package_telemetry_open_network_v1';
export const PTC_PACKAGE_INSTALL_TEST_PRIVATE_PATH =
  PTC_TEST_PRIVATE_GEULBAT_SECRET_PATH;

const CACHE_ID = 'ptc_lab_package_cache_local_v1';

export function createCacheOnlyPackageInstallLab(args?: {
  networkMode?: PtcLabPolicyProjection['network'];
  lifecyclePolicy?: PtcLabPolicyProjection['packageManager']['lifecycleScripts'];
  managers?: PtcLabPolicyProjection['packageManager']['managers'];
  installMode?: PtcLabPolicyProjection['packageManager']['installMode'];
  maxInstallMs?: number;
  maxInstallOutputBytes?: number;
}): {
  admission: PtcLabAdmittedProfile;
  session: PtcLabCacheOnlyPackageInstallSessionHandle;
} {
  const { admission, policy } = createAdmittedNpmLabPolicy({
    policyId: 'ptc_lab_test_cache_only_install_policy_v1',
    telemetryPolicyId: PTC_PACKAGE_INSTALL_TEST_CACHE_TELEMETRY_POLICY_ID,
    network:
      args?.networkMode ?? createPtcLabLocalDockerPolicyProjection().network,
    installMode: args?.installMode ?? 'cache_only',
    ...(args?.lifecyclePolicy === undefined
      ? {}
      : { lifecyclePolicy: args.lifecyclePolicy }),
    ...(args?.managers === undefined ? {} : { managers: args.managers }),
    ...(args?.maxInstallMs === undefined
      ? {}
      : { maxInstallMs: args.maxInstallMs }),
    ...(args?.maxInstallOutputBytes === undefined
      ? {}
      : { maxInstallOutputBytes: args.maxInstallOutputBytes }),
  });
  if (policy.network.mode !== 'disabled') {
    throw new Error('expected disabled network policy');
  }
  const cacheIdentity = packageCacheIdentityForPolicy(policy);

  return {
    admission,
    session: {
      profile: 'lab',
      policyId: policy.policyId,
      labSessionId: 'lab-session-1',
      containerId: 'container-1',
      packageCacheRootContainerPath:
        PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
      packageCacheMountPolicyId:
        PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID,
      packageCacheId: CACHE_ID,
      packageCacheIdentityHash: cacheIdentity.cacheIdentityHash,
      installMode: 'cache_only',
      networkMode: 'disabled',
      networkPolicyId: policy.network.networkPolicyId,
      networkInstallPolicyId: PTC_LAB_NETWORK_INSTALL_DISABLED_POLICY_ID,
    },
  };
}

export function createNetworkPackageInstallLab(args?: {
  lifecyclePolicy?: PtcLabPolicyProjection['packageManager']['lifecycleScripts'];
  managers?: PtcLabPolicyProjection['packageManager']['managers'];
  installMode?: PtcLabPolicyProjection['packageManager']['installMode'];
  maxInstallMs?: number;
  maxInstallOutputBytes?: number;
}): {
  admission: PtcLabAdmittedProfile;
  session: PtcLabNetworkPackageInstallSessionHandle;
} {
  const { admission, policy } = createAdmittedNpmLabPolicy({
    policyId: 'ptc_lab_test_network_install_policy_v1',
    telemetryPolicyId: PTC_PACKAGE_INSTALL_TEST_NETWORK_TELEMETRY_POLICY_ID,
    network: createPtcLabOpenEgressLocalPolicy(),
    installMode: args?.installMode ?? 'open_network',
    ...(args?.lifecyclePolicy === undefined
      ? {}
      : { lifecyclePolicy: args.lifecyclePolicy }),
    ...(args?.managers === undefined ? {} : { managers: args.managers }),
    ...(args?.maxInstallMs === undefined
      ? {}
      : { maxInstallMs: args.maxInstallMs }),
    ...(args?.maxInstallOutputBytes === undefined
      ? {}
      : { maxInstallOutputBytes: args.maxInstallOutputBytes }),
  });
  if (policy.network.mode !== 'open') {
    throw new Error('expected open network policy');
  }
  const cacheIdentity = packageCacheIdentityForPolicy(policy);

  return {
    admission,
    session: {
      profile: 'lab',
      policyId: policy.policyId,
      labSessionId: 'lab-session-network',
      containerId: 'container-network',
      packageCacheRootContainerPath:
        PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
      packageCacheMountPolicyId:
        PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID,
      packageCacheId: CACHE_ID,
      packageCacheIdentityHash: cacheIdentity.cacheIdentityHash,
      installMode: 'open_network',
      networkMode: 'open',
      networkPolicyId: policy.network.networkPolicyId,
      networkExplicitOptInPolicyId: policy.network.explicitOptInPolicyId,
      networkInstallPolicyId: PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
    },
  };
}

export function createAdmittedNpmLabPolicy(args: {
  policyId: PtcLabPolicyId;
  telemetryPolicyId: string;
  network: PtcLabPolicyProjection['network'];
  lifecyclePolicy?: PtcLabPolicyProjection['packageManager']['lifecycleScripts'];
  managers?: PtcLabPolicyProjection['packageManager']['managers'];
  installMode: PtcLabPolicyProjection['packageManager']['installMode'];
  maxInstallMs?: number;
  maxInstallOutputBytes?: number;
}): {
  admission: PtcLabAdmittedProfile;
  policy: PtcLabPolicyProjection;
} {
  const base = createPtcLabLocalDockerPolicyProjection();
  const policy: PtcLabPolicyProjection = {
    ...base,
    policyId: args.policyId,
    packageManager: {
      enabled: true,
      managers: args.managers ?? ['npm'],
      installMode: args.installMode,
      lifecycleScripts: args.lifecyclePolicy ?? {
        policy: 'disabled',
        policyId: PTC_LAB_LIFECYCLE_SCRIPTS_DISABLED_POLICY_ID,
      },
      maxInstallMs: args.maxInstallMs ?? 5000,
      maxInstallOutputBytes: args.maxInstallOutputBytes ?? 8192,
      telemetryPolicyId: args.telemetryPolicyId,
    },
    network: args.network,
  };
  const admission = admitPtcExecutionProfile({
    requestedProfile: 'lab',
    labEnabled: true,
    reason: 'explicit_user_request',
    labPolicy: policy,
  });
  if (!admission.ok) {
    throw new Error('expected admitted lab policy');
  }
  return { admission: admission.value, policy };
}

function packageCacheIdentityForPolicy(
  policy: PtcLabPolicyProjection,
): ReturnType<typeof normalizePtcPackageCacheIdentity> {
  return normalizePtcPackageCacheIdentity({
    trustContextId: 'trust-package-install-test',
    workspaceRootRealpath: '/workspace/package-install-test',
    labPolicyId: policy.policyId,
    packageCacheId: policy.packageCache.cacheId,
    packageCacheMountPolicyId: policy.packageCache.mountPolicyId,
    packageManagerFamilies: policy.packageManager.managers,
    lifecycleScriptsPolicyId: policy.packageManager.lifecycleScripts.policyId,
    networkInstallPolicyId: policy.network.networkPolicyId,
  });
}
