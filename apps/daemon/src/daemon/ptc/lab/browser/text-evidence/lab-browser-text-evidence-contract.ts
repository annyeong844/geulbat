import { digestPtcStableJson } from '../../../shared/stable-identity.js';
import {
  buildPtcLabBrowserTextEvidenceExecutionPolicyFields,
  type buildPtcLabBrowserTextEvidenceSummaryPolicyFields,
} from '../core/lab-browser-policy-fields.js';
import type { PtcLabBrowserPolicy } from '../core/lab-browser-policy.js';
import type { PtcLabBrowserRuntimeOwnerArgs } from '../core/lab-browser-runtime-execution.js';
import {
  type PtcLabBrowserUserUrlNavigationRequest,
  type PtcLabBrowserUserUrlTargetDigest,
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
  type PtcLabBrowserEvidenceDigest,
  type PtcLabBrowserEvidenceFailureReason,
  type PtcLabBrowserEvidencePhase,
  type PtcLabBrowserPhasedFailure,
  type PtcLabBrowserResult,
  type PtcLabBrowserRuntimeOwnedSessionLifecycle,
  type SharedPtcLabBrowserTextEvidenceSummary,
} from '../core/lab-browser-result-contract.js';
import type { PtcLabAdmittedProfile } from '../../profile/lab-profile.js';

export const PTC_LAB_BROWSER_TEXT_EVIDENCE_CAPABILITY =
  'ptc_lab_browser_dom_text_evidence' as const;
export const PTC_LAB_BROWSER_TEXT_EVIDENCE_RESULT_KIND =
  'ptc_lab_browser_text_evidence_result' as const;
const PTC_LAB_BROWSER_TEXT_EVIDENCE_ERROR_KIND =
  'ptc_lab_browser_text_evidence_error' as const;

type PtcLabBrowserTextEvidenceFailureReason =
  PtcLabBrowserEvidenceFailureReason;

type PtcLabBrowserTextEvidencePhase = PtcLabBrowserEvidencePhase;

type PtcLabBrowserTextEvidenceAttemptDigest =
  PtcLabBrowserNavigationAttemptDigest;
type PtcLabBrowserTextEvidenceDigest = PtcLabBrowserEvidenceDigest;

export type PtcLabBrowserTextEvidenceSummary =
  SharedPtcLabBrowserTextEvidenceSummary<
    PtcLabBrowserUserUrlTargetDigest,
    PtcLabBrowserTextEvidenceAttemptDigest,
    PtcLabBrowserTextEvidenceDigest
  >;

type PtcLabBrowserTextEvidenceError = PtcLabBrowserPhasedFailure<
  typeof PTC_LAB_BROWSER_TEXT_EVIDENCE_ERROR_KIND,
  PtcLabBrowserTextEvidenceFailureReason,
  PtcLabBrowserTextEvidencePhase,
  {
    targetDigest?: PtcLabBrowserUserUrlTargetDigest;
    textEvidenceAttemptDigest?: PtcLabBrowserTextEvidenceAttemptDigest;
    sessionLifecycle?: PtcLabBrowserRuntimeOwnedSessionLifecycle;
    diagnostics?: PtcLabBrowserDiagnostics;
  }
>;

export type PtcLabBrowserTextEvidenceResult<T> = PtcLabBrowserResult<
  T,
  PtcLabBrowserTextEvidenceError
>;

export type PtcLabBrowserTextEvidenceRequest =
  PtcLabBrowserUserUrlNavigationRequest;

type PtcLabBrowserTextEvidencePolicy = Extract<
  PtcLabBrowserPolicy,
  { mode: 'dom_text_evidence' }
>;
type PtcLabBrowserTextEvidenceExecutionPolicyFields = ReturnType<
  typeof buildPtcLabBrowserTextEvidenceExecutionPolicyFields
>;
type PtcLabBrowserTextEvidenceSummaryPolicyFields = ReturnType<
  typeof buildPtcLabBrowserTextEvidenceSummaryPolicyFields
>;

interface PtcLabBrowserTextEvidenceExecutionDigestInput
  extends
    PtcLabBrowserNavigationAttemptSharedDigestInput<
      PtcLabBrowserTextEvidenceSummaryPolicyFields['browserPolicyId']
    >,
    PtcLabBrowserTextEvidenceExecutionPolicyFields {}

export interface PtcLabBrowserTextEvidenceExecutionIdentity extends PtcLabBrowserTextEvidenceExecutionDigestInput {
  textEvidenceAttemptDigest: PtcLabBrowserTextEvidenceAttemptDigest;
}

export type RunPtcLabBrowserTextEvidenceArgs = PtcLabBrowserRuntimeOwnerArgs<
  PtcLabBrowserTextEvidenceRequest,
  PtcLabAdmittedProfile | undefined
>;

export function browserTextEvidenceFailure(
  reasonCode: PtcLabBrowserTextEvidenceFailureReason,
  message: string,
  phase: PtcLabBrowserTextEvidencePhase,
  details: Omit<
    PtcLabBrowserTextEvidenceError,
    'kind' | 'ok' | 'reasonCode' | 'message' | 'phase'
  > = {},
): PtcLabBrowserTextEvidenceError {
  return createPtcLabBrowserPhasedFailure({
    kind: PTC_LAB_BROWSER_TEXT_EVIDENCE_ERROR_KIND,
    reasonCode,
    message,
    phase,
    extras: details,
  });
}

export function buildPtcLabBrowserTextEvidenceExecutionIdentity(args: {
  browser: PtcLabBrowserTextEvidencePolicy;
  effectiveTimeoutMs: number;
  targetDigest: PtcLabBrowserUserUrlTargetDigest;
}): PtcLabBrowserTextEvidenceExecutionIdentity {
  const input = {
    ...buildPtcLabBrowserNavigationAttemptSharedDigestInput({
      browser: args.browser,
      effectiveTimeoutMs: args.effectiveTimeoutMs,
      targetDigest: args.targetDigest,
    }),
    ...buildPtcLabBrowserTextEvidenceExecutionPolicyFields(args.browser),
  } satisfies PtcLabBrowserTextEvidenceExecutionDigestInput;
  return {
    ...input,
    textEvidenceAttemptDigest: digestPtcLabBrowserNavigationAttempt(input),
  };
}

export function digestPtcLabBrowserTextEvidence(
  value: Omit<
    PtcLabBrowserTextEvidenceSummary,
    | keyof PtcLabBrowserTextEvidenceSummaryPolicyFields
    | 'kind'
    | 'ok'
    | 'profile'
    | 'capability'
    | 'textEvidenceDigest'
    | 'sessionLifecycle'
    | 'requestedUrl'
    | 'checks'
  >,
): PtcLabBrowserTextEvidenceDigest {
  return digestPtcStableJson(value);
}
