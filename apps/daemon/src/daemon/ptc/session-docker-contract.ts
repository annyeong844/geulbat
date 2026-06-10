import {
  PTC_LAB_LIFECYCLE_SCRIPTS_DISABLED_POLICY_ID,
  PTC_LAB_NETWORK_INSTALL_DISABLED_POLICY_ID,
  PTC_LAB_PACKAGE_CACHE_DEFAULT_ID,
  PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID,
  type PtcLabPackageManagerName,
} from './lab-package-cache-contract.js';
import {
  createPtcLabNetworkDisabledPolicy,
  type PtcLabNetworkIdentitySnapshot,
  type PtcLabNetworkPolicy,
} from './lab-network-policy.js';
import {
  createPtcLabBrowserDisabledPolicy,
  type PtcLabBrowserIdentitySnapshot,
  type PtcLabBrowserPolicy,
} from './lab-browser-policy.js';
import { PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_POLICY_ID } from './lab-profile-contract.js';

export const PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT = '/geulbat/callbacks';
export const PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT =
  '/geulbat/artifacts' as const;
export const PTC_SESSION_DOCKER_ARTIFACT_WORKSPACE_MOUNT_POLICY_ID =
  'ptc_session_artifact_workspace_mount_v1' as const;

export interface PtcSessionDockerIdentity {
  threadId: string;
  workspaceRoot: string;
  trustContextId: string;
}

export interface PtcSessionDockerPolicy {
  imageRef: string;
  launchPolicyId: string;
  imagePolicyId: string;
  idleEntrypointVersion: string;
  callbackMountPolicyId: string;
  artifactWorkspaceMountPolicyId: string;
  labPolicyId: string;
  packageCacheId: string;
  packageCacheMountPolicyId: string;
  packageManagerFamilies: PtcLabPackageManagerName[];
  lifecycleScriptsPolicyId: string;
  networkInstallPolicyId: string;
  network: PtcLabNetworkPolicy;
  browser: PtcLabBrowserPolicy;
  cpus: string;
  memory: string;
  pidsLimit: string;
  scratchTmpfs: string;
  tmpTmpfs: string;
}

export interface PtcSessionDockerReuseKey {
  threadId: string;
  workspaceRootRealpath: string;
  trustContextId: string;
  launchPolicyId: string;
  imageRef: string;
  imagePolicyId: string;
  idleEntrypointVersion: string;
  callbackMountPolicyId: string;
  artifactWorkspaceMountPolicyId: string;
  labPolicyId: string;
  packageCacheId: string;
  packageCacheMountPolicyId: string;
  packageCacheRootContainerPath: typeof PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT;
  packageManagerFamilies: PtcLabPackageManagerName[];
  lifecycleScriptsPolicyId: string;
  networkInstallPolicyId: string;
  network: PtcLabNetworkIdentitySnapshot;
  browser: PtcLabBrowserIdentitySnapshot;
  cpus: string;
  memory: string;
  pidsLimit: string;
  scratchTmpfs: string;
  tmpTmpfs: string;
  packageCacheIdentityHash: string;
  identityHash: string;
}

export type PtcSessionDockerState =
  | 'starting'
  | 'ready'
  | 'closing'
  | 'closed'
  | 'crashed';

export type PtcSessionDockerFailureReason =
  | 'docker_unavailable'
  | 'image_unavailable'
  | 'network_backend_unavailable'
  | 'unsupported_platform'
  | 'launch_policy_invalid'
  | 'container_create_failed'
  | 'container_start_failed'
  | 'container_inspect_failed'
  | 'container_crashed'
  | 'container_host_root_prepare_failed'
  | 'container_remove_failed'
  | 'container_host_root_cleanup_failed'
  | 'container_start_cleanup_failed'
  | 'manager_closing';

export type PtcSessionDockerResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reasonCode: PtcSessionDockerFailureReason;
      message: string;
      diagnostics?: Record<string, string | number | boolean>;
    };

