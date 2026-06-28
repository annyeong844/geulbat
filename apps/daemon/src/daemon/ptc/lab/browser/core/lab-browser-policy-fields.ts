import type { PtcLabBrowserPolicy } from './lab-browser-policy.js';
import type {
  PtcLabBrowserPageLoadEvidenceSummaryPolicyFields,
  PtcLabBrowserTextEvidenceSummaryPolicyFields,
} from '../../../shared/browser-evidence-contract.js';
import type { PtcLabBrowserUserUrlNavigationSummaryPolicyFields } from '../../../shared/browser-navigation-contract.js';

type PtcLabBrowserPolicyByMode<Mode extends PtcLabBrowserPolicy['mode']> =
  Extract<PtcLabBrowserPolicy, { mode: Mode }>;

type PtcLabBrowserPageLoadEvidencePolicy =
  PtcLabBrowserPolicyByMode<'page_load_evidence'>;
type PtcLabBrowserTextEvidencePolicy =
  PtcLabBrowserPolicyByMode<'dom_text_evidence'>;
type PtcLabBrowserUserUrlNavigationPolicy =
  PtcLabBrowserPolicyByMode<'user_url_navigation'>;
type PtcLabBrowserEvidencePolicy =
  | PtcLabBrowserPageLoadEvidencePolicy
  | PtcLabBrowserTextEvidencePolicy;

function buildPtcLabBrowserEvidenceExecutionPolicyFields<
  Browser extends PtcLabBrowserEvidencePolicy,
  BudgetFields extends object,
  CapabilityFields extends object,
>(
  browser: Browser,
  budgetFields: BudgetFields,
  capabilityFields: CapabilityFields,
) {
  return {
    policyFingerprint: browser.policyFingerprint,
    maxNavigationMs: browser.maxNavigationMs,
    ...budgetFields,
    maxTabs: browser.maxTabs,
    evidencePolicyId: browser.evidencePolicyId,
    ...capabilityFields,
    requestedUrlEchoPolicyId: browser.requestedUrlEchoPolicyId,
    finalUrlEchoPolicyId: browser.finalUrlEchoPolicyId,
    finalUrlDigestPolicyId: browser.finalUrlDigestPolicyId,
    redirectCountPolicyId: browser.redirectCountPolicyId,
    timingPolicyId: browser.timingPolicyId,
  };
}

export function buildPtcLabBrowserPageLoadEvidenceExecutionPolicyFields(
  browser: PtcLabBrowserPageLoadEvidencePolicy,
) {
  return buildPtcLabBrowserEvidenceExecutionPolicyFields(
    browser,
    {},
    {
      pageLoadEvidenceDigestPolicyId: browser.pageLoadEvidenceDigestPolicyId,
      responseStatusPolicyId: browser.responseStatusPolicyId,
    },
  );
}

export function buildPtcLabBrowserTextEvidenceExecutionPolicyFields(
  browser: PtcLabBrowserTextEvidencePolicy,
) {
  return buildPtcLabBrowserEvidenceExecutionPolicyFields(
    browser,
    {},
    {
      textEvidenceDigestPolicyId: browser.textEvidenceDigestPolicyId,
    },
  );
}

function buildPtcLabBrowserEvidenceSummaryPolicyFields<
  Browser extends PtcLabBrowserEvidencePolicy,
  BudgetFields extends object,
  CapabilityFields extends object,
