import type { PtcBrowserTextEvidenceRuntimeSummary } from '../daemon/ptc/runtime/browser/browser-text-evidence-runtime-contract.js';
import { PTC_LAB_BROWSER_TEXT_EVIDENCE_CAPABILITY } from '../daemon/ptc/lab/browser/text-evidence/lab-browser-text-evidence-contract.js';
import { createPtcLabBrowserTextEvidencePolicy } from '../daemon/ptc/lab/browser/core/lab-browser-policy.js';
import { buildPtcLabBrowserTextEvidenceSummaryPolicyFields } from '../daemon/ptc/lab/browser/core/lab-browser-policy-fields.js';

export function browserTextEvidenceSummary(
  visibleText = 'Visible page text',
): PtcBrowserTextEvidenceRuntimeSummary {
  const targetDigest =
    `sha256:${'a'.repeat(64)}` as PtcBrowserTextEvidenceRuntimeSummary['targetDigest'];
  const browser = createTextEvidenceBrowserPolicy();
  return {
    kind: 'ptc_lab_browser_text_evidence_result',
    ok: true,
    profile: 'lab',
    capability: PTC_LAB_BROWSER_TEXT_EVIDENCE_CAPABILITY,
    targetDigest,
    textEvidenceAttemptDigest:
      `sha256:${'b'.repeat(64)}` as PtcBrowserTextEvidenceRuntimeSummary['textEvidenceAttemptDigest'],
    textEvidenceDigest:
      `sha256:${'c'.repeat(64)}` as PtcBrowserTextEvidenceRuntimeSummary['textEvidenceDigest'],
    sessionLifecycle: {
      mode: 'runtime_owned',
      retainedAfterExecution: true,
      taintedAfterExecution: false,
    },
    ...buildPtcLabBrowserTextEvidenceSummaryPolicyFields(browser),
    requestedUrl: {
      digest: targetDigest,
      echoPolicyId: browser.requestedUrlEchoPolicyId,
      redacted: true,
    },
    finalUrl: {
      digest:
        `sha256:${'e'.repeat(64)}` as PtcBrowserTextEvidenceRuntimeSummary['finalUrl']['digest'],
      digestPolicyId: browser.finalUrlDigestPolicyId,
      echoPolicyId: browser.finalUrlEchoPolicyId,
      redacted: true,
    },
    loadOutcome: 'loaded',
    loadState: 'domcontentloaded',
    visibleText,
    redirects: {
      policyId: browser.redirectCountPolicyId,
      count: 1,
    },
    timing: {
      policyId: browser.timingPolicyId,
      ownerDurationMs: 12,
      navigationDurationMs: 7,
    },
    evidenceAvailability: {
      visibleText: 'available',
      finalUrl: 'available',
      navigationTiming: 'available',
    },
    checks: {
      targetVerified: true,
      engineAvailable: true,
      contextCreated: true,
      navigationStarted: true,
      navigationSettled: true,
      redirectPolicyEnforced: true,
      downloadPolicyEnforced: true,
      popupPolicyEnforced: true,
      evidenceCaptured: true,
      cleanupCompleted: true,
    },
  };
}

function createTextEvidenceBrowserPolicy() {
  const browser = createPtcLabBrowserTextEvidencePolicy({
    maxNavigationMs: 15_000,
  });
  if (browser.mode !== 'dom_text_evidence') {
    throw new Error('expected dom text evidence browser policy');
  }
  return browser;
}
