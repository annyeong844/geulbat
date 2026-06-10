import { sha256StableJson } from '@geulbat/shared-utils/stable-json';
import {
  PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
  doesPtcLabOpenNetworkSessionMatchPolicy,
  type PtcLabNetworkIdentitySnapshot,
  type PtcLabNetworkPolicy,
} from './lab-network-policy.js';

export const PTC_LAB_BROWSER_POLICY_VERSION =
  'ptc_lab_browser_policy_v1' as const;
export const PTC_LAB_BROWSER_DISABLED_POLICY_ID =
  'ptc_lab_browser_disabled_v1' as const;
export const PTC_LAB_BROWSER_FIXED_PREFLIGHT_POLICY_ID =
  'ptc_lab_browser_fixed_preflight_v1' as const;
export const PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_POLICY_ID =
  'ptc_lab_browser_fixed_runtime_probe_v1' as const;
export const PTC_LAB_BROWSER_FIXED_NAVIGATION_PROBE_POLICY_ID =
  'ptc_lab_browser_fixed_navigation_probe_v1' as const;
export const PTC_LAB_BROWSER_USER_URL_NAVIGATION_POLICY_ID =
  'ptc_lab_browser_user_url_navigation_v1' as const;
export const PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_POLICY_ID =
  'ptc_lab_browser_page_load_evidence_v1' as const;
export const PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID =
  'ptc_lab_browser_runtime_engine_chromium_v1' as const;
export const PTC_LAB_BROWSER_NAVIGATION_TARGET_FIXED_HTTPS_POLICY_ID =
  'ptc_lab_browser_navigation_target_fixed_https_v1' as const;
export const PTC_LAB_BROWSER_URL_GRAMMAR_POLICY_OWNED_TARGET_REF_POLICY_ID =
  'ptc_lab_browser_url_grammar_policy_owned_target_ref_v1' as const;
export const PTC_LAB_BROWSER_URL_GRAMMAR_HTTP_HTTPS_NO_CREDENTIALS_POLICY_ID =
  'ptc_lab_browser_url_grammar_http_https_no_credentials_v1' as const;
export const PTC_LAB_BROWSER_CALLER_HEADERS_NONE_POLICY_ID =
  'ptc_lab_browser_caller_headers_none_v1' as const;
export const PTC_LAB_BROWSER_HEADERS_RUNTIME_DEFAULT_POLICY_ID =
  'ptc_lab_browser_headers_runtime_default_v1' as const;
export const PTC_LAB_BROWSER_BODY_NONE_POLICY_ID =
  'ptc_lab_browser_body_none_v1' as const;
export const PTC_LAB_BROWSER_REDIRECT_DISABLED_POLICY_ID =
  'ptc_lab_browser_redirect_disabled_v1' as const;
export const PTC_LAB_BROWSER_REDIRECT_REVALIDATED_POLICY_ID =
  'ptc_lab_browser_redirect_revalidated_v1' as const;
export const PTC_LAB_BROWSER_PROFILE_NONE_POLICY_ID =
  'ptc_lab_browser_profile_none_v1' as const;
export const PTC_LAB_BROWSER_PROFILE_FRESH_PER_ATTEMPT_POLICY_ID =
  'ptc_lab_browser_profile_fresh_per_attempt_v1' as const;
export const PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID =
  'ptc_lab_browser_cookie_store_none_v1' as const;
export const PTC_LAB_BROWSER_DOWNLOADS_DISABLED_POLICY_ID =
  'ptc_lab_browser_downloads_disabled_v1' as const;
export const PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID =
  'ptc_lab_browser_artifact_export_disabled_v1' as const;
export const PTC_LAB_BROWSER_TELEMETRY_DISABLED_POLICY_ID =
  'ptc_lab_browser_telemetry_disabled_v1' as const;
export const PTC_LAB_BROWSER_TELEMETRY_OWNER_OUTCOME_POLICY_ID =
  'ptc_lab_browser_telemetry_owner_outcome_v1' as const;
export const PTC_LAB_BROWSER_NAVIGATION_SUMMARY_ONLY_POLICY_ID =
  'ptc_lab_browser_navigation_summary_only_v1' as const;
export const PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_SUMMARY_POLICY_ID =
  'ptc_lab_browser_page_load_evidence_summary_v1' as const;
export const PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_DIGEST_RESULT_WITH_TIMING_POLICY_ID =
  'ptc_lab_browser_page_load_evidence_digest_result_with_timing_v1' as const;
export const PTC_LAB_BROWSER_URL_ECHO_DIGEST_ONLY_POLICY_ID =
  'ptc_lab_browser_url_echo_digest_only_v1' as const;
export const PTC_LAB_BROWSER_FINAL_URL_ECHO_DIGEST_ONLY_POLICY_ID =
  'ptc_lab_browser_final_url_echo_digest_only_v1' as const;
export const PTC_LAB_BROWSER_FINAL_URL_DIGEST_PUBLIC_SHA256_POLICY_ID =
  'ptc_lab_browser_final_url_digest_public_sha256_v1' as const;
export const PTC_LAB_BROWSER_RESPONSE_STATUS_CODE_OPTIONAL_POLICY_ID =
  'ptc_lab_browser_response_status_code_optional_v1' as const;
export const PTC_LAB_BROWSER_TITLE_BOUNDED_TEXT_POLICY_ID =
  'ptc_lab_browser_title_bounded_text_v1' as const;
export const PTC_LAB_BROWSER_REDIRECT_COUNT_ONLY_POLICY_ID =
  'ptc_lab_browser_redirect_count_only_v1' as const;
export const PTC_LAB_BROWSER_TIMING_OWNER_AND_NAVIGATION_BOUNDED_POLICY_ID =
  'ptc_lab_browser_timing_owner_and_navigation_bounded_v1' as const;
export const PTC_LAB_BROWSER_POPUPS_DISABLED_POLICY_ID =
  'ptc_lab_browser_popups_disabled_v1' as const;
export const PTC_LAB_BROWSER_PERMISSIONS_DENIED_POLICY_ID =
  'ptc_lab_browser_permissions_denied_v1' as const;
export const PTC_LAB_BROWSER_TIMEOUT_BOUNDED_POLICY_ID =
  'ptc_lab_browser_timeout_bounded_v1' as const;
export const PTC_LAB_BROWSER_LOAD_WAIT_DOMCONTENTLOADED_POLICY_ID =
  'ptc_lab_browser_load_wait_domcontentloaded_v1' as const;
