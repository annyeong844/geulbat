import {
  PTC_LAB_NETWORK_INSTALL_DISABLED_POLICY_ID,
  type PtcLabPackageInstallMode,
} from './lab-package-cache-contract.js';
import {
  PTC_LAB_NETWORK_DISABLED_POLICY_ID,
  PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
  type PtcLabNetworkTelemetrySummary,
} from './lab-network-policy.js';
import type {
  PtcLabAdmittedProfile,
  PtcLabPolicyProjection,
} from './lab-profile.js';

export const PTC_LAB_PACKAGE_INSTALL_WORKDIR_EXISTS_EXIT_CODE = 73;
export const PTC_LAB_PACKAGE_INSTALL_WORKDIR_EXISTS_MARKER =
  'geulbat-package-install-workdir-exists';

export type PtcLabPackageInstallFailureReason =
  | 'ptc_lab_package_install_admission_required'
  | 'ptc_lab_package_install_policy_disabled'
  | 'ptc_lab_package_install_policy_mismatch'
  | 'ptc_lab_package_install_request_invalid'
  | 'ptc_lab_package_install_workdir_exists'
  | 'ptc_lab_package_manager_unavailable'
  | 'ptc_lab_package_install_timeout'
  | 'ptc_lab_package_install_cancelled'
  | 'ptc_lab_package_install_failed'
  | 'ptc_lab_package_install_output_invalid';

export type PtcLabPackageInstallResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reasonCode: PtcLabPackageInstallFailureReason;
      message: string;
      diagnostics?: Record<string, string | number | boolean>;
    };

export interface PtcLabNpmExactPackage {
  name: string;
  version: string;
}

export interface PtcLabCacheOnlyNpmInstallRequest {
  manager: 'npm';
  installId: string;
  packages: PtcLabNpmExactPackage[];
  timeoutMs?: number;
  outputExcerptByteLimit?: number;
}

export interface PtcLabNetworkNpmInstallRequest {
  manager: 'npm';
  installId: string;
  packages: PtcLabNpmExactPackage[];
  timeoutMs?: number;
  outputExcerptByteLimit?: number;
}

interface PtcLabPackageInstallSessionHandleBase {
  profile: 'lab';
  policyId: string;
  labSessionId: string;
  containerId: string;
  packageCacheRootContainerPath: string;
  packageCacheMountPolicyId: string;
  packageCacheId: string;
  packageCacheIdentityHash: string;
}

export interface PtcLabCacheOnlyPackageInstallSessionHandle extends PtcLabPackageInstallSessionHandleBase {
  installMode: 'cache_only';
  networkMode: 'disabled';
  networkPolicyId: typeof PTC_LAB_NETWORK_DISABLED_POLICY_ID;
  networkInstallPolicyId: typeof PTC_LAB_NETWORK_INSTALL_DISABLED_POLICY_ID;
}

export interface PtcLabNetworkPackageInstallSessionHandle extends PtcLabPackageInstallSessionHandleBase {
  installMode: 'open_network';
  networkMode: 'open';
  networkPolicyId: typeof PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID;
  networkExplicitOptInPolicyId: string;
  networkInstallPolicyId: typeof PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID;
}

export type PtcLabPackageInstallSessionHandle =
  | PtcLabCacheOnlyPackageInstallSessionHandle
  | PtcLabNetworkPackageInstallSessionHandle;

export interface PtcLabPackageInstallRunnerInvocation {
  executable: string;
  args: string[];
  timeoutMs: number;
  signal?: AbortSignal;
}

export type PtcLabPackageInstallRunnerResult =
  | { kind: 'exit'; exitCode: number; stdout: string; stderr: string }
  | {
      kind: 'timeout';
      stdout: string;
      stderr: string;
      processTerminated: boolean;
    }
  | {
      kind: 'cancelled';
      stdout: string;
      stderr: string;
      processTerminated: boolean;
    }
  | { kind: 'package_manager_unavailable'; stdout: string; stderr: string }
  | { kind: 'workdir_exists'; stdout: string; stderr: string }
  | { kind: 'failed'; stdout: string; stderr: string };

export type PtcLabPackageInstallRunner = (
  invocation: PtcLabPackageInstallRunnerInvocation,
) => Promise<PtcLabPackageInstallRunnerResult>;

export interface PtcLabPackageInstallSessionTaint {
  reasonCode:
    | 'ptc_lab_package_install_timeout'
    | 'ptc_lab_package_install_cancelled';
  installId: string;
  containerId: string;
}

export interface RunPtcLabPackageInstallSmokeArgsBase {
  admission: PtcLabAdmittedProfile | undefined;
  session: PtcLabPackageInstallSessionHandle | undefined;
  runner?: PtcLabPackageInstallRunner;
  dockerPath?: string;
  now?: () => number;
  signal?: AbortSignal;
  onSessionTainted?: (
    taint: PtcLabPackageInstallSessionTaint,
  ) => Promise<void> | void;
}

export interface RunPtcLabCacheOnlyNpmInstallSmokeArgs extends RunPtcLabPackageInstallSmokeArgsBase {
  request: PtcLabCacheOnlyNpmInstallRequest;
}

export interface RunPtcLabNetworkNpmInstallSmokeArgs extends RunPtcLabPackageInstallSmokeArgsBase {
  request: PtcLabNetworkNpmInstallRequest;
}

export interface PtcLabCacheOnlyNpmInstallSummary {
  manager: 'npm';
  installMode: 'cache_only';
  installId: string;
  packageCount: number;
  packages: PtcLabNpmExactPackage[];
  cacheIdentityHash: string;
  packageCacheId: string;
  packageCacheMountPolicyId: string;
  lifecycleScriptsPolicyId: string;
  networkInstallPolicyId: string;
  telemetryPolicyId: string;
  offline: true;
  lifecycleScripts: 'disabled';
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  cacheObservation: 'not_measured' | 'npm_reported_cache_miss_possible';
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface PtcLabNetworkNpmInstallSummary {
  manager: 'npm';
  installMode: 'open_network';
  installId: string;
  packageCount: number;
  packages: PtcLabNpmExactPackage[];
  cacheIdentityHash: string;
  packageCacheId: string;
  packageCacheMountPolicyId: string;
  lifecycleScriptsPolicyId: string;
  networkInstallPolicyId: string;
  telemetryPolicyId: string;
  offline: false;
  lifecycleScripts: 'disabled';
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  networkTelemetry: PtcLabNetworkTelemetrySummary;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface PtcLabValidatedNpmInstallRequest {
  installId: string;
  packages: PtcLabNpmExactPackage[];
  effectiveTimeoutMs: number;
  outputExcerptByteLimit: number;
}

export type PtcLabOpenNetworkPolicyProjection = PtcLabPolicyProjection & {
  network: Extract<PtcLabPolicyProjection['network'], { mode: 'open' }>;
};

export type PtcLabPackageInstallModeForSmoke = Extract<
  PtcLabPackageInstallMode,
  'cache_only' | 'open_network'
>;

export function packageInstallFailure(
  reasonCode: PtcLabPackageInstallFailureReason,
  message: string,
  diagnostics?: Record<string, string | number | boolean>,
): PtcLabPackageInstallResult<never> {
  return diagnostics === undefined
    ? { ok: false, reasonCode, message }
    : { ok: false, reasonCode, message, diagnostics };
}
