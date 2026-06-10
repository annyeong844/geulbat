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
  type PtcLabBrowserFixedRuntimeProbeRequest,
  type PtcLabBrowserRuntimeResult,
  browserRuntimeFailure,
} from './lab-browser-runtime-contract.js';

export interface PtcLabBrowserRuntimePolicy {
  policyId: string;
  browser: Extract<PtcLabBrowserPolicy, { mode: 'fixed_runtime_probe' }>;
  network: Extract<
    NonNullable<PtcLabAdmittedProfile['labPolicy']>['network'],
    { mode: 'open' }
  >;
}

export interface PtcLabBrowserValidatedRuntimeRequest {
  probeId: string;
  timeoutMs: number;
}

const PTC_LAB_BROWSER_RUNTIME_DEFAULT_TIMEOUT_MS = 5_000;
const PTC_LAB_BROWSER_RUNTIME_REQUEST_KEYS = new Set(['probeId', 'timeoutMs']);

export function readBrowserRuntimePolicy(
  admission: PtcLabAdmittedProfile | undefined,
): PtcLabBrowserRuntimeResult<PtcLabBrowserRuntimePolicy> {
  if (
    admission === undefined ||
    admission.metadata.selectedProfile !== 'lab' ||
    admission.labPolicy === undefined
  ) {
    return browserRuntimeFailure(
      'ptc_lab_browser_admission_required',
      'PTC lab browser runtime probe requires an admitted lab profile',
    );
  }
  if (
    !admission.labPolicy.browser.enabled ||
    admission.labPolicy.browser.mode !== 'fixed_runtime_probe' ||
    admission.labPolicy.network.mode !== 'open'
  ) {
    return browserRuntimeFailure(
      'ptc_lab_browser_policy_disabled',
      'PTC lab browser runtime probe policy is disabled',
    );
  }
  if (
    admission.labPolicy.browser.networkPolicyId !==
      admission.labPolicy.network.networkPolicyId ||
    admission.labPolicy.network.metricsCoverage === 'runtime_observed'
  ) {
    return browserRuntimeFailure(
      'ptc_lab_browser_policy_disabled',
      'PTC lab browser runtime probe policy is not compatible with admitted network policy',
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

export function validateBrowserRuntimeRequest(args: {
  request: PtcLabBrowserFixedRuntimeProbeRequest;
  maxTimeoutMs: number;
}): PtcLabBrowserRuntimeResult<PtcLabBrowserValidatedRuntimeRequest> {
  if (
    !hasOnlyPtcLabBrowserRequestKeys(
      args.request,
      PTC_LAB_BROWSER_RUNTIME_REQUEST_KEYS,
    ) ||
    !isPtcLabBrowserSafeProbeId(args.request.probeId)
  ) {
    return ptcLabBrowserRequestInvalid('runtime probe');
  }
  const timeoutMs =
    args.request.timeoutMs ?? PTC_LAB_BROWSER_RUNTIME_DEFAULT_TIMEOUT_MS;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > args.maxTimeoutMs
  ) {
    return ptcLabBrowserRequestInvalid('runtime probe');
  }

  return { ok: true, value: { probeId: args.request.probeId, timeoutMs } };
}

export function validateBrowserRuntimeSession(args: {
  handle: PtcSessionDockerHandle;
  policyId: string;
  browser: Extract<PtcLabBrowserPolicy, { mode: 'fixed_runtime_probe' }>;
  network: PtcLabBrowserRuntimePolicy['network'];
}): PtcLabBrowserRuntimeResult<void> {
  const sessionPolicy = validatePtcLabBrowserSessionPolicy({
    ...args,
    capabilityLabel: 'runtime',
  });
  if (!sessionPolicy.ok) {
    return browserRuntimeFailure(
      sessionPolicy.reasonCode,
      sessionPolicy.message,
    );
  }
  return sessionPolicy;
}
