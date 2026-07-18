import { isPtcRecord } from '../../../shared/record-shape.js';
import { admitPtcBoundedTimeoutMs } from '../../../shared/lab-spine.js';
import { validatePtcLabBrowserSessionPolicy } from '../core/lab-browser-identity.js';
import type { PtcLabBrowserPolicy } from '../core/lab-browser-policy.js';
import { readPtcLabOpenBrowserPolicy } from '../../profile/lab-browser-policy-admission.js';
import type { PtcLabAdmittedProfile } from '../../profile/lab-profile.js';
import type { PtcSessionDockerHandle } from '../../session/session-docker-contract.js';
import {
  type PtcLabBrowserUserUrlNavigationResult,
  browserUserUrlNavigationFailure,
} from './lab-browser-user-url-navigation-contract.js';
import {
  normalizePtcLabBrowserUserUrlNavigationTarget,
  type PtcLabBrowserValidatedUrlRequest,
} from '../core/lab-browser-url-navigation.js';

export interface PtcLabBrowserUserUrlNavigationPolicy {
  policyId: string;
  browser: Extract<PtcLabBrowserPolicy, { mode: 'user_url_navigation' }>;
  network: Extract<
    NonNullable<PtcLabAdmittedProfile['labPolicy']>['network'],
    { mode: 'open' }
  >;
  shell: NonNullable<PtcLabAdmittedProfile['labPolicy']>['shell'];
}

export type PtcLabBrowserValidatedUserUrlNavigationRequest =
  PtcLabBrowserValidatedUrlRequest;

const PTC_LAB_BROWSER_USER_URL_NAVIGATION_DEFAULT_TIMEOUT_MS = 5_000;

export function readBrowserUserUrlNavigationPolicy(
  admission: PtcLabAdmittedProfile | undefined,
): PtcLabBrowserUserUrlNavigationResult<PtcLabBrowserUserUrlNavigationPolicy> {
  const policy = readPtcLabOpenBrowserPolicy({
    admission,
    browserMode: 'user_url_navigation',
    modeMismatchMessage:
      'PTC lab browser user URL navigation requires user URL browser policy identity',
    subject: 'user URL navigation',
  });
  if (!policy.ok) {
    return browserUserUrlNavigationFailure(
      policy.reasonCode,
      policy.message,
      policy.phase,
    );
  }
  return policy;
}

export function validateBrowserUserUrlNavigationRequest(args: {
  request: unknown;
  maxTimeoutMs: number;
}): PtcLabBrowserUserUrlNavigationResult<PtcLabBrowserValidatedUserUrlNavigationRequest> {
  const timeout = validateBrowserUserUrlNavigationTimeout({
    timeoutMs: isPtcRecord(args.request) ? args.request.timeoutMs : undefined,
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
  const timeout = admitPtcBoundedTimeoutMs({
    timeoutMs: args.timeoutMs,
    defaultTimeoutMs: PTC_LAB_BROWSER_USER_URL_NAVIGATION_DEFAULT_TIMEOUT_MS,
    maxTimeoutMs: args.maxTimeoutMs,
  });
  if (!timeout.ok) {
    return browserUserUrlNavigationFailure(
      'ptc_lab_browser_request_invalid',
      'PTC lab browser user URL navigation timeout is invalid',
      'request_admission',
    );
  }
  return timeout;
}
