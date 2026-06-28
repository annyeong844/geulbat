export type PtcLabBrowserEvidenceFailureReason =
  | 'ptc_lab_browser_admission_required'
  | 'ptc_lab_browser_policy_disabled'
  | 'ptc_lab_browser_policy_mismatch'
  | 'ptc_lab_browser_network_disabled'
  | 'ptc_lab_browser_request_invalid'
  | 'ptc_lab_browser_url_admission_failed'
  | 'ptc_lab_browser_session_unavailable'
  | 'ptc_lab_browser_runtime_unavailable'
  | 'ptc_lab_browser_navigation_failed'
  | 'ptc_lab_browser_redirect_disallowed'
  | 'ptc_lab_browser_download_disallowed'
  | 'ptc_lab_browser_popup_disallowed'
  | 'ptc_lab_browser_evidence_unavailable'
  | 'ptc_lab_browser_evidence_output_invalid'
  | 'ptc_lab_browser_timeout'
  | 'ptc_lab_browser_cancelled'
  | 'ptc_lab_browser_cleanup_failed'
  | 'ptc_lab_browser_cleanup_uncertain';

export type PtcLabBrowserEvidencePhase =
  | 'request_admission'
  | 'target_verification'
  | 'policy_admission'
  | 'session_acquisition'
  | 'runtime_start'
  | 'navigation'
  | 'redirect_revalidation'
  | 'download_policy'
  | 'popup_policy'
  | 'evidence_capture'
  | 'cleanup'
  | 'output_serialization';

export type PtcSha256Digest = `sha256:${string}`;

export type PtcLabBrowserEvidenceDigest = PtcSha256Digest;

export type PtcLabBrowserEvidenceDiagnostics = Record<
  string,
  string | number | boolean
>;

export interface PtcLabBrowserEvidenceChecks {
  targetVerified: boolean;
  engineAvailable: boolean;
  contextCreated: boolean;
  navigationStarted: boolean;
  navigationSettled: boolean;
  redirectPolicyEnforced: boolean;
  downloadPolicyEnforced: boolean;
  popupPolicyEnforced: boolean;
  evidenceCaptured: boolean;
  cleanupCompleted: boolean;
}

export type PtcLabBrowserEvidenceAdapterChecks = Omit<
  PtcLabBrowserEvidenceChecks,
  'targetVerified'
>;

export interface PtcLabBrowserRuntimeOwnedSessionLifecycle<
  TaintedAfterExecution extends boolean = boolean,
> {
  mode: 'runtime_owned';
  retainedAfterExecution: boolean;
  taintedAfterExecution: TaintedAfterExecution;
}

export interface PtcLabBrowserRedactedRequestedUrl<
  Digest extends PtcLabBrowserEvidenceDigest,
  EchoPolicyId extends string,
> {
  digest: Digest;
  echoPolicyId: EchoPolicyId;
  redacted: true;
}

export interface PtcLabBrowserRedactedFinalUrl<
  Digest extends PtcLabBrowserEvidenceDigest,
  DigestPolicyId extends string,
  EchoPolicyId extends string,
> {
  digest: Digest;
  digestPolicyId: DigestPolicyId;
  echoPolicyId: EchoPolicyId;
  redacted: true;
}

export interface PtcLabBrowserRedirectCount<PolicyId extends string> {
  policyId: PolicyId;
  count: number;
}

export interface PtcLabBrowserEvidenceTiming<PolicyId extends string> {
  policyId: PolicyId;
  ownerDurationMs: number;
  navigationDurationMs?: number;
}

export interface PtcLabBrowserEvidenceCommonAvailability {
  finalUrl: 'available';
  navigationTiming: 'available' | 'unavailable_allowed';
}

export interface PtcLabBrowserPageLoadEvidenceSummaryPolicyFields {
  policyFingerprint: PtcSha256Digest;
  maxNavigationMs: number;
  maxTabs: 1;
  browserPolicyId: 'ptc_lab_browser_page_load_evidence_v1';
  browserMode: 'page_load_evidence';
  browserEnginePolicyId: 'ptc_lab_browser_runtime_engine_chromium_v1';
  browserNetworkPolicyId: 'ptc_lab_open_egress_local_v1';
  browserUrlGrammarPolicyId: 'ptc_lab_browser_url_grammar_http_https_no_credentials_v1';
  browserRedirectPolicyId: 'ptc_lab_browser_redirect_revalidated_v1';
  browserEvidencePolicyId: 'ptc_lab_browser_page_load_evidence_summary_v1';
  pageLoadEvidenceDigestPolicyId: 'ptc_lab_browser_page_load_evidence_digest_result_with_timing_v1';
  requestedUrlEchoPolicyId: 'ptc_lab_browser_url_echo_digest_only_v1';
  finalUrlEchoPolicyId: 'ptc_lab_browser_final_url_echo_digest_only_v1';
  finalUrlDigestPolicyId: 'ptc_lab_browser_final_url_digest_public_sha256_v1';
  responseStatusPolicyId: 'ptc_lab_browser_response_status_code_optional_v1';
  redirectCountPolicyId: 'ptc_lab_browser_redirect_count_only_v1';
  timingPolicyId: 'ptc_lab_browser_timing_owner_and_navigation_bounded_v1';
  artifactExported: false;
}

