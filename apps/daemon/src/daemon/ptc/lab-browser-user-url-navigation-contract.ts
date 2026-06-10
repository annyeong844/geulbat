import {
  PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID,
  PTC_LAB_BROWSER_DOWNLOADS_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_NAVIGATION_SUMMARY_ONLY_POLICY_ID,
  PTC_LAB_BROWSER_PERMISSIONS_DENIED_POLICY_ID,
  PTC_LAB_BROWSER_POPUPS_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_PROFILE_FRESH_PER_ATTEMPT_POLICY_ID,
  PTC_LAB_BROWSER_REDIRECT_REVALIDATED_POLICY_ID,
  PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
  PTC_LAB_BROWSER_URL_ECHO_DIGEST_ONLY_POLICY_ID,
  PTC_LAB_BROWSER_USER_URL_NAVIGATION_POLICY_ID,
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
  PTC_LAB_BROWSER_USER_URL_NAVIGATION_CAPABILITY,
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

export const PTC_LAB_BROWSER_USER_URL_NAVIGATION_RUNTIME_CAPABILITY =
  'ptc_lab_browser_user_url_navigation_runtime' as const;
export const PTC_LAB_BROWSER_USER_URL_NAVIGATION_RESULT_KIND =
  'ptc_lab_browser_user_url_navigation_result' as const;
export const PTC_LAB_BROWSER_USER_URL_NAVIGATION_ERROR_KIND =
  'ptc_lab_browser_user_url_navigation_error' as const;

export const PTC_LAB_BROWSER_USER_URL_NAVIGATION_RUNTIME_SCRIPT = String.raw`
(async () => {
  const fs = require('fs');
  const capability = 'ptc_lab_browser_user_url_navigation';
  const checks = {
    engineAvailable: false,
    contextCreated: false,
    navigationStarted: false,
    navigationSettled: false,
    redirectPolicyEnforced: false,
    downloadPolicyEnforced: false,
    cleanupCompleted: false
  };
  function finish(exitCode, payload) {
    process.stdout.write(JSON.stringify({ capability, checks, ...payload }) + '\n', () => {
      process.exit(exitCode);
    });
  }
  function readInput() {
    const inputPath = process.argv[2];
    if (typeof inputPath !== 'string' || inputPath.length === 0) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    } catch {
      return null;
    }
  }
  function isAdmittedUrl(value) {
    if (typeof value !== 'string') {
      return false;
    }
    try {
      const parsed = new URL(value);
      return (
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        parsed.username === '' &&
        parsed.password === ''
      );
    } catch {
      return false;
    }
  }
  function redirectsRevalidated(response, page) {
    if (!response || !isAdmittedUrl(page.url())) {
      return false;
    }
    let request = response.request();
    while (request) {
      if (!isAdmittedUrl(request.url())) {
        return false;
      }
      request = request.redirectedFrom();
    }
    return true;
  }
  async function cleanup(page, context, browser) {
    let ok = true;
    if (page) {
      try { await page.close(); } catch { ok = false; }
    }
    if (context) {
      try { await context.close(); } catch { ok = false; }
    }
    if (browser) {
      try { await browser.close(); } catch { ok = false; }
    }
    checks.cleanupCompleted = ok;
    return ok;
  }

  const input = readInput();
  if (
    !input ||
    !isAdmittedUrl(input.targetUrl) ||
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs <= 0 ||
    input.loadWaitState !== 'domcontentloaded'
  ) {
    checks.cleanupCompleted = true;
    finish(2, { ok: false, errorCode: 'navigation_failed' });
    return;
  }

  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    checks.cleanupCompleted = true;
    finish(3, { ok: false, errorCode: 'browser_runtime_unavailable' });
    return;
  }

  let browser;
  let context;
  let page;
  let popupObserved = false;
  let downloadObserved = false;
  try {
    browser = await chromium.launch({ headless: true });
    checks.engineAvailable = true;
    context = await browser.newContext({
      acceptDownloads: false,
      locale: 'en-US',
      timezoneId: 'UTC',
      viewport: { width: 1280, height: 720 }
    });
    checks.contextCreated = true;
    context.on('page', async (openedPage) => {
      if (page && openedPage !== page) {
        popupObserved = true;
        try { await openedPage.close(); } catch {}
      }
    });
    page = await context.newPage();
    page.on('popup', async (popup) => {
      popupObserved = true;
      try { await popup.close(); } catch {}
    });
    page.on('download', async (download) => {
      downloadObserved = true;
      try { await download.cancel(); } catch {}
    });
    checks.navigationStarted = true;
    const response = await page.goto(input.targetUrl, {
      waitUntil: input.loadWaitState,
      timeout: input.timeoutMs
    });
    checks.navigationSettled = Boolean(response);
    checks.redirectPolicyEnforced = redirectsRevalidated(response, page);
    checks.downloadPolicyEnforced = !downloadObserved;
    const loaded =
      checks.navigationSettled &&
      checks.redirectPolicyEnforced &&
      checks.downloadPolicyEnforced &&
      !popupObserved;
    const cleaned = await cleanup(page, context, browser);
    finish(loaded && cleaned ? 0 : 2, {
      ok: loaded && cleaned,
      ...(loaded && cleaned
        ? {}
        : {
            errorCode: cleaned
              ? popupObserved
                ? 'popup_disallowed'
                : downloadObserved
                  ? 'download_disallowed'
                  : checks.navigationSettled && !checks.redirectPolicyEnforced
                    ? 'redirect_disallowed'
                    : 'navigation_failed'
              : 'cleanup_uncertain'
          })
    });
  } catch {
    const cleaned = await cleanup(page, context, browser);
    finish(2, {
      ok: false,
      errorCode: browser ? (cleaned ? 'navigation_failed' : 'cleanup_uncertain') : 'browser_runtime_unavailable'
    });
  }
})();
`;

export type PtcLabBrowserUserUrlNavigationFailureReason =
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

export type PtcLabBrowserUserUrlNavigationPhase =
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

export type PtcLabBrowserUserUrlNavigationAttemptDigest =
  PtcLabBrowserNavigationAttemptDigest;

export interface PtcLabBrowserUserUrlNavigationChecks {
  targetVerified: boolean;
  engineAvailable: boolean;
  contextCreated: boolean;
  navigationStarted: boolean;
  navigationSettled: boolean;
  redirectPolicyEnforced: boolean;
  downloadPolicyEnforced: boolean;
  cleanupCompleted: boolean;
}

export interface PtcLabBrowserUserUrlNavigationSummary {
  kind: typeof PTC_LAB_BROWSER_USER_URL_NAVIGATION_RESULT_KIND;
  ok: true;
  profile: 'lab';
  capability: typeof PTC_LAB_BROWSER_USER_URL_NAVIGATION_CAPABILITY;
  targetDigest: PtcLabBrowserUserUrlTargetDigest;
  navigationAttemptDigest: PtcLabBrowserUserUrlNavigationAttemptDigest;
  sessionLifecycle: {
    mode: 'runtime_owned';
    retainedAfterExecution: boolean;
    taintedAfterExecution: false;
  };
  browserPolicyId: typeof PTC_LAB_BROWSER_USER_URL_NAVIGATION_POLICY_ID;
  browserMode: 'user_url_navigation';
  browserEnginePolicyId: typeof PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID;
  browserNetworkPolicyId: typeof PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID;
  browserUrlGrammarPolicyId: typeof PTC_LAB_BROWSER_URL_GRAMMAR_HTTP_HTTPS_NO_CREDENTIALS_POLICY_ID;
  browserRedirectPolicyId: typeof PTC_LAB_BROWSER_REDIRECT_REVALIDATED_POLICY_ID;
  browserEvidencePolicyId: typeof PTC_LAB_BROWSER_NAVIGATION_SUMMARY_ONLY_POLICY_ID;
  browserUrlEchoPolicyId: typeof PTC_LAB_BROWSER_URL_ECHO_DIGEST_ONLY_POLICY_ID;
  browserPopupPolicyId: typeof PTC_LAB_BROWSER_POPUPS_DISABLED_POLICY_ID;
  browserPermissionPolicyId: typeof PTC_LAB_BROWSER_PERMISSIONS_DENIED_POLICY_ID;
  browserProfilePolicyId: typeof PTC_LAB_BROWSER_PROFILE_FRESH_PER_ATTEMPT_POLICY_ID;
  browserCookieStorePolicyId: typeof PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID;
  browserDownloadPolicyId: typeof PTC_LAB_BROWSER_DOWNLOADS_DISABLED_POLICY_ID;
  browserArtifactExportPolicyId: typeof PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID;
  artifactExported: false;
  requestedUrlRedacted: boolean;
  finalUrlRedacted: true;
  navigationOutcome: 'loaded';
  loadState: 'domcontentloaded' | 'load';
  checks: PtcLabBrowserUserUrlNavigationChecks;
  durationMs: number;
}

export type PtcLabBrowserUserUrlNavigationError = PtcLabBrowserPhasedFailure<
  typeof PTC_LAB_BROWSER_USER_URL_NAVIGATION_ERROR_KIND,
  PtcLabBrowserUserUrlNavigationFailureReason,
  PtcLabBrowserUserUrlNavigationPhase,
  {
    targetDigest?: PtcLabBrowserUserUrlTargetDigest;
    navigationAttemptDigest?: PtcLabBrowserUserUrlNavigationAttemptDigest;
    sessionLifecycle?: {
      mode: 'runtime_owned';
      retainedAfterExecution: boolean;
      taintedAfterExecution: boolean;
    };
    diagnostics?: PtcLabBrowserDiagnostics;
  }
>;

export type PtcLabBrowserUserUrlNavigationResult<T> = PtcLabBrowserResult<
  T,
  PtcLabBrowserUserUrlNavigationError
>;

export interface PtcLabBrowserUserUrlNavigationRuntimeInput {
  target: PtcLabBrowserUserUrlNavigationTarget;
  timeoutMs?: number;
}

export interface PtcLabBrowserUserUrlNavigationExecutionDigestInput extends PtcLabBrowserNavigationAttemptSharedDigestInput<
  typeof PTC_LAB_BROWSER_USER_URL_NAVIGATION_POLICY_ID
> {
  evidencePolicyId: typeof PTC_LAB_BROWSER_NAVIGATION_SUMMARY_ONLY_POLICY_ID;
  urlEchoPolicyId: typeof PTC_LAB_BROWSER_URL_ECHO_DIGEST_ONLY_POLICY_ID;
}

export interface PtcLabBrowserUserUrlNavigationExecutionIdentity extends PtcLabBrowserUserUrlNavigationExecutionDigestInput {
  navigationAttemptDigest: PtcLabBrowserUserUrlNavigationAttemptDigest;
}

export interface RunPtcLabBrowserUserUrlNavigationArgs {
  admission: PtcLabAdmittedProfile | undefined;
  identity: PtcSessionDockerIdentity;
  sessionManager: PtcSessionDockerManager;
  request: PtcLabBrowserUserUrlNavigationRequest;
  commandRunner?: PtcSessionDockerCommandRunner;
  dockerPath?: string;
  now?: () => number;
  signal?: AbortSignal;
}

export interface RunPtcLabBrowserUserUrlNavigationRuntimeArgs {
  admission: PtcLabAdmittedProfile | undefined;
  identity: PtcSessionDockerIdentity;
  sessionManager: PtcSessionDockerManager;
  input: PtcLabBrowserUserUrlNavigationRuntimeInput;
  ownerStartMs?: number;
  commandRunner?: PtcSessionDockerCommandRunner;
  dockerPath?: string;
  now?: () => number;
  signal?: AbortSignal;
}

export function buildPtcLabBrowserUserUrlNavigationExecutionIdentity(args: {
  browser: Extract<PtcLabBrowserPolicy, { mode: 'user_url_navigation' }>;
  effectiveTimeoutMs: number;
  targetDigest: PtcLabBrowserUserUrlTargetDigest;
}): PtcLabBrowserUserUrlNavigationExecutionIdentity {
  const digestInput: PtcLabBrowserUserUrlNavigationExecutionDigestInput = {
    ...buildPtcLabBrowserNavigationAttemptSharedDigestInput(args),
    evidencePolicyId: args.browser.evidencePolicyId,
    urlEchoPolicyId: args.browser.urlEchoPolicyId,
  };
  return {
    ...digestInput,
    navigationAttemptDigest:
      digestPtcLabBrowserUserUrlNavigationAttempt(digestInput),
  };
}

export function digestPtcLabBrowserUserUrlNavigationAttempt(
  value: PtcLabBrowserUserUrlNavigationExecutionDigestInput,
): PtcLabBrowserUserUrlNavigationAttemptDigest {
  return digestPtcLabBrowserNavigationAttempt(value);
}

export function browserUserUrlNavigationFailure(
  reasonCode: PtcLabBrowserUserUrlNavigationFailureReason,
  message: string,
  phase: PtcLabBrowserUserUrlNavigationPhase,
  extras: Omit<
    PtcLabBrowserUserUrlNavigationError,
    'kind' | 'ok' | 'reasonCode' | 'message' | 'phase'
  > = {},
): PtcLabBrowserUserUrlNavigationError {
  return createPtcLabBrowserPhasedFailure({
    kind: PTC_LAB_BROWSER_USER_URL_NAVIGATION_ERROR_KIND,
    reasonCode,
    message,
    phase,
    extras,
  });
}