>(
  browser: Browser,
  budgetFields: BudgetFields,
  capabilityFields: CapabilityFields,
): BudgetFields &
  CapabilityFields & {
    policyFingerprint: Browser['policyFingerprint'];
    maxNavigationMs: Browser['maxNavigationMs'];
    maxTabs: Browser['maxTabs'];
    browserPolicyId: Browser['browserPolicyId'];
    browserMode: Browser['mode'];
    browserEnginePolicyId: Browser['browserEnginePolicyId'];
    browserNetworkPolicyId: Browser['networkPolicyId'];
    browserUrlGrammarPolicyId: Browser['urlGrammarPolicyId'];
    browserRedirectPolicyId: Browser['redirectPolicyId'];
    browserEvidencePolicyId: Browser['evidencePolicyId'];
    requestedUrlEchoPolicyId: Browser['requestedUrlEchoPolicyId'];
    finalUrlEchoPolicyId: Browser['finalUrlEchoPolicyId'];
    finalUrlDigestPolicyId: Browser['finalUrlDigestPolicyId'];
    redirectCountPolicyId: Browser['redirectCountPolicyId'];
    timingPolicyId: Browser['timingPolicyId'];
    artifactExported: false;
  } {
  return {
    policyFingerprint: browser.policyFingerprint,
    maxNavigationMs: browser.maxNavigationMs,
    ...budgetFields,
    maxTabs: browser.maxTabs,
    browserPolicyId: browser.browserPolicyId,
    browserMode: browser.mode,
    browserEnginePolicyId: browser.browserEnginePolicyId,
    browserNetworkPolicyId: browser.networkPolicyId,
    browserUrlGrammarPolicyId: browser.urlGrammarPolicyId,
    browserRedirectPolicyId: browser.redirectPolicyId,
    browserEvidencePolicyId: browser.evidencePolicyId,
    ...capabilityFields,
    requestedUrlEchoPolicyId: browser.requestedUrlEchoPolicyId,
    finalUrlEchoPolicyId: browser.finalUrlEchoPolicyId,
    finalUrlDigestPolicyId: browser.finalUrlDigestPolicyId,
    redirectCountPolicyId: browser.redirectCountPolicyId,
    timingPolicyId: browser.timingPolicyId,
    artifactExported: false as const,
  };
}

export function buildPtcLabBrowserUserUrlNavigationSummaryPolicyFields(
  browser: PtcLabBrowserUserUrlNavigationPolicy,
): PtcLabBrowserUserUrlNavigationSummaryPolicyFields {
  return {
    browserPolicyId: browser.browserPolicyId,
    browserMode: browser.mode,
    browserEnginePolicyId: browser.browserEnginePolicyId,
    browserNetworkPolicyId: browser.networkPolicyId,
    browserUrlGrammarPolicyId: browser.urlGrammarPolicyId,
    browserRedirectPolicyId: browser.redirectPolicyId,
    browserEvidencePolicyId: browser.evidencePolicyId,
    browserUrlEchoPolicyId: browser.urlEchoPolicyId,
    browserPopupPolicyId: browser.popupPolicyId,
    browserPermissionPolicyId: browser.permissionPolicyId,
    browserProfilePolicyId: browser.profilePolicyId,
    browserCookieStorePolicyId: browser.cookieStorePolicyId,
    browserDownloadPolicyId: browser.downloadPolicyId,
    browserArtifactExportPolicyId: browser.artifactExportPolicyId,
    artifactExported: false,
  };
}

export function buildPtcLabBrowserPageLoadEvidenceSummaryPolicyFields(
  browser: PtcLabBrowserPageLoadEvidencePolicy,
): PtcLabBrowserPageLoadEvidenceSummaryPolicyFields {
  return buildPtcLabBrowserEvidenceSummaryPolicyFields(
    browser,
    {},
    {
      pageLoadEvidenceDigestPolicyId: browser.pageLoadEvidenceDigestPolicyId,
      responseStatusPolicyId: browser.responseStatusPolicyId,
    },
  );
}

export function buildPtcLabBrowserTextEvidenceSummaryPolicyFields(
  browser: PtcLabBrowserTextEvidencePolicy,
): PtcLabBrowserTextEvidenceSummaryPolicyFields {
  return buildPtcLabBrowserEvidenceSummaryPolicyFields(
    browser,
    {},
    {
      textEvidenceDigestPolicyId: browser.textEvidenceDigestPolicyId,
    },
  );
}
