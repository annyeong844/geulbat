import {
  PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_BODY_NONE_POLICY_ID,
  PTC_LAB_BROWSER_CALLER_HEADERS_NONE_POLICY_ID,
  PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID,
  PTC_LAB_BROWSER_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_DOM_TEXT_EVIDENCE_POLICY_ID,
  PTC_LAB_BROWSER_DOWNLOADS_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_FINAL_URL_DIGEST_PUBLIC_SHA256_POLICY_ID,
  PTC_LAB_BROWSER_FINAL_URL_ECHO_DIGEST_ONLY_POLICY_ID,
  PTC_LAB_BROWSER_HEADERS_RUNTIME_DEFAULT_POLICY_ID,
  PTC_LAB_BROWSER_LOAD_WAIT_DOMCONTENTLOADED_POLICY_ID,
  PTC_LAB_BROWSER_LOCALE_SANDBOX_DEFAULT_POLICY_ID,
  PTC_LAB_BROWSER_NAVIGATION_SUMMARY_ONLY_POLICY_ID,
  PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_DIGEST_RESULT_WITH_TIMING_POLICY_ID,
  PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_POLICY_ID,
  PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_SUMMARY_POLICY_ID,
  PTC_LAB_BROWSER_PERMISSIONS_DENIED_POLICY_ID,
  PTC_LAB_BROWSER_POPUPS_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_POLICY_VERSION,
  PTC_LAB_BROWSER_PROFILE_FRESH_PER_ATTEMPT_POLICY_ID,
  PTC_LAB_BROWSER_PROFILE_NONE_POLICY_ID,
  PTC_LAB_BROWSER_REDIRECT_COUNT_ONLY_POLICY_ID,
  PTC_LAB_BROWSER_REDIRECT_REVALIDATED_POLICY_ID,
  PTC_LAB_BROWSER_RESPONSE_STATUS_CODE_OPTIONAL_POLICY_ID,
  PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
  PTC_LAB_BROWSER_TELEMETRY_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_TELEMETRY_OWNER_OUTCOME_POLICY_ID,
  PTC_LAB_BROWSER_TEXT_EVIDENCE_DIGEST_RESULT_WITH_TIMING_POLICY_ID,
  PTC_LAB_BROWSER_TEXT_EVIDENCE_SUMMARY_POLICY_ID,
  PTC_LAB_BROWSER_TIMING_OWNER_AND_NAVIGATION_BOUNDED_POLICY_ID,
  PTC_LAB_BROWSER_TIMEOUT_BOUNDED_POLICY_ID,
  PTC_LAB_BROWSER_TIMEZONE_SANDBOX_DEFAULT_POLICY_ID,
  PTC_LAB_BROWSER_URL_ECHO_DIGEST_ONLY_POLICY_ID,
  PTC_LAB_BROWSER_URL_GRAMMAR_HTTP_HTTPS_NO_CREDENTIALS_POLICY_ID,
  PTC_LAB_BROWSER_USER_URL_NAVIGATION_POLICY_ID,
  PTC_LAB_BROWSER_VIEWPORT_DEFAULT_POLICY_ID,
} from './lab-browser-policy-ids.js';
import { PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID } from '../../network/lab-network-policy.js';
import { digestPtcStableJson } from '../../../shared/stable-identity.js';
import type { PtcSha256Digest } from '../../../shared/browser-evidence-contract.js';

const PTC_LAB_BROWSER_DEFAULT_MAX_ACTION_MS = 5_000;
const PTC_LAB_BROWSER_MAX_ACTION_MS = 15_000;

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
  | ({
      enabled: true;
      mode: 'user_url_navigation';
      policyVersion: typeof PTC_LAB_BROWSER_POLICY_VERSION;
    } & ReturnType<typeof buildPtcLabBrowserUserUrlNavigationPolicyFields>)
  | ({
      enabled: true;
      mode: 'page_load_evidence';
      policyVersion: typeof PTC_LAB_BROWSER_POLICY_VERSION;
      policyFingerprint: PtcSha256Digest;
    } & ReturnType<typeof buildPtcLabBrowserPageLoadEvidencePolicyFields>)
  | ({
      enabled: true;
      mode: 'dom_text_evidence';
      policyVersion: typeof PTC_LAB_BROWSER_POLICY_VERSION;
      policyFingerprint: PtcSha256Digest;
    } & ReturnType<typeof buildPtcLabBrowserTextEvidencePolicyFields>);

interface CreatePtcLabBrowserUserUrlNavigationPolicyArgs {
  maxActionMs?: number;
}

