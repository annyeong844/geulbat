import { sha256StableJson } from '@geulbat/shared-utils/stable-json';
import {
  PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID,
  PTC_LAB_BROWSER_FIXED_NAVIGATION_PROBE_POLICY_ID,
  PTC_LAB_BROWSER_NAVIGATION_SUMMARY_ONLY_POLICY_ID,
  PTC_LAB_BROWSER_NAVIGATION_TARGET_FIXED_HTTPS_POLICY_ID,
  PTC_LAB_BROWSER_PROFILE_NONE_POLICY_ID,
  PTC_LAB_BROWSER_REDIRECT_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
  PTC_LAB_BROWSER_TELEMETRY_OWNER_OUTCOME_POLICY_ID,
  PTC_LAB_BROWSER_URL_GRAMMAR_POLICY_OWNED_TARGET_REF_POLICY_ID,
} from './lab-browser-policy.js';
import { PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID } from './lab-network-policy.js';
import {
  createPtcLabBrowserFailure,
  type PtcLabBrowserDiagnostics,
  type PtcLabBrowserSimpleResult,
} from './lab-browser-result-contract.js';
import type { PtcLabAdmittedProfile } from './lab-profile.js';
import type {
  PtcSessionDockerCommandRunner,
  PtcSessionDockerIdentity,
  PtcSessionDockerManager,
} from './session-docker-contract.js';

export const PTC_LAB_BROWSER_FIXED_NAVIGATION_PROBE_CAPABILITY =
  'ptc_lab_browser_fixed_navigation_probe' as const;
export const PTC_LAB_BROWSER_FIXED_NAVIGATION_TARGET_REF =
  PTC_LAB_BROWSER_NAVIGATION_TARGET_FIXED_HTTPS_POLICY_ID;

export interface PtcLabBrowserNavigationTarget {
  targetRef: typeof PTC_LAB_BROWSER_FIXED_NAVIGATION_TARGET_REF;
  url: string;
  method: 'GET';
  headersPolicy: 'none';
  bodyPolicy: 'none';
  redirectPolicyId: typeof PTC_LAB_BROWSER_REDIRECT_DISABLED_POLICY_ID;
  expectedLoadState: 'domcontentloaded' | 'load';
}

export const PTC_LAB_BROWSER_FIXED_NAVIGATION_TARGET: PtcLabBrowserNavigationTarget =
  Object.freeze({
    targetRef: PTC_LAB_BROWSER_FIXED_NAVIGATION_TARGET_REF,
    url: 'https://example.com/',
    method: 'GET',
    headersPolicy: 'none',
    bodyPolicy: 'none',
    redirectPolicyId: PTC_LAB_BROWSER_REDIRECT_DISABLED_POLICY_ID,
    expectedLoadState: 'domcontentloaded',
  });

export const PTC_LAB_BROWSER_FIXED_NAVIGATION_TARGET_DIGEST =
  digestPtcLabBrowserNavigationTarget(PTC_LAB_BROWSER_FIXED_NAVIGATION_TARGET);

export const PTC_LAB_BROWSER_FIXED_NAVIGATION_PROBE_SCRIPT = String.raw`
(async () => {
  const capability = 'ptc_lab_browser_fixed_navigation_probe';
  const targetUrl = ${JSON.stringify(PTC_LAB_BROWSER_FIXED_NAVIGATION_TARGET.url)};
  const expectedLoadState = ${JSON.stringify(PTC_LAB_BROWSER_FIXED_NAVIGATION_TARGET.expectedLoadState)};
  const checks = {
    engineAvailable: false,
    contextCreated: false,
    navigationCommitted: false,
    loadStateReached: false,
    cleanupCompleted: false
  };
  function finish(exitCode, payload) {
    process.stdout.write(JSON.stringify({ capability, checks, ...payload }) + '\n', () => {
      process.exit(exitCode);
    });
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
  let downloadObserved = false;
  try {
    browser = await chromium.launch({ headless: true });
    checks.engineAvailable = true;
    context = await browser.newContext();
    checks.contextCreated = true;
    page = await context.newPage();
    page.on('download', () => { downloadObserved = true; });
    const response = await page.goto(targetUrl, { waitUntil: expectedLoadState });
    checks.navigationCommitted = Boolean(response);
    checks.loadStateReached = Boolean(response);
    if (!response || !response.ok()) {
      const cleaned = await cleanup(page, context, browser);
      finish(2, { ok: false, errorCode: cleaned ? 'target_unavailable' : 'cleanup_uncertain' });
      return;
    }
    const redirected = Boolean(response.request().redirectedFrom());
    const finalUrlMatches = page.url() === targetUrl;
    const loaded = checks.navigationCommitted && checks.loadStateReached && !redirected && finalUrlMatches && !downloadObserved;
    const cleaned = await cleanup(page, context, browser);
    finish(loaded && cleaned ? 0 : 2, {
      ok: loaded && cleaned,
      ...(loaded && cleaned ? {} : { errorCode: cleaned ? 'navigation_failed' : 'cleanup_failed' })
    });
  } catch {
    const cleaned = await cleanup(page, context, browser);
    finish(2, {
      ok: false,
      errorCode: browser ? (cleaned ? 'target_unavailable' : 'cleanup_uncertain') : 'browser_runtime_unavailable'
    });
  }
})();
`;

