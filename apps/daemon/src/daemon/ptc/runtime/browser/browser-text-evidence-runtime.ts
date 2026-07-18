import {
  PTC_BROWSER_TEXT_EVIDENCE_LAB_POLICY_ID,
  PTC_BROWSER_TEXT_EVIDENCE_MAX_TIMEOUT_MS,
  type PtcBrowserTextEvidenceRuntime,
  type PtcBrowserTextEvidenceRuntimeResult,
} from './browser-text-evidence-runtime-contract.js';
import {
  createPtcBrowserUrlEvidenceRuntime,
  type PtcBrowserRuntimeOptions,
} from './browser-state-runtime.js';
import { createPtcLabBrowserTextEvidencePolicy } from '../../lab/browser/core/lab-browser-policy.js';
import { runPtcLabBrowserTextEvidence } from '../../lab/browser/text-evidence/lab-browser-text-evidence.js';
import { browserTextEvidenceFailure } from '../../lab/browser/text-evidence/lab-browser-text-evidence-contract.js';

export function createPtcBrowserTextEvidenceRuntime(
  options: PtcBrowserRuntimeOptions = {},
): PtcBrowserTextEvidenceRuntime {
  return createPtcBrowserUrlEvidenceRuntime({
    options,
    labPolicyId: PTC_BROWSER_TEXT_EVIDENCE_LAB_POLICY_ID,
    createBrowserPolicy: () =>
      createPtcLabBrowserTextEvidencePolicy({
        maxNavigationMs: PTC_BROWSER_TEXT_EVIDENCE_MAX_TIMEOUT_MS,
      }),
    stateRuntimeUnavailable: (
      diagnostics,
    ): Extract<PtcBrowserTextEvidenceRuntimeResult, { ok: false }> =>
      browserTextEvidenceFailure(
        'ptc_lab_browser_session_unavailable',
        'PTC browser text evidence state runtime is unavailable',
        'session_acquisition',
        { diagnostics },
      ),
    cleanupFailureReasonCode:
      'ptc_browser_text_evidence_session_cleanup_failed',
    cleanupFailureMessage: 'PTC browser text evidence session cleanup failed',
    admissionFailed: (admission) =>
      browserTextEvidenceFailure(
        'ptc_lab_browser_policy_disabled',
        admission.message,
        'policy_admission',
        {
          diagnostics: { admissionReasonCode: admission.reasonCode },
        },
      ),
    sessionWarmupFailed: (reasonCode) =>
      browserTextEvidenceFailure(
        'ptc_lab_browser_session_unavailable',
        'PTC browser text evidence session warm-up failed',
        'session_acquisition',
        { diagnostics: { sessionReasonCode: reasonCode } },
      ),
    runEvidence: runPtcLabBrowserTextEvidence,
  });
}
