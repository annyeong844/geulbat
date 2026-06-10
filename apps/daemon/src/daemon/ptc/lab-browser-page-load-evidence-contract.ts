import { sha256StableJson } from '@geulbat/shared-utils/stable-json';
import {
  PTC_LAB_BROWSER_FINAL_URL_DIGEST_PUBLIC_SHA256_POLICY_ID,
  PTC_LAB_BROWSER_FINAL_URL_ECHO_DIGEST_ONLY_POLICY_ID,
  PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_DIGEST_RESULT_WITH_TIMING_POLICY_ID,
  PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_POLICY_ID,
  PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_SUMMARY_POLICY_ID,
  PTC_LAB_BROWSER_REDIRECT_COUNT_ONLY_POLICY_ID,
  PTC_LAB_BROWSER_REDIRECT_REVALIDATED_POLICY_ID,
  PTC_LAB_BROWSER_RESPONSE_STATUS_CODE_OPTIONAL_POLICY_ID,
  PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
  PTC_LAB_BROWSER_TIMING_OWNER_AND_NAVIGATION_BOUNDED_POLICY_ID,
  PTC_LAB_BROWSER_TITLE_BOUNDED_TEXT_POLICY_ID,
  PTC_LAB_BROWSER_URL_ECHO_DIGEST_ONLY_POLICY_ID,
  type PtcLabBrowserPolicy,
} from './lab-browser-policy.js';
import { PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID } from './lab-network-policy.js';
import type { PtcLabAdmittedProfile } from './lab-profile.js';
import type {
  PtcSessionDockerCommandRunner,
  PtcSessionDockerIdentity,
  PtcSessionDockerManager,
} from './session-docker-contract.js';
import {
  PTC_LAB_BROWSER_URL_GRAMMAR_HTTP_HTTPS_NO_CREDENTIALS_POLICY_ID,
  type PtcLabBrowserUserUrlNavigationRequest,
  type PtcLabBrowserUserUrlNavigationTarget,
  type PtcLabBrowserUserUrlTargetDigest,
} from './lab-browser-url-navigation.js';
import {
  buildPtcLabBrowserNavigationAttemptSharedDigestInput,
  digestPtcLabBrowserNavigationAttempt,
  type PtcLabBrowserNavigationAttemptDigest,
  type PtcLabBrowserNavigationAttemptSharedDigestInput,
} from './lab-browser-navigation-attempt-identity.js';
import {
  createPtcLabBrowserPhasedFailure,
  type PtcLabBrowserDiagnostics,
  type PtcLabBrowserPhasedFailure,
  type PtcLabBrowserResult,
} from './lab-browser-result-contract.js';

export const PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_CAPABILITY =
  'ptc_lab_browser_page_load_evidence' as const;
export const PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_RESULT_KIND =
  'ptc_lab_browser_page_load_evidence_result' as const;
export const PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_ERROR_KIND =
  'ptc_lab_browser_page_load_evidence_error' as const;

export type PtcLabBrowserPageLoadEvidenceFailureReason =
  | 'ptc_lab_browser_policy_disabled'
  | 'ptc_lab_browser_policy_mismatch'
  | 'ptc_lab_browser_network_disabled'
  | 'ptc_lab_browser_request_invalid'
  | 'ptc_lab_browser_url_admission_failed'
  | 'ptc_lab_browser_target_digest_mismatch'
  | 'ptc_lab_browser_session_unavailable'
  | 'ptc_lab_browser_runtime_unavailable'
  | 'ptc_lab_browser_navigation_failed'
  | 'ptc_lab_browser_redirect_disallowed'
  | 'ptc_lab_browser_download_disallowed'
  | 'ptc_lab_browser_popup_disallowed'
  | 'ptc_lab_browser_permission_disallowed'
  | 'ptc_lab_browser_evidence_unavailable'
  | 'ptc_lab_browser_evidence_output_invalid'
  | 'ptc_lab_browser_timeout'
  | 'ptc_lab_browser_cancelled'
  | 'ptc_lab_browser_session_tainted'
  | 'ptc_lab_browser_cleanup_failed'
  | 'ptc_lab_browser_cleanup_uncertain';

export type PtcLabBrowserPageLoadEvidencePhase =
  | 'request_admission'
  | 'target_verification'
  | 'policy_admission'
  | 'session_acquisition'
  | 'runtime_start'
  | 'navigation'
  | 'redirect_revalidation'
  | 'download_policy'
  | 'popup_policy'
  | 'permission_policy'
  | 'evidence_capture'
  | 'evidence_sanitization'
  | 'cleanup'
  | 'output_serialization';

export type PtcLabBrowserPageLoadEvidenceAttemptDigest =
  PtcLabBrowserNavigationAttemptDigest;
