import {
  PTC_BROWSER_PAGE_LOAD_EVIDENCE_LAB_POLICY_ID,
  PTC_BROWSER_PAGE_LOAD_EVIDENCE_MAX_TIMEOUT_MS,
  type PtcBrowserPageLoadEvidenceRuntime,
  type PtcBrowserPageLoadEvidenceRuntimeResult,
} from './browser-page-load-evidence-runtime-contract.js';
import {
  createPtcBrowserUrlEvidenceRuntime,
  type PtcBrowserRuntimeOptions,
} from './browser-state-runtime.js';
import { createPtcLabBrowserPageLoadEvidencePolicy } from '../../lab/browser/core/lab-browser-policy.js';
import { runPtcLabBrowserPageLoadEvidence } from '../../lab/browser/page-load-evidence/lab-browser-page-load-evidence.js';
import { browserPageLoadEvidenceFailure } from '../../lab/browser/page-load-evidence/lab-browser-page-load-evidence-contract.js';

export function createPtcBrowserPageLoadEvidenceRuntime(
  options: PtcBrowserRuntimeOptions = {},
): PtcBrowserPageLoadEvidenceRuntime {
  return createPtcBrowserUrlEvidenceRuntime({
    options,
    labPolicyId: PTC_BROWSER_PAGE_LOAD_EVIDENCE_LAB_POLICY_ID,
    createBrowserPolicy: () =>
      createPtcLabBrowserPageLoadEvidencePolicy({
        maxNavigationMs: PTC_BROWSER_PAGE_LOAD_EVIDENCE_MAX_TIMEOUT_MS,
      }),
    stateRuntimeUnavailable: (
      diagnostics,
    ): Extract<PtcBrowserPageLoadEvidenceRuntimeResult, { ok: false }> =>
      browserPageLoadEvidenceFailure(
        'ptc_lab_browser_session_unavailable',
        'PTC browser page-load evidence state runtime is unavailable',
        'session_acquisition',
        { diagnostics },
      ),
    cleanupFailureReasonCode:
      'ptc_browser_page_load_evidence_session_cleanup_failed',
    cleanupFailureMessage:
      'PTC browser page-load evidence session cleanup failed',
    admissionFailed: (admission) =>
      browserPageLoadEvidenceFailure(
        'ptc_lab_browser_policy_disabled',
        admission.message,
        'policy_admission',
        {
          diagnostics: { admissionReasonCode: admission.reasonCode },
        },
      ),
    runEvidence: runPtcLabBrowserPageLoadEvidence,
  });
}
