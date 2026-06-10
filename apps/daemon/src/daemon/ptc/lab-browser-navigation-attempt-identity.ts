import { sha256StableJson } from '@geulbat/shared-utils/stable-json';
import {
  PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID,
  PTC_LAB_BROWSER_DOWNLOADS_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_HEADERS_RUNTIME_DEFAULT_POLICY_ID,
  PTC_LAB_BROWSER_LOAD_WAIT_DOMCONTENTLOADED_POLICY_ID,
  PTC_LAB_BROWSER_LOCALE_SANDBOX_DEFAULT_POLICY_ID,
  PTC_LAB_BROWSER_PERMISSIONS_DENIED_POLICY_ID,
  PTC_LAB_BROWSER_POPUPS_DISABLED_POLICY_ID,
  PTC_LAB_BROWSER_PROFILE_FRESH_PER_ATTEMPT_POLICY_ID,
  PTC_LAB_BROWSER_REDIRECT_REVALIDATED_POLICY_ID,
  PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID,
  PTC_LAB_BROWSER_TIMEZONE_SANDBOX_DEFAULT_POLICY_ID,
  PTC_LAB_BROWSER_TIMEOUT_BOUNDED_POLICY_ID,
  PTC_LAB_BROWSER_VIEWPORT_DEFAULT_POLICY_ID,
  type PtcLabBrowserPolicy,
} from './lab-browser-policy.js';
import { PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID } from './lab-network-policy.js';
import type { PtcLabBrowserUserUrlTargetDigest } from './lab-browser-url-navigation.js';

type PtcLabBrowserNavigationAttemptPolicy = Extract<
  PtcLabBrowserPolicy,
  { mode: 'user_url_navigation' | 'page_load_evidence' }
>;

export type PtcLabBrowserNavigationAttemptDigest = `sha256:${string}`;

export interface PtcLabBrowserNavigationAttemptSharedDigestInput<
  BrowserPolicyId extends string =
    PtcLabBrowserNavigationAttemptPolicy['browserPolicyId'],
> {
  targetDigest: PtcLabBrowserUserUrlTargetDigest;
  effectiveTimeoutMs: number;
  timeoutPolicyId: typeof PTC_LAB_BROWSER_TIMEOUT_BOUNDED_POLICY_ID;
  browserPolicyId: BrowserPolicyId;
  browserEnginePolicyId: typeof PTC_LAB_BROWSER_RUNTIME_ENGINE_CHROMIUM_POLICY_ID;
  browserHeadersPolicyId: typeof PTC_LAB_BROWSER_HEADERS_RUNTIME_DEFAULT_POLICY_ID;
  networkPolicyId: typeof PTC_LAB_OPEN_EGRESS_LOCAL_POLICY_ID;
  redirectPolicyId: typeof PTC_LAB_BROWSER_REDIRECT_REVALIDATED_POLICY_ID;
  profilePolicyId: typeof PTC_LAB_BROWSER_PROFILE_FRESH_PER_ATTEMPT_POLICY_ID;
  cookieStorePolicyId: typeof PTC_LAB_BROWSER_COOKIE_STORE_NONE_POLICY_ID;
  downloadPolicyId: typeof PTC_LAB_BROWSER_DOWNLOADS_DISABLED_POLICY_ID;
  artifactExportPolicyId: typeof PTC_LAB_BROWSER_ARTIFACT_EXPORT_DISABLED_POLICY_ID;
  popupPolicyId: typeof PTC_LAB_BROWSER_POPUPS_DISABLED_POLICY_ID;
  permissionPolicyId: typeof PTC_LAB_BROWSER_PERMISSIONS_DENIED_POLICY_ID;
  viewportPolicyId: typeof PTC_LAB_BROWSER_VIEWPORT_DEFAULT_POLICY_ID;
  localePolicyId: typeof PTC_LAB_BROWSER_LOCALE_SANDBOX_DEFAULT_POLICY_ID;
  timezonePolicyId: typeof PTC_LAB_BROWSER_TIMEZONE_SANDBOX_DEFAULT_POLICY_ID;
  loadWaitPolicyId: typeof PTC_LAB_BROWSER_LOAD_WAIT_DOMCONTENTLOADED_POLICY_ID;
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
  const digest = sha256StableJson(value);
  return `sha256:${digest}`;
}