export type PtcLabBrowserPageLoadEvidenceDigest = `sha256:${string}`;

export interface PtcLabBrowserPageLoadEvidenceChecks {
  targetVerified: boolean;
  engineAvailable: boolean;
  contextCreated: boolean;
  navigationStarted: boolean;
  navigationSettled: boolean;
  redirectPolicyEnforced: boolean;
  downloadPolicyEnforced: boolean;
  popupPolicyEnforced: boolean;
  permissionPolicyEnforced: boolean;
  evidenceSanitized: boolean;
  cleanupCompleted: boolean;
}

export interface PtcLabBrowserPageLoadEvidenceSummaryPolicyFields {
  policyFingerprint: `sha256:${string}`;
  maxNavigationMs: number;
  maxTitleChars: number;
  maxTabs: 1;
  browserPolicyId: typeof PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_POLICY_ID;
  browserMode: 'page_load_evidence';
  browserEnginePolicyId: typeof PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID;
  browserNetworkPolicyId: typeof PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID;
  browserUrlGrammarPolicyId: typeof PTC_LAB_BROWSER_URL_GRAMMAR_HTTP_HTTPS_NO_CREDENTIALS_POLICY_ID;
  browserRedirectPolicyId: typeof PTC_LAB_BROWSER_REDIRECT_REVALIDATED_POLICY_ID;
  browserEvidencePolicyId: typeof PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_SUMMARY_POLICY_ID;
  pageLoadEvidenceDigestPolicyId: typeof PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_DIGEST_RESULT_WITH_TIMING_POLICY_ID;
  requestedUrlEchoPolicyId: typeof PTC_LAB_BROWSER_URL_ECHO_DIGEST_ONLY_POLICY_ID;
  finalUrlEchoPolicyId: typeof PTC_LAB_BROWSER_FINAL_URL_ECHO_DIGEST_ONLY_POLICY_ID;
  finalUrlDigestPolicyId: typeof PTC_LAB_BROWSER_FINAL_URL_DIGEST_PUBLIC_SHA256_POLICY_ID;
  responseStatusPolicyId: typeof PTC_LAB_BROWSER_RESPONSE_STATUS_CODE_OPTIONAL_POLICY_ID;
  titlePolicyId: typeof PTC_LAB_BROWSER_TITLE_BOUNDED_TEXT_POLICY_ID;
  redirectCountPolicyId: typeof PTC_LAB_BROWSER_REDIRECT_COUNT_ONLY_POLICY_ID;
  timingPolicyId: typeof PTC_LAB_BROWSER_TIMING_OWNER_AND_NAVIGATION_BOUNDED_POLICY_ID;
  artifactExported: false;
}

export interface PtcLabBrowserPageLoadEvidenceSummary extends PtcLabBrowserPageLoadEvidenceSummaryPolicyFields {
  kind: typeof PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_RESULT_KIND;
  ok: true;
  profile: 'lab';
  capability: typeof PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_CAPABILITY;
  targetDigest: PtcLabBrowserUserUrlTargetDigest;
  pageLoadEvidenceAttemptDigest: PtcLabBrowserPageLoadEvidenceAttemptDigest;
  pageLoadEvidenceDigest: PtcLabBrowserPageLoadEvidenceDigest;
  sessionLifecycle: {
    mode: 'runtime_owned';
    retainedAfterExecution: boolean;
    taintedAfterExecution: false;
  };
  requestedUrl: {
    digest: PtcLabBrowserUserUrlTargetDigest;
    echoPolicyId: typeof PTC_LAB_BROWSER_URL_ECHO_DIGEST_ONLY_POLICY_ID;
    redacted: true;
  };
  finalUrl: {
    digest: `sha256:${string}`;
    digestPolicyId: typeof PTC_LAB_BROWSER_FINAL_URL_DIGEST_PUBLIC_SHA256_POLICY_ID;
    echoPolicyId: typeof PTC_LAB_BROWSER_FINAL_URL_ECHO_DIGEST_ONLY_POLICY_ID;
    redacted: true;
  };
  loadOutcome: 'loaded' | 'no_committed_document' | 'browser_error_page';
  loadState: 'domcontentloaded' | 'load' | 'no_committed_document';
  responseStatus?: {
    policyId: typeof PTC_LAB_BROWSER_RESPONSE_STATUS_CODE_OPTIONAL_POLICY_ID;
    code: number;
    source: 'final_main_resource_response';
  };
  title?: {
    policyId: typeof PTC_LAB_BROWSER_TITLE_BOUNDED_TEXT_POLICY_ID;
    text: string;
    charCount: number;
    truncated: boolean;
    maxChars: number;
    redacted: boolean;
  };
  redirects: {
    policyId: typeof PTC_LAB_BROWSER_REDIRECT_COUNT_ONLY_POLICY_ID;
    count: number;
  };
  timing: {
    policyId: typeof PTC_LAB_BROWSER_TIMING_OWNER_AND_NAVIGATION_BOUNDED_POLICY_ID;
    ownerDurationMs: number;
    navigationDurationMs?: number;
  };
  evidenceAvailability: {
    responseStatus: 'available' | 'unavailable_allowed';
    title: 'available' | 'unavailable_allowed' | 'redacted';
    finalUrl: 'available';
    navigationTiming: 'available' | 'unavailable_allowed';
  };
  checks: PtcLabBrowserPageLoadEvidenceChecks;
}