export type PtcLabBrowserNavigationFailureReason =
  | 'ptc_lab_browser_admission_required'
  | 'ptc_lab_browser_policy_disabled'
  | 'ptc_lab_browser_policy_mismatch'
  | 'ptc_lab_browser_request_invalid'
  | 'ptc_lab_browser_session_unavailable'
  | 'ptc_lab_browser_target_unavailable'
  | 'ptc_lab_browser_runtime_unavailable'
  | 'ptc_lab_browser_navigation_failed'
  | 'ptc_lab_browser_output_invalid'
  | 'ptc_lab_browser_timeout'
  | 'ptc_lab_browser_cancelled'
  | 'ptc_lab_browser_session_tainted'
  | 'ptc_lab_browser_cleanup_failed'
  | 'ptc_lab_browser_cleanup_uncertain';

export type PtcLabBrowserNavigationResult<T> = PtcLabBrowserSimpleResult<
  T,
  PtcLabBrowserNavigationFailureReason
>;

export interface PtcLabBrowserFixedNavigationProbeRequest {
  probeId: string;
  targetRef: typeof PTC_LAB_BROWSER_FIXED_NAVIGATION_TARGET_REF;
  timeoutMs?: number;
}

export interface PtcLabBrowserFixedNavigationProbeChecks {
  engineAvailable: boolean;
  contextCreated: boolean;
  navigationCommitted: boolean;
  loadStateReached: boolean;
  cleanupCompleted: boolean;
}

export interface PtcLabBrowserFixedNavigationProbeSummary {
  ok: true;
  profile: 'lab';
  capability: typeof PTC_LAB_BROWSER_FIXED_NAVIGATION_PROBE_CAPABILITY;
  policyId: string;
  labSessionId: string;
  probeId: string;
  targetRef: typeof PTC_LAB_BROWSER_FIXED_NAVIGATION_TARGET_REF;
  targetDigest: string;
  browserPolicyId: typeof PTC_LAB_BROWSER_FIXED_NAVIGATION_PROBE_POLICY_ID;
  browserMode: 'fixed_navigation_probe';
  browserRuntimeEnginePolicyId: typeof PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID;
  browserNetworkPolicyId: typeof PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID;
  browserNavigationTargetPolicyId: typeof PTC_LAB_BROWSER_NAVIGATION_TARGET_FIXED_HTTPS_POLICY_ID;
  browserUrlGrammarPolicyId: typeof PTC_LAB_BROWSER_URL_GRAMMAR_POLICY_OWNED_TARGET_REF_POLICY_ID;
  browserRedirectPolicyId: typeof PTC_LAB_BROWSER_REDIRECT_DISABLED_POLICY_ID;
  browserTelemetryPolicyId: typeof PTC_LAB_BROWSER_TELEMETRY_OWNER_OUTCOME_POLICY_ID;
  browserOutputPolicy: 'summary_only';
  browserEvidencePolicyId: typeof PTC_LAB_BROWSER_NAVIGATION_SUMMARY_ONLY_POLICY_ID;
  browserProfilePolicyId: typeof PTC_LAB_BROWSER_PROFILE_NONE_POLICY_ID;
  browserCookieStorePolicyId: typeof PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID;
  browserArtifactExportPolicyId: typeof PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID;
  browserProfile: 'none';
  browserCookies: 'none';
  artifactExported: false;
  navigationOutcome: 'loaded';
  checks: PtcLabBrowserFixedNavigationProbeChecks;
  durationMs: number;
}

export interface RunPtcLabBrowserFixedNavigationProbeArgs {
  admission: PtcLabAdmittedProfile | undefined;
  identity: PtcSessionDockerIdentity;
  sessionManager: PtcSessionDockerManager;
  request: PtcLabBrowserFixedNavigationProbeRequest;
  commandRunner?: PtcSessionDockerCommandRunner;
  dockerPath?: string;
  now?: () => number;
  signal?: AbortSignal;
}

export function browserNavigationFailure(
  reasonCode: PtcLabBrowserNavigationFailureReason,
  message: string,
  diagnostics?: PtcLabBrowserDiagnostics,
): PtcLabBrowserNavigationResult<never> {
  return createPtcLabBrowserFailure(reasonCode, message, diagnostics);
}

export function digestPtcLabBrowserNavigationTarget(
  target: PtcLabBrowserNavigationTarget,
): string {
  return sha256StableJson(target);
}
