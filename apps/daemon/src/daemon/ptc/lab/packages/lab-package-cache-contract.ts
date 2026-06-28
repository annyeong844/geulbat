export const PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT =
  '/geulbat/package-cache' as const;
export const PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID =
  'ptc_session_package_cache_mount_v1' as const;
export const PTC_LAB_PACKAGE_CACHE_DEFAULT_ID =
  'ptc_lab_package_cache_local_v1' as const;
export const PTC_LAB_PACKAGE_CACHE_DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
export const PTC_LAB_LIFECYCLE_SCRIPTS_DISABLED_POLICY_ID =
  'ptc_lab_lifecycle_scripts_disabled_v1' as const;
const PTC_LAB_PACKAGE_TELEMETRY_PENDING_POLICY_ID =
  'ptc_lab_package_telemetry_pending_v1' as const;
export const PTC_LAB_NETWORK_INSTALL_DISABLED_POLICY_ID =
  'ptc_lab_network_disabled_v1' as const;

export type PtcLabPackageManagerName = 'npm' | 'pip' | 'playwright';

export type PtcLabPackageInstallMode =
  | 'disabled'
  | 'cache_only'
  | 'open_network';

type PtcLabPackageLifecycleScriptsPolicy =
  | 'disabled'
  | 'allowed_with_explicit_policy';

export interface PtcLabPackageCachePolicy {
  enabled: boolean;
  cacheId: string;
  mountPolicyId: typeof PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID;
  containerRoot: typeof PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT;
  quota: {
    maxBytes: number;
    enforcement: 'not_enforced_record_only' | 'enforced';
    evictionPolicy: 'manual' | 'least_recently_used';
  };
}

export interface PtcLabPackageManagerPolicy {
  enabled: boolean;
  managers: PtcLabPackageManagerName[];
  installMode: PtcLabPackageInstallMode;
  lifecycleScripts: {
    policy: PtcLabPackageLifecycleScriptsPolicy;
    policyId: string;
  };
  maxInstallMs: number;
  maxInstallOutputBytes: number;
  telemetryPolicyId: string;
}

export interface PtcPackageCacheIdentityInput {
  trustContextId: string;
  workspaceRootRealpath: string;
  labPolicyId: string;
  packageCacheId: string;
  packageCacheMountPolicyId: string;
  packageManagerFamilies: PtcLabPackageManagerName[];
  lifecycleScriptsPolicyId: string;
  networkInstallPolicyId: string;
}

interface PtcPackageCacheIdentityFieldSource {
  trustContextId: string;
  workspaceRootRealpath: string;
  labPolicyId: string;
  packageCacheId: string;
  packageCacheMountPolicyId: string;
  packageManagerFamilies: readonly PtcLabPackageManagerName[];
  lifecycleScriptsPolicyId: string;
  networkInstallPolicyId: string;
}

export interface PtcPackageCacheIdentity extends PtcPackageCacheIdentityInput {
  cacheIdentityHash: string;
}

export interface PtcPackageCacheRoot {
  cacheIdentityHash: string;
  hostPath: string;
  containerPath: typeof PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT;
}

export type PtcLabPackageCacheFailureReason =
  | 'ptc_lab_package_cache_policy_invalid'
  | 'ptc_lab_package_cache_policy_mismatch'
  | 'ptc_lab_package_cache_cleanup_failed';

export type PtcLabPackageCacheResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reasonCode: PtcLabPackageCacheFailureReason;
      message: string;
      diagnostics?: Record<string, string | number | boolean>;
    };

export function createDefaultPtcLabPackageCachePolicy(): PtcLabPackageCachePolicy {
  return {
    enabled: true,
    cacheId: PTC_LAB_PACKAGE_CACHE_DEFAULT_ID,
    mountPolicyId: PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID,
    containerRoot: PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
    quota: {
      maxBytes: PTC_LAB_PACKAGE_CACHE_DEFAULT_MAX_BYTES,
      enforcement: 'not_enforced_record_only',
      evictionPolicy: 'manual',
    },
  };
}

export function createDefaultPtcLabPackageManagerPolicy(): PtcLabPackageManagerPolicy {
  return {
    enabled: false,
    managers: [],
    installMode: 'disabled',
    lifecycleScripts: {
      policy: 'disabled',
      policyId: PTC_LAB_LIFECYCLE_SCRIPTS_DISABLED_POLICY_ID,
    },
    maxInstallMs: 0,
    maxInstallOutputBytes: 0,
    telemetryPolicyId: PTC_LAB_PACKAGE_TELEMETRY_PENDING_POLICY_ID,
  };
}

export function pickPtcPackageCacheIdentityInput(
  source: PtcPackageCacheIdentityFieldSource,
): PtcPackageCacheIdentityInput {
  return {
    trustContextId: source.trustContextId,
    workspaceRootRealpath: source.workspaceRootRealpath,
    labPolicyId: source.labPolicyId,
    packageCacheId: source.packageCacheId,
    packageCacheMountPolicyId: source.packageCacheMountPolicyId,
    packageManagerFamilies: [...source.packageManagerFamilies],
    lifecycleScriptsPolicyId: source.lifecycleScriptsPolicyId,
    networkInstallPolicyId: source.networkInstallPolicyId,
  };
}
