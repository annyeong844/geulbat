import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildPtcPackageCacheRoot,
  cleanupPtcPackageCacheRoot,
  createDefaultPtcLabPackageCachePolicy,
  createDefaultPtcLabPackageManagerPolicy,
  normalizePtcPackageCacheIdentity,
  preparePtcPackageCacheRoot,
  PTC_LAB_PACKAGE_CACHE_DEFAULT_MAX_BYTES,
  PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID,
  type PtcPackageCacheIdentityInput,
} from './lab-package-cache.js';

async function withTempRuntimeRoot<T>(
  fn: (runtimeRoot: string) => Promise<T>,
): Promise<T> {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'geulbat-ptc-cache-'));
  try {
    return await fn(runtimeRoot);
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
}

const BASE_IDENTITY: PtcPackageCacheIdentityInput = {
  trustContextId: 'local-default-v1',
  workspaceRootRealpath: '/real/workspace/project-a',
  labPolicyId: 'ptc_lab_local_docker_policy_v1',
  packageCacheId: 'ptc_lab_package_cache_local_v1',
  packageCacheMountPolicyId: PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID,
  packageManagerFamilies: [],
  lifecycleScriptsPolicyId: 'ptc_lab_lifecycle_scripts_disabled_v1',
  networkInstallPolicyId: 'ptc_lab_network_disabled_v1',
};

void test('default PTC lab package/cache policies enable cache substrate but disable installs', () => {
  const cache = createDefaultPtcLabPackageCachePolicy();
  const manager = createDefaultPtcLabPackageManagerPolicy();

  assert.equal(cache.enabled, true);
  assert.equal(cache.cacheId, 'ptc_lab_package_cache_local_v1');
  assert.equal(
    cache.mountPolicyId,
    PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID,
  );
  assert.equal(
    cache.containerRoot,
    PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
  );
  assert.equal(cache.quota.maxBytes, PTC_LAB_PACKAGE_CACHE_DEFAULT_MAX_BYTES);
  assert.equal(cache.quota.enforcement, 'not_enforced_record_only');
  assert.equal(cache.quota.evictionPolicy, 'manual');

  assert.equal(manager.enabled, false);
  assert.deepEqual(manager.managers, []);
  assert.equal(manager.installMode, 'disabled');
  assert.equal(manager.lifecycleScripts.policy, 'disabled');
  assert.equal(
    manager.lifecycleScripts.policyId,
    'ptc_lab_lifecycle_scripts_disabled_v1',
  );
  assert.equal(manager.maxInstallMs, 0);
  assert.equal(manager.maxInstallOutputBytes, 0);
  assert.equal(
    manager.telemetryPolicyId,
    'ptc_lab_package_telemetry_pending_v1',
  );
});

void test('normalizePtcPackageCacheIdentity sorts manager family sets before hashing', () => {
  const first = normalizePtcPackageCacheIdentity({
    ...BASE_IDENTITY,
    packageManagerFamilies: ['pip', 'npm'],
  });
  const second = normalizePtcPackageCacheIdentity({
    ...BASE_IDENTITY,
    packageManagerFamilies: ['npm', 'pip'],
  });

  assert.deepEqual(first.packageManagerFamilies, ['npm', 'pip']);
  assert.deepEqual(second.packageManagerFamilies, ['npm', 'pip']);
  assert.equal(first.cacheIdentityHash, second.cacheIdentityHash);
  assert.match(first.cacheIdentityHash, /^[a-f0-9]{64}$/u);
});

void test('normalizePtcPackageCacheIdentity changes hash for lifecycle and network policy changes', () => {
  const base = normalizePtcPackageCacheIdentity(BASE_IDENTITY);
  const lifecycleChanged = normalizePtcPackageCacheIdentity({
    ...BASE_IDENTITY,
    lifecycleScriptsPolicyId: 'ptc_lab_lifecycle_scripts_allowed_v1',
  });
  const networkChanged = normalizePtcPackageCacheIdentity({
    ...BASE_IDENTITY,
    networkInstallPolicyId: 'ptc_lab_network_allowlisted_registry_v1',
  });

  assert.notEqual(lifecycleChanged.cacheIdentityHash, base.cacheIdentityHash);
  assert.notEqual(networkChanged.cacheIdentityHash, base.cacheIdentityHash);
});

