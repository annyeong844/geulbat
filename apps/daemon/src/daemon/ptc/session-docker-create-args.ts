import { buildPtcPackageCacheRoot } from './lab-package-cache.js';
import { PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT } from './lab-package-cache-contract.js';
import {
  buildPtcLabDockerNetworkIdentityArgs,
  buildPtcLabDockerNetworkIdentityLabels,
} from './lab-network-policy.js';
import { buildPtcLabBrowserIdentityLabels } from './lab-browser-policy.js';
import {
  PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT,
} from './session-docker-contract.js';
import {
  buildPtcSessionDockerArtifactRoot,
  buildPtcSessionDockerCallbackRoot,
  toPtcPackageCacheIdentity,
} from './session-docker-host-roots.js';
import type { PtcSessionDockerReuseKey } from './session-docker-contract.js';

export function buildPtcSessionDockerCreateArgs(args: {
  reuseKey: PtcSessionDockerReuseKey;
  runtimeRoot: string;
}): string[] {
  const callbackRoot = buildPtcSessionDockerCallbackRoot({
    runtimeRoot: args.runtimeRoot,
    reuseKey: args.reuseKey,
  });
  const artifactRoot = buildPtcSessionDockerArtifactRoot({
    runtimeRoot: args.runtimeRoot,
    reuseKey: args.reuseKey,
  });
  const packageCacheRoot = buildPtcPackageCacheRoot({
    runtimeRoot: args.runtimeRoot,
    identity: toPtcPackageCacheIdentity(args.reuseKey),
  });

  return [
    'create',
    ...buildPtcLabDockerNetworkIdentityArgs(args.reuseKey.network),
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--tmpfs',
    args.reuseKey.scratchTmpfs,
    '--tmpfs',
    args.reuseKey.tmpTmpfs,
    '--mount',
    `type=bind,src=${callbackRoot},dst=${PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT},rw`,
    '--mount',
    `type=bind,src=${artifactRoot},dst=${PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT},rw`,
    '--mount',
    `type=bind,src=${packageCacheRoot.hostPath},dst=${PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT},rw`,
    '--cpus',
    args.reuseKey.cpus,
    '--memory',
    args.reuseKey.memory,
    '--pids-limit',
    args.reuseKey.pidsLimit,
    '-e',
    'HOME=/geulbat/scratch/home',
    '-e',
    'TMPDIR=/tmp',
    '-e',
    'XDG_CACHE_HOME=/geulbat/scratch/cache',
    '--label',
    'geulbat.kind=ptc-session',
    '--label',
    'geulbat.owner=daemon',
    '--label',
    `geulbat.identityHash=${args.reuseKey.identityHash}`,
    '--label',
    `geulbat.launchPolicyId=${args.reuseKey.launchPolicyId}`,
    '--label',
    `geulbat.imagePolicyId=${args.reuseKey.imagePolicyId}`,
    '--label',
    `geulbat.labPolicyId=${args.reuseKey.labPolicyId}`,
    '--label',
    `geulbat.callbackMountPolicyId=${args.reuseKey.callbackMountPolicyId}`,
    '--label',
    `geulbat.artifactWorkspaceMountPolicyId=${args.reuseKey.artifactWorkspaceMountPolicyId}`,
    '--label',
    `geulbat.packageCacheMountPolicyId=${args.reuseKey.packageCacheMountPolicyId}`,
    '--label',
    `geulbat.packageCacheId=${args.reuseKey.packageCacheId}`,
    '--label',
    `geulbat.packageCacheIdentityHash=${args.reuseKey.packageCacheIdentityHash}`,
    ...buildPtcLabBrowserIdentityLabels(args.reuseKey.browser).flatMap(
      (label) => ['--label', label],
    ),
    ...buildPtcLabDockerNetworkIdentityLabels(args.reuseKey.network).flatMap(
      (label) => ['--label', label],
    ),
    '--label',
    `geulbat.idleEntrypointVersion=${args.reuseKey.idleEntrypointVersion}`,
    '--label',
    'geulbat.managerVersion=ptc-session-docker-v1',
    args.reuseKey.imageRef,
    'node',
    '-e',
    "setInterval(() => {}, 60_000); process.on('SIGTERM', () => process.exit(0));",
  ];
}