interface CreatePtcLabBrowserPageLoadEvidencePolicyArgs {
  maxNavigationMs?: number;
}

interface CreatePtcLabBrowserTextEvidencePolicyArgs {
  maxNavigationMs?: number;
}

const PTC_LAB_BROWSER_URL_NAVIGATION_POLICY_BASE = {
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
  popupPolicyId: PTC_LAB_BROWSER_POPUPS_DISABLED_POLICY_ID,
  permissionPolicyId: PTC_LAB_BROWSER_PERMISSIONS_DENIED_POLICY_ID,
  timeoutPolicyId: PTC_LAB_BROWSER_TIMEOUT_BOUNDED_POLICY_ID,
  loadWaitPolicyId: PTC_LAB_BROWSER_LOAD_WAIT_DOMCONTENTLOADED_POLICY_ID,
  viewportPolicyId: PTC_LAB_BROWSER_VIEWPORT_DEFAULT_POLICY_ID,
  localePolicyId: PTC_LAB_BROWSER_LOCALE_SANDBOX_DEFAULT_POLICY_ID,
  timezonePolicyId: PTC_LAB_BROWSER_TIMEZONE_SANDBOX_DEFAULT_POLICY_ID,
} as const;

const PTC_LAB_BROWSER_EVIDENCE_URL_RESULT_POLICY_FIELDS = {
  requestedUrlEchoPolicyId: PTC_LAB_BROWSER_URL_ECHO_DIGEST_ONLY_POLICY_ID,
  finalUrlEchoPolicyId: PTC_LAB_BROWSER_FINAL_URL_ECHO_DIGEST_ONLY_POLICY_ID,
  finalUrlDigestPolicyId:
    PTC_LAB_BROWSER_FINAL_URL_DIGEST_PUBLIC_SHA256_POLICY_ID,
  redirectCountPolicyId: PTC_LAB_BROWSER_REDIRECT_COUNT_ONLY_POLICY_ID,
  timingPolicyId: PTC_LAB_BROWSER_TIMING_OWNER_AND_NAVIGATION_BOUNDED_POLICY_ID,
} as const;

type PtcLabBrowserUrlNavigationPolicyBaseFields =
  typeof PTC_LAB_BROWSER_URL_NAVIGATION_POLICY_BASE & {
    maxTabs: 1;
  };

type PtcLabBrowserEvidencePolicyBaseFields =
  PtcLabBrowserUrlNavigationPolicyBaseFields & {
    maxNavigationMs: number;
  } & typeof PTC_LAB_BROWSER_EVIDENCE_URL_RESULT_POLICY_FIELDS;

type PtcLabBrowserUserUrlNavigationPolicyFields =
  PtcLabBrowserUrlNavigationPolicyBaseFields & {
    maxActionMs: number;
    browserPolicyId: typeof PTC_LAB_BROWSER_USER_URL_NAVIGATION_POLICY_ID;
    evidencePolicyId: typeof PTC_LAB_BROWSER_NAVIGATION_SUMMARY_ONLY_POLICY_ID;
    urlEchoPolicyId: typeof PTC_LAB_BROWSER_URL_ECHO_DIGEST_ONLY_POLICY_ID;
  };

type PtcLabBrowserPageLoadEvidencePolicyFields =
  PtcLabBrowserEvidencePolicyBaseFields & {
    browserPolicyId: typeof PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_POLICY_ID;
    evidencePolicyId: typeof PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_SUMMARY_POLICY_ID;
    pageLoadEvidenceDigestPolicyId: typeof PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_DIGEST_RESULT_WITH_TIMING_POLICY_ID;
    responseStatusPolicyId: typeof PTC_LAB_BROWSER_RESPONSE_STATUS_CODE_OPTIONAL_POLICY_ID;
  };

type PtcLabBrowserTextEvidencePolicyFields =
  PtcLabBrowserEvidencePolicyBaseFields & {
    browserPolicyId: typeof PTC_LAB_BROWSER_DOM_TEXT_EVIDENCE_POLICY_ID;
    evidencePolicyId: typeof PTC_LAB_BROWSER_TEXT_EVIDENCE_SUMMARY_POLICY_ID;
    textEvidenceDigestPolicyId: typeof PTC_LAB_BROWSER_TEXT_EVIDENCE_DIGEST_RESULT_WITH_TIMING_POLICY_ID;
  };