void test('package cache root is independent from session roots', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const identity = normalizePtcPackageCacheIdentity(BASE_IDENTITY);
    const root = buildPtcPackageCacheRoot({ runtimeRoot, identity });

    assert.equal(
      root.hostPath,
      join(runtimeRoot, 'ptc-package-caches', identity.cacheIdentityHash),
    );
    assert.equal(root.containerPath, '/geulbat/package-cache');
    assert.equal(root.hostPath.includes('/ptc-sessions/'), false);

    const prepared = await preparePtcPackageCacheRoot({
      runtimeRoot,
      identity,
    });
    assert.equal(prepared.hostPath, root.hostPath);
    await access(root.hostPath);
  });
});

void test('cleanupPtcPackageCacheRoot deletes only matching cache identity roots', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const identity = normalizePtcPackageCacheIdentity(BASE_IDENTITY);
    const otherIdentity = normalizePtcPackageCacheIdentity({
      ...BASE_IDENTITY,
      packageCacheId: 'ptc_lab_other_cache_v1',
    });
    const root = await preparePtcPackageCacheRoot({ runtimeRoot, identity });
    const otherRoot = await preparePtcPackageCacheRoot({
      runtimeRoot,
      identity: otherIdentity,
    });
    await writeFile(join(root.hostPath, 'marker.txt'), 'remove me', 'utf8');
    await writeFile(join(otherRoot.hostPath, 'marker.txt'), 'keep me', 'utf8');

    const cleanup = await cleanupPtcPackageCacheRoot({
      runtimeRoot,
      identity,
      expectedCacheIdentityHash: identity.cacheIdentityHash,
    });

    assert.equal(cleanup.ok, true);
    await assert.rejects(() => access(root.hostPath), /ENOENT/u);
    await access(otherRoot.hostPath);
  });
});

void test('cleanupPtcPackageCacheRoot rejects identity mismatches without leaking host paths', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const identity = normalizePtcPackageCacheIdentity(BASE_IDENTITY);
    await preparePtcPackageCacheRoot({ runtimeRoot, identity });

    const cleanup = await cleanupPtcPackageCacheRoot({
      runtimeRoot,
      identity,
      expectedCacheIdentityHash: '0'.repeat(64),
    });

    assert.equal(cleanup.ok, false);
    assert.equal(
      cleanup.ok ? '' : cleanup.reasonCode,
      'ptc_lab_package_cache_policy_mismatch',
    );
    const text = JSON.stringify(cleanup);
    assert.doesNotMatch(text, /ptc-package-caches/u);
    assert.doesNotMatch(text, /\/tmp\//u);
    assert.doesNotMatch(text, /\.geulbat/u);
  });
});

void test('cleanupPtcPackageCacheRoot rejects forged cache identity hashes', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const identity = normalizePtcPackageCacheIdentity(BASE_IDENTITY);
    const forged = {
      ...identity,
      packageCacheId: 'ptc_lab_other_cache_v1',
    };

    const cleanup = await cleanupPtcPackageCacheRoot({
      runtimeRoot,
      identity: forged,
      expectedCacheIdentityHash: forged.cacheIdentityHash,
    });

    assert.equal(cleanup.ok, false);
    assert.equal(
      cleanup.ok ? '' : cleanup.reasonCode,
      'ptc_lab_package_cache_policy_invalid',
    );
  });
});

void test('cleanupPtcPackageCacheRoot accepts cache identity, not raw host paths', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const identity = normalizePtcPackageCacheIdentity({
      ...BASE_IDENTITY,
      packageCacheId: '../escape',
    });

    const cleanup = await cleanupPtcPackageCacheRoot({
      runtimeRoot,
      identity,
      expectedCacheIdentityHash: identity.cacheIdentityHash,
    });

    assert.equal(cleanup.ok, false);
    assert.equal(
      cleanup.ok ? '' : cleanup.reasonCode,
      'ptc_lab_package_cache_policy_invalid',
    );
  });
});
