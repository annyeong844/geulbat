import { mkdir, realpath, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { sha256StableJson } from '@geulbat/shared-utils/stable-json';
import { applyPtcHostPathMode } from './host-path-mode.js';
import { PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT } from './lab-package-cache-contract.js';
import type {
  PtcLabPackageCacheFailureReason,
  PtcLabPackageCacheResult,
  PtcPackageCacheIdentity,
  PtcPackageCacheIdentityInput,
  PtcPackageCacheRoot,
} from './lab-package-cache-contract.js';

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
  const cacheIdentityHash = sha256StableJson(base);
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
  await applyPtcHostPathMode({
    path: packageCachesRoot,
    pathKind: 'ptc_package_caches_root',
    mode: 0o700,
  });
  await mkdir(root.hostPath, { recursive: true });
  await applyPtcHostPathMode({
    path: root.hostPath,
    pathKind: 'ptc_package_cache_root',
    mode: 0o700,
  });
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
