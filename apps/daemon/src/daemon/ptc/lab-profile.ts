import {
  createDefaultPtcLabPackageCachePolicy,
  createDefaultPtcLabPackageManagerPolicy,
  type PtcLabPackageCachePolicy,
  type PtcLabPackageManagerPolicy,
} from './lab-package-cache-contract.js';
import {
  createPtcLabNetworkDisabledPolicy,
  type PtcLabNetworkPolicy,
} from './lab-network-policy.js';
import {
  createPtcLabBrowserDisabledPolicy,
  type PtcLabBrowserPolicy,
} from './lab-browser-policy.js';
import {
  PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_MAX_COMMAND_MS,
  PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_MAX_PROCESS_COUNT,
  PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_POLICY_ID,
  PTC_LAB_LOCAL_DOCKER_POLICY_ID,
  PTC_SAFE_SUBSET_DEFAULT_POLICY_ID,
} from './lab-profile-contract.js';

export type PtcExecutionProfile = 'safe_subset' | 'lab';
export type PtcExecutionProfileRequest = PtcExecutionProfile | 'default';

export type PtcProfileAdmissionReason =
  | 'explicit_user_request'
  | 'workload_router'
  | 'default_policy';

export interface PtcProfileAdmissionMetadata {
  requestedProfile: PtcExecutionProfileRequest;
  selectedProfile: PtcExecutionProfile;
  policyId: string;
  reason: PtcProfileAdmissionReason;
}

export type PtcLabEgressMode = PtcLabNetworkPolicy['mode'];
export type PtcLabShellMode =
  | 'disabled'
  | 'batch_command'
  | 'interactive_terminal';

export interface PtcLabPolicyProjection {
  profile: 'lab';
  policyId: string;
  boundary: {
    kind: 'docker' | 'vm' | 'microvm';
    boundaryClaim: 'docker_containment' | 'hostile_isolation';
  };
  mounts: {
    workspaceRead?: {
      enabled: boolean;
      roots: Array<{ id: string; mode: 'read_only' }>;
    };
    workspaceWrite?: {
      enabled: boolean;
      pathGrants: Array<{
        grantId: string;
        pathGlobs: string[];
        maxWrites?: number;
      }>;
    };
    artifactWorkspace: {
      enabled: true;
      workspaceId: string;
      exportPolicyId: string;
    };
  };
  shell: {
    mode: PtcLabShellMode;
    maxProcessCount: number;
    maxCommandMs: number;
  };
  packageCache: PtcLabPackageCachePolicy;
  packageManager: PtcLabPackageManagerPolicy;
  network: PtcLabNetworkPolicy;
  browser: PtcLabBrowserPolicy;
}

export type PtcProfileAdmissionFailureReason =
  | 'ptc_lab_not_enabled'
  | 'ptc_profile_invalid';

export interface PtcLabAdmittedProfile {
  metadata: PtcProfileAdmissionMetadata;
  labPolicy?: PtcLabPolicyProjection;
}

export type PtcProfileAdmissionResult =
  | {
      ok: true;
      value: PtcLabAdmittedProfile;
    }
  | {
      ok: false;
      reasonCode: PtcProfileAdmissionFailureReason;
      message: string;
    };

export interface AdmitPtcExecutionProfileArgs {
  requestedProfile: PtcExecutionProfileRequest;
  labEnabled: boolean;
  reason: PtcProfileAdmissionReason;
  labPolicy?: PtcLabPolicyProjection;
}

export function createPtcLabLocalDockerPolicyProjection(): PtcLabPolicyProjection {
  return {
    profile: 'lab',
    policyId: PTC_LAB_LOCAL_DOCKER_POLICY_ID,
    boundary: {
      kind: 'docker',
      boundaryClaim: 'docker_containment',
    },
    mounts: {
      artifactWorkspace: {
        enabled: true,
        workspaceId: 'ptc_lab_artifact_workspace_v1',
        exportPolicyId: 'ptc_lab_artifact_export_pending_v1',
      },
    },
    shell: {
      mode: 'disabled',
      maxProcessCount: 0,
      maxCommandMs: 0,
    },
    packageCache: createDefaultPtcLabPackageCachePolicy(),
    packageManager: createDefaultPtcLabPackageManagerPolicy(),
    network: createPtcLabNetworkDisabledPolicy(),
    browser: createPtcLabBrowserDisabledPolicy(),
  };
}

export function createPtcLabLocalDockerBatchCommandPolicyProjection(): PtcLabPolicyProjection {
  return {
    ...createPtcLabLocalDockerPolicyProjection(),
    policyId: PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_POLICY_ID,
    shell: {
      mode: 'batch_command',
      maxProcessCount: PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_MAX_PROCESS_COUNT,
      maxCommandMs: PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_MAX_COMMAND_MS,
    },
  };
}

export function admitPtcExecutionProfile(
  args: AdmitPtcExecutionProfileArgs,
): PtcProfileAdmissionResult {
  if (
    args.requestedProfile !== 'default' &&
    args.requestedProfile !== 'safe_subset' &&
    args.requestedProfile !== 'lab'
  ) {
    return {
      ok: false,
      reasonCode: 'ptc_profile_invalid',
      message: 'PTC execution profile request is invalid',
    };
  }

  if (args.requestedProfile === 'lab') {
    if (!args.labEnabled) {
      return {
        ok: false,
        reasonCode: 'ptc_lab_not_enabled',
        message: 'PTC lab profile is not enabled',
      };
    }

    const labPolicy =
      args.labPolicy ?? createPtcLabLocalDockerPolicyProjection();
    return {
      ok: true,
      value: {
        metadata: {
          requestedProfile: 'lab',
          selectedProfile: 'lab',
          policyId: labPolicy.policyId,
          reason: args.reason,
        },
        labPolicy,
      },
    };
  }

  return {
    ok: true,
    value: {
      metadata: {
        requestedProfile: args.requestedProfile,
        selectedProfile: 'safe_subset',
        policyId: PTC_SAFE_SUBSET_DEFAULT_POLICY_ID,
        reason: args.reason,
      },
    },
  };
}

export type PtcLabWorkspaceReadEgressDecision =
  | 'no_workspace_read'
  | 'workspace_read_without_egress'
  | 'workspace_read_with_open_egress';

export interface PtcLabWorkspaceReadEgressSummary {
  workspaceReadEnabled: boolean;
  egressMode: PtcLabEgressMode;
  combinedDecision: PtcLabWorkspaceReadEgressDecision;
}

export function describePtcLabWorkspaceReadEgressDecision(
  policy: PtcLabPolicyProjection,
): PtcLabWorkspaceReadEgressSummary {
  const workspaceReadEnabled = policy.mounts.workspaceRead?.enabled === true;
  const egressMode = policy.network.mode;
  if (!workspaceReadEnabled) {
    return {
      workspaceReadEnabled,
      egressMode,
      combinedDecision: 'no_workspace_read',
    };
  }

  return {
    workspaceReadEnabled,
    egressMode,
    combinedDecision:
      egressMode === 'open'
        ? 'workspace_read_with_open_egress'
        : 'workspace_read_without_egress',
  };
}