export type PtcSessionDockerCommandResult =
  | { kind: 'exit'; exitCode: number; stdout: string; stderr: string }
  | { kind: 'timeout'; stdout: string; stderr: string }
  | { kind: 'cancelled'; stdout: string; stderr: string }
  | { kind: 'crash'; stdout: string; stderr: string };

export interface PtcSessionDockerCommandInvocation {
  executable: string;
  args: string[];
  timeoutMs: number;
  signal?: AbortSignal;
}

export type PtcSessionDockerCommandRunner = (
  invocation: PtcSessionDockerCommandInvocation,
) => Promise<PtcSessionDockerCommandResult>;

export interface PtcSessionDockerHandle {
  state: 'ready';
  containerId: string;
  reuseKey: PtcSessionDockerReuseKey;
  callbackRootHostPath: string;
  callbackRootContainerPath: typeof PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT;
  artifactRootHostPath: string;
  artifactRootContainerPath: typeof PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT;
  artifactWorkspaceMountPolicyId: string;
  packageCacheRootHostPath: string;
  packageCacheRootContainerPath: typeof PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT;
  packageCacheMountPolicyId: string;
  packageCacheId: string;
  packageCacheIdentityHash: string;
}

export interface PtcSessionDockerManager {
  getOrCreate(
    identity: PtcSessionDockerIdentity,
    options?: { signal?: AbortSignal },
  ): Promise<PtcSessionDockerResult<PtcSessionDockerHandle>>;
  close(
    identity: PtcSessionDockerIdentity,
    options?: { signal?: AbortSignal },
  ): Promise<PtcSessionDockerResult<void>>;
  closeAll(options?: {
    signal?: AbortSignal;
  }): Promise<PtcSessionDockerResult<void>>;
}

export const PTC_SESSION_DOCKER_DEFAULT_POLICY: PtcSessionDockerPolicy =
  Object.freeze({
    imageRef: 'local/geulbat-ptc-session:2026-05-31',
    launchPolicyId: 'ptc_session_docker_launch_v1',
    imagePolicyId: 'ptc_session_docker_image_v1',
    idleEntrypointVersion: 'ptc_session_idle_entrypoint_v1',
    callbackMountPolicyId: 'ptc_session_callback_mount_v1',
    artifactWorkspaceMountPolicyId:
      PTC_SESSION_DOCKER_ARTIFACT_WORKSPACE_MOUNT_POLICY_ID,
    labPolicyId: 'ptc_lab_local_docker_policy_v1',
    packageCacheId: PTC_LAB_PACKAGE_CACHE_DEFAULT_ID,
    packageCacheMountPolicyId: PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID,
    packageManagerFamilies: [],
    lifecycleScriptsPolicyId: PTC_LAB_LIFECYCLE_SCRIPTS_DISABLED_POLICY_ID,
    networkInstallPolicyId: PTC_LAB_NETWORK_INSTALL_DISABLED_POLICY_ID,
    network: createPtcLabNetworkDisabledPolicy(),
    browser: createPtcLabBrowserDisabledPolicy(),
    cpus: '1',
    memory: '512m',
    pidsLimit: '128',
    scratchTmpfs: '/geulbat/scratch:rw,noexec,nosuid,nodev,size=64m',
    tmpTmpfs: '/tmp:rw,nosuid,nodev,size=64m',
  });

export const PTC_SESSION_DOCKER_LOCAL_BATCH_COMMAND_LAUNCH_POLICY_ID =
  'ptc_session_docker_local_batch_command_launch_v1' as const;

export function createPtcSessionDockerLocalBatchCommandPolicy(): PtcSessionDockerPolicy {
  return {
    ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
    launchPolicyId: PTC_SESSION_DOCKER_LOCAL_BATCH_COMMAND_LAUNCH_POLICY_ID,
    labPolicyId: PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_POLICY_ID,
    cpus: '2',
    memory: '2g',
    pidsLimit: '256',
    scratchTmpfs: '/geulbat/scratch:rw,noexec,nosuid,nodev,size=512m',
    tmpTmpfs: '/tmp:rw,nosuid,nodev,size=512m',
  };
}
