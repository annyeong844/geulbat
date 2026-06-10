import {
  PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_POLICY_ID,
  PTC_LAB_BROWSER_PROFILE_NONE_POLICY_ID,
  PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID,
  PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
  PTC_LAB_BROWSER_TELEMETRY_OWNER_OUTCOME_POLICY_ID,
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

export const PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_CAPABILITY =
  'ptc_lab_browser_fixed_runtime_probe' as const;
export const PTC_LAB_BROWSER_RUNTIME_CONTROLLED_READY_MARKER =
  '__GEULBAT_BROWSER_PROBE_READY__' as const;

export const PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_SCRIPT = String.raw`
(async () => {
  const capability = 'ptc_lab_browser_fixed_runtime_probe';
  const marker = '__GEULBAT_BROWSER_PROBE_READY__';
  const documentSource = '<!doctype html><meta charset="utf-8"><title>geulbat browser probe</title><script>window.__GEULBAT_BROWSER_PROBE_READY__ = true;</script>';
  const checks = {
    engineAvailable: false,
    contextCreated: false,
    controlledDocumentReady: false,
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
  try {
    browser = await chromium.launch({ headless: true });
    checks.engineAvailable = true;
    context = await browser.newContext();
    checks.contextCreated = true;
    page = await context.newPage();
    await page.setContent(documentSource, { waitUntil: 'domcontentloaded' });
    checks.controlledDocumentReady = await page.evaluate((name) => Boolean(globalThis[name]), marker);
    const cleaned = await cleanup(page, context, browser);
    const ok = checks.controlledDocumentReady && cleaned;
    finish(ok ? 0 : 2, {
      ok,
      ...(ok ? {} : { errorCode: cleaned ? 'execution_failed' : 'cleanup_failed' })
    });
  } catch {
    const cleaned = await cleanup(page, context, browser);
    finish(2, {
      ok: false,
      errorCode: browser ? (cleaned ? 'execution_failed' : 'cleanup_uncertain') : 'browser_runtime_unavailable'
    });
  }
})();
`;

export type PtcLabBrowserRuntimeFailureReason =
  | 'ptc_lab_browser_admission_required'
  | 'ptc_lab_browser_policy_disabled'
  | 'ptc_lab_browser_policy_mismatch'
  | 'ptc_lab_browser_request_invalid'
  | 'ptc_lab_browser_session_unavailable'
  | 'ptc_lab_browser_runtime_unavailable'
  | 'ptc_lab_browser_execution_failed'
  | 'ptc_lab_browser_output_invalid'
  | 'ptc_lab_browser_timeout'
  | 'ptc_lab_browser_cancelled'
  | 'ptc_lab_browser_session_tainted'
  | 'ptc_lab_browser_cleanup_failed'
  | 'ptc_lab_browser_cleanup_uncertain';

export type PtcLabBrowserRuntimeResult<T> = PtcLabBrowserSimpleResult<
  T,
  PtcLabBrowserRuntimeFailureReason
>;

export interface PtcLabBrowserFixedRuntimeProbeRequest {
  probeId: string;
  timeoutMs?: number;
}

export interface PtcLabBrowserFixedRuntimeProbeChecks {
  engineAvailable: boolean;
  contextCreated: boolean;
  controlledDocumentReady: boolean;
  cleanupCompleted: boolean;
}

export interface PtcLabBrowserFixedRuntimeProbeSummary {
  ok: true;
  profile: 'lab';
  capability: typeof PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_CAPABILITY;
  policyId: string;
  labSessionId: string;
  probeId: string;
  browserPolicyId: typeof PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_POLICY_ID;
  browserMode: 'fixed_runtime_probe';
  browserRuntimeEnginePolicyId: typeof PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID;
  browserNetworkPolicyId: typeof PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID;
  browserTelemetryPolicyId: typeof PTC_LAB_BROWSER_TELEMETRY_OWNER_OUTCOME_POLICY_ID;
  browserOutputPolicy: 'summary_only';
  browserProfilePolicyId: typeof PTC_LAB_BROWSER_PROFILE_NONE_POLICY_ID;
  browserCookieStorePolicyId: typeof PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID;
  browserArtifactExportPolicyId: typeof PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID;
  browserProfile: 'none';
  browserCookies: 'none';
  artifactExported: false;
  checks: PtcLabBrowserFixedRuntimeProbeChecks;
  durationMs: number;
}

export interface RunPtcLabBrowserFixedRuntimeProbeArgs {
  admission: PtcLabAdmittedProfile | undefined;
  identity: PtcSessionDockerIdentity;
  sessionManager: PtcSessionDockerManager;
  request: PtcLabBrowserFixedRuntimeProbeRequest;
  commandRunner?: PtcSessionDockerCommandRunner;
  dockerPath?: string;
  now?: () => number;
  signal?: AbortSignal;
}

export function browserRuntimeFailure(
  reasonCode: PtcLabBrowserRuntimeFailureReason,
  message: string,
  diagnostics?: PtcLabBrowserDiagnostics,
): PtcLabBrowserRuntimeResult<never> {
  return createPtcLabBrowserFailure(reasonCode, message, diagnostics);
}