export const PTC_LAB_BROWSER_VIEWPORT_DEFAULT_POLICY_ID =
  'ptc_lab_browser_viewport_default_v1' as const;
export const PTC_LAB_BROWSER_LOCALE_SANDBOX_DEFAULT_POLICY_ID =
  'ptc_lab_browser_locale_sandbox_default_v1' as const;
export const PTC_LAB_BROWSER_TIMEZONE_SANDBOX_DEFAULT_POLICY_ID =
  'ptc_lab_browser_timezone_sandbox_default_v1' as const;

export type PtcLabBrowserPolicy =
  | {
      enabled: false;
      mode: 'disabled';
      policyVersion: typeof PTC_LAB_BROWSER_POLICY_VERSION;
      browserPolicyId: typeof PTC_LAB_BROWSER_DISABLED_POLICY_ID;
      profilePolicyId: typeof PTC_LAB_BROWSER_PROFILE_NONE_POLICY_ID;
      cookieStorePolicyId: typeof PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID;
      artifactExportPolicyId: typeof PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID;
      telemetryPolicyId: typeof PTC_LAB_BROWSER_TELEMETRY_DISABLED_POLICY_ID;
    }
  | {
      enabled: true;
      mode: 'fixed_preflight';
      policyVersion: typeof PTC_LAB_BROWSER_POLICY_VERSION;
      browserPolicyId: typeof PTC_LAB_BROWSER_FIXED_PREFLIGHT_POLICY_ID;
      networkPolicyId: typeof PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID;
      maxTabs: 1;
      maxActionMs: number;
      profilePolicyId: typeof PTC_LAB_BROWSER_PROFILE_NONE_POLICY_ID;
      cookieStorePolicyId: typeof PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID;
      artifactExportPolicyId: typeof PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID;
      telemetryPolicyId: typeof PTC_LAB_BROWSER_TELEMETRY_OWNER_OUTCOME_POLICY_ID;
      outputPolicy: 'summary_only';
    }
  | {
      enabled: true;
      mode: 'fixed_runtime_probe';
      policyVersion: typeof PTC_LAB_BROWSER_POLICY_VERSION;
      browserPolicyId: typeof PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_POLICY_ID;
      runtimeEnginePolicyId: typeof PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID;
      networkPolicyId: typeof PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID;
      maxTabs: 1;
      maxActionMs: number;
      profilePolicyId: typeof PTC_LAB_BROWSER_PROFILE_NONE_POLICY_ID;
      cookieStorePolicyId: typeof PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID;
      artifactExportPolicyId: typeof PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID;
      telemetryPolicyId: typeof PTC_LAB_BROWSER_TELEMETRY_OWNER_OUTCOME_POLICY_ID;
      outputPolicy: 'summary_only';
    }
  | {
      enabled: true;
      mode: 'fixed_navigation_probe';
      policyVersion: typeof PTC_LAB_BROWSER_POLICY_VERSION;
      browserPolicyId: typeof PTC_LAB_BROWSER_FIXED_NAVIGATION_PROBE_POLICY_ID;
      runtimeEnginePolicyId: typeof PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID;
      networkPolicyId: typeof PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID;
      navigationTargetPolicyId: typeof PTC_LAB_BROWSER_NAVIGATION_TARGET_FIXED_HTTPS_POLICY_ID;
      urlGrammarPolicyId: typeof PTC_LAB_BROWSER_URL_GRAMMAR_POLICY_OWNED_TARGET_REF_POLICY_ID;
      redirectPolicyId: typeof PTC_LAB_BROWSER_REDIRECT_DISABLED_POLICY_ID;
      maxTabs: 1;
      maxActionMs: number;
      profilePolicyId: typeof PTC_LAB_BROWSER_PROFILE_NONE_POLICY_ID;
      cookieStorePolicyId: typeof PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID;
      artifactExportPolicyId: typeof PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID;
      telemetryPolicyId: typeof PTC_LAB_BROWSER_TELEMETRY_OWNER_OUTCOME_POLICY_ID;
      outputPolicy: 'summary_only';
      evidencePolicyId: typeof PTC_LAB_BROWSER_NAVIGATION_SUMMARY_ONLY_POLICY_ID;
    }
  | {
      enabled: true;
      mode: 'user_url_navigation';
      policyVersion: typeof PTC_LAB_BROWSER_POLICY_VERSION;
      browserPolicyId: typeof PTC_LAB_BROWSER_USER_URL_NAVIGATION_POLICY_ID;
      browserEnginePolicyId: typeof PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID;
      networkPolicyId: typeof PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID;
      urlGrammarPolicyId: typeof PTC_LAB_BROWSER_URL_GRAMMAR_HTTP_HTTPS_NO_CREDENTIALS_POLICY_ID;
      callerHeadersPolicyId: typeof PTC_LAB_BROWSER_CALLER_HEADERS_NONE_POLICY_ID;
      browserHeadersPolicyId: typeof PTC_LAB_BROWSER_HEADERS_RUNTIME_DEFAULT_POLICY_ID;
      bodyPolicyId: typeof PTC_LAB_BROWSER_BODY_NONE_POLICY_ID;
      redirectPolicyId: typeof PTC_LAB_BROWSER_REDIRECT_REVALIDATED_POLICY_ID;
      maxTabs: 1;
      maxActionMs: number;
      profilePolicyId: typeof PTC_LAB_BROWSER_PROFILE_FRESH_PER_ATTEMPT_POLICY_ID;
      cookieStorePolicyId: typeof PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID;
      downloadPolicyId: typeof PTC_LAB_BROWSER_DOWNLOADS_DISABLED_POLICY_ID;
      artifactExportPolicyId: typeof PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID;
      telemetryPolicyId: typeof PTC_LAB_BROWSER_TELEMETRY_OWNER_OUTCOME_POLICY_ID;
      outputPolicy: 'summary_only';
      evidencePolicyId: typeof PTC_LAB_BROWSER_NAVIGATION_SUMMARY_ONLY_POLICY_ID;
      urlEchoPolicyId: typeof PTC_LAB_BROWSER_URL_ECHO_DIGEST_ONLY_POLICY_ID;
      popupPolicyId: typeof PTC_LAB_BROWSER_POPUPS_DISABLED_POLICY_ID;
      permissionPolicyId: typeof PTC_LAB_BROWSER_PERMISSIONS_DENIED_POLICY_ID;
      timeoutPolicyId: typeof PTC_LAB_BROWSER_TIMEOUT_BOUNDED_POLICY_ID;
      loadWaitPolicyId: typeof PTC_LAB_BROWSER_LOAD_WAIT_DOMCONTENTLOADED_POLICY_ID;
      viewportPolicyId: typeof PTC_LAB_BROWSER_VIEWPORT_DEFAULT_POLICY_ID;
      localePolicyId: typeof PTC_LAB_BROWSER_LOCALE_SANDBOX_DEFAULT_POLICY_ID;
      timezonePolicyId: typeof PTC_LAB_BROWSER_TIMEZONE_SANDBOX_DEFAULT_POLICY_ID;
    }
  | {
      enabled: true;
      mode: 'page_load_evidence';
      policyVersion: typeof PTC_LAB_BROWSER_POLICY_VERSION;
      policyFingerprint: `sha256:${string}`;
      browserPolicyId: typeof PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_POLICY_ID;
      browserEnginePolicyId: typeof PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID;
      networkPolicyId: typeof PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID;
      urlGrammarPolicyId: typeof PTC_LAB_BROWSER_URL_GRAMMAR_HTTP_HTTPS_NO_CREDENTIALS_POLICY_ID;
      callerHeadersPolicyId: typeof PTC_LAB_BROWSER_CALLER_HEADERS_NONE_POLICY_ID;
      browserHeadersPolicyId: typeof PTC_LAB_BROWSER_HEADERS_RUNTIME_DEFAULT_POLICY_ID;
      bodyPolicyId: typeof PTC_LAB_BROWSER_BODY_NONE_POLICY_ID;
      redirectPolicyId: typeof PTC_LAB_BROWSER_REDIRECT_REVALIDATED_POLICY_ID;
      maxTabs: 1;
      maxNavigationMs: number;
      maxTitleChars: number;
      profilePolicyId: typeof PTC_LAB_BROWSER_PROFILE_FRESH_PER_ATTEMPT_POLICY_ID;
      cookieStorePolicyId: typeof PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID;
      downloadPolicyId: typeof PTC_LAB_BROWSER_DOWNLOADS_DISABLED_POLICY_ID;
      artifactExportPolicyId: typeof PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID;
      telemetryPolicyId: typeof PTC_LAB_BROWSER_TELEMETRY_OWNER_OUTCOME_POLICY_ID;
      outputPolicy: 'summary_only';
      evidencePolicyId: typeof PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_SUMMARY_POLICY_ID;
      pageLoadEvidenceDigestPolicyId: typeof PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_DIGEST_RESULT_WITH_TIMING_POLICY_ID;
      requestedUrlEchoPolicyId: typeof PTC_LAB_BROWSER_URL_ECHO_DIGEST_ONLY_POLICY_ID;
      finalUrlEchoPolicyId: typeof PTC_LAB_BROWSER_FINAL_URL_ECHO_DIGEST_ONLY_POLICY_ID;
      finalUrlDigestPolicyId: typeof PTC_LAB_BROWSER_FINAL_URL_DIGEST_PUBLIC_SHA256_POLICY_ID;
      responseStatusPolicyId: typeof PTC_LAB_BROWSER_RESPONSE_STATUS_CODE_OPTIONAL_POLICY_ID;
      titlePolicyId: typeof PTC_LAB_BROWSER_TITLE_BOUNDED_TEXT_POLICY_ID;
      redirectCountPolicyId: typeof PTC_LAB_BROWSER_REDIRECT_COUNT_ONLY_POLICY_ID;
      timingPolicyId: typeof PTC_LAB_BROWSER_TIMING_OWNER_AND_NAVIGATION_BOUNDED_POLICY_ID;
      popupPolicyId: typeof PTC_LAB_BROWSER_POPUPS_DISABLED_POLICY_ID;
      permissionPolicyId: typeof PTC_LAB_BROWSER_PERMISSIONS_DENIED_POLICY_ID;
      timeoutPolicyId: typeof PTC_LAB_BROWSER_TIMEOUT_BOUNDED_POLICY_ID;
      loadWaitPolicyId: typeof PTC_LAB_BROWSER_LOAD_WAIT_DOMCONTENTLOADED_POLICY_ID;
      viewportPolicyId: typeof PTC_LAB_BROWSER_VIEWPORT_DEFAULT_POLICY_ID;
      localePolicyId: typeof PTC_LAB_BROWSER_LOCALE_SANDBOX_DEFAULT_POLICY_ID;
      timezonePolicyId: typeof PTC_LAB_BROWSER_TIMEZONE_SANDBOX_DEFAULT_POLICY_ID;
    };