export type PtcLabBrowserPageLoadEvidenceError = PtcLabBrowserPhasedFailure<
  typeof PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_ERROR_KIND,
  PtcLabBrowserPageLoadEvidenceFailureReason,
  PtcLabBrowserPageLoadEvidencePhase,
  {
    targetDigest?: PtcLabBrowserUserUrlTargetDigest;
    pageLoadEvidenceAttemptDigest?: PtcLabBrowserPageLoadEvidenceAttemptDigest;
    sessionLifecycle?: {
      mode: 'runtime_owned';
      retainedAfterExecution: boolean;
      taintedAfterExecution: boolean;
    };
    diagnostics?: PtcLabBrowserDiagnostics;
  }
>;

export type PtcLabBrowserPageLoadEvidenceResult<T> = PtcLabBrowserResult<
  T,
  PtcLabBrowserPageLoadEvidenceError
>;

export interface PtcLabBrowserPageLoadEvidenceRuntimeInput {
  target: PtcLabBrowserUserUrlNavigationTarget;
  timeoutMs?: number;
}

export interface PtcLabBrowserPageLoadEvidenceExecutionPolicyFields {
  policyFingerprint: `sha256:${string}`;
  maxNavigationMs: number;
  maxTitleChars: number;
  maxTabs: 1;
  evidencePolicyId: typeof PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_SUMMARY_POLICY_ID;
  pageLoadEvidenceDigestPolicyId: typeof PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_DIGEST_RESULT_WITH_TIMING_POLICY_ID;
  requestedUrlEchoPolicyId: typeof PTC_LAB_BROWSER_URL_ECHO_DIGEST_ONLY_POLICY_ID;
  finalUrlEchoPolicyId: typeof PTC_LAB_BROWSER_FINAL_URL_ECHO_DIGEST_ONLY_POLICY_ID;
  finalUrlDigestPolicyId: typeof PTC_LAB_BROWSER_FINAL_URL_DIGEST_PUBLIC_SHA256_POLICY_ID;
  responseStatusPolicyId: typeof PTC_LAB_BROWSER_RESPONSE_STATUS_CODE_OPTIONAL_POLICY_ID;
  titlePolicyId: typeof PTC_LAB_BROWSER_TITLE_BOUNDED_TEXT_POLICY_ID;
  redirectCountPolicyId: typeof PTC_LAB_BROWSER_REDIRECT_COUNT_ONLY_POLICY_ID;
  timingPolicyId: typeof PTC_LAB_BROWSER_TIMING_OWNER_AND_NAVIGATION_BOUNDED_POLICY_ID;
}

export interface PtcLabBrowserPageLoadEvidenceExecutionDigestInput
  extends
    PtcLabBrowserNavigationAttemptSharedDigestInput<
      typeof PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_POLICY_ID
    >,
    PtcLabBrowserPageLoadEvidenceExecutionPolicyFields {}

export interface PtcLabBrowserPageLoadEvidenceExecutionIdentity extends PtcLabBrowserPageLoadEvidenceExecutionDigestInput {
  pageLoadEvidenceAttemptDigest: PtcLabBrowserPageLoadEvidenceAttemptDigest;
}

export interface RunPtcLabBrowserPageLoadEvidenceArgs {
  admission: PtcLabAdmittedProfile | undefined;
  identity: PtcSessionDockerIdentity;
  sessionManager: PtcSessionDockerManager;
  request: PtcLabBrowserUserUrlNavigationRequest;
  commandRunner?: PtcSessionDockerCommandRunner;
  dockerPath?: string;
  now?: () => number;
  signal?: AbortSignal;
}

export interface RunPtcLabBrowserPageLoadEvidenceRuntimeArgs {
  admission: PtcLabAdmittedProfile | undefined;
  identity: PtcSessionDockerIdentity;
  sessionManager: PtcSessionDockerManager;
  input: PtcLabBrowserPageLoadEvidenceRuntimeInput;
  ownerStartMs?: number;
  commandRunner?: PtcSessionDockerCommandRunner;
  dockerPath?: string;
  now?: () => number;
  signal?: AbortSignal;
}

