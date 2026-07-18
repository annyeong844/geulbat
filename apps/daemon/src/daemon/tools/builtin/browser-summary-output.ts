import type {
  PtcBrowserNavigateFailureReason,
  PtcBrowserNavigateRuntimeSummary,
} from '../../ptc/runtime/browser/browser-navigate-runtime-contract.js';
import type {
  PtcBrowserPageLoadEvidenceFailureReason,
  PtcBrowserPageLoadEvidenceRuntimeResult,
  PtcBrowserPageLoadEvidenceRuntimeSummary,
} from '../../ptc/runtime/browser/browser-page-load-evidence-runtime-contract.js';
import type {
  PtcBrowserTextEvidenceRuntimeResult,
  PtcBrowserTextEvidenceRuntimeSummary,
} from '../../ptc/runtime/browser/browser-text-evidence-runtime-contract.js';

type BrowserEvidencePolicyOutputKey = Extract<
  keyof PtcBrowserPageLoadEvidenceRuntimeSummary,
  keyof PtcBrowserTextEvidenceRuntimeSummary
>;

type BrowserToolFailureReason =
  | PtcBrowserNavigateFailureReason
  | PtcBrowserPageLoadEvidenceFailureReason;

type BrowserToolFailureErrorCode =
  | 'aborted'
  | 'execution_failed'
  | 'invalid_args'
  | 'timeout';

type BrowserToolFailureSubject =
  | 'navigation'
  | 'page-load evidence'
  | 'text evidence';

type BrowserEvidenceFailureOutputArgs =
  | {
      failure: Extract<PtcBrowserPageLoadEvidenceRuntimeResult, { ok: false }>;
      subject: 'page-load evidence';
      attemptDigestField: 'pageLoadEvidenceAttemptDigest';
    }
  | {
      failure: Extract<PtcBrowserTextEvidenceRuntimeResult, { ok: false }>;
      subject: 'text evidence';
      attemptDigestField: 'textEvidenceAttemptDigest';
    };

const BROWSER_INVALID_ARGS_FAILURE_REASONS = new Set<BrowserToolFailureReason>([
  'ptc_lab_browser_policy_disabled',
  'ptc_lab_browser_policy_mismatch',
  'ptc_lab_browser_network_disabled',
  'ptc_lab_browser_request_invalid',
  'ptc_lab_browser_url_admission_failed',
]);

const BROWSER_NAVIGATE_POLICY_OUTPUT_KEYS = [
  'browserPolicyId',
  'browserMode',
  'browserEnginePolicyId',
  'browserNetworkPolicyId',
  'browserUrlGrammarPolicyId',
  'browserRedirectPolicyId',
  'browserEvidencePolicyId',
  'browserUrlEchoPolicyId',
  'browserPopupPolicyId',
  'browserPermissionPolicyId',
  'browserProfilePolicyId',
  'browserCookieStorePolicyId',
  'browserDownloadPolicyId',
  'browserArtifactExportPolicyId',
  'artifactExported',
] as const satisfies readonly (keyof PtcBrowserNavigateRuntimeSummary)[];

const BROWSER_EVIDENCE_POLICY_BUDGET_OUTPUT_KEYS = [
  'policyFingerprint',
  'maxNavigationMs',
] as const satisfies readonly BrowserEvidencePolicyOutputKey[];

const BROWSER_EVIDENCE_POLICY_ID_OUTPUT_KEYS = [
  'maxTabs',
  'browserPolicyId',
  'browserMode',
  'browserEnginePolicyId',
  'browserNetworkPolicyId',
  'browserUrlGrammarPolicyId',
  'browserRedirectPolicyId',
  'browserEvidencePolicyId',
] as const satisfies readonly BrowserEvidencePolicyOutputKey[];

const BROWSER_EVIDENCE_URL_POLICY_OUTPUT_KEYS = [
  'requestedUrlEchoPolicyId',
  'finalUrlEchoPolicyId',
  'finalUrlDigestPolicyId',
] as const satisfies readonly BrowserEvidencePolicyOutputKey[];

