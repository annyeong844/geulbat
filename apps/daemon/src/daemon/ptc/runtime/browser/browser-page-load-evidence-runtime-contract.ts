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
  PtcLabBrowserEvidenceFailureReason,
  PtcLabBrowserEvidencePhase,
  PtcLabBrowserPageLoadEvidenceSummary as SharedPtcLabBrowserPageLoadEvidenceSummary,
  PtcLabBrowserRuntimeOwnedSessionLifecycle,
} from '../../shared/browser-evidence-contract.js';

export const PTC_BROWSER_PAGE_LOAD_EVIDENCE_TOOL_NAME =
  'browser_page_load_evidence' as const;
export const PTC_BROWSER_PAGE_LOAD_EVIDENCE_LAB_POLICY_ID =
  'ptc_lab_browser_page_load_evidence_tool_v1' as const;
export const PTC_BROWSER_PAGE_LOAD_EVIDENCE_MAX_URL_BYTES =
  PTC_BROWSER_RUNTIME_MAX_URL_BYTES;
export const PTC_BROWSER_PAGE_LOAD_EVIDENCE_MAX_TIMEOUT_MS =
  PTC_BROWSER_RUNTIME_MAX_TIMEOUT_MS;

type PtcBrowserPageLoadEvidenceTargetDigest = PtcSha256Digest;
type PtcBrowserPageLoadEvidenceAttemptDigest = PtcSha256Digest;
type PtcBrowserPageLoadEvidenceDigest = PtcSha256Digest;

export type PtcBrowserPageLoadEvidenceRuntimeSummary =
  SharedPtcLabBrowserPageLoadEvidenceSummary<
    PtcBrowserPageLoadEvidenceTargetDigest,
    PtcBrowserPageLoadEvidenceAttemptDigest,
    PtcBrowserPageLoadEvidenceDigest
  >;

export type PtcBrowserPageLoadEvidenceFailureReason =
  PtcLabBrowserEvidenceFailureReason;

type PtcBrowserPageLoadEvidenceFailurePhase = PtcLabBrowserEvidencePhase;

interface PtcBrowserPageLoadEvidenceRuntimeError {
  kind: 'ptc_lab_browser_page_load_evidence_error';
  ok: false;
  reasonCode: PtcBrowserPageLoadEvidenceFailureReason;
  message: string;
  phase: PtcBrowserPageLoadEvidenceFailurePhase;
  targetDigest?: PtcBrowserPageLoadEvidenceTargetDigest;
  pageLoadEvidenceAttemptDigest?: PtcBrowserPageLoadEvidenceAttemptDigest;
  sessionLifecycle?: PtcLabBrowserRuntimeOwnedSessionLifecycle;
  diagnostics?: PtcLabBrowserEvidenceDiagnostics;
}

export type PtcBrowserPageLoadEvidenceRuntimeResult =
  | { ok: true; value: PtcBrowserPageLoadEvidenceRuntimeSummary }
  | PtcBrowserPageLoadEvidenceRuntimeError;

export type PtcBrowserPageLoadEvidenceRuntimeCleanupResult =
  PtcBrowserRuntimeCleanupResult<'ptc_browser_page_load_evidence_session_cleanup_failed'>;

export interface PtcBrowserPageLoadEvidenceRuntime {
  collectEvidence(
    args: PtcBrowserRuntimeOperationArgs<PtcBrowserRuntimeUrlRequest>,
  ): Promise<PtcBrowserPageLoadEvidenceRuntimeResult>;
  closeAll(
    args?: PtcBrowserRuntimeCloseAllArgs,
  ): Promise<PtcBrowserPageLoadEvidenceRuntimeCleanupResult>;
}
