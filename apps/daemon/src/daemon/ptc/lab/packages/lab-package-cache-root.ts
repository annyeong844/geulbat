import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { applyPtcHostPathMode } from '../session/host-path-mode.js';
import { PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT } from './lab-package-cache-contract.js';
import type {
  PtcPackageCacheIdentity,
  PtcPackageCacheRoot,
} from './lab-package-cache-contract.js';

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
