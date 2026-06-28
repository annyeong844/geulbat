import {
  PTC_LAB_LIFECYCLE_SCRIPTS_DISABLED_POLICY_ID,
  PTC_LAB_NETWORK_INSTALL_DISABLED_POLICY_ID,
  PTC_LAB_PACKAGE_CACHE_DEFAULT_ID,
  PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID,
  type PtcLabPackageManagerName,
} from '../packages/lab-package-cache-contract.js';
import {
  createPtcLabNetworkDisabledPolicy,
  type PtcLabNetworkIdentitySnapshot,
  type PtcLabNetworkPolicy,
} from '../network/lab-network-policy.js';
import {
  createPtcLabBrowserDisabledPolicy,
  type PtcLabBrowserPolicy,
} from '../browser/core/lab-browser-policy.js';
import { type PtcLabBrowserIdentitySnapshot } from '../browser/core/lab-browser-identity.js';
import {
  PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_POLICY_ID,
  PTC_LAB_LOCAL_DOCKER_POLICY_ID,
  type PtcLabPolicyId,
} from '../profile/lab-profile-contract.js';
import type {
  PtcDockerClientCommandInvocation,
  PtcDockerClientCommandResult,
} from '../../shared/process-command.js';

export const PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT = '/geulbat/callbacks';
export const PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT =
  '/geulbat/artifacts' as const;
const PTC_SESSION_DOCKER_DEFAULT_LAUNCH_POLICY_ID =
  'ptc_session_docker_launch_v1' as const;
const PTC_SESSION_DOCKER_IMAGE_POLICY_ID =
  'ptc_session_docker_image_v1' as const;
const PTC_SESSION_DOCKER_IDLE_ENTRYPOINT_VERSION =
  'ptc_session_idle_entrypoint_v1' as const;
export const PTC_SESSION_DOCKER_HOST_USER_POLICY_ID =
  'ptc_session_docker_host_user_v1' as const;
const PTC_SESSION_DOCKER_CALLBACK_MOUNT_POLICY_ID =
  'ptc_session_callback_mount_v1' as const;
export const PTC_SESSION_DOCKER_ARTIFACT_WORKSPACE_MOUNT_POLICY_ID =
  'ptc_session_artifact_workspace_mount_v1' as const;
export const PTC_SESSION_DOCKER_LOCAL_BATCH_COMMAND_LAUNCH_POLICY_ID =
  'ptc_session_docker_local_batch_command_launch_v1' as const;

type PtcSessionDockerLaunchPolicyId =
  | typeof PTC_SESSION_DOCKER_DEFAULT_LAUNCH_POLICY_ID
  | typeof PTC_SESSION_DOCKER_LOCAL_BATCH_COMMAND_LAUNCH_POLICY_ID;
export type PtcSessionDockerArtifactWorkspaceMountPolicyId =
  typeof PTC_SESSION_DOCKER_ARTIFACT_WORKSPACE_MOUNT_POLICY_ID;
export type PtcSessionDockerPackageCacheMountPolicyId =
  typeof PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID;
export type PtcSessionDockerLifecycleScriptsPolicyId =
  typeof PTC_LAB_LIFECYCLE_SCRIPTS_DISABLED_POLICY_ID;
export type PtcSessionDockerNetworkInstallPolicyId =
  PtcLabNetworkPolicy['networkPolicyId'];

export interface PtcSessionDockerIdentity {
  threadId: string;
  workspaceRoot: string;
  trustContextId: string;
}

export interface PtcSessionDockerHostUser {
  hostUserPolicyId: typeof PTC_SESSION_DOCKER_HOST_USER_POLICY_ID;
  uid: number;
  gid: number;
}

