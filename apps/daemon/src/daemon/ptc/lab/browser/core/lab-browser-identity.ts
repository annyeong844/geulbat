import { hashPtcStableJson } from '../../../shared/stable-identity.js';
import {
  doesPtcLabOpenNetworkSessionMatchPolicy,
  type PtcLabNetworkIdentitySnapshot,
  type PtcLabNetworkPolicy,
} from '../../network/lab-network-policy.js';
import type { PtcLabBrowserPolicy } from './lab-browser-policy.js';

type PtcLabBrowserPolicyByMode<Mode extends PtcLabBrowserPolicy['mode']> =
  Extract<PtcLabBrowserPolicy, { mode: Mode }>;

type PtcLabBrowserIdentityBase<Mode extends PtcLabBrowserPolicy['mode']> = Omit<
  PtcLabBrowserPolicyByMode<Mode>,
  'policyVersion' | 'telemetryPolicyId'
> & {
  browserTelemetryPolicyId: PtcLabBrowserPolicyByMode<Mode>['telemetryPolicyId'];
};

export type PtcLabBrowserIdentitySnapshot =
  | PtcLabBrowserIdentityBase<'disabled'>
  | PtcLabBrowserIdentityBase<'user_url_navigation'>
  | PtcLabBrowserIdentityBase<'page_load_evidence'>
  | PtcLabBrowserIdentityBase<'dom_text_evidence'>;

type PtcLabBrowserIdentityByMode<
  Mode extends PtcLabBrowserIdentitySnapshot['mode'],
> = Extract<PtcLabBrowserIdentitySnapshot, { mode: Mode }>;

type PtcLabBrowserIdentityLabelField<Identity extends object> = readonly [
  {
    [Key in Extract<keyof Identity, string>]: Identity[Key] extends
      | string
      | number
      | bigint
      | boolean
      ? Key
      : never;
  }[Extract<keyof Identity, string>],
  string,
];

interface PtcLabBrowserSessionIdentitySource {
  reuseKey: {
    labPolicyId: string;
    network: PtcLabNetworkIdentitySnapshot;
    browser: PtcLabBrowserIdentitySnapshot;
  };
}

const PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_AFTER_ENGINE_LABEL_FIELDS = [
  ['policyFingerprint', 'browserPolicyFingerprint'],
] as const satisfies readonly PtcLabBrowserIdentityLabelField<
  PtcLabBrowserIdentityByMode<'page_load_evidence'>
>[];

const PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_AFTER_REDIRECT_LABEL_FIELDS = [
  ['maxNavigationMs', 'browserMaxNavigationMs'],
] as const satisfies readonly PtcLabBrowserIdentityLabelField<
  PtcLabBrowserIdentityByMode<'page_load_evidence'>
>[];

const PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_AFTER_EVIDENCE_LABEL_FIELDS = [
  ['pageLoadEvidenceDigestPolicyId', 'browserPageLoadEvidenceDigestPolicyId'],
  ['requestedUrlEchoPolicyId', 'browserRequestedUrlEchoPolicyId'],
  ['finalUrlEchoPolicyId', 'browserFinalUrlEchoPolicyId'],
  ['finalUrlDigestPolicyId', 'browserFinalUrlDigestPolicyId'],
  ['responseStatusPolicyId', 'browserResponseStatusPolicyId'],
  ['redirectCountPolicyId', 'browserRedirectCountPolicyId'],
  ['timingPolicyId', 'browserTimingPolicyId'],
] as const satisfies readonly PtcLabBrowserIdentityLabelField<
  PtcLabBrowserIdentityByMode<'page_load_evidence'>
>[];

const PTC_LAB_BROWSER_TEXT_EVIDENCE_AFTER_ENGINE_LABEL_FIELDS = [
  ['policyFingerprint', 'browserPolicyFingerprint'],
] as const satisfies readonly PtcLabBrowserIdentityLabelField<
  PtcLabBrowserIdentityByMode<'dom_text_evidence'>
>[];

const PTC_LAB_BROWSER_TEXT_EVIDENCE_AFTER_REDIRECT_LABEL_FIELDS = [
  ['maxNavigationMs', 'browserMaxNavigationMs'],
] as const satisfies readonly PtcLabBrowserIdentityLabelField<
  PtcLabBrowserIdentityByMode<'dom_text_evidence'>
>[];

const PTC_LAB_BROWSER_TEXT_EVIDENCE_AFTER_EVIDENCE_LABEL_FIELDS = [
  ['textEvidenceDigestPolicyId', 'browserTextEvidenceDigestPolicyId'],
  ['requestedUrlEchoPolicyId', 'browserRequestedUrlEchoPolicyId'],
  ['finalUrlEchoPolicyId', 'browserFinalUrlEchoPolicyId'],
  ['finalUrlDigestPolicyId', 'browserFinalUrlDigestPolicyId'],
  ['redirectCountPolicyId', 'browserRedirectCountPolicyId'],
  ['timingPolicyId', 'browserTimingPolicyId'],
] as const satisfies readonly PtcLabBrowserIdentityLabelField<
  PtcLabBrowserIdentityByMode<'dom_text_evidence'>