type PtcLabBrowserPolicyByMode<Mode extends PtcLabBrowserPolicy['mode']> =
  Extract<PtcLabBrowserPolicy, { mode: Mode }>;

type PtcLabBrowserPageLoadEvidencePolicy =
  PtcLabBrowserPolicyByMode<'page_load_evidence'>;

type PtcLabBrowserPageLoadEvidencePolicyFields = Omit<
  PtcLabBrowserPageLoadEvidencePolicy,
  'enabled' | 'mode' | 'policyVersion' | 'policyFingerprint'
>;

type PtcLabBrowserPageLoadEvidenceLabelKey =
  | 'policyFingerprint'
  | 'maxNavigationMs'
  | 'maxTitleChars'
  | 'pageLoadEvidenceDigestPolicyId'
  | 'requestedUrlEchoPolicyId'
  | 'finalUrlEchoPolicyId'
  | 'finalUrlDigestPolicyId'
  | 'responseStatusPolicyId'
  | 'titlePolicyId'
  | 'redirectCountPolicyId'
  | 'timingPolicyId';

type PtcLabBrowserPageLoadEvidenceLabelField = readonly [
  PtcLabBrowserPageLoadEvidenceLabelKey,
  string,
];

type PtcLabBrowserPageLoadEvidenceLabelSource = Record<
  PtcLabBrowserPageLoadEvidenceLabelKey,
  string | number
>;

type PtcLabBrowserIdentityBase<Mode extends PtcLabBrowserPolicy['mode']> = Omit<
  PtcLabBrowserPolicyByMode<Mode>,
  'policyVersion' | 'telemetryPolicyId'
> & {
  browserTelemetryPolicyId: PtcLabBrowserPolicyByMode<Mode>['telemetryPolicyId'];
};

type PtcLabBrowserFixedRuntimeProbeIdentitySnapshot = Omit<
  PtcLabBrowserIdentityBase<'fixed_runtime_probe'>,
  'runtimeEnginePolicyId'
> & {
  browserRuntimeEnginePolicyId: PtcLabBrowserPolicyByMode<'fixed_runtime_probe'>['runtimeEnginePolicyId'];
};

