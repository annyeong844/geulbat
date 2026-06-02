import { createHash } from 'node:crypto';
import { chmod, mkdir, realpath, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';

export const PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT =
  '/geulbat/package-cache' as const;
export const PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID =
  'ptc_session_package_cache_mount_v1' as const;
export const PTC_LAB_PACKAGE_CACHE_DEFAULT_ID =
  'ptc_lab_package_cache_local_v1' as const;
export const PTC_LAB_PACKAGE_CACHE_DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
export const PTC_LAB_LIFECYCLE_SCRIPTS_DISABLED_POLICY_ID =
  'ptc_lab_lifecycle_scripts_disabled_v1' as const;
export const PTC_LAB_PACKAGE_TELEMETRY_PENDING_POLICY_ID =
  'ptc_lab_package_telemetry_pending_v1' as const;
export const PTC_LAB_NETWORK_INSTALL_DISABLED_POLICY_ID =
  'ptc_lab_network_disabled_v1' as const;

export type PtcLabPackageManagerName = 'npm' | 'pip' | 'playwright';

export type PtcLabPackageInstallMode =
  | 'disabled'
  | 'cache_only'
  | 'allowlisted_network'
  | 'open_network';

export type PtcLabPackageLifecycleScriptsPolicy =
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
  | 'ptc_lab_package_cache_root_unavailable'
  | 'ptc_lab_package_cache_policy_mismatch'
  | 'ptc_lab_package_cache_cleanup_failed'
  | 'ptc_lab_package_cache_quota_unenforced';

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

export function normalizePtcPackageCacheIdentity(
  input: PtcPackageCacheIdentityInput,
): PtcPackageCacheIdentity {
  const packageManagerFamilies = [...input.packageManagerFamilies].sort();
  const base = {
    trustContextId: input.trustContextId,
    workspaceRootRealpath: input.workspaceRootRealpath,
    labPolicyId: input.labPolicyId,
    packageCacheId: input.packageCacheId,
    packageCacheMountPolicyId: input.packageCacheMountPolicyId,
    packageManagerFamilies,
    lifecycleScriptsPolicyId: input.lifecycleScriptsPolicyId,
    networkInstallPolicyId: input.networkInstallPolicyId,
  };
  const cacheIdentityHash = createHash('sha256')
    .update(stableStringify(base), 'utf8')
    .digest('hex');
  return { ...base, cacheIdentityHash };
}

export function buildPtcPackageCacheRoot(args: {
  runtimeRoot: string;
  identity: PtcPackageCacheIdentity;
}): PtcPackageCacheRoot {
  return {
    cacheIdentityHash: args.identity.cacheIdentityHash,
    hostPath: join(
      args.runtimeRoot,
      'ptc-package-caches',
      args.identity.cacheIdentityHash,
    ),
    containerPath: PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
  };
}

export async function preparePtcPackageCacheRoot(args: {
  runtimeRoot: string;
  identity: PtcPackageCacheIdentity;
}): Promise<PtcPackageCacheRoot> {
  const root = buildPtcPackageCacheRoot(args);
  const packageCachesRoot = join(args.runtimeRoot, 'ptc-package-caches');
  await mkdir(packageCachesRoot, { recursive: true });
  await chmod(packageCachesRoot, 0o700).catch(() => {});
  await mkdir(root.hostPath, { recursive: true });
  await chmod(root.hostPath, 0o700).catch(() => {});
  return root;
}

export async function cleanupPtcPackageCacheRoot(args: {
  runtimeRoot: string;
  identity: PtcPackageCacheIdentity;
  expectedCacheIdentityHash: string;
}): Promise<PtcLabPackageCacheResult<void>> {
  if (
    !isSafeCacheIdentity(args.identity) ||
    !isNormalizedPtcPackageCacheIdentity(args.identity)
  ) {
    return failure(
      'ptc_lab_package_cache_policy_invalid',
      'PTC lab package cache identity is invalid',
    );
  }
  if (
    args.expectedCacheIdentityHash !== args.identity.cacheIdentityHash ||
    !/^[a-f0-9]{64}$/u.test(args.expectedCacheIdentityHash)
  ) {
    return failure(
      'ptc_lab_package_cache_policy_mismatch',
      'PTC lab package cache identity does not match cleanup request',
    );
  }

  const namespaceRoot = join(args.runtimeRoot, 'ptc-package-caches');
  const root = buildPtcPackageCacheRoot(args);
  try {
    const namespaceRealpath = await realpath(namespaceRoot).catch(
      () => namespaceRoot,
    );
    const parentRealpath = await realpath(join(root.hostPath, '..')).catch(
      () => namespaceRoot,
    );
    if (
      parentRealpath !== namespaceRealpath &&
      !parentRealpath.startsWith(`${namespaceRealpath}${sep}`)
    ) {
      return failure(
        'ptc_lab_package_cache_policy_invalid',
        'PTC lab package cache cleanup path is invalid',
      );
    }
    await rm(root.hostPath, { recursive: true, force: true });
    return { ok: true, value: undefined };
  } catch {
    return failure(
      'ptc_lab_package_cache_cleanup_failed',
      'PTC lab package cache cleanup failed',
      { cleanupFailed: true },
    );
  }
}

function isNormalizedPtcPackageCacheIdentity(
  identity: PtcPackageCacheIdentity,
): boolean {
  const recomputed = normalizePtcPackageCacheIdentity({
    trustContextId: identity.trustContextId,
    workspaceRootRealpath: identity.workspaceRootRealpath,
    labPolicyId: identity.labPolicyId,
    packageCacheId: identity.packageCacheId,
    packageCacheMountPolicyId: identity.packageCacheMountPolicyId,
    packageManagerFamilies: identity.packageManagerFamilies,
    lifecycleScriptsPolicyId: identity.lifecycleScriptsPolicyId,
    networkInstallPolicyId: identity.networkInstallPolicyId,
  });

  return recomputed.cacheIdentityHash === identity.cacheIdentityHash;
}

function isSafeCacheIdentity(identity: PtcPackageCacheIdentity): boolean {
  return (
    isSafePolicyToken(identity.trustContextId) &&
    isSafePolicyToken(identity.labPolicyId) &&
    isSafePolicyToken(identity.packageCacheId) &&
    isSafePolicyToken(identity.packageCacheMountPolicyId) &&
    isSafePolicyToken(identity.lifecycleScriptsPolicyId) &&
    isSafePolicyToken(identity.networkInstallPolicyId) &&
    /^[a-f0-9]{64}$/u.test(identity.cacheIdentityHash)
  );
}

function isSafePolicyToken(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u.test(value);
}

function failure(
  reasonCode: PtcLabPackageCacheFailureReason,
  message: string,
  diagnostics?: Record<string, string | number | boolean>,
): PtcLabPackageCacheResult<never> {
  return diagnostics === undefined
    ? { ok: false, reasonCode, message }
    : { ok: false, reasonCode, message, diagnostics };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
