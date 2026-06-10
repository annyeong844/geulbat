export const PTC_BROWSER_NAVIGATE_TOOL_NAME = 'browser_navigate' as const;
export const PTC_BROWSER_NAVIGATE_LAB_POLICY_ID =
  'ptc_lab_browser_navigate_user_url_v1' as const;
export const PTC_BROWSER_NAVIGATE_TRUST_CONTEXT_ID =
  'ptc_lab_browser_navigate_user_url_v1' as const;
export const PTC_BROWSER_NAVIGATE_MAX_URL_BYTES = 2048;
export const PTC_BROWSER_NAVIGATE_MAX_TIMEOUT_MS = 15_000;
export const PTC_BROWSER_NAVIGATE_TOOL_TIMEOUT_MS =
  PTC_BROWSER_NAVIGATE_MAX_TIMEOUT_MS + 30_000;

export type PtcBrowserNavigateTargetDigest = `sha256:${string}`;
export type PtcBrowserNavigateAttemptDigest = `sha256:${string}`;

export interface PtcBrowserNavigateRuntimeRequest {
  url: string;
  timeoutMs?: number;
}

export interface PtcBrowserNavigateRuntimeSummary {
  kind: 'ptc_lab_browser_user_url_navigation_result';
  ok: true;
  profile: 'lab';
  capability: 'ptc_lab_browser_user_url_navigation';
  targetDigest: PtcBrowserNavigateTargetDigest;
  navigationAttemptDigest: PtcBrowserNavigateAttemptDigest;
  sessionLifecycle: {
    mode: 'runtime_owned';
    retainedAfterExecution: boolean;
    taintedAfterExecution: false;
  };
  browserPolicyId: 'ptc_lab_browser_user_url_navigation_v1';
  browserMode: 'user_url_navigation';
  browserEnginePolicyId: 'ptc_lab_browser_runtime_engine_chromium_v1';
  browserNetworkPolicyId: 'ptc_lab_open_egress_local_v1';
  browserUrlGrammarPolicyId: 'ptc_lab_browser_url_grammar_http_https_no_credentials_v1';
  browserRedirectPolicyId: 'ptc_lab_browser_redirect_revalidated_v1';
  browserEvidencePolicyId: 'ptc_lab_browser_navigation_summary_only_v1';
  browserUrlEchoPolicyId: 'ptc_lab_browser_url_echo_digest_only_v1';
  browserPopupPolicyId: 'ptc_lab_browser_popups_disabled_v1';
  browserPermissionPolicyId: 'ptc_lab_browser_permissions_denied_v1';
  browserProfilePolicyId: 'ptc_lab_browser_profile_fresh_per_attempt_v1';
  browserCookieStorePolicyId: 'ptc_lab_browser_cookie_store_none_v1';
  browserDownloadPolicyId: 'ptc_lab_browser_downloads_disabled_v1';
  browserArtifactExportPolicyId: 'ptc_lab_browser_artifact_export_disabled_v1';
  artifactExported: false;
  requestedUrlRedacted: boolean;
  finalUrlRedacted: true;
  navigationOutcome: 'loaded';
  loadState: 'domcontentloaded' | 'load';
  checks: {
    targetVerified: boolean;
    engineAvailable: boolean;
    contextCreated: boolean;
    navigationStarted: boolean;
    navigationSettled: boolean;
    redirectPolicyEnforced: boolean;
    downloadPolicyEnforced: boolean;
    cleanupCompleted: boolean;
  };
  durationMs: number;
}

export type PtcBrowserNavigateFailureReason =
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
  | 'ptc_lab_browser_output_invalid'
  | 'ptc_lab_browser_timeout'
  | 'ptc_lab_browser_cancelled'
  | 'ptc_lab_browser_session_tainted'
  | 'ptc_lab_browser_cleanup_failed'
  | 'ptc_lab_browser_cleanup_uncertain';

export type PtcBrowserNavigateFailurePhase =
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
  | 'cleanup'
  | 'output_serialization';

export interface PtcBrowserNavigateRuntimeError {
  kind: 'ptc_lab_browser_user_url_navigation_error';
  ok: false;
  reasonCode: PtcBrowserNavigateFailureReason;
  message: string;
  phase: PtcBrowserNavigateFailurePhase;
  targetDigest?: PtcBrowserNavigateTargetDigest;
  navigationAttemptDigest?: PtcBrowserNavigateAttemptDigest;
  sessionLifecycle?: {
    mode: 'runtime_owned';
    retainedAfterExecution: boolean;
    taintedAfterExecution: boolean;
  };
  diagnostics?: Record<string, string | number | boolean>;
}

export type PtcBrowserNavigateRuntimeResult =
  | { ok: true; value: PtcBrowserNavigateRuntimeSummary }
  | PtcBrowserNavigateRuntimeError;

export type PtcBrowserNavigateRuntimeCleanupResult =
  | { ok: true }
  | {
      ok: false;
      reasonCode: 'ptc_browser_navigate_session_cleanup_failed';
      message: string;
      diagnostics?: Record<string, string | number | boolean>;
    };

export interface PtcBrowserNavigateRuntime {
  navigate(args: {
    runContext: {
      threadId: string;
      projectId: string;
      workspaceRoot: string;
    };
    request: PtcBrowserNavigateRuntimeRequest;
    signal?: AbortSignal;
  }): Promise<PtcBrowserNavigateRuntimeResult>;
  closeAll(args?: {
    signal?: AbortSignal;
  }): Promise<PtcBrowserNavigateRuntimeCleanupResult>;
}
