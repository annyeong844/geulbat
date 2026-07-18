import type { PtcLabBrowserPolicy } from '../core/lab-browser-policy.js';
import type { PtcLabAdmittedProfile } from '../../profile/lab-profile.js';
import type { buildPtcLabBrowserUserUrlNavigationSummaryPolicyFields } from '../core/lab-browser-policy-fields.js';
import type { PtcLabBrowserRuntimeOwnerArgs } from '../core/lab-browser-runtime-execution.js';
import type {
  PtcLabBrowserUserUrlNavigationRequest,
  PtcLabBrowserUserUrlTargetDigest,
} from '../core/lab-browser-url-navigation.js';
import {
  buildPtcLabBrowserNavigationAttemptSharedDigestInput,
  digestPtcLabBrowserNavigationAttempt,
  type PtcLabBrowserNavigationAttemptDigest,
  type PtcLabBrowserNavigationAttemptSharedDigestInput,
} from '../core/lab-browser-navigation-attempt-identity.js';
import {
  createPtcLabBrowserPhasedFailure,
  type PtcLabBrowserDiagnostics,
  type PtcLabBrowserNavigationChecks,
  type PtcLabBrowserNavigationFailureReason,
  type PtcLabBrowserNavigationPhase,
  type PtcLabBrowserPhasedFailure,
  type PtcLabBrowserResult,
  type PtcLabBrowserRuntimeOwnedSessionLifecycle,
  type SharedPtcLabBrowserUserUrlNavigationSummary,
} from '../core/lab-browser-result-contract.js';

export const PTC_LAB_BROWSER_USER_URL_NAVIGATION_RESULT_KIND =
  'ptc_lab_browser_user_url_navigation_result' as const;
const PTC_LAB_BROWSER_USER_URL_NAVIGATION_ERROR_KIND =
  'ptc_lab_browser_user_url_navigation_error' as const;

export type PtcLabBrowserUserUrlNavigationFailureReason =
  PtcLabBrowserNavigationFailureReason;

export type PtcLabBrowserUserUrlNavigationPhase = PtcLabBrowserNavigationPhase;

export type PtcLabBrowserUserUrlNavigationAttemptDigest =
  PtcLabBrowserNavigationAttemptDigest;

export type PtcLabBrowserUserUrlNavigationChecks =
  PtcLabBrowserNavigationChecks;

export type PtcLabBrowserUserUrlNavigationSummary =
  SharedPtcLabBrowserUserUrlNavigationSummary<
    PtcLabBrowserUserUrlTargetDigest,
    PtcLabBrowserUserUrlNavigationAttemptDigest
  >;

export type PtcLabBrowserUserUrlNavigationError = PtcLabBrowserPhasedFailure<
  typeof PTC_LAB_BROWSER_USER_URL_NAVIGATION_ERROR_KIND,
  PtcLabBrowserUserUrlNavigationFailureReason,
  PtcLabBrowserUserUrlNavigationPhase,
  {
    targetDigest?: PtcLabBrowserUserUrlTargetDigest;
    navigationAttemptDigest?: PtcLabBrowserUserUrlNavigationAttemptDigest;
    sessionLifecycle?: PtcLabBrowserRuntimeOwnedSessionLifecycle;
    diagnostics?: PtcLabBrowserDiagnostics;
  }
>;

export type PtcLabBrowserUserUrlNavigationResult<T> = PtcLabBrowserResult<
  T,
  PtcLabBrowserUserUrlNavigationError
>;
type PtcLabBrowserUserUrlNavigationSummaryPolicyFields = ReturnType<
  typeof buildPtcLabBrowserUserUrlNavigationSummaryPolicyFields
>;

export interface PtcLabBrowserUserUrlNavigationExecutionDigestInput extends PtcLabBrowserNavigationAttemptSharedDigestInput<
  PtcLabBrowserUserUrlNavigationSummaryPolicyFields['browserPolicyId']
> {
  evidencePolicyId: PtcLabBrowserUserUrlNavigationSummaryPolicyFields['browserEvidencePolicyId'];
  urlEchoPolicyId: PtcLabBrowserUserUrlNavigationSummaryPolicyFields['browserUrlEchoPolicyId'];
}

export interface PtcLabBrowserUserUrlNavigationExecutionIdentity extends PtcLabBrowserUserUrlNavigationExecutionDigestInput {
  navigationAttemptDigest: PtcLabBrowserUserUrlNavigationAttemptDigest;
}

export type RunPtcLabBrowserUserUrlNavigationArgs =
  PtcLabBrowserRuntimeOwnerArgs<
    PtcLabBrowserUserUrlNavigationRequest,
    PtcLabAdmittedProfile | undefined
  >;

export function buildPtcLabBrowserUserUrlNavigationExecutionIdentity(args: {
  browser: Extract<PtcLabBrowserPolicy, { mode: 'user_url_navigation' }>;
  effectiveTimeoutMs: number;
  targetDigest: PtcLabBrowserUserUrlTargetDigest;
}): PtcLabBrowserUserUrlNavigationExecutionIdentity {
  const digestInput: PtcLabBrowserUserUrlNavigationExecutionDigestInput = {
    ...buildPtcLabBrowserNavigationAttemptSharedDigestInput(args),
    evidencePolicyId: args.browser.evidencePolicyId,
    urlEchoPolicyId: args.browser.urlEchoPolicyId,
  };
  return {
    ...digestInput,
    navigationAttemptDigest: digestPtcLabBrowserNavigationAttempt(digestInput),
  };
}

export function browserUserUrlNavigationFailure(
  reasonCode: PtcLabBrowserUserUrlNavigationFailureReason,
  message: string,
  phase: PtcLabBrowserUserUrlNavigationPhase,
  extras: Omit<
    PtcLabBrowserUserUrlNavigationError,
    'kind' | 'ok' | 'reasonCode' | 'message' | 'phase'
  > = {},
): PtcLabBrowserUserUrlNavigationError {
  return createPtcLabBrowserPhasedFailure({
    kind: PTC_LAB_BROWSER_USER_URL_NAVIGATION_ERROR_KIND,
    reasonCode,
    message,
    phase,
    extras,
  });
}
