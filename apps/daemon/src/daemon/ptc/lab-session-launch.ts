import {
  describePtcLabWorkspaceReadEgressDecision,
  type PtcLabAdmittedProfile,
  type PtcLabEgressMode,
  type PtcLabPolicyProjection,
  type PtcLabShellMode,
  type PtcProfileAdmissionMetadata,
} from './lab-profile.js';

export type PtcLabLaunchClass = 'fake_runner';

export type PtcLabSessionLaunchFailureReason =
  | 'ptc_lab_admission_required'
  | 'ptc_lab_launch_failed';

export type PtcLabSessionLaunchResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reasonCode: PtcLabSessionLaunchFailureReason;
      message: string;
      diagnostics?: Record<string, string | number | boolean>;
    };

export interface PtcLabSessionLaunchRunnerRequest {
  metadata: PtcProfileAdmissionMetadata;
  policy: PtcLabPolicyProjection;
}

export interface PtcLabSessionLaunchRunnerSummary {
  labSessionId: string;
  launchClass: PtcLabLaunchClass;
}

export type PtcLabSessionLaunchRunner = (
  request: PtcLabSessionLaunchRunnerRequest,
) => Promise<PtcLabSessionLaunchResult<PtcLabSessionLaunchRunnerSummary>>;

export interface RunPtcLabSessionLaunchContractArgs {
  admission: PtcLabAdmittedProfile | undefined;
  runner: PtcLabSessionLaunchRunner;
}

export interface PtcLabSessionLaunchSummary {
  profile: 'lab';
  requestedProfile: PtcProfileAdmissionMetadata['requestedProfile'];
  selectedProfile: 'lab';
  admissionReason: PtcProfileAdmissionMetadata['reason'];
  policyId: string;
  labSessionId: string;
  launchClass: PtcLabLaunchClass;
  boundaryKind: PtcLabPolicyProjection['boundary']['kind'];
  boundaryClaim: PtcLabPolicyProjection['boundary']['boundaryClaim'];
  shellMode: PtcLabShellMode;
  packageManagerEnabled: boolean;
  packageCacheEnabled: boolean;
  egressMode: PtcLabEgressMode;
  workspaceReadEnabled: boolean;
  workspaceWriteEnabled: boolean;
  workspaceReadEgressDecision: string;
  artifactWorkspaceEnabled: boolean;
  artifactImportExportEnabled: false;
  artifactExportPolicyId: string;
  browserEnabled: boolean;
}

export async function runPtcLabSessionLaunchContract(
  args: RunPtcLabSessionLaunchContractArgs,
): Promise<PtcLabSessionLaunchResult<PtcLabSessionLaunchSummary>> {
  if (
    args.admission === undefined ||
    args.admission.metadata.selectedProfile !== 'lab' ||
    args.admission.labPolicy === undefined
  ) {
    return {
      ok: false,
      reasonCode: 'ptc_lab_admission_required',
      message: 'PTC lab launch requires an admitted lab profile',
    };
  }

  const policy = args.admission.labPolicy;
  let launched: PtcLabSessionLaunchResult<PtcLabSessionLaunchRunnerSummary>;
  try {
    launched = await args.runner({
      metadata: args.admission.metadata,
      policy,
    });
  } catch {
    return launchFailed();
  }
  if (!launched.ok) {
    return launchFailed(launched.reasonCode);
  }
  if (!isSafeLabSessionId(launched.value.labSessionId)) {
    return launchFailed('unsafe_lab_session_id');
  }

  const workspaceReadEgress = describePtcLabWorkspaceReadEgressDecision(policy);
  return {
    ok: true,
    value: {
      profile: 'lab',
      requestedProfile: args.admission.metadata.requestedProfile,
      selectedProfile: 'lab',
      admissionReason: args.admission.metadata.reason,
      policyId: policy.policyId,
      labSessionId: launched.value.labSessionId,
      launchClass: launched.value.launchClass,
      boundaryKind: policy.boundary.kind,
      boundaryClaim: policy.boundary.boundaryClaim,
      shellMode: policy.shell.mode,
      packageManagerEnabled: policy.packageManager.enabled,
      packageCacheEnabled: policy.packageCache.enabled,
      egressMode: policy.network.mode,
      workspaceReadEnabled: workspaceReadEgress.workspaceReadEnabled,
      workspaceWriteEnabled: policy.mounts.workspaceWrite?.enabled === true,
      workspaceReadEgressDecision: workspaceReadEgress.combinedDecision,
      artifactWorkspaceEnabled: policy.mounts.artifactWorkspace.enabled,
      artifactImportExportEnabled: false,
      artifactExportPolicyId: policy.mounts.artifactWorkspace.exportPolicyId,
      browserEnabled: policy.browser.enabled,
    },
  };
}

function launchFailed(
  runnerReasonCode?: string,
): PtcLabSessionLaunchResult<never> {
  return {
    ok: false,
    reasonCode: 'ptc_lab_launch_failed',
    message: 'PTC lab launch failed',
    ...(runnerReasonCode === undefined
      ? {}
      : { diagnostics: { runnerReasonCode } }),
  };
}

function isSafeLabSessionId(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,127}$/u.test(value);
}