>[];

export function toPtcLabBrowserIdentitySnapshot(
  policy: PtcLabBrowserPolicy,
): PtcLabBrowserIdentitySnapshot {
  if (!policy.enabled) {
    return {
      enabled: false,
      mode: policy.mode,
      browserPolicyId: policy.browserPolicyId,
      profilePolicyId: policy.profilePolicyId,
      cookieStorePolicyId: policy.cookieStorePolicyId,
      artifactExportPolicyId: policy.artifactExportPolicyId,
      browserTelemetryPolicyId: policy.telemetryPolicyId,
    } satisfies Extract<PtcLabBrowserIdentitySnapshot, { mode: 'disabled' }>;
  }

  if (policy.mode === 'user_url_navigation') {
    return {
      enabled: true,
      mode: 'user_url_navigation',
      browserPolicyId: policy.browserPolicyId,
      browserEnginePolicyId: policy.browserEnginePolicyId,
      networkPolicyId: policy.networkPolicyId,
      urlGrammarPolicyId: policy.urlGrammarPolicyId,
      callerHeadersPolicyId: policy.callerHeadersPolicyId,
      browserHeadersPolicyId: policy.browserHeadersPolicyId,
      bodyPolicyId: policy.bodyPolicyId,
      redirectPolicyId: policy.redirectPolicyId,
      maxTabs: policy.maxTabs,
      maxActionMs: policy.maxActionMs,
      profilePolicyId: policy.profilePolicyId,
      cookieStorePolicyId: policy.cookieStorePolicyId,
      downloadPolicyId: policy.downloadPolicyId,
      artifactExportPolicyId: policy.artifactExportPolicyId,
      browserTelemetryPolicyId: policy.telemetryPolicyId,
      evidencePolicyId: policy.evidencePolicyId,
      urlEchoPolicyId: policy.urlEchoPolicyId,
      popupPolicyId: policy.popupPolicyId,
      permissionPolicyId: policy.permissionPolicyId,
      timeoutPolicyId: policy.timeoutPolicyId,
      loadWaitPolicyId: policy.loadWaitPolicyId,
      viewportPolicyId: policy.viewportPolicyId,
      localePolicyId: policy.localePolicyId,
      timezonePolicyId: policy.timezonePolicyId,
    } satisfies Extract<
      PtcLabBrowserIdentitySnapshot,
      { mode: 'user_url_navigation' }
    >;
  }

  if (policy.mode === 'page_load_evidence') {
    return {
      enabled: true,
      mode: 'page_load_evidence',
      browserPolicyId: policy.browserPolicyId,
      policyFingerprint: policy.policyFingerprint,
      browserEnginePolicyId: policy.browserEnginePolicyId,
      networkPolicyId: policy.networkPolicyId,
      urlGrammarPolicyId: policy.urlGrammarPolicyId,
      callerHeadersPolicyId: policy.callerHeadersPolicyId,
      browserHeadersPolicyId: policy.browserHeadersPolicyId,
      bodyPolicyId: policy.bodyPolicyId,
      redirectPolicyId: policy.redirectPolicyId,
      maxTabs: policy.maxTabs,
      maxNavigationMs: policy.maxNavigationMs,
      profilePolicyId: policy.profilePolicyId,
      cookieStorePolicyId: policy.cookieStorePolicyId,
      downloadPolicyId: policy.downloadPolicyId,
      artifactExportPolicyId: policy.artifactExportPolicyId,
      browserTelemetryPolicyId: policy.telemetryPolicyId,
      evidencePolicyId: policy.evidencePolicyId,
      pageLoadEvidenceDigestPolicyId: policy.pageLoadEvidenceDigestPolicyId,
      requestedUrlEchoPolicyId: policy.requestedUrlEchoPolicyId,
      finalUrlEchoPolicyId: policy.finalUrlEchoPolicyId,
      finalUrlDigestPolicyId: policy.finalUrlDigestPolicyId,
      responseStatusPolicyId: policy.responseStatusPolicyId,
      redirectCountPolicyId: policy.redirectCountPolicyId,
      timingPolicyId: policy.timingPolicyId,
      popupPolicyId: policy.popupPolicyId,
      permissionPolicyId: policy.permissionPolicyId,
      timeoutPolicyId: policy.timeoutPolicyId,
      loadWaitPolicyId: policy.loadWaitPolicyId,
      viewportPolicyId: policy.viewportPolicyId,
      localePolicyId: policy.localePolicyId,
      timezonePolicyId: policy.timezonePolicyId,
    } satisfies Extract<
      PtcLabBrowserIdentitySnapshot,
      { mode: 'page_load_evidence' }
    >;
  }

  if (policy.mode === 'dom_text_evidence') {
    return {
      enabled: true,
      mode: 'dom_text_evidence',
      browserPolicyId: policy.browserPolicyId,
      policyFingerprint: policy.policyFingerprint,
      browserEnginePolicyId: policy.browserEnginePolicyId,
      networkPolicyId: policy.networkPolicyId,
      urlGrammarPolicyId: policy.urlGrammarPolicyId,
      callerHeadersPolicyId: policy.callerHeadersPolicyId,
      browserHeadersPolicyId: policy.browserHeadersPolicyId,
      bodyPolicyId: policy.bodyPolicyId,
      redirectPolicyId: policy.redirectPolicyId,
      maxTabs: policy.maxTabs,
      maxNavigationMs: policy.maxNavigationMs,
      profilePolicyId: policy.profilePolicyId,
      cookieStorePolicyId: policy.cookieStorePolicyId,
      downloadPolicyId: policy.downloadPolicyId,
      artifactExportPolicyId: policy.artifactExportPolicyId,
      browserTelemetryPolicyId: policy.telemetryPolicyId,
      evidencePolicyId: policy.evidencePolicyId,
      textEvidenceDigestPolicyId: policy.textEvidenceDigestPolicyId,
      requestedUrlEchoPolicyId: policy.requestedUrlEchoPolicyId,
      finalUrlEchoPolicyId: policy.finalUrlEchoPolicyId,
      finalUrlDigestPolicyId: policy.finalUrlDigestPolicyId,
      redirectCountPolicyId: policy.redirectCountPolicyId,
      timingPolicyId: policy.timingPolicyId,
      popupPolicyId: policy.popupPolicyId,
      permissionPolicyId: policy.permissionPolicyId,
      timeoutPolicyId: policy.timeoutPolicyId,
      loadWaitPolicyId: policy.loadWaitPolicyId,
      viewportPolicyId: policy.viewportPolicyId,
      localePolicyId: policy.localePolicyId,
      timezonePolicyId: policy.timezonePolicyId,
    } satisfies Extract<
      PtcLabBrowserIdentitySnapshot,
      { mode: 'dom_text_evidence' }
    >;
  }

  const unreachablePolicy: never = policy;
  return unreachablePolicy;
}

