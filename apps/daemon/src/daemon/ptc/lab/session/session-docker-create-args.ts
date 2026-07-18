import { buildPtcPackageCacheRoot } from '../packages/lab-package-cache-root.js';
import { PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT } from '../packages/lab-package-cache-contract.js';
import { hashPtcStableJson } from '../../shared/stable-identity.js';
import {
  buildPtcLabDockerNetworkIdentityArgs,
  buildPtcLabDockerNetworkIdentityLabels,
} from '../network/lab-network-policy.js';
import { buildPtcLabBrowserIdentityLabels } from '../browser/core/lab-browser-identity.js';
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
    '--user',
    `${args.reuseKey.hostUser.uid}:${args.reuseKey.hostUser.gid}`,
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
    `type=bind,src=${callbackRoot},dst=${PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT}`,
    '--mount',
    `type=bind,src=${artifactRoot},dst=${PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT}`,
    '--mount',
    `type=bind,src=${packageCacheRoot.hostPath},dst=${PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT}`,
    ...(args.reuseKey.sdkProjectionMount === undefined
      ? []
      : [
          '--mount',
          `type=bind,src=${args.reuseKey.sdkProjectionMount.hostRootPath},dst=${args.reuseKey.sdkProjectionMount.containerRootPath},readonly`,
        ]),
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
    ...buildDockerLabelArgs(
      buildPtcSessionDockerLabels(
        args.reuseKey,
        buildPtcSessionDockerRuntimeScopeHash(args.runtimeRoot),
      ),
    ),
    args.reuseKey.imageRef,
    'node',
    '-e',
    "setInterval(() => {}, 60_000); process.on('SIGTERM', () => process.exit(0));",
  ];
}

function buildPtcSessionDockerLabels(
  reuseKey: PtcSessionDockerReuseKey,
  runtimeScopeHash: string,
): string[] {
  return [
    'geulbat.kind=ptc-session',
    'geulbat.owner=daemon',
    `geulbat.identityHash=${reuseKey.identityHash}`,
    `geulbat.runtimeScopeHash=${runtimeScopeHash}`,
    ...(reuseKey.ephemeralBurstId === undefined
      ? []
      : ['geulbat.ephemeral=true']),
    `geulbat.launchPolicyId=${reuseKey.launchPolicyId}`,
    `geulbat.imagePolicyId=${reuseKey.imagePolicyId}`,
    `geulbat.hostUserPolicyId=${reuseKey.hostUser.hostUserPolicyId}`,
    `geulbat.labPolicyId=${reuseKey.labPolicyId}`,
    `geulbat.callbackMountPolicyId=${reuseKey.callbackMountPolicyId}`,
    `geulbat.artifactWorkspaceMountPolicyId=${reuseKey.artifactWorkspaceMountPolicyId}`,
    `geulbat.packageCacheMountPolicyId=${reuseKey.packageCacheMountPolicyId}`,
    `geulbat.packageCacheId=${reuseKey.packageCacheId}`,
    `geulbat.packageCacheIdentityHash=${reuseKey.packageCacheIdentityHash}`,
    ...(reuseKey.sdkProjectionMount === undefined
      ? []
      : [
          `geulbat.sdkProjectionMountPolicyId=${reuseKey.sdkProjectionMount.mountPolicyId}`,
          `geulbat.sdkProjectionHash=${reuseKey.sdkProjectionMount.sdkProjectionHash}`,
        ]),
    ...buildPtcLabBrowserIdentityLabels(reuseKey.browser),
    ...buildPtcLabDockerNetworkIdentityLabels(reuseKey.network),
    `geulbat.idleEntrypointVersion=${reuseKey.idleEntrypointVersion}`,
    'geulbat.managerVersion=ptc-session-docker-v1',
  ];
}

export function buildPtcSessionDockerRuntimeScopeHash(
  runtimeRoot: string,
): string {
  return hashPtcStableJson({ runtimeRoot });
}

function buildDockerLabelArgs(labels: readonly string[]): string[] {
  return labels.flatMap((label) => ['--label', label]);
}
