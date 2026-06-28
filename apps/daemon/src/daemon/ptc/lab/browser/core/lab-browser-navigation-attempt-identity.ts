import { digestPtcStableJson } from '../../../shared/stable-identity.js';
import type { PtcSha256Digest } from '../../../shared/browser-evidence-contract.js';
import type { PtcLabBrowserPolicy } from './lab-browser-policy.js';
import type { PtcLabBrowserUserUrlTargetDigest } from './lab-browser-url-navigation.js';

type PtcLabBrowserNavigationAttemptPolicy = Extract<
  PtcLabBrowserPolicy,
  { mode: 'user_url_navigation' | 'page_load_evidence' | 'dom_text_evidence' }
>;

export type PtcLabBrowserNavigationAttemptDigest = PtcSha256Digest;

export interface PtcLabBrowserNavigationAttemptSharedDigestInput<
  BrowserPolicyId extends string =
    PtcLabBrowserNavigationAttemptPolicy['browserPolicyId'],
> {
  targetDigest: PtcLabBrowserUserUrlTargetDigest;
  effectiveTimeoutMs: number;
  timeoutPolicyId: PtcLabBrowserNavigationAttemptPolicy['timeoutPolicyId'];
  browserPolicyId: BrowserPolicyId;
  browserEnginePolicyId: PtcLabBrowserNavigationAttemptPolicy['browserEnginePolicyId'];
  browserHeadersPolicyId: PtcLabBrowserNavigationAttemptPolicy['browserHeadersPolicyId'];
  networkPolicyId: PtcLabBrowserNavigationAttemptPolicy['networkPolicyId'];
  redirectPolicyId: PtcLabBrowserNavigationAttemptPolicy['redirectPolicyId'];
  profilePolicyId: PtcLabBrowserNavigationAttemptPolicy['profilePolicyId'];
  cookieStorePolicyId: PtcLabBrowserNavigationAttemptPolicy['cookieStorePolicyId'];
  downloadPolicyId: PtcLabBrowserNavigationAttemptPolicy['downloadPolicyId'];
  artifactExportPolicyId: PtcLabBrowserNavigationAttemptPolicy['artifactExportPolicyId'];
  popupPolicyId: PtcLabBrowserNavigationAttemptPolicy['popupPolicyId'];
  permissionPolicyId: PtcLabBrowserNavigationAttemptPolicy['permissionPolicyId'];
  viewportPolicyId: PtcLabBrowserNavigationAttemptPolicy['viewportPolicyId'];
  localePolicyId: PtcLabBrowserNavigationAttemptPolicy['localePolicyId'];
  timezonePolicyId: PtcLabBrowserNavigationAttemptPolicy['timezonePolicyId'];
  loadWaitPolicyId: PtcLabBrowserNavigationAttemptPolicy['loadWaitPolicyId'];
}

export function buildPtcLabBrowserNavigationAttemptSharedDigestInput<
  Browser extends PtcLabBrowserNavigationAttemptPolicy,
>(args: {
  browser: Browser;
  effectiveTimeoutMs: number;
  targetDigest: PtcLabBrowserUserUrlTargetDigest;
}): PtcLabBrowserNavigationAttemptSharedDigestInput<
  Browser['browserPolicyId']
> {
  return {
    targetDigest: args.targetDigest,
    effectiveTimeoutMs: args.effectiveTimeoutMs,
    timeoutPolicyId: args.browser.timeoutPolicyId,
    browserPolicyId: args.browser.browserPolicyId,
    browserEnginePolicyId: args.browser.browserEnginePolicyId,
    browserHeadersPolicyId: args.browser.browserHeadersPolicyId,
    networkPolicyId: args.browser.networkPolicyId,
    redirectPolicyId: args.browser.redirectPolicyId,
    profilePolicyId: args.browser.profilePolicyId,
    cookieStorePolicyId: args.browser.cookieStorePolicyId,
    downloadPolicyId: args.browser.downloadPolicyId,
    artifactExportPolicyId: args.browser.artifactExportPolicyId,
    popupPolicyId: args.browser.popupPolicyId,
    permissionPolicyId: args.browser.permissionPolicyId,
    viewportPolicyId: args.browser.viewportPolicyId,
    localePolicyId: args.browser.localePolicyId,
    timezonePolicyId: args.browser.timezonePolicyId,
    loadWaitPolicyId: args.browser.loadWaitPolicyId,
  };
}

export function digestPtcLabBrowserNavigationAttempt(
  value: unknown,
): PtcLabBrowserNavigationAttemptDigest {
  return digestPtcStableJson(value);
}
