import type {
  PTC_LAB_NETWORK_INSTALL_DISABLED_POLICY_ID,
  PtcLabPackageInstallMode,
} from './lab-package-cache-contract.js';
import { ptcFailure } from '../../shared/lab-spine.js';
import type {
  PtcLabNetworkIdentitySnapshot,
  PtcLabNetworkTelemetrySummary,
} from '../network/lab-network-policy.js';
import type {
  PtcLabAdmittedProfile,
  PtcLabPolicyProjection,
} from '../profile/lab-profile.js';
import type {
  PtcSessionDockerCommandInvocation,
  PtcSessionDockerCommandResult,
  PtcSessionDockerMappedNonExitCommandResult,
} from '../session/session-docker-contract.js';

export const PTC_LAB_PACKAGE_INSTALL_WORKDIR_EXISTS_EXIT_CODE = 73;
export const PTC_LAB_PACKAGE_INSTALL_WORKDIR_EXISTS_MARKER =
  'geulbat-package-install-workdir-exists';

type PtcLabPackageInstallFailureReason =
  | 'ptc_lab_package_install_admission_required'
  | 'ptc_lab_package_install_policy_disabled'
  | 'ptc_lab_package_install_policy_mismatch'
  | 'ptc_lab_package_install_request_invalid'
  | 'ptc_lab_package_install_workdir_exists'
  | 'ptc_lab_package_manager_unavailable'
  | 'ptc_lab_package_install_timeout'
  | 'ptc_lab_package_install_cancelled'
  | 'ptc_lab_package_install_failed';

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

export interface PtcLabNpmInstallRequest {
  manager: 'npm';
  installId: string;
  packages: PtcLabNpmExactPackage[];
  timeoutMs?: number;
}

export type PtcLabCacheOnlyNpmInstallRequest = PtcLabNpmInstallRequest;
export type PtcLabNetworkNpmInstallRequest = PtcLabNpmInstallRequest;

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

type PtcLabDisabledNetworkIdentity = Extract<
  PtcLabNetworkIdentitySnapshot,
  { mode: 'disabled' }
>;

type PtcLabOpenNetworkIdentity = Extract<
  PtcLabNetworkIdentitySnapshot,
  { mode: 'open' }
>;

export interface PtcLabCacheOnlyPackageInstallSessionHandle extends PtcLabPackageInstallSessionHandleBase {
  installMode: 'cache_only';
  networkMode: 'disabled';
  networkPolicyId: PtcLabDisabledNetworkIdentity['networkPolicyId'];
  networkInstallPolicyId: typeof PTC_LAB_NETWORK_INSTALL_DISABLED_POLICY_ID;
}

export interface PtcLabNetworkPackageInstallSessionHandle extends PtcLabPackageInstallSessionHandleBase {
  installMode: 'open_network';
  networkMode: 'open';
  networkPolicyId: PtcLabOpenNetworkIdentity['networkPolicyId'];
  networkExplicitOptInPolicyId: PtcLabOpenNetworkIdentity['explicitOptInPolicyId'];
  networkInstallPolicyId: PtcLabOpenNetworkIdentity['networkPolicyId'];
}

export type PtcLabPackageInstallSessionHandle =
  | PtcLabCacheOnlyPackageInstallSessionHandle
  | PtcLabNetworkPackageInstallSessionHandle;

export type PtcLabPackageInstallRunnerInvocation =
  PtcSessionDockerCommandInvocation;

type PtcLabPackageInstallRunnerExitResult = Extract<
  PtcSessionDockerCommandResult,
  { kind: 'exit' }
>;

export type PtcLabPackageInstallRunnerResult =
  | PtcLabPackageInstallRunnerExitResult
  | PtcSessionDockerMappedNonExitCommandResult<'failed', boolean>
  | { kind: 'package_manager_unavailable'; stdout: string; stderr: string }
  | { kind: 'workdir_exists'; stdout: string; stderr: string };

export type PtcLabPackageInstallRunner = (
  invocation: PtcLabPackageInstallRunnerInvocation,
) => Promise<PtcLabPackageInstallRunnerResult>;

interface PtcLabPackageInstallSessionTaint {
  reasonCode:
    | 'ptc_lab_package_install_timeout'
    | 'ptc_lab_package_install_cancelled';
  installId: string;
  containerId: string;
}

interface RunPtcLabPackageInstallSmokeArgsBase {
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
}

export interface PtcLabValidatedNpmInstallRequest {
  installId: string;
  packages: PtcLabNpmExactPackage[];
  effectiveTimeoutMs: number;
}

export type PtcLabOpenNetworkPolicyProjection = PtcLabPolicyProjection & {
  network: Extract<PtcLabPolicyProjection['network'], { mode: 'open' }>;
};

export type PtcLabPackageInstallModeForSmoke = Extract<
  PtcLabPackageInstallMode,
  'cache_only' | 'open_network'
>;

export const packageInstallFailure =
  ptcFailure<PtcLabPackageInstallFailureReason>;
