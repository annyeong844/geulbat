import {
  PTC_BROWSER_RUNTIME_MAX_TIMEOUT_MS,
  PTC_BROWSER_RUNTIME_MAX_URL_BYTES,
  type PtcBrowserRuntimeCleanupResult,
  type PtcBrowserRuntimeCloseAllArgs,
  type PtcBrowserRuntimeOperationArgs,
  type PtcBrowserRuntimeUrlRequest,
} from '../../shared/browser-runtime-contract.js';
import type {
  PtcSha256Digest,
  PtcLabBrowserEvidenceDiagnostics,
  PtcLabBrowserRuntimeOwnedSessionLifecycle,
} from '../../shared/browser-evidence-contract.js';
import type {
  PtcLabBrowserNavigationFailureReason,
  PtcLabBrowserNavigationPhase,
  PtcLabBrowserUserUrlNavigationSummary as SharedPtcLabBrowserUserUrlNavigationSummary,
} from '../../shared/browser-navigation-contract.js';

export const PTC_BROWSER_NAVIGATE_TOOL_NAME = 'browser_navigate' as const;
export const PTC_BROWSER_NAVIGATE_LAB_POLICY_ID =
  'ptc_lab_browser_navigate_user_url_v1' as const;
export const PTC_BROWSER_NAVIGATE_MAX_URL_BYTES =
  PTC_BROWSER_RUNTIME_MAX_URL_BYTES;
export const PTC_BROWSER_NAVIGATE_MAX_TIMEOUT_MS =
  PTC_BROWSER_RUNTIME_MAX_TIMEOUT_MS;

type PtcBrowserNavigateTargetDigest = PtcSha256Digest;
type PtcBrowserNavigateAttemptDigest = PtcSha256Digest;

export type PtcBrowserNavigateRuntimeSummary =
  SharedPtcLabBrowserUserUrlNavigationSummary<
    PtcBrowserNavigateTargetDigest,
    PtcBrowserNavigateAttemptDigest
  >;

export type PtcBrowserNavigateFailureReason =
  PtcLabBrowserNavigationFailureReason;

type PtcBrowserNavigateFailurePhase = PtcLabBrowserNavigationPhase;

interface PtcBrowserNavigateRuntimeError {
  kind: 'ptc_lab_browser_user_url_navigation_error';
  ok: false;
  reasonCode: PtcBrowserNavigateFailureReason;
  message: string;
  phase: PtcBrowserNavigateFailurePhase;
  targetDigest?: PtcBrowserNavigateTargetDigest;
  navigationAttemptDigest?: PtcBrowserNavigateAttemptDigest;
  sessionLifecycle?: PtcLabBrowserRuntimeOwnedSessionLifecycle;
  diagnostics?: PtcLabBrowserEvidenceDiagnostics;
}

export type PtcBrowserNavigateRuntimeResult =
  | { ok: true; value: PtcBrowserNavigateRuntimeSummary }
  | PtcBrowserNavigateRuntimeError;

export type PtcBrowserNavigateRuntimeCleanupResult =
  PtcBrowserRuntimeCleanupResult<'ptc_browser_navigate_session_cleanup_failed'>;

export interface PtcBrowserNavigateRuntime {
  navigate(
    args: PtcBrowserRuntimeOperationArgs<PtcBrowserRuntimeUrlRequest>,
  ): Promise<PtcBrowserNavigateRuntimeResult>;
  closeAll(
    args?: PtcBrowserRuntimeCloseAllArgs,
  ): Promise<PtcBrowserNavigateRuntimeCleanupResult>;
}
