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
  type PtcLabBrowserOwnerPreflightRequest,
  type PtcLabBrowserOwnerResult,
  browserOwnerFailure,
} from './lab-browser-owner-contract.js';

export interface PtcLabBrowserPreflightPolicy {
  policyId: string;
  browser: Extract<PtcLabBrowserPolicy, { mode: 'fixed_preflight' }>;
  network: Extract<
    NonNullable<PtcLabAdmittedProfile['labPolicy']>['network'],
    { mode: 'open' }
  >;
}

export interface PtcLabBrowserValidatedPreflightRequest {
  probeId: string;
  timeoutMs: number;
}

const PTC_LAB_BROWSER_PREFLIGHT_DEFAULT_TIMEOUT_MS = 5_000;
const PTC_LAB_BROWSER_PREFLIGHT_REQUEST_KEYS = new Set([
  'probeId',
  'timeoutMs',
]);

export function readBrowserPreflightPolicy(
  admission: PtcLabAdmittedProfile | undefined,
): PtcLabBrowserOwnerResult<PtcLabBrowserPreflightPolicy> {
  if (
    admission === undefined ||
    admission.metadata.selectedProfile !== 'lab' ||
    admission.labPolicy === undefined
  ) {
    return browserOwnerFailure(
      'ptc_lab_browser_admission_required',
      'PTC lab browser owner preflight requires an admitted lab profile',
    );
  }
  if (
    !admission.labPolicy.browser.enabled ||
    admission.labPolicy.browser.mode !== 'fixed_preflight' ||
    admission.labPolicy.network.mode !== 'open'
  ) {
    return browserOwnerFailure(
      'ptc_lab_browser_policy_disabled',
      'PTC lab browser owner preflight policy is disabled',
    );
  }
  if (
    admission.labPolicy.browser.networkPolicyId !==
      admission.labPolicy.network.networkPolicyId ||
    admission.labPolicy.network.metricsCoverage === 'runtime_observed'
  ) {
    return browserOwnerFailure(
      'ptc_lab_browser_policy_disabled',
      'PTC lab browser owner preflight policy is not compatible with admitted network policy',
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

export function validateBrowserPreflightRequest(args: {
  request: PtcLabBrowserOwnerPreflightRequest;
  maxTimeoutMs: number;
}): PtcLabBrowserOwnerResult<PtcLabBrowserValidatedPreflightRequest> {
  if (
    !hasOnlyPtcLabBrowserRequestKeys(
      args.request,
      PTC_LAB_BROWSER_PREFLIGHT_REQUEST_KEYS,
    ) ||
    !isPtcLabBrowserSafeProbeId(args.request.probeId)
  ) {
    return ptcLabBrowserRequestInvalid('owner preflight');
  }
  const timeoutMs =
    args.request.timeoutMs ?? PTC_LAB_BROWSER_PREFLIGHT_DEFAULT_TIMEOUT_MS;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > args.maxTimeoutMs
  ) {
    return ptcLabBrowserRequestInvalid('owner preflight');
  }

  return { ok: true, value: { probeId: args.request.probeId, timeoutMs } };
}

export function validateBrowserPreflightSession(args: {
  handle: PtcSessionDockerHandle;
  policyId: string;
  browser: Extract<PtcLabBrowserPolicy, { mode: 'fixed_preflight' }>;
  network: PtcLabBrowserPreflightPolicy['network'];
}): PtcLabBrowserOwnerResult<void> {
  const sessionPolicy = validatePtcLabBrowserSessionPolicy({
    ...args,
    capabilityLabel: 'owner',
  });
  if (!sessionPolicy.ok) {
    return browserOwnerFailure(sessionPolicy.reasonCode, sessionPolicy.message);
  }
  return sessionPolicy;
}