export interface PtcLabBrowserTextEvidenceSummaryPolicyFields {
  policyFingerprint: PtcSha256Digest;
  maxNavigationMs: number;
  maxTabs: 1;
  browserPolicyId: 'ptc_lab_browser_dom_text_evidence_v1';
  browserMode: 'dom_text_evidence';
  browserEnginePolicyId: 'ptc_lab_browser_runtime_engine_chromium_v1';
  browserNetworkPolicyId: 'ptc_lab_open_egress_local_v1';
  browserUrlGrammarPolicyId: 'ptc_lab_browser_url_grammar_http_https_no_credentials_v1';
  browserRedirectPolicyId: 'ptc_lab_browser_redirect_revalidated_v1';
  browserEvidencePolicyId: 'ptc_lab_browser_text_evidence_summary_v1';
  textEvidenceDigestPolicyId: 'ptc_lab_browser_text_evidence_digest_result_with_timing_v1';
  requestedUrlEchoPolicyId: 'ptc_lab_browser_url_echo_digest_only_v1';
  finalUrlEchoPolicyId: 'ptc_lab_browser_final_url_echo_digest_only_v1';
  finalUrlDigestPolicyId: 'ptc_lab_browser_final_url_digest_public_sha256_v1';
  redirectCountPolicyId: 'ptc_lab_browser_redirect_count_only_v1';
  timingPolicyId: 'ptc_lab_browser_timing_owner_and_navigation_bounded_v1';
  artifactExported: false;
}

export interface PtcLabBrowserPageLoadEvidenceSummary<
  TargetDigest extends PtcLabBrowserEvidenceDigest =
    PtcLabBrowserEvidenceDigest,
  AttemptDigest extends PtcLabBrowserEvidenceDigest =
    PtcLabBrowserEvidenceDigest,
  PageLoadEvidenceDigest extends PtcLabBrowserEvidenceDigest =
    PtcLabBrowserEvidenceDigest,
> extends PtcLabBrowserPageLoadEvidenceSummaryPolicyFields {
  kind: 'ptc_lab_browser_page_load_evidence_result';
  ok: true;
  profile: 'lab';
  capability: 'ptc_lab_browser_page_load_evidence';
  targetDigest: TargetDigest;
  pageLoadEvidenceAttemptDigest: AttemptDigest;
  pageLoadEvidenceDigest: PageLoadEvidenceDigest;
  sessionLifecycle: PtcLabBrowserRuntimeOwnedSessionLifecycle<false>;
  requestedUrl: PtcLabBrowserRedactedRequestedUrl<
    TargetDigest,
    PtcLabBrowserPageLoadEvidenceSummaryPolicyFields['requestedUrlEchoPolicyId']
  >;
  finalUrl: PtcLabBrowserRedactedFinalUrl<
    PtcLabBrowserEvidenceDigest,
    PtcLabBrowserPageLoadEvidenceSummaryPolicyFields['finalUrlDigestPolicyId'],
    PtcLabBrowserPageLoadEvidenceSummaryPolicyFields['finalUrlEchoPolicyId']
  >;
  loadOutcome: 'loaded' | 'no_committed_document' | 'browser_error_page';
  loadState: 'domcontentloaded' | 'load' | 'no_committed_document';
  responseStatus?: {
    policyId: PtcLabBrowserPageLoadEvidenceSummaryPolicyFields['responseStatusPolicyId'];
    code: number;
    source: 'final_main_resource_response';
  };
  title?: string;
  redirects: PtcLabBrowserRedirectCount<
    PtcLabBrowserPageLoadEvidenceSummaryPolicyFields['redirectCountPolicyId']
  >;
  timing: PtcLabBrowserEvidenceTiming<
    PtcLabBrowserPageLoadEvidenceSummaryPolicyFields['timingPolicyId']
  >;
  evidenceAvailability: PtcLabBrowserEvidenceCommonAvailability & {
    responseStatus: 'available' | 'unavailable_allowed';
    title: 'available' | 'unavailable_allowed';
  };
  checks: PtcLabBrowserEvidenceChecks;
}

export interface PtcLabBrowserTextEvidenceSummary<
  TargetDigest extends PtcLabBrowserEvidenceDigest =
    PtcLabBrowserEvidenceDigest,
  AttemptDigest extends PtcLabBrowserEvidenceDigest =
    PtcLabBrowserEvidenceDigest,
  TextEvidenceDigest extends PtcLabBrowserEvidenceDigest =
    PtcLabBrowserEvidenceDigest,
> extends PtcLabBrowserTextEvidenceSummaryPolicyFields {
  kind: 'ptc_lab_browser_text_evidence_result';
  ok: true;
  profile: 'lab';
  capability: 'ptc_lab_browser_dom_text_evidence';
  targetDigest: TargetDigest;
  textEvidenceAttemptDigest: AttemptDigest;
  textEvidenceDigest: TextEvidenceDigest;
  sessionLifecycle: PtcLabBrowserRuntimeOwnedSessionLifecycle<false>;
  requestedUrl: PtcLabBrowserRedactedRequestedUrl<
    TargetDigest,
    PtcLabBrowserTextEvidenceSummaryPolicyFields['requestedUrlEchoPolicyId']
  >;
  finalUrl: PtcLabBrowserRedactedFinalUrl<
    PtcLabBrowserEvidenceDigest,
    PtcLabBrowserTextEvidenceSummaryPolicyFields['finalUrlDigestPolicyId'],
    PtcLabBrowserTextEvidenceSummaryPolicyFields['finalUrlEchoPolicyId']
  >;
  loadOutcome: 'loaded';
  loadState: 'domcontentloaded' | 'load';
  visibleText: string;
  redirects: PtcLabBrowserRedirectCount<
    PtcLabBrowserTextEvidenceSummaryPolicyFields['redirectCountPolicyId']
  >;
  timing: PtcLabBrowserEvidenceTiming<
    PtcLabBrowserTextEvidenceSummaryPolicyFields['timingPolicyId']
  >;
  evidenceAvailability: PtcLabBrowserEvidenceCommonAvailability & {
    visibleText: 'available';
  };
  checks: PtcLabBrowserEvidenceChecks;
}
