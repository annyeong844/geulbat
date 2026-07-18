import { realpath, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { ptcFailure } from '../../shared/lab-spine.js';
import { isPtcSha256Hex } from '../../shared/sha256.js';
import { hashPtcStableJson } from '../../shared/stable-identity.js';
import { pickPtcPackageCacheIdentityInput } from './lab-package-cache-contract.js';
import type {
  PtcLabPackageCacheFailureReason,
  PtcLabPackageCacheResult,
  PtcPackageCacheIdentity,
  PtcPackageCacheIdentityInput,
} from './lab-package-cache-contract.js';

export function normalizePtcPackageCacheIdentity(
  input: PtcPackageCacheIdentityInput,
): PtcPackageCacheIdentity {
  const base = pickPtcPackageCacheIdentityInput({
    ...input,
    packageManagerFamilies: [...input.packageManagerFamilies].sort(),
  });
  const cacheIdentityHash = hashPtcStableJson(base);
  return { ...base, cacheIdentityHash };
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
    !isPtcSha256Hex(args.expectedCacheIdentityHash)
  ) {
    return failure(
      'ptc_lab_package_cache_policy_mismatch',
      'PTC lab package cache identity does not match cleanup request',
    );
  }

  return await cleanupPtcPackageCacheRootByHash({
    runtimeRoot: args.runtimeRoot,
    cacheIdentityHash: args.expectedCacheIdentityHash,
  });
}

export async function cleanupPtcPackageCacheRootByHash(args: {
  runtimeRoot: string;
  cacheIdentityHash: string;
}): Promise<PtcLabPackageCacheResult<void>> {
  if (!isPtcSha256Hex(args.cacheIdentityHash)) {
    return failure(
      'ptc_lab_package_cache_policy_invalid',
      'PTC lab package cache cleanup identity is invalid',
    );
  }

  const namespaceRoot = join(args.runtimeRoot, 'ptc-package-caches');
  const rootPath = join(namespaceRoot, args.cacheIdentityHash);
  try {
    const namespaceRealpath = await realpath(namespaceRoot);
    const parentRealpath = await realpath(join(rootPath, '..'));
    if (
      parentRealpath !== namespaceRealpath &&
      !parentRealpath.startsWith(`${namespaceRealpath}${sep}`)
    ) {
      return failure(
        'ptc_lab_package_cache_policy_invalid',
        'PTC lab package cache cleanup path is invalid',
      );
    }
    await rm(rootPath, { recursive: true, force: true });
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
  const recomputed = normalizePtcPackageCacheIdentity(
    pickPtcPackageCacheIdentityInput(identity),
  );

  return recomputed.cacheIdentityHash === identity.cacheIdentityHash;
}

function isSafeCacheIdentity(identity: PtcPackageCacheIdentity): boolean {
  return (
    isSafePackageCacheIdentityToken(identity.trustContextId) &&
    (identity.ephemeralBurstId === undefined ||
      isSafePackageCacheIdentityToken(identity.ephemeralBurstId)) &&
    isSafePackageCacheIdentityToken(identity.labPolicyId) &&
    isSafePackageCacheIdentityToken(identity.packageCacheId) &&
    isSafePackageCacheIdentityToken(identity.packageCacheMountPolicyId) &&
    isSafePackageCacheIdentityToken(identity.lifecycleScriptsPolicyId) &&
    isSafePackageCacheIdentityToken(identity.networkInstallPolicyId) &&
    isPtcSha256Hex(identity.cacheIdentityHash)
  );
}

function isSafePackageCacheIdentityToken(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,127}$/u.test(value);
}

const failure = ptcFailure<PtcLabPackageCacheFailureReason>;
