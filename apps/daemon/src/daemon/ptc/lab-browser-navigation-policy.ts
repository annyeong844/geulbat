import {
  hasOnlyPtcLabBrowserRequestKeys,
  isPtcLabBrowserSafeProbeId,
  ptcLabBrowserRequestInvalid,
  validatePtcLabBrowserSessionPolicy,
  type PtcLabBrowserPolicy,
} from './lab-browser-policy.js';
import type { PtcLabAdmittedProfile } from './lab-profile.js';
import type { PtcSessionDockerHandle } from './session-docker-contract.js';
import {
  PTC_LAB_BROWSER_FIXED_NAVIGATION_TARGET_REF,
  type PtcLabBrowserFixedNavigationProbeRequest,
  type PtcLabBrowserNavigationResult,
  browserNavigationFailure,
} from './lab-browser-navigation-contract.js';

export interface PtcLabBrowserNavigationPolicy {
  policyId: string;
  browser: Extract<PtcLabBrowserPolicy, { mode: 'fixed_navigation_probe' }>;
  network: Extract<
    NonNullable<PtcLabAdmittedProfile['labPolicy']>['network'],
    { mode: 'open' }
  >;
}

export interface PtcLabBrowserValidatedNavigationRequest {
  probeId: string;
  targetRef: typeof PTC_LAB_BROWSER_FIXED_NAVIGATION_TARGET_REF;
  timeoutMs: number;
}

const PTC_LAB_BROWSER_NAVIGATION_DEFAULT_TIMEOUT_MS = 5_000;
const PTC_LAB_BROWSER_NAVIGATION_REQUEST_KEYS = new Set([
  'probeId',
  'targetRef',
  'timeoutMs',
]);

export function readBrowserNavigationPolicy(
  admission: PtcLabAdmittedProfile | undefined,
): PtcLabBrowserNavigationResult<PtcLabBrowserNavigationPolicy> {
  if (
    admission === undefined ||
    admission.metadata.selectedProfile !== 'lab' ||
    admission.labPolicy === undefined
  ) {
    return browserNavigationFailure(
      'ptc_lab_browser_admission_required',
      'PTC lab browser navigation probe requires an admitted lab profile',
    );
  }
  if (
    !admission.labPolicy.browser.enabled ||
    admission.labPolicy.browser.mode !== 'fixed_navigation_probe' ||
    admission.labPolicy.network.mode !== 'open'
  ) {
    return browserNavigationFailure(
      'ptc_lab_browser_policy_disabled',
      'PTC lab browser navigation probe policy is disabled',
    );
  }
  if (
    admission.labPolicy.browser.networkPolicyId !==
      admission.labPolicy.network.networkPolicyId ||
    admission.labPolicy.network.metricsCoverage === 'runtime_observed'
  ) {
    return browserNavigationFailure(
      'ptc_lab_browser_policy_disabled',
      'PTC lab browser navigation probe policy is not compatible with admitted network policy',
    );
  }

  return {
    ok: true,
    value: {
      policyId: admission.labPolicy.policyId,
      browser: admission.labPolicy.browser,
      network: admission.labPolicy.network,
    },
  };
}

export function validateBrowserNavigationRequest(args: {
  request: PtcLabBrowserFixedNavigationProbeRequest;
  maxTimeoutMs: number;
}): PtcLabBrowserNavigationResult<PtcLabBrowserValidatedNavigationRequest> {
  if (
    !hasOnlyPtcLabBrowserRequestKeys(
      args.request,
      PTC_LAB_BROWSER_NAVIGATION_REQUEST_KEYS,
    ) ||
    !isPtcLabBrowserSafeProbeId(args.request.probeId) ||
    args.request.targetRef !== PTC_LAB_BROWSER_FIXED_NAVIGATION_TARGET_REF
  ) {
    return ptcLabBrowserRequestInvalid('navigation probe');
  }
  const timeoutMs =
    args.request.timeoutMs ?? PTC_LAB_BROWSER_NAVIGATION_DEFAULT_TIMEOUT_MS;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > args.maxTimeoutMs
  ) {
    return ptcLabBrowserRequestInvalid('navigation probe');
  }

  return {
    ok: true,
    value: {
      probeId: args.request.probeId,
      targetRef: args.request.targetRef,
      timeoutMs,
    },
  };
}

export function validateBrowserNavigationSession(args: {
  handle: PtcSessionDockerHandle;
  policyId: string;
  browser: Extract<PtcLabBrowserPolicy, { mode: 'fixed_navigation_probe' }>;
  network: PtcLabBrowserNavigationPolicy['network'];
}): PtcLabBrowserNavigationResult<void> {
  const sessionPolicy = validatePtcLabBrowserSessionPolicy({
    ...args,
    capabilityLabel: 'navigation',
  });
  if (!sessionPolicy.ok) {
    return browserNavigationFailure(
      sessionPolicy.reasonCode,
      sessionPolicy.message,
    );
  }
  return sessionPolicy;
}