type PtcLabBrowserFixedNavigationProbeIdentitySnapshot = Omit<
  PtcLabBrowserIdentityBase<'fixed_navigation_probe'>,
  'runtimeEnginePolicyId'
> & {
  browserRuntimeEnginePolicyId: PtcLabBrowserPolicyByMode<'fixed_navigation_probe'>['runtimeEnginePolicyId'];
};

export type PtcLabBrowserIdentitySnapshot =
  | PtcLabBrowserIdentityBase<'disabled'>
  | PtcLabBrowserIdentityBase<'fixed_preflight'>
  | PtcLabBrowserFixedRuntimeProbeIdentitySnapshot
  | PtcLabBrowserFixedNavigationProbeIdentitySnapshot
  | PtcLabBrowserIdentityBase<'user_url_navigation'>
  | PtcLabBrowserIdentityBase<'page_load_evidence'>;

export interface PtcLabBrowserSessionIdentitySource {
  reuseKey: {
    labPolicyId: string;
    network: PtcLabNetworkIdentitySnapshot;
    browser: PtcLabBrowserIdentitySnapshot;
  };
}

export interface CreatePtcLabBrowserFixedPreflightPolicyArgs {
  maxActionMs?: number;
}

export interface CreatePtcLabBrowserFixedRuntimeProbePolicyArgs {
  maxActionMs?: number;
}

export interface CreatePtcLabBrowserFixedNavigationProbePolicyArgs {
  maxActionMs?: number;
}

export interface CreatePtcLabBrowserUserUrlNavigationPolicyArgs {
  maxActionMs?: number;
}

export interface CreatePtcLabBrowserPageLoadEvidencePolicyArgs {
  maxNavigationMs?: number;
  maxTitleChars?: number;
}

const PTC_LAB_BROWSER_DEFAULT_MAX_ACTION_MS = 5_000;
const PTC_LAB_BROWSER_MAX_ACTION_MS = 15_000;
const PTC_LAB_BROWSER_DEFAULT_MAX_TITLE_CHARS = 160;
const PTC_LAB_BROWSER_MAX_TITLE_CHARS = 512;

const PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_AFTER_ENGINE_LABEL_FIELDS = [
  ['policyFingerprint', 'browserPolicyFingerprint'],
] as const satisfies readonly PtcLabBrowserPageLoadEvidenceLabelField[];

const PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_AFTER_REDIRECT_LABEL_FIELDS = [
  ['maxNavigationMs', 'browserMaxNavigationMs'],
  ['maxTitleChars', 'browserMaxTitleChars'],
] as const satisfies readonly PtcLabBrowserPageLoadEvidenceLabelField[];

const PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_AFTER_EVIDENCE_LABEL_FIELDS = [
  ['pageLoadEvidenceDigestPolicyId', 'browserPageLoadEvidenceDigestPolicyId'],
  ['requestedUrlEchoPolicyId', 'browserRequestedUrlEchoPolicyId'],
  ['finalUrlEchoPolicyId', 'browserFinalUrlEchoPolicyId'],
  ['finalUrlDigestPolicyId', 'browserFinalUrlDigestPolicyId'],
  ['responseStatusPolicyId', 'browserResponseStatusPolicyId'],
  ['titlePolicyId', 'browserTitlePolicyId'],
  ['redirectCountPolicyId', 'browserRedirectCountPolicyId'],
  ['timingPolicyId', 'browserTimingPolicyId'],
] as const satisfies readonly PtcLabBrowserPageLoadEvidenceLabelField[];

export function createPtcLabBrowserDisabledPolicy(): PtcLabBrowserPolicy {
  return {
    enabled: false,
    mode: 'disabled',
    policyVersion: PTC_LAB_BROWSER_POLICY_VERSION,
    browserPolicyId: PTC_LAB_BROWSER_DISABLED_POLICY_ID,
    profilePolicyId: PTC_LAB_BROWSER_PROFILE_NONE_POLICY_ID,
    cookieStorePolicyId: PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID,
    artifactExportPolicyId: PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID,
    telemetryPolicyId: PTC_LAB_BROWSER_TELEMETRY_DISABLED_POLICY_ID,
  };
}

export function createPtcLabBrowserFixedPreflightPolicy(
  args: CreatePtcLabBrowserFixedPreflightPolicyArgs = {},
): PtcLabBrowserPolicy {
  const maxActionMs = normalizePtcLabBrowserMaxActionMs(
    args.maxActionMs,
    'fixed preflight',
  );
  return {
    enabled: true,
    mode: 'fixed_preflight',
    policyVersion: PTC_LAB_BROWSER_POLICY_VERSION,
    browserPolicyId: PTC_LAB_BROWSER_FIXED_PREFLIGHT_POLICY_ID,
    networkPolicyId: PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
    maxTabs: 1,
    maxActionMs,
    profilePolicyId: PTC_LAB_BROWSER_PROFILE_NONE_POLICY_ID,
    cookieStorePolicyId: PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID,
    artifactExportPolicyId: PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID,
    telemetryPolicyId: PTC_LAB_BROWSER_TELEMETRY_OWNER_OUTCOME_POLICY_ID,
    outputPolicy: 'summary_only',
  };
}

export function createPtcLabBrowserFixedRuntimeProbePolicy(
  args: CreatePtcLabBrowserFixedRuntimeProbePolicyArgs = {},
): PtcLabBrowserPolicy {
  const maxActionMs = normalizePtcLabBrowserMaxActionMs(
    args.maxActionMs,
    'fixed runtime probe',
  );
  return {
    enabled: true,
    mode: 'fixed_runtime_probe',
    policyVersion: PTC_LAB_BROWSER_POLICY_VERSION,
    browserPolicyId: PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_POLICY_ID,
    runtimeEnginePolicyId: PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
    networkPolicyId: PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
    maxTabs: 1,
    maxActionMs,
    profilePolicyId: PTC_LAB_BROWSER_PROFILE_NONE_POLICY_ID,
    cookieStorePolicyId: PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID,
    artifactExportPolicyId: PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID,
    telemetryPolicyId: PTC_LAB_BROWSER_TELEMETRY_OWNER_OUTCOME_POLICY_ID,
    outputPolicy: 'summary_only',
  };
}