function digestPtcLabBrowserPolicyFingerprint(
  value: Record<string, string | number | Record<string, string | number>>,
): PtcSha256Digest {
  return digestPtcStableJson(value);
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

function buildPtcLabBrowserUserUrlNavigationPolicyFields(args: {
  maxActionMs: number;
}): PtcLabBrowserUserUrlNavigationPolicyFields {
  return {
    ...PTC_LAB_BROWSER_URL_NAVIGATION_POLICY_BASE,
    maxTabs: 1,
    maxActionMs: args.maxActionMs,
    browserPolicyId: PTC_LAB_BROWSER_USER_URL_NAVIGATION_POLICY_ID,
    evidencePolicyId: PTC_LAB_BROWSER_NAVIGATION_SUMMARY_ONLY_POLICY_ID,
    urlEchoPolicyId: PTC_LAB_BROWSER_URL_ECHO_DIGEST_ONLY_POLICY_ID,
  };
}

function buildPtcLabBrowserPageLoadEvidencePolicyFields(args: {
  maxNavigationMs: number;
}): PtcLabBrowserPageLoadEvidencePolicyFields {
  return {
    ...PTC_LAB_BROWSER_URL_NAVIGATION_POLICY_BASE,
    maxNavigationMs: args.maxNavigationMs,
    maxTabs: 1,
    browserPolicyId: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_POLICY_ID,
    evidencePolicyId: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_SUMMARY_POLICY_ID,
    pageLoadEvidenceDigestPolicyId:
      PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_DIGEST_RESULT_WITH_TIMING_POLICY_ID,
    responseStatusPolicyId:
      PTC_LAB_BROWSER_RESPONSE_STATUS_CODE_OPTIONAL_POLICY_ID,
    ...PTC_LAB_BROWSER_EVIDENCE_URL_RESULT_POLICY_FIELDS,
  };
}

function buildPtcLabBrowserTextEvidencePolicyFields(args: {
  maxNavigationMs: number;
}): PtcLabBrowserTextEvidencePolicyFields {
  return {
    ...PTC_LAB_BROWSER_URL_NAVIGATION_POLICY_BASE,
    maxNavigationMs: args.maxNavigationMs,
    maxTabs: 1,
    browserPolicyId: PTC_LAB_BROWSER_DOM_TEXT_EVIDENCE_POLICY_ID,
    evidencePolicyId: PTC_LAB_BROWSER_TEXT_EVIDENCE_SUMMARY_POLICY_ID,
    textEvidenceDigestPolicyId:
      PTC_LAB_BROWSER_TEXT_EVIDENCE_DIGEST_RESULT_WITH_TIMING_POLICY_ID,
    ...PTC_LAB_BROWSER_EVIDENCE_URL_RESULT_POLICY_FIELDS,
  };
}

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

export function createPtcLabBrowserUserUrlNavigationPolicy(
  args: CreatePtcLabBrowserUserUrlNavigationPolicyArgs = {},
): PtcLabBrowserPolicy {
  const maxActionMs = normalizePtcLabBrowserMaxActionMs(
    args.maxActionMs,
    'user URL navigation',
  );
  const fields = buildPtcLabBrowserUserUrlNavigationPolicyFields({
    maxActionMs,
  });
  return {
    enabled: true,
    mode: 'user_url_navigation',
    policyVersion: PTC_LAB_BROWSER_POLICY_VERSION,
    ...fields,
  };
}

export function createPtcLabBrowserPageLoadEvidencePolicy(
  args: CreatePtcLabBrowserPageLoadEvidencePolicyArgs = {},
): PtcLabBrowserPolicy {
  const maxNavigationMs = normalizePtcLabBrowserMaxActionMs(
    args.maxNavigationMs,
    'page-load evidence',
  );
  const fields = buildPtcLabBrowserPageLoadEvidencePolicyFields({
    maxNavigationMs,
  });

  return {
    enabled: true,
    mode: 'page_load_evidence',
    policyVersion: PTC_LAB_BROWSER_POLICY_VERSION,
    policyFingerprint: digestPtcLabBrowserPolicyFingerprint(fields),
    ...fields,
  };
}

export function createPtcLabBrowserTextEvidencePolicy(
  args: CreatePtcLabBrowserTextEvidencePolicyArgs = {},
): PtcLabBrowserPolicy {
  const maxNavigationMs = normalizePtcLabBrowserMaxActionMs(
    args.maxNavigationMs,
    'text evidence',
  );
  const fields = buildPtcLabBrowserTextEvidencePolicyFields({
    maxNavigationMs,
  });

  return {
    enabled: true,
    mode: 'dom_text_evidence',
    policyVersion: PTC_LAB_BROWSER_POLICY_VERSION,
    policyFingerprint: digestPtcLabBrowserPolicyFingerprint(fields),
    ...fields,
  };
}
