import {
  PTC_LAB_BROWSER_FIXED_PREFLIGHT_POLICY_ID,
  PTC_LAB_BROWSER_TELEMETRY_OWNER_OUTCOME_POLICY_ID,
} from './lab-browser-policy.js';
import {
  createPtcLabBrowserFailure,
  type PtcLabBrowserDiagnostics,
  type PtcLabBrowserSimpleResult,
} from './lab-browser-result-contract.js';
import type { PtcLabNetworkTelemetrySummary } from './lab-network-policy.js';
import type { PtcLabAdmittedProfile } from './lab-profile.js';
import type {
  PtcSessionDockerCommandRunner,
  PtcSessionDockerIdentity,
  PtcSessionDockerManager,
} from './session-docker-contract.js';

export const PTC_LAB_BROWSER_OWNER_PREFLIGHT_SCRIPT = String.raw`
process.stdout.write(JSON.stringify({
  ok: true,
  capability: 'ptc_lab_browser_owner_preflight'
}) + '\n');
`;

export type PtcLabBrowserOwnerFailureReason =
  | 'ptc_lab_browser_admission_required'
  | 'ptc_lab_browser_policy_disabled'
  | 'ptc_lab_browser_policy_mismatch'
  | 'ptc_lab_browser_request_invalid'
  | 'ptc_lab_browser_session_unavailable'
  | 'ptc_lab_browser_execution_failed'
  | 'ptc_lab_browser_timeout'
  | 'ptc_lab_browser_cancelled'
  | 'ptc_lab_browser_output_invalid';

export type PtcLabBrowserOwnerResult<T> = PtcLabBrowserSimpleResult<
  T,
  PtcLabBrowserOwnerFailureReason
>;

export interface PtcLabBrowserOwnerPreflightRequest {
  probeId: string;
  timeoutMs?: number;
}

export interface PtcLabBrowserOwnerPreflightSummary {
  ok: true;
  profile: 'lab';
  policyId: string;
  labSessionId: string;
  probeId: string;
  browserPolicyId: typeof PTC_LAB_BROWSER_FIXED_PREFLIGHT_POLICY_ID;
  browserMode: 'fixed_preflight';
  executionClass: 'ptc_lab_browser_owner_preflight';
  exitCode: number;
  durationMs: number;
  browserTelemetryPolicyId: typeof PTC_LAB_BROWSER_TELEMETRY_OWNER_OUTCOME_POLICY_ID;
  browserOutputPolicy: 'summary_only';
  browserProfile: 'none';
  browserCookies: 'none';
  artifactExported: false;
  networkTelemetry: PtcLabNetworkTelemetrySummary;
}

export interface RunPtcLabBrowserOwnerPreflightArgs {
  admission: PtcLabAdmittedProfile | undefined;
  identity: PtcSessionDockerIdentity;
  sessionManager: PtcSessionDockerManager;
  request: PtcLabBrowserOwnerPreflightRequest;
  commandRunner?: PtcSessionDockerCommandRunner;
  dockerPath?: string;
  now?: () => number;
  signal?: AbortSignal;
}

export function browserOwnerFailure(
  reasonCode: PtcLabBrowserOwnerFailureReason,
  message: string,
  diagnostics?: PtcLabBrowserDiagnostics,
): PtcLabBrowserOwnerResult<never> {
  return createPtcLabBrowserFailure(reasonCode, message, diagnostics);
}