export function createPtcLabBrowserFixedNavigationProbePolicy(
  args: CreatePtcLabBrowserFixedNavigationProbePolicyArgs = {},
): PtcLabBrowserPolicy {
  const maxActionMs = normalizePtcLabBrowserMaxActionMs(
    args.maxActionMs,
    'fixed navigation probe',
  );
  return {
    enabled: true,
    mode: 'fixed_navigation_probe',
    policyVersion: PTC_LAB_BROWSER_POLICY_VERSION,
    browserPolicyId: PTC_LAB_BROWSER_FIXED_NAVIGATION_PROBE_POLICY_ID,
    runtimeEnginePolicyId: PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
    networkPolicyId: PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
    navigationTargetPolicyId:
      PTC_LAB_BROWSER_NAVIGATION_TARGET_FIXED_HTTPS_POLICY_ID,
    urlGrammarPolicyId:
      PTC_LAB_BROWSER_URL_GRAMMAR_POLICY_OWNED_TARGET_REF_POLICY_ID,
    redirectPolicyId: PTC_LAB_BROWSER_REDIRECT_DISABLED_POLICY_ID,
    maxTabs: 1,
    maxActionMs,
    profilePolicyId: PTC_LAB_BROWSER_PROFILE_NONE_POLICY_ID,
    cookieStorePolicyId: PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID,
    artifactExportPolicyId: PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID,
    telemetryPolicyId: PTC_LAB_BROWSER_TELEMETRY_OWNER_OUTCOME_POLICY_ID,
    outputPolicy: 'summary_only',
    evidencePolicyId: PTC_LAB_BROWSER_NAVIGATION_SUMMARY_ONLY_POLICY_ID,
  };
}

export function createPtcLabBrowserUserUrlNavigationPolicy(
  args: CreatePtcLabBrowserUserUrlNavigationPolicyArgs = {},
): PtcLabBrowserPolicy {
  const maxActionMs = normalizePtcLabBrowserMaxActionMs(
    args.maxActionMs,
    'user URL navigation',
  );
  return {
    enabled: true,
    mode: 'user_url_navigation',
    policyVersion: PTC_LAB_BROWSER_POLICY_VERSION,
    browserPolicyId: PTC_LAB_BROWSER_USER_URL_NAVIGATION_POLICY_ID,
    browserEnginePolicyId: PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
    networkPolicyId: PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
    urlGrammarPolicyId:
      PTC_LAB_BROWSER_URL_GRAMMAR_HTTP_HTTPS_NO_CREDENTIALS_POLICY_ID,
    callerHeadersPolicyId: PTC_LAB_BROWSER_CALLER_HEADERS_NONE_POLICY_ID,
    browserHeadersPolicyId: PTC_LAB_BROWSER_HEADERS_RUNTIME_DEFAULT_POLICY_ID,
    bodyPolicyId: PTC_LAB_BROWSER_BODY_NONE_POLICY_ID,
    redirectPolicyId: PTC_LAB_BROWSER_REDIRECT_REVALIDATED_POLICY_ID,
    maxTabs: 1,
    maxActionMs,
    profilePolicyId: PTC_LAB_BROWSER_PROFILE_FRESH_PER_ATTEMPT_POLICY_ID,
    cookieStorePolicyId: PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID,
    downloadPolicyId: PTC_LAB_BROWSER_DOWNLOADS_DISABLED_POLICY_ID,
    artifactExportPolicyId: PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID,
    telemetryPolicyId: PTC_LAB_BROWSER_TELEMETRY_OWNER_OUTCOME_POLICY_ID,
    outputPolicy: 'summary_only',
    evidencePolicyId: PTC_LAB_BROWSER_NAVIGATION_SUMMARY_ONLY_POLICY_ID,
    urlEchoPolicyId: PTC_LAB_BROWSER_URL_ECHO_DIGEST_ONLY_POLICY_ID,
    popupPolicyId: PTC_LAB_BROWSER_POPUPS_DISABLED_POLICY_ID,
    permissionPolicyId: PTC_LAB_BROWSER_PERMISSIONS_DENIED_POLICY_ID,
    timeoutPolicyId: PTC_LAB_BROWSER_TIMEOUT_BOUNDED_POLICY_ID,
    loadWaitPolicyId: PTC_LAB_BROWSER_LOAD_WAIT_DOMCONTENTLOADED_POLICY_ID,
    viewportPolicyId: PTC_LAB_BROWSER_VIEWPORT_DEFAULT_POLICY_ID,
    localePolicyId: PTC_LAB_BROWSER_LOCALE_SANDBOX_DEFAULT_POLICY_ID,
    timezonePolicyId: PTC_LAB_BROWSER_TIMEZONE_SANDBOX_DEFAULT_POLICY_ID,
  };
}

export function createPtcLabBrowserPageLoadEvidencePolicy(
  args: CreatePtcLabBrowserPageLoadEvidencePolicyArgs = {},
): PtcLabBrowserPolicy {
  const maxNavigationMs = normalizePtcLabBrowserMaxActionMs(
    args.maxNavigationMs,
    'page-load evidence',
  );
  const maxTitleChars = normalizePtcLabBrowserMaxTitleChars(args.maxTitleChars);
  const fields = buildPtcLabBrowserPageLoadEvidencePolicyFields({
    maxNavigationMs,
    maxTitleChars,
  });

  return {
    enabled: true,
    mode: 'page_load_evidence',
    policyVersion: PTC_LAB_BROWSER_POLICY_VERSION,
    policyFingerprint: digestPtcLabBrowserPolicyFingerprint(fields),
    ...fields,
  };
}