export interface PtcSessionDockerPolicy {
  imageRef: string;
  launchPolicyId: PtcSessionDockerLaunchPolicyId;
  imagePolicyId: typeof PTC_SESSION_DOCKER_IMAGE_POLICY_ID;
  idleEntrypointVersion: typeof PTC_SESSION_DOCKER_IDLE_ENTRYPOINT_VERSION;
  hostUserPolicyId: typeof PTC_SESSION_DOCKER_HOST_USER_POLICY_ID;
  callbackMountPolicyId: typeof PTC_SESSION_DOCKER_CALLBACK_MOUNT_POLICY_ID;
  artifactWorkspaceMountPolicyId: PtcSessionDockerArtifactWorkspaceMountPolicyId;
  labPolicyId: PtcLabPolicyId;
  packageCacheId: string;
  packageCacheMountPolicyId: PtcSessionDockerPackageCacheMountPolicyId;
  packageManagerFamilies: PtcLabPackageManagerName[];
  lifecycleScriptsPolicyId: PtcSessionDockerLifecycleScriptsPolicyId;
  networkInstallPolicyId: PtcSessionDockerNetworkInstallPolicyId;
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
  launchPolicyId: PtcSessionDockerLaunchPolicyId;
  imageRef: string;
  imagePolicyId: typeof PTC_SESSION_DOCKER_IMAGE_POLICY_ID;
  idleEntrypointVersion: typeof PTC_SESSION_DOCKER_IDLE_ENTRYPOINT_VERSION;
  hostUser: PtcSessionDockerHostUser;
  callbackMountPolicyId: typeof PTC_SESSION_DOCKER_CALLBACK_MOUNT_POLICY_ID;
  artifactWorkspaceMountPolicyId: PtcSessionDockerArtifactWorkspaceMountPolicyId;
  labPolicyId: PtcLabPolicyId;
  packageCacheId: string;
  packageCacheMountPolicyId: PtcSessionDockerPackageCacheMountPolicyId;
  packageCacheRootContainerPath: typeof PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT;
  packageManagerFamilies: PtcLabPackageManagerName[];
  lifecycleScriptsPolicyId: PtcSessionDockerLifecycleScriptsPolicyId;
  networkInstallPolicyId: PtcSessionDockerNetworkInstallPolicyId;
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

export type PtcSessionDockerFailureReason =
  | 'docker_unavailable'
  | 'image_unavailable'
  | 'network_backend_unavailable'
  | 'container_create_failed'
  | 'container_start_failed'
  | 'container_inspect_failed'
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

export type PtcSessionDockerCommandResult = PtcDockerClientCommandResult;

export type PtcSessionDockerCommandInvocation =
  PtcDockerClientCommandInvocation;

export type PtcSessionDockerCommandRunner = (
  invocation: PtcSessionDockerCommandInvocation,
) => Promise<PtcSessionDockerCommandResult>;

export type PtcSessionDockerMappedNonExitCommandResult<
  FailedKind extends string,
  ProcessTerminated extends boolean = false,
> =
  | {
      kind: 'timeout';
      stdout: string;
      stderr: string;
      processTerminated: ProcessTerminated;
    }
  | {
      kind: 'cancelled';
      stdout: string;
      stderr: string;
      processTerminated: ProcessTerminated;
    }
  | { kind: FailedKind; stdout: string; stderr: string };

export interface PtcSessionDockerHandle {
  state: 'ready';
  containerId: string;
  reuseKey: PtcSessionDockerReuseKey;
  callbackRootHostPath: string;
  callbackRootContainerPath: typeof PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT;
  artifactRootHostPath: string;
  artifactRootContainerPath: typeof PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT;
  artifactWorkspaceMountPolicyId: PtcSessionDockerArtifactWorkspaceMountPolicyId;
  packageCacheRootHostPath: string;
  packageCacheRootContainerPath: typeof PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT;
  packageCacheMountPolicyId: PtcSessionDockerPackageCacheMountPolicyId;
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
    launchPolicyId: PTC_SESSION_DOCKER_DEFAULT_LAUNCH_POLICY_ID,
    imagePolicyId: PTC_SESSION_DOCKER_IMAGE_POLICY_ID,
    idleEntrypointVersion: PTC_SESSION_DOCKER_IDLE_ENTRYPOINT_VERSION,
    hostUserPolicyId: PTC_SESSION_DOCKER_HOST_USER_POLICY_ID,
    callbackMountPolicyId: PTC_SESSION_DOCKER_CALLBACK_MOUNT_POLICY_ID,
    artifactWorkspaceMountPolicyId:
      PTC_SESSION_DOCKER_ARTIFACT_WORKSPACE_MOUNT_POLICY_ID,
    labPolicyId: PTC_LAB_LOCAL_DOCKER_POLICY_ID,
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