export function buildPtcLabBrowserPageLoadEvidenceExecutionIdentity(args: {
  browser: Extract<PtcLabBrowserPolicy, { mode: 'page_load_evidence' }>;
  effectiveTimeoutMs: number;
  targetDigest: PtcLabBrowserUserUrlTargetDigest;
}): PtcLabBrowserPageLoadEvidenceExecutionIdentity {
  const digestInput: PtcLabBrowserPageLoadEvidenceExecutionDigestInput = {
    ...buildPtcLabBrowserNavigationAttemptSharedDigestInput(args),
    ...buildPtcLabBrowserPageLoadEvidenceExecutionPolicyFields(args.browser),
  };
  return {
    ...digestInput,
    pageLoadEvidenceAttemptDigest:
      digestPtcLabBrowserPageLoadEvidenceAttempt(digestInput),
  };
}

export function buildPtcLabBrowserPageLoadEvidenceExecutionPolicyFields(
  browser: Extract<PtcLabBrowserPolicy, { mode: 'page_load_evidence' }>,
): PtcLabBrowserPageLoadEvidenceExecutionPolicyFields {
  return {
    policyFingerprint: browser.policyFingerprint,
    maxNavigationMs: browser.maxNavigationMs,
    maxTitleChars: browser.maxTitleChars,
    maxTabs: browser.maxTabs,
    evidencePolicyId: browser.evidencePolicyId,
    pageLoadEvidenceDigestPolicyId: browser.pageLoadEvidenceDigestPolicyId,
    requestedUrlEchoPolicyId: browser.requestedUrlEchoPolicyId,
    finalUrlEchoPolicyId: browser.finalUrlEchoPolicyId,
    finalUrlDigestPolicyId: browser.finalUrlDigestPolicyId,
    responseStatusPolicyId: browser.responseStatusPolicyId,
    titlePolicyId: browser.titlePolicyId,
    redirectCountPolicyId: browser.redirectCountPolicyId,
    timingPolicyId: browser.timingPolicyId,
  };
}

export function buildPtcLabBrowserPageLoadEvidenceSummaryPolicyFields(
  browser: Extract<PtcLabBrowserPolicy, { mode: 'page_load_evidence' }>,
): PtcLabBrowserPageLoadEvidenceSummaryPolicyFields {
  return {
    policyFingerprint: browser.policyFingerprint,
    maxNavigationMs: browser.maxNavigationMs,
    maxTitleChars: browser.maxTitleChars,
    maxTabs: browser.maxTabs,
    browserPolicyId: browser.browserPolicyId,
    browserMode: browser.mode,
    browserEnginePolicyId: browser.browserEnginePolicyId,
    browserNetworkPolicyId: browser.networkPolicyId,
    browserUrlGrammarPolicyId: browser.urlGrammarPolicyId,
    browserRedirectPolicyId: browser.redirectPolicyId,
    browserEvidencePolicyId: browser.evidencePolicyId,
    pageLoadEvidenceDigestPolicyId: browser.pageLoadEvidenceDigestPolicyId,
    requestedUrlEchoPolicyId: browser.requestedUrlEchoPolicyId,
    finalUrlEchoPolicyId: browser.finalUrlEchoPolicyId,
    finalUrlDigestPolicyId: browser.finalUrlDigestPolicyId,
    responseStatusPolicyId: browser.responseStatusPolicyId,
    titlePolicyId: browser.titlePolicyId,
    redirectCountPolicyId: browser.redirectCountPolicyId,
    timingPolicyId: browser.timingPolicyId,
    artifactExported: false,
  };
}

export function digestPtcLabBrowserPageLoadEvidenceAttempt(
  value: PtcLabBrowserPageLoadEvidenceExecutionDigestInput,
): PtcLabBrowserPageLoadEvidenceAttemptDigest {
  return digestPtcLabBrowserNavigationAttempt(value);
}

export function digestPtcLabBrowserPageLoadEvidence(
  value: unknown,
): PtcLabBrowserPageLoadEvidenceDigest {
  const digest = sha256StableJson(value);
  return `sha256:${digest}`;
}

export function browserPageLoadEvidenceFailure(
  reasonCode: PtcLabBrowserPageLoadEvidenceFailureReason,
  message: string,
  phase: PtcLabBrowserPageLoadEvidencePhase,
  extras: Omit<
    PtcLabBrowserPageLoadEvidenceError,
    'kind' | 'ok' | 'reasonCode' | 'message' | 'phase'
  > = {},
): PtcLabBrowserPageLoadEvidenceError {
  return createPtcLabBrowserPhasedFailure({
    kind: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_ERROR_KIND,
    reasonCode,
    message,
    phase,
    extras,
  });
}