function buildPtcLabBrowserPageLoadEvidencePolicyFields(args: {
  maxNavigationMs: number;
  maxTitleChars: number;
}): PtcLabBrowserPageLoadEvidencePolicyFields {
  return {
    maxNavigationMs: args.maxNavigationMs,
    maxTabs: 1,
    maxTitleChars: args.maxTitleChars,
    browserPolicyId: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_POLICY_ID,
    browserEnginePolicyId: PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
    networkPolicyId: PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID,
    urlGrammarPolicyId:
      PTC_LAB_BROWSER_URL_GRAMMAR_HTTP_HTTPS_NO_CREDENTIALS_POLICY_ID,
    callerHeadersPolicyId: PTC_LAB_BROWSER_CALLER_HEADERS_NONE_POLICY_ID,
    browserHeadersPolicyId: PTC_LAB_BROWSER_HEADERS_RUNTIME_DEFAULT_POLICY_ID,
    bodyPolicyId: PTC_LAB_BROWSER_BODY_NONE_POLICY_ID,
    redirectPolicyId: PTC_LAB_BROWSER_REDIRECT_REVALIDATED_POLICY_ID,
    profilePolicyId: PTC_LAB_BROWSER_PROFILE_FRESH_PER_ATTEMPT_POLICY_ID,
    cookieStorePolicyId: PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID,
    downloadPolicyId: PTC_LAB_BROWSER_DOWNLOADS_DISABLED_POLICY_ID,
    artifactExportPolicyId: PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID,
    telemetryPolicyId: PTC_LAB_BROWSER_TELEMETRY_OWNER_OUTCOME_POLICY_ID,
    outputPolicy: 'summary_only',
    evidencePolicyId: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_SUMMARY_POLICY_ID,
    pageLoadEvidenceDigestPolicyId:
      PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_DIGEST_RESULT_WITH_TIMING_POLICY_ID,
    requestedUrlEchoPolicyId: PTC_LAB_BROWSER_URL_ECHO_DIGEST_ONLY_POLICY_ID,
    finalUrlEchoPolicyId: PTC_LAB_BROWSER_FINAL_URL_ECHO_DIGEST_ONLY_POLICY_ID,
    finalUrlDigestPolicyId:
      PTC_LAB_BROWSER_FINAL_URL_DIGEST_PUBLIC_SHA256_POLICY_ID,
    responseStatusPolicyId:
      PTC_LAB_BROWSER_RESPONSE_STATUS_CODE_OPTIONAL_POLICY_ID,
    titlePolicyId: PTC_LAB_BROWSER_TITLE_BOUNDED_TEXT_POLICY_ID,
    redirectCountPolicyId: PTC_LAB_BROWSER_REDIRECT_COUNT_ONLY_POLICY_ID,
    timingPolicyId:
      PTC_LAB_BROWSER_TIMING_OWNER_AND_NAVIGATION_BOUNDED_POLICY_ID,
    popupPolicyId: PTC_LAB_BROWSER_POPUPS_DISABLED_POLICY_ID,
    permissionPolicyId: PTC_LAB_BROWSER_PERMISSIONS_DENIED_POLICY_ID,
    timeoutPolicyId: PTC_LAB_BROWSER_TIMEOUT_BOUNDED_POLICY_ID,
    loadWaitPolicyId: PTC_LAB_BROWSER_LOAD_WAIT_DOMCONTENTLOADED_POLICY_ID,
    viewportPolicyId: PTC_LAB_BROWSER_VIEWPORT_DEFAULT_POLICY_ID,
    localePolicyId: PTC_LAB_BROWSER_LOCALE_SANDBOX_DEFAULT_POLICY_ID,
    timezonePolicyId: PTC_LAB_BROWSER_TIMEZONE_SANDBOX_DEFAULT_POLICY_ID,
  };
}

export function toPtcLabBrowserIdentitySnapshot(
  policy: PtcLabBrowserPolicy,
): PtcLabBrowserIdentitySnapshot {
  if (!policy.enabled) {
    return {
      enabled: false,
      mode: policy.mode,
      browserPolicyId: policy.browserPolicyId,
      profilePolicyId: policy.profilePolicyId,
      cookieStorePolicyId: policy.cookieStorePolicyId,
      artifactExportPolicyId: policy.artifactExportPolicyId,
      browserTelemetryPolicyId: policy.telemetryPolicyId,
    } satisfies Extract<PtcLabBrowserIdentitySnapshot, { mode: 'disabled' }>;
  }

  if (policy.mode === 'fixed_preflight') {
    return {
      enabled: true,
      mode: 'fixed_preflight',
      browserPolicyId: policy.browserPolicyId,
      networkPolicyId: policy.networkPolicyId,
      maxTabs: policy.maxTabs,
      maxActionMs: policy.maxActionMs,
      profilePolicyId: policy.profilePolicyId,
      cookieStorePolicyId: policy.cookieStorePolicyId,
      artifactExportPolicyId: policy.artifactExportPolicyId,
      browserTelemetryPolicyId: policy.telemetryPolicyId,
      outputPolicy: policy.outputPolicy,
    } satisfies Extract<
      PtcLabBrowserIdentitySnapshot,
      { mode: 'fixed_preflight' }
    >;
  }

  if (policy.mode === 'fixed_runtime_probe') {
    return {
      enabled: true,
      mode: 'fixed_runtime_probe',
      browserPolicyId: policy.browserPolicyId,
      browserRuntimeEnginePolicyId: policy.runtimeEnginePolicyId,
      networkPolicyId: policy.networkPolicyId,
      maxTabs: policy.maxTabs,
      maxActionMs: policy.maxActionMs,
      profilePolicyId: policy.profilePolicyId,
      cookieStorePolicyId: policy.cookieStorePolicyId,
      artifactExportPolicyId: policy.artifactExportPolicyId,
      browserTelemetryPolicyId: policy.telemetryPolicyId,
      outputPolicy: policy.outputPolicy,
    } satisfies Extract<
      PtcLabBrowserIdentitySnapshot,
      { mode: 'fixed_runtime_probe' }
    >;
  }

  if (policy.mode === 'fixed_navigation_probe') {
    return {
      enabled: true,
      mode: 'fixed_navigation_probe',
      browserPolicyId: policy.browserPolicyId,
      browserRuntimeEnginePolicyId: policy.runtimeEnginePolicyId,
      networkPolicyId: policy.networkPolicyId,
      navigationTargetPolicyId: policy.navigationTargetPolicyId,
      urlGrammarPolicyId: policy.urlGrammarPolicyId,
      redirectPolicyId: policy.redirectPolicyId,
      maxTabs: policy.maxTabs,
      maxActionMs: policy.maxActionMs,
      profilePolicyId: policy.profilePolicyId,
      cookieStorePolicyId: policy.cookieStorePolicyId,
      artifactExportPolicyId: policy.artifactExportPolicyId,
      browserTelemetryPolicyId: policy.telemetryPolicyId,
      outputPolicy: policy.outputPolicy,
      evidencePolicyId: policy.evidencePolicyId,
    } satisfies Extract<
      PtcLabBrowserIdentitySnapshot,
      { mode: 'fixed_navigation_probe' }
    >;
  }

  if (policy.mode === 'user_url_navigation') {
    return {
      enabled: true,
      mode: 'user_url_navigation',
      browserPolicyId: policy.browserPolicyId,
      browserEnginePolicyId: policy.browserEnginePolicyId,
      networkPolicyId: policy.networkPolicyId,
      urlGrammarPolicyId: policy.urlGrammarPolicyId,
      callerHeadersPolicyId: policy.callerHeadersPolicyId,
      browserHeadersPolicyId: policy.browserHeadersPolicyId,
      bodyPolicyId: policy.bodyPolicyId,
      redirectPolicyId: policy.redirectPolicyId,
      maxTabs: policy.maxTabs,
      maxActionMs: policy.maxActionMs,
      profilePolicyId: policy.profilePolicyId,
      cookieStorePolicyId: policy.cookieStorePolicyId,
      downloadPolicyId: policy.downloadPolicyId,
      artifactExportPolicyId: policy.artifactExportPolicyId,
      browserTelemetryPolicyId: policy.telemetryPolicyId,
      outputPolicy: policy.outputPolicy,
      evidencePolicyId: policy.evidencePolicyId,
      urlEchoPolicyId: policy.urlEchoPolicyId,
      popupPolicyId: policy.popupPolicyId,
      permissionPolicyId: policy.permissionPolicyId,
      timeoutPolicyId: policy.timeoutPolicyId,
      loadWaitPolicyId: policy.loadWaitPolicyId,
      viewportPolicyId: policy.viewportPolicyId,
      localePolicyId: policy.localePolicyId,
      timezonePolicyId: policy.timezonePolicyId,
    } satisfies Extract<
      PtcLabBrowserIdentitySnapshot,
      { mode: 'user_url_navigation' }
    >;
  }

  if (policy.mode === 'page_load_evidence') {
    return {
      enabled: true,
      mode: 'page_load_evidence',
      browserPolicyId: policy.browserPolicyId,
      policyFingerprint: policy.policyFingerprint,
      browserEnginePolicyId: policy.browserEnginePolicyId,
      networkPolicyId: policy.networkPolicyId,
      urlGrammarPolicyId: policy.urlGrammarPolicyId,
      callerHeadersPolicyId: policy.callerHeadersPolicyId,
      browserHeadersPolicyId: policy.browserHeadersPolicyId,
      bodyPolicyId: policy.bodyPolicyId,
      redirectPolicyId: policy.redirectPolicyId,
      maxTabs: policy.maxTabs,
      maxNavigationMs: policy.maxNavigationMs,
      maxTitleChars: policy.maxTitleChars,
      profilePolicyId: policy.profilePolicyId,
      cookieStorePolicyId: policy.cookieStorePolicyId,
      downloadPolicyId: policy.downloadPolicyId,
      artifactExportPolicyId: policy.artifactExportPolicyId,
      browserTelemetryPolicyId: policy.telemetryPolicyId,
      outputPolicy: policy.outputPolicy,
      evidencePolicyId: policy.evidencePolicyId,
      pageLoadEvidenceDigestPolicyId: policy.pageLoadEvidenceDigestPolicyId,
      requestedUrlEchoPolicyId: policy.requestedUrlEchoPolicyId,
      finalUrlEchoPolicyId: policy.finalUrlEchoPolicyId,
      finalUrlDigestPolicyId: policy.finalUrlDigestPolicyId,
      responseStatusPolicyId: policy.responseStatusPolicyId,
      titlePolicyId: policy.titlePolicyId,
      redirectCountPolicyId: policy.redirectCountPolicyId,
      timingPolicyId: policy.timingPolicyId,
      popupPolicyId: policy.popupPolicyId,
      permissionPolicyId: policy.permissionPolicyId,
      timeoutPolicyId: policy.timeoutPolicyId,
      loadWaitPolicyId: policy.loadWaitPolicyId,
      viewportPolicyId: policy.viewportPolicyId,
      localePolicyId: policy.localePolicyId,
      timezonePolicyId: policy.timezonePolicyId,
    } satisfies Extract<
      PtcLabBrowserIdentitySnapshot,
      { mode: 'page_load_evidence' }
    >;
  }

  const unreachablePolicy: never = policy;
  return unreachablePolicy;
}