const BROWSER_EVIDENCE_POLICY_TRAILER_OUTPUT_KEYS = [
  'redirectCountPolicyId',
  'timingPolicyId',
  'artifactExported',
] as const satisfies readonly BrowserEvidencePolicyOutputKey[];

const BROWSER_PAGE_LOAD_EVIDENCE_POLICY_OUTPUT_KEYS = [
  ...BROWSER_EVIDENCE_POLICY_BUDGET_OUTPUT_KEYS,
  ...BROWSER_EVIDENCE_POLICY_ID_OUTPUT_KEYS,
  'pageLoadEvidenceDigestPolicyId',
  ...BROWSER_EVIDENCE_URL_POLICY_OUTPUT_KEYS,
  'responseStatusPolicyId',
  ...BROWSER_EVIDENCE_POLICY_TRAILER_OUTPUT_KEYS,
] as const satisfies readonly (keyof PtcBrowserPageLoadEvidenceRuntimeSummary)[];

const BROWSER_TEXT_EVIDENCE_POLICY_OUTPUT_KEYS = [
  ...BROWSER_EVIDENCE_POLICY_BUDGET_OUTPUT_KEYS,
  ...BROWSER_EVIDENCE_POLICY_ID_OUTPUT_KEYS,
  'textEvidenceDigestPolicyId',
  ...BROWSER_EVIDENCE_URL_POLICY_OUTPUT_KEYS,
  ...BROWSER_EVIDENCE_POLICY_TRAILER_OUTPUT_KEYS,
] as const satisfies readonly (keyof PtcBrowserTextEvidenceRuntimeSummary)[];

const BROWSER_SAFE_DIAGNOSTIC_KEYS = [
  'admissionReasonCode',
  'unsupportedCategory',
  'maxUrlBytes',
  'sessionReasonCode',
  'sessionTainted',
  'sessionCloseFailed',
  'commandResultKind',
  'inputCleanupFailed',
  'stateRootRealpathFailed',
  'runtimeRootUnavailable',
] as const;

type PickSummaryFields<Summary, Keys extends readonly (keyof Summary)[]> = {
  [Key in Keys[number]]: Summary[Key];
};

type BrowserSafeDiagnostics = Record<string, string | number | boolean>;

export function pickBrowserNavigatePolicyOutputFields(
  summary: PtcBrowserNavigateRuntimeSummary,
): PickSummaryFields<
  PtcBrowserNavigateRuntimeSummary,
  typeof BROWSER_NAVIGATE_POLICY_OUTPUT_KEYS
> {
  return pickSummaryFields(summary, BROWSER_NAVIGATE_POLICY_OUTPUT_KEYS);
}

export function pickBrowserPageLoadEvidencePolicyOutputFields(
  summary: PtcBrowserPageLoadEvidenceRuntimeSummary,
): PickSummaryFields<
  PtcBrowserPageLoadEvidenceRuntimeSummary,
  typeof BROWSER_PAGE_LOAD_EVIDENCE_POLICY_OUTPUT_KEYS
> {
  return pickSummaryFields(
    summary,
    BROWSER_PAGE_LOAD_EVIDENCE_POLICY_OUTPUT_KEYS,
  );
}

export function pickBrowserTextEvidencePolicyOutputFields(
  summary: PtcBrowserTextEvidenceRuntimeSummary,
): PickSummaryFields<
  PtcBrowserTextEvidenceRuntimeSummary,
  typeof BROWSER_TEXT_EVIDENCE_POLICY_OUTPUT_KEYS
> {
  return pickSummaryFields(summary, BROWSER_TEXT_EVIDENCE_POLICY_OUTPUT_KEYS);
}