function doesPtcLabBrowserSessionMatchPolicy(args: {
  handle: PtcLabBrowserSessionIdentitySource;
  policyId: string;
  browser: PtcLabBrowserPolicy;
  network: Extract<PtcLabNetworkPolicy, { mode: 'open' }>;
}): boolean {
  const reuseKey = args.handle.reuseKey;
  return (
    doesPtcLabOpenNetworkSessionMatchPolicy({
      handle: args.handle,
      policyId: args.policyId,
      network: args.network,
    }) &&
    hashPtcStableJson(reuseKey.browser) ===
      hashPtcStableJson(toPtcLabBrowserIdentitySnapshot(args.browser))
  );
}

type PtcLabBrowserSessionPolicyCapabilityLabel =
  | 'owner'
  | 'runtime'
  | 'navigation'
  | 'user URL navigation'
  | 'page-load evidence'
  | 'text evidence';

interface PtcLabBrowserSessionPolicyMismatch {
  ok: false;
  reasonCode: 'ptc_lab_browser_policy_mismatch';
  message: string;
}

export function validatePtcLabBrowserSessionPolicy(args: {
  handle: PtcLabBrowserSessionIdentitySource;
  policyId: string;
  browser: PtcLabBrowserPolicy;
  network: Extract<PtcLabNetworkPolicy, { mode: 'open' }>;
  capabilityLabel: PtcLabBrowserSessionPolicyCapabilityLabel;
}): { ok: true; value: undefined } | PtcLabBrowserSessionPolicyMismatch {
  if (!doesPtcLabBrowserSessionMatchPolicy(args)) {
    return {
      ok: false,
      reasonCode: 'ptc_lab_browser_policy_mismatch',
      message: `PTC lab browser ${args.capabilityLabel} session does not match admitted policy`,
    };
  }
  return { ok: true, value: undefined };
}

