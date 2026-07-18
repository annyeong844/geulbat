import {
  createDefaultPtcLabPackageCachePolicy,
  createDefaultPtcLabPackageManagerPolicy,
  type PtcLabPackageCachePolicy,
  type PtcLabPackageManagerPolicy,
} from '../packages/lab-package-cache-contract.js';
import {
  createPtcLabOpenEgressLocalPolicy,
  createPtcLabNetworkDisabledPolicy,
  type PtcLabNetworkPolicy,
} from '../network/lab-network-policy.js';
import {
  createPtcLabBrowserDisabledPolicy,
  type PtcLabBrowserPolicy,
} from '../browser/core/lab-browser-policy.js';
import {
  PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_MAX_COMMAND_MS,
  PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_MAX_BUFFERED_BYTES_PER_STREAM,
  PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_MAX_PROCESS_COUNT,
  PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_POLICY_ID,
  PTC_LAB_LOCAL_DOCKER_POLICY_ID,
  PTC_LAB_OPEN_NETWORK_PACKAGE_INSTALL_POLICY_ID,
  PTC_SAFE_SUBSET_DEFAULT_POLICY_ID,
  type PtcLabPolicyId,
  type PtcProfileAdmissionPolicyId,
} from './lab-profile-contract.js';

type PtcExecutionProfile = 'safe_subset' | 'lab';
type PtcExecutionProfileRequest = PtcExecutionProfile | 'default';

type PtcProfileAdmissionReason =
  | 'explicit_user_request'
  | 'workload_router'
  | 'default_policy';

interface PtcProfileAdmissionMetadata {
  requestedProfile: PtcExecutionProfileRequest;
  selectedProfile: PtcExecutionProfile;
  policyId: PtcProfileAdmissionPolicyId;
  reason: PtcProfileAdmissionReason;
}

type PtcLabEgressMode = PtcLabNetworkPolicy['mode'];
type PtcLabShellMode = 'disabled' | 'batch_command' | 'interactive_terminal';

export interface PtcLabPolicyProjection {
  profile: 'lab';
  policyId: PtcLabPolicyId;
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
    maxBufferedBytesPerStream: number;
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

type PtcProfileAdmissionResult =
  | {
      ok: true;
      value: PtcLabAdmittedProfile;
    }
  | {
      ok: false;
      reasonCode: PtcProfileAdmissionFailureReason;
      message: string;
    };

interface AdmitPtcExecutionProfileArgs {
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
      maxBufferedBytesPerStream: 0,
    },
    packageCache: createDefaultPtcLabPackageCachePolicy(),
    packageManager: createDefaultPtcLabPackageManagerPolicy(),
    network: createPtcLabNetworkDisabledPolicy(),
    browser: createPtcLabBrowserDisabledPolicy(),
  };
}

interface CreatePtcLabLocalDockerOpenEgressBrowserPolicyProjectionArgs {
  policyId: PtcLabPolicyId;
  browser: PtcLabBrowserPolicy;
}

export function createPtcLabLocalDockerOpenEgressBrowserPolicyProjection(
  args: CreatePtcLabLocalDockerOpenEgressBrowserPolicyProjectionArgs,
): PtcLabPolicyProjection {
  return {
    ...createPtcLabLocalDockerPolicyProjection(),
    policyId: args.policyId,
    // 브라우저 evidence exec은 결과 JSON을 stdout으로 돌려받는다 —
    // base의 0 상한을 물려받으면 첫 바이트부터 output_limit_exceeded로
    // 죽는다 (셸 실행은 여전히 disabled)
    shell: {
      mode: 'disabled',
      maxProcessCount: 0,
      maxCommandMs: 0,
      maxBufferedBytesPerStream:
        PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_MAX_BUFFERED_BYTES_PER_STREAM,
    },
    network: createPtcLabOpenEgressLocalPolicy({
      metricsCoverage: 'owner_outcome_only',
    }),
    browser: args.browser,
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
      maxBufferedBytesPerStream:
        PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_MAX_BUFFERED_BYTES_PER_STREAM,
    },
  };
}

interface CreatePtcLabOpenNetworkPackageInstallPolicyProjectionArgs {
  maxInstallMs: number;
  maxInstallOutputBytes: number;
}

// Operator-opt-in "package install + open-network exec" surface: batch-command
// shell plus enabled npm (open_network, lifecycle scripts stay disabled) plus
// explicit local open egress. Never the default projection.
export function createPtcLabLocalDockerOpenNetworkPackageInstallPolicyProjection(
  args: CreatePtcLabOpenNetworkPackageInstallPolicyProjectionArgs,
): PtcLabPolicyProjection {
  const batchCommand = createPtcLabLocalDockerBatchCommandPolicyProjection();
  return {
    ...batchCommand,
    policyId: PTC_LAB_OPEN_NETWORK_PACKAGE_INSTALL_POLICY_ID,
    // Installs run through the shared batch-command shell, so the shell budget
    // must admit the operator's install knobs (slow installs are awaited).
    shell: {
      ...batchCommand.shell,
      maxCommandMs: Math.max(
        batchCommand.shell.maxCommandMs,
        args.maxInstallMs,
      ),
      maxBufferedBytesPerStream: Math.max(
        batchCommand.shell.maxBufferedBytesPerStream,
        args.maxInstallOutputBytes,
      ),
    },
    packageManager: {
      ...createDefaultPtcLabPackageManagerPolicy(),
      enabled: true,
      managers: ['npm'],
      installMode: 'open_network',
      maxInstallMs: args.maxInstallMs,
      maxInstallOutputBytes: args.maxInstallOutputBytes,
    },
    network: createPtcLabOpenEgressLocalPolicy({
      metricsCoverage: 'owner_outcome_only',
    }),
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

type PtcLabWorkspaceReadEgressDecision =
  | 'no_workspace_read'
  | 'workspace_read_without_egress'
  | 'workspace_read_with_open_egress';

interface PtcLabWorkspaceReadEgressSummary {
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
