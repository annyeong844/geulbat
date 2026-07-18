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
  PtcLabBrowserRuntimeOwnedSessionLifecycle,
  PtcLabBrowserTextEvidenceSummary as SharedPtcLabBrowserTextEvidenceSummary,
} from '../../shared/browser-evidence-contract.js';

export const PTC_BROWSER_TEXT_EVIDENCE_TOOL_NAME =
  'browser_text_evidence' as const;
export const PTC_BROWSER_TEXT_EVIDENCE_LAB_POLICY_ID =
  'ptc_lab_browser_text_evidence_tool_v1' as const;
export const PTC_BROWSER_TEXT_EVIDENCE_MAX_URL_BYTES =
  PTC_BROWSER_RUNTIME_MAX_URL_BYTES;
export const PTC_BROWSER_TEXT_EVIDENCE_MAX_TIMEOUT_MS =
  PTC_BROWSER_RUNTIME_MAX_TIMEOUT_MS;

type PtcBrowserTextEvidenceTargetDigest = PtcSha256Digest;
type PtcBrowserTextEvidenceAttemptDigest = PtcSha256Digest;
type PtcBrowserTextEvidenceDigest = PtcSha256Digest;

export type PtcBrowserTextEvidenceRuntimeSummary =
  SharedPtcLabBrowserTextEvidenceSummary<
    PtcBrowserTextEvidenceTargetDigest,
    PtcBrowserTextEvidenceAttemptDigest,
    PtcBrowserTextEvidenceDigest
  >;

export type PtcBrowserTextEvidenceFailureReason =
  PtcLabBrowserEvidenceFailureReason;

type PtcBrowserTextEvidenceFailurePhase = PtcLabBrowserEvidencePhase;

interface PtcBrowserTextEvidenceRuntimeError {
  kind: 'ptc_lab_browser_text_evidence_error';
  ok: false;
  reasonCode: PtcBrowserTextEvidenceFailureReason;
  message: string;
  phase: PtcBrowserTextEvidenceFailurePhase;
  targetDigest?: PtcBrowserTextEvidenceTargetDigest;
  textEvidenceAttemptDigest?: PtcBrowserTextEvidenceAttemptDigest;
  sessionLifecycle?: PtcLabBrowserRuntimeOwnedSessionLifecycle;
  diagnostics?: PtcLabBrowserEvidenceDiagnostics;
}

export type PtcBrowserTextEvidenceRuntimeResult =
  | { ok: true; value: PtcBrowserTextEvidenceRuntimeSummary }
  | PtcBrowserTextEvidenceRuntimeError;

type PtcBrowserTextEvidenceRuntimeCleanupResult =
  PtcBrowserRuntimeCleanupResult<'ptc_browser_text_evidence_session_cleanup_failed'>;

type PtcBrowserTextEvidenceRuntimeWarmArgs = Omit<
  PtcBrowserRuntimeOperationArgs<Record<never, never>>,
  'request'
>;

type PtcBrowserTextEvidenceRuntimeWarmResult =
  | { ok: true }
  | PtcBrowserTextEvidenceRuntimeError;

export interface PtcBrowserTextEvidenceRuntime {
  warmState?(
    args: PtcBrowserTextEvidenceRuntimeWarmArgs,
  ): Promise<PtcBrowserTextEvidenceRuntimeWarmResult>;
  collectEvidence(
    args: PtcBrowserRuntimeOperationArgs<PtcBrowserRuntimeUrlRequest>,
  ): Promise<PtcBrowserTextEvidenceRuntimeResult>;
  closeAll(
    args?: PtcBrowserRuntimeCloseAllArgs,
  ): Promise<PtcBrowserTextEvidenceRuntimeCleanupResult>;
}