export function buildPtcLabBrowserIdentityLabels(
  identity: PtcLabBrowserIdentitySnapshot,
): string[] {
  const labels = [
    `geulbat.browserEnabled=${identity.enabled}`,
    `geulbat.browserMode=${identity.mode}`,
    `geulbat.browserPolicyId=${identity.browserPolicyId}`,
    `geulbat.browserProfilePolicyId=${identity.profilePolicyId}`,
    `geulbat.browserCookieStorePolicyId=${identity.cookieStorePolicyId}`,
    `geulbat.browserArtifactExportPolicyId=${identity.artifactExportPolicyId}`,
    `geulbat.browserTelemetryPolicyId=${identity.browserTelemetryPolicyId}`,
  ];

  if (!identity.enabled) {
    return labels;
  }

  return [
    ...labels,
    `geulbat.browserNetworkPolicyId=${identity.networkPolicyId}`,
    `geulbat.browserMaxTabs=${identity.maxTabs}`,
    ...(identity.mode === 'user_url_navigation'
      ? buildPtcLabBrowserNavigationIdentityLabels({
          identity,
          afterEvidenceLabels: [
            `geulbat.browserUrlEchoPolicyId=${identity.urlEchoPolicyId}`,
          ],
        })
      : []),
    ...(identity.mode === 'page_load_evidence'
      ? buildPtcLabBrowserNavigationIdentityLabels({
          identity,
          afterEngineLabels: buildPtcLabBrowserIdentityFieldLabels(
            identity,
            PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_AFTER_ENGINE_LABEL_FIELDS,
          ),
          afterRedirectLabels: buildPtcLabBrowserIdentityFieldLabels(
            identity,
            PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_AFTER_REDIRECT_LABEL_FIELDS,
          ),
          afterEvidenceLabels: buildPtcLabBrowserIdentityFieldLabels(
            identity,
            PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_AFTER_EVIDENCE_LABEL_FIELDS,
          ),
        })
      : []),
    ...(identity.mode === 'dom_text_evidence'
      ? buildPtcLabBrowserNavigationIdentityLabels({
          identity,
          afterEngineLabels: buildPtcLabBrowserIdentityFieldLabels(
            identity,
            PTC_LAB_BROWSER_TEXT_EVIDENCE_AFTER_ENGINE_LABEL_FIELDS,
          ),
          afterRedirectLabels: buildPtcLabBrowserIdentityFieldLabels(
            identity,
            PTC_LAB_BROWSER_TEXT_EVIDENCE_AFTER_REDIRECT_LABEL_FIELDS,
          ),
          afterEvidenceLabels: buildPtcLabBrowserIdentityFieldLabels(
            identity,
            PTC_LAB_BROWSER_TEXT_EVIDENCE_AFTER_EVIDENCE_LABEL_FIELDS,
          ),
        })
      : []),
  ];
}

function buildPtcLabBrowserNavigationIdentityLabels(args: {
  identity: Extract<
    PtcLabBrowserIdentitySnapshot,
    { mode: 'user_url_navigation' | 'page_load_evidence' | 'dom_text_evidence' }
  >;
  afterEngineLabels?: string[];
  afterRedirectLabels?: string[];
  afterEvidenceLabels?: string[];
}): string[] {
  return [
    `geulbat.browserEnginePolicyId=${args.identity.browserEnginePolicyId}`,
    ...(args.afterEngineLabels ?? []),
    `geulbat.browserUrlGrammarPolicyId=${args.identity.urlGrammarPolicyId}`,
    `geulbat.browserCallerHeadersPolicyId=${args.identity.callerHeadersPolicyId}`,
    `geulbat.browserHeadersPolicyId=${args.identity.browserHeadersPolicyId}`,
    `geulbat.browserBodyPolicyId=${args.identity.bodyPolicyId}`,
    `geulbat.browserRedirectPolicyId=${args.identity.redirectPolicyId}`,
    ...(args.afterRedirectLabels ?? []),
    `geulbat.browserDownloadPolicyId=${args.identity.downloadPolicyId}`,
    `geulbat.browserEvidencePolicyId=${args.identity.evidencePolicyId}`,
    ...(args.afterEvidenceLabels ?? []),
    `geulbat.browserPopupPolicyId=${args.identity.popupPolicyId}`,
    `geulbat.browserPermissionPolicyId=${args.identity.permissionPolicyId}`,
    `geulbat.browserTimeoutPolicyId=${args.identity.timeoutPolicyId}`,
    `geulbat.browserLoadWaitPolicyId=${args.identity.loadWaitPolicyId}`,
    `geulbat.browserViewportPolicyId=${args.identity.viewportPolicyId}`,
    `geulbat.browserLocalePolicyId=${args.identity.localePolicyId}`,
    `geulbat.browserTimezonePolicyId=${args.identity.timezonePolicyId}`,
  ];
}

function buildPtcLabBrowserIdentityFieldLabels<Source extends object>(
  identity: Source,
  fields: readonly PtcLabBrowserIdentityLabelField<Source>[],
): string[] {
  return fields.map(
    ([key, labelName]) => `geulbat.${labelName}=${String(identity[key])}`,
  );
}