export function doesPtcLabBrowserSessionMatchPolicy(args: {
  handle: PtcLabBrowserSessionIdentitySource;
  policyId: string;
  browser: PtcLabBrowserPolicy;
  network: Extract<PtcLabNetworkPolicy, { mode: 'open' }>;
}): boolean {
  const reuseKey = args.handle.reuseKey;
  return (
    doesPtcLabOpenNetworkSessionMatchPolicy({
      handle: args.handle,
      policyId: args.policyId,
      network: args.network,
    }) &&
    sha256StableJson(reuseKey.browser) ===
      sha256StableJson(toPtcLabBrowserIdentitySnapshot(args.browser))
  );
}

export type PtcLabBrowserSessionPolicyCapabilityLabel =
  | 'owner'
  | 'runtime'
  | 'navigation'
  | 'user URL navigation'
  | 'page-load evidence';

export interface PtcLabBrowserSessionPolicyMismatch {
  ok: false;
  reasonCode: 'ptc_lab_browser_policy_mismatch';
  message: string;
}

export function validatePtcLabBrowserSessionPolicy(args: {
  handle: PtcLabBrowserSessionIdentitySource;
  policyId: string;
  browser: PtcLabBrowserPolicy;
  network: Extract<PtcLabNetworkPolicy, { mode: 'open' }>;
  capabilityLabel: PtcLabBrowserSessionPolicyCapabilityLabel;
}): { ok: true; value: undefined } | PtcLabBrowserSessionPolicyMismatch {
  if (!doesPtcLabBrowserSessionMatchPolicy(args)) {
    return {
      ok: false,
      reasonCode: 'ptc_lab_browser_policy_mismatch',
      message: `PTC lab browser ${args.capabilityLabel} session does not match admitted policy`,
    };
  }
  return { ok: true, value: undefined };
}

export function buildPtcLabBrowserLabels(
  policy: PtcLabBrowserPolicy,
): string[] {
  return buildPtcLabBrowserIdentityLabels(
    toPtcLabBrowserIdentitySnapshot(policy),
  );
}