export function pickBrowserSafeDiagnosticFields(
  diagnostics: Record<string, unknown> | undefined,
): BrowserSafeDiagnostics | undefined {
  if (diagnostics === undefined) {
    return undefined;
  }
  const safe: BrowserSafeDiagnostics = {};
  for (const key of BROWSER_SAFE_DIAGNOSTIC_KEYS) {
    const value = diagnostics[key];
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      safe[key] = value;
    }
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

export function stringifyBrowserEvidenceFailureOutput(
  args: BrowserEvidenceFailureOutputArgs,
): string {
  const attemptDigest =
    args.attemptDigestField === 'pageLoadEvidenceAttemptDigest'
      ? args.failure.pageLoadEvidenceAttemptDigest
      : args.failure.textEvidenceAttemptDigest;
  const failure = args.failure;
  return JSON.stringify({
    kind: failure.kind,
    ok: failure.ok,
    reasonCode: failure.reasonCode,
    message: browserFailureReasonMessage({
      reasonCode: failure.reasonCode,
      subject: args.subject,
    }),
    phase: failure.phase,
    targetDigest: failure.targetDigest,
    ...(attemptDigest === undefined
      ? {}
      : { [args.attemptDigestField]: attemptDigest }),
    sessionLifecycle: failure.sessionLifecycle,
    diagnostics: pickBrowserSafeDiagnosticFields(failure.diagnostics),
  });
}

export function browserFailureReasonToToolErrorCode(
  reasonCode: BrowserToolFailureReason,
): BrowserToolFailureErrorCode {
  if (BROWSER_INVALID_ARGS_FAILURE_REASONS.has(reasonCode)) {
    return 'invalid_args';
  }
  if (reasonCode === 'ptc_lab_browser_timeout') {
    return 'timeout';
  }
  if (reasonCode === 'ptc_lab_browser_cancelled') {
    return 'aborted';
  }
  return 'execution_failed';
}

export function browserFailureReasonMessage(args: {
  reasonCode: BrowserToolFailureReason;
  subject: BrowserToolFailureSubject;
}): string {
  const subject = `PTC browser ${args.subject}`;
  switch (args.reasonCode) {
    case 'ptc_lab_browser_admission_required':
      return `${subject} requires an admitted lab profile.`;
    case 'ptc_lab_browser_policy_disabled':
      return `${subject} is disabled by policy.`;
    case 'ptc_lab_browser_policy_mismatch':
      return `${subject} policy identity is incompatible.`;
    case 'ptc_lab_browser_network_disabled':
      return `${subject} requires admitted network access.`;
    case 'ptc_lab_browser_request_invalid':
      return `${subject} request is invalid.`;
    case 'ptc_lab_browser_url_admission_failed':
      return `${subject} URL was not admitted.`;
    case 'ptc_lab_browser_session_unavailable':
      return `${subject} session is unavailable.`;
    case 'ptc_lab_browser_runtime_unavailable':
      return 'PTC browser runtime is unavailable.';
    case 'ptc_lab_browser_navigation_failed':
      return args.subject === 'navigation'
        ? `${subject} failed.`
        : `${subject} navigation failed.`;
    case 'ptc_lab_browser_redirect_disallowed':
      return `${subject} redirect was disallowed.`;
    case 'ptc_lab_browser_download_disallowed':
      return `${subject} download was disallowed.`;
    case 'ptc_lab_browser_popup_disallowed':
      return `${subject} popup was disallowed.`;
    case 'ptc_lab_browser_output_invalid':
    case 'ptc_lab_browser_evidence_output_invalid':
      return `${subject} output was invalid.`;
    case 'ptc_lab_browser_evidence_unavailable':
      return `${subject} is unavailable.`;
    case 'ptc_lab_browser_timeout':
      return `${subject} timed out.`;
    case 'ptc_lab_browser_cancelled':
      return `${subject} was cancelled.`;
    case 'ptc_lab_browser_cleanup_failed':
      return `${subject} cleanup failed.`;
    case 'ptc_lab_browser_cleanup_uncertain':
      return `${subject} cleanup was not proven.`;
  }
}

function pickSummaryFields<
  Summary,
  const Keys extends readonly (keyof Summary)[],
>(summary: Summary, keys: Keys): PickSummaryFields<Summary, Keys> {
  const result: Partial<Record<keyof Summary, unknown>> = {};
  for (const key of keys) {
    result[key] = summary[key];
  }
  return result as PickSummaryFields<Summary, Keys>;
}
