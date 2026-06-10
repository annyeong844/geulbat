import { isRecord } from '@geulbat/protocol/runtime-utils';
import {
  validatePtcLabBrowserSessionPolicy,
  type PtcLabBrowserPolicy,
} from './lab-browser-policy.js';
import type { PtcLabAdmittedProfile } from './lab-profile.js';
import type { PtcSessionDockerHandle } from './session-docker-contract.js';
import {
  type PtcLabBrowserUserUrlNavigationResult,
  type PtcLabBrowserUserUrlNavigationRuntimeInput,
  browserUserUrlNavigationFailure,
} from './lab-browser-user-url-navigation-contract.js';
import {
  digestPtcLabBrowserUserUrlNavigationTarget,
  normalizePtcLabBrowserUserUrlNavigationTarget,
  type PtcLabBrowserUserUrlNavigationRequest,
  type PtcLabBrowserUserUrlNavigationTarget,
} from './lab-browser-url-navigation.js';

export interface PtcLabBrowserUserUrlNavigationPolicy {
  policyId: string;
  browser: Extract<PtcLabBrowserPolicy, { mode: 'user_url_navigation' }>;
  network: Extract<
    NonNullable<PtcLabAdmittedProfile['labPolicy']>['network'],
    { mode: 'open' }
  >;
}

export interface PtcLabBrowserValidatedUserUrlNavigationRequest {
  target: PtcLabBrowserUserUrlNavigationTarget;
  timeoutMs: number;
}

const PTC_LAB_BROWSER_USER_URL_NAVIGATION_DEFAULT_TIMEOUT_MS = 5_000;

export function readBrowserUserUrlNavigationPolicy(
  admission: PtcLabAdmittedProfile | undefined,
): PtcLabBrowserUserUrlNavigationResult<PtcLabBrowserUserUrlNavigationPolicy> {
  if (
    admission === undefined ||
    admission.metadata.selectedProfile !== 'lab' ||
    admission.labPolicy === undefined
  ) {
    return browserUserUrlNavigationFailure(
      'ptc_lab_browser_policy_disabled',
      'PTC lab browser user URL navigation requires an admitted lab profile',
      'policy_admission',
    );
  }
  if (!admission.labPolicy.browser.enabled) {
    return browserUserUrlNavigationFailure(
      'ptc_lab_browser_policy_disabled',
      'PTC lab browser user URL navigation policy is disabled',
      'policy_admission',
    );
  }
  if (admission.labPolicy.browser.mode !== 'user_url_navigation') {
    return browserUserUrlNavigationFailure(
      'ptc_lab_browser_policy_mismatch',
      'PTC lab browser user URL navigation requires user URL browser policy identity',
      'policy_admission',
    );
  }
  if (admission.labPolicy.network.mode !== 'open') {
    return browserUserUrlNavigationFailure(
      'ptc_lab_browser_network_disabled',
      'PTC lab browser user URL navigation requires admitted lab open network policy',
      'policy_admission',
    );
  }
  if (
    admission.labPolicy.browser.networkPolicyId !==
      admission.labPolicy.network.networkPolicyId ||
    admission.labPolicy.network.metricsCoverage === 'runtime_observed'
  ) {
    return browserUserUrlNavigationFailure(
      'ptc_lab_browser_policy_mismatch',
      'PTC lab browser user URL navigation policy is not compatible with admitted network policy',
      'policy_admission',
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

export function validateBrowserUserUrlNavigationRequest(args: {
  request: PtcLabBrowserUserUrlNavigationRequest | unknown;
  maxTimeoutMs: number;
}): PtcLabBrowserUserUrlNavigationResult<PtcLabBrowserValidatedUserUrlNavigationRequest> {
  const timeout = validateBrowserUserUrlNavigationTimeout({
    timeoutMs: isRecord(args.request) ? args.request.timeoutMs : undefined,
    maxTimeoutMs: args.maxTimeoutMs,
  });
  if (!timeout.ok) {
    return timeout;
  }
  const target = normalizePtcLabBrowserUserUrlNavigationTarget(args.request);
  if (!target.ok) {
    return browserUserUrlNavigationFailure(
      'ptc_lab_browser_url_admission_failed',
      'PTC lab browser user URL navigation target admission failed',
      'request_admission',
      {
        diagnostics: target.diagnostics ?? {
          admissionReasonCode: target.reasonCode,
        },
      },
    );
  }

  return {
    ok: true,
    value: { target: target.value, timeoutMs: timeout.value },
  };
}

export function validateBrowserUserUrlNavigationRuntimeInput(args: {
  input: PtcLabBrowserUserUrlNavigationRuntimeInput;
  maxTimeoutMs: number;
}): PtcLabBrowserUserUrlNavigationResult<PtcLabBrowserValidatedUserUrlNavigationRequest> {
  const timeout = validateBrowserUserUrlNavigationTimeout({
    timeoutMs: args.input.timeoutMs,
    maxTimeoutMs: args.maxTimeoutMs,
  });
  if (!timeout.ok) {
    return timeout;
  }
  if (!targetDigestMatches(args.input.target)) {
    return browserUserUrlNavigationFailure(
      'ptc_lab_browser_target_digest_mismatch',
      'PTC lab browser user URL navigation target digest does not match normalized target',
      'target_verification',
      { targetDigest: args.input.target.targetDigest },
    );
  }

  return {
    ok: true,
    value: { target: args.input.target, timeoutMs: timeout.value },
  };
}

export function validateBrowserUserUrlNavigationSession(args: {
  handle: PtcSessionDockerHandle;
  policyId: string;
  browser: Extract<PtcLabBrowserPolicy, { mode: 'user_url_navigation' }>;
  network: PtcLabBrowserUserUrlNavigationPolicy['network'];
}): PtcLabBrowserUserUrlNavigationResult<void> {
  const sessionPolicy = validatePtcLabBrowserSessionPolicy({
    ...args,
    capabilityLabel: 'user URL navigation',
  });
  if (!sessionPolicy.ok) {
    return browserUserUrlNavigationFailure(
      sessionPolicy.reasonCode,
      sessionPolicy.message,
      'session_acquisition',
    );
  }
  return sessionPolicy;
}

function validateBrowserUserUrlNavigationTimeout(args: {
  timeoutMs: unknown;
  maxTimeoutMs: number;
}): PtcLabBrowserUserUrlNavigationResult<number> {
  const timeoutMs =
    args.timeoutMs ?? PTC_LAB_BROWSER_USER_URL_NAVIGATION_DEFAULT_TIMEOUT_MS;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > args.maxTimeoutMs
  ) {
    return browserUserUrlNavigationFailure(
      'ptc_lab_browser_request_invalid',
      'PTC lab browser user URL navigation timeout is invalid',
      'request_admission',
    );
  }
  return { ok: true, value: timeoutMs };
}

function targetDigestMatches(
  target: PtcLabBrowserUserUrlNavigationTarget,
): boolean {
  return (
    digestPtcLabBrowserUserUrlNavigationTarget({
      url: target.url,
      method: target.method,
      callerHeadersPolicyId: target.callerHeadersPolicyId,
      bodyPolicyId: target.bodyPolicyId,
      urlGrammarPolicyId: target.urlGrammarPolicyId,
    }) === target.targetDigest
  );
}