export function buildPtcLabBrowserIdentityLabels(
  identity: PtcLabBrowserIdentitySnapshot,
): string[] {
  const labels = [
    `geulbat.browserEnabled=${identity.enabled}`,
    `geulbat.browserMode=${identity.mode}`,
    `geulbat.browserPolicyId=${identity.browserPolicyId}`,
    `geulbat.browserProfilePolicyId=${identity.profilePolicyId}`,
    `geulbat.browserCookieStorePolicyId=${identity.cookieStorePolicyId}`,
    `geulbat.browserArtifactExportPolicyId=${identity.artifactExportPolicyId}`,
    `geulbat.browserTelemetryPolicyId=${identity.browserTelemetryPolicyId}`,
  ];

  return identity.enabled
    ? [
        ...labels,
        `geulbat.browserNetworkPolicyId=${identity.networkPolicyId}`,
        `geulbat.browserMaxTabs=${identity.maxTabs}`,
        `geulbat.browserOutputPolicy=${identity.outputPolicy}`,
        ...(identity.mode === 'fixed_runtime_probe' ||
        identity.mode === 'fixed_navigation_probe'
          ? [
              `geulbat.browserRuntimeEnginePolicyId=${identity.browserRuntimeEnginePolicyId}`,
            ]
          : []),
        ...(identity.mode === 'user_url_navigation'
          ? buildPtcLabBrowserNavigationIdentityLabels({
              identity,
              afterEvidenceLabels: [
                `geulbat.browserUrlEchoPolicyId=${identity.urlEchoPolicyId}`,
              ],
            })
          : []),
        ...(identity.mode === 'page_load_evidence'
          ? buildPtcLabBrowserNavigationIdentityLabels({
              identity,
              afterEngineLabels: buildPtcLabBrowserPageLoadEvidenceLabels(
                identity,
                PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_AFTER_ENGINE_LABEL_FIELDS,
              ),
              afterRedirectLabels: buildPtcLabBrowserPageLoadEvidenceLabels(
                identity,
                PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_AFTER_REDIRECT_LABEL_FIELDS,
              ),
              afterEvidenceLabels: buildPtcLabBrowserPageLoadEvidenceLabels(
                identity,
                PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_AFTER_EVIDENCE_LABEL_FIELDS,
              ),
            })
          : []),
        ...(identity.mode === 'fixed_navigation_probe'
          ? [
              `geulbat.browserNavigationTargetPolicyId=${identity.navigationTargetPolicyId}`,
              `geulbat.browserUrlGrammarPolicyId=${identity.urlGrammarPolicyId}`,
              `geulbat.browserRedirectPolicyId=${identity.redirectPolicyId}`,
              `geulbat.browserEvidencePolicyId=${identity.evidencePolicyId}`,
            ]
          : []),
      ]
    : labels;
}

function buildPtcLabBrowserNavigationIdentityLabels(args: {
  identity: Extract<
    PtcLabBrowserIdentitySnapshot,
    { mode: 'user_url_navigation' | 'page_load_evidence' }
  >;
  afterEngineLabels?: string[];
  afterRedirectLabels?: string[];
  afterEvidenceLabels?: string[];
}): string[] {
  return [
    `geulbat.browserEnginePolicyId=${args.identity.browserEnginePolicyId}`,
    ...(args.afterEngineLabels ?? []),
    `geulbat.browserUrlGrammarPolicyId=${args.identity.urlGrammarPolicyId}`,
    `geulbat.browserCallerHeadersPolicyId=${args.identity.callerHeadersPolicyId}`,
    `geulbat.browserHeadersPolicyId=${args.identity.browserHeadersPolicyId}`,
    `geulbat.browserBodyPolicyId=${args.identity.bodyPolicyId}`,
    `geulbat.browserRedirectPolicyId=${args.identity.redirectPolicyId}`,
    ...(args.afterRedirectLabels ?? []),
    `geulbat.browserDownloadPolicyId=${args.identity.downloadPolicyId}`,
    `geulbat.browserEvidencePolicyId=${args.identity.evidencePolicyId}`,
    ...(args.afterEvidenceLabels ?? []),
    `geulbat.browserPopupPolicyId=${args.identity.popupPolicyId}`,
    `geulbat.browserPermissionPolicyId=${args.identity.permissionPolicyId}`,
    `geulbat.browserTimeoutPolicyId=${args.identity.timeoutPolicyId}`,
    `geulbat.browserLoadWaitPolicyId=${args.identity.loadWaitPolicyId}`,
    `geulbat.browserViewportPolicyId=${args.identity.viewportPolicyId}`,
    `geulbat.browserLocalePolicyId=${args.identity.localePolicyId}`,
    `geulbat.browserTimezonePolicyId=${args.identity.timezonePolicyId}`,
  ];
}

function buildPtcLabBrowserPageLoadEvidenceLabels(
  identity: PtcLabBrowserPageLoadEvidenceLabelSource,
  fields: readonly PtcLabBrowserPageLoadEvidenceLabelField[],
): string[] {
  return fields.map(
    ([key, labelName]) => `geulbat.${labelName}=${identity[key]}`,
  );
}

function digestPtcLabBrowserPolicyFingerprint(
  value: Record<string, string | number>,
): `sha256:${string}` {
  const digest = sha256StableJson(value);
  return `sha256:${digest}`;
}

export function isPtcLabBrowserSafeProbeId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(value);
}

export function hasOnlyPtcLabBrowserRequestKeys(
  value: object,
  allowedKeys: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

export interface PtcLabBrowserRequestInvalidFailure {
  ok: false;
  reasonCode: 'ptc_lab_browser_request_invalid';
  message: string;
}

export type PtcLabBrowserRequestInvalidCapability =
  | 'owner preflight'
  | 'runtime probe'
  | 'navigation probe';

export function ptcLabBrowserRequestInvalid(
  capabilityLabel: PtcLabBrowserRequestInvalidCapability,
): PtcLabBrowserRequestInvalidFailure {
  return {
    ok: false,
    reasonCode: 'ptc_lab_browser_request_invalid',
    message: `PTC lab browser ${capabilityLabel} request is invalid`,
  };
}

function normalizePtcLabBrowserMaxActionMs(
  value: number | undefined,
  label: string,
): number {
  const maxActionMs = value ?? PTC_LAB_BROWSER_DEFAULT_MAX_ACTION_MS;
  if (
    !Number.isInteger(maxActionMs) ||
    maxActionMs <= 0 ||
    maxActionMs > PTC_LAB_BROWSER_MAX_ACTION_MS
  ) {
    throw new Error(`PTC lab browser ${label} maxActionMs is invalid`);
  }
  return maxActionMs;
}

function normalizePtcLabBrowserMaxTitleChars(
  value: number | undefined,
): number {
  const maxTitleChars = value ?? PTC_LAB_BROWSER_DEFAULT_MAX_TITLE_CHARS;
  if (
    !Number.isInteger(maxTitleChars) ||
    maxTitleChars <= 0 ||
    maxTitleChars > PTC_LAB_BROWSER_MAX_TITLE_CHARS
  ) {
    throw new Error(
      'PTC lab browser page-load evidence maxTitleChars is invalid',
    );
  }
  return maxTitleChars;
}
