import { digestPtcStableJson } from '../../../shared/stable-identity.js';
import type { PtcLabBrowserPolicy } from '../core/lab-browser-policy.js';
import {
  buildPtcLabBrowserPageLoadEvidenceExecutionPolicyFields,
  type buildPtcLabBrowserPageLoadEvidenceSummaryPolicyFields,
} from '../core/lab-browser-policy-fields.js';
import type { PtcLabBrowserRuntimeOwnerArgs } from '../core/lab-browser-runtime-execution.js';
import type { PtcLabAdmittedProfile } from '../../profile/lab-profile.js';
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
  type SharedPtcLabBrowserPageLoadEvidenceSummary,
} from '../core/lab-browser-result-contract.js';

export const PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_CAPABILITY =
  'ptc_lab_browser_page_load_evidence' as const;
export const PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_RESULT_KIND =
  'ptc_lab_browser_page_load_evidence_result' as const;
const PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_ERROR_KIND =
  'ptc_lab_browser_page_load_evidence_error' as const;

type PtcLabBrowserPageLoadEvidenceFailureReason =
  PtcLabBrowserEvidenceFailureReason;

type PtcLabBrowserPageLoadEvidencePhase = PtcLabBrowserEvidencePhase;

export type PtcLabBrowserPageLoadEvidenceAttemptDigest =
  PtcLabBrowserNavigationAttemptDigest;
type PtcLabBrowserPageLoadEvidenceDigest = PtcLabBrowserEvidenceDigest;

export type PtcLabBrowserPageLoadEvidenceSummary =
  SharedPtcLabBrowserPageLoadEvidenceSummary<
    PtcLabBrowserUserUrlTargetDigest,
    PtcLabBrowserPageLoadEvidenceAttemptDigest,
    PtcLabBrowserPageLoadEvidenceDigest
  >;

type PtcLabBrowserPageLoadEvidenceError = PtcLabBrowserPhasedFailure<
  typeof PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_ERROR_KIND,
  PtcLabBrowserPageLoadEvidenceFailureReason,
  PtcLabBrowserPageLoadEvidencePhase,
  {
    targetDigest?: PtcLabBrowserUserUrlTargetDigest;
    pageLoadEvidenceAttemptDigest?: PtcLabBrowserPageLoadEvidenceAttemptDigest;
    sessionLifecycle?: PtcLabBrowserRuntimeOwnedSessionLifecycle;
    diagnostics?: PtcLabBrowserDiagnostics;
  }
>;

export type PtcLabBrowserPageLoadEvidenceResult<T> = PtcLabBrowserResult<
  T,
  PtcLabBrowserPageLoadEvidenceError
>;

type PtcLabBrowserPageLoadEvidencePolicy = Extract<
  PtcLabBrowserPolicy,
  { mode: 'page_load_evidence' }
>;
type PtcLabBrowserPageLoadEvidenceExecutionPolicyFields = ReturnType<
  typeof buildPtcLabBrowserPageLoadEvidenceExecutionPolicyFields
>;
type PtcLabBrowserPageLoadEvidenceSummaryPolicyFields = ReturnType<
  typeof buildPtcLabBrowserPageLoadEvidenceSummaryPolicyFields
>;

interface PtcLabBrowserPageLoadEvidenceExecutionDigestInput
  extends
    PtcLabBrowserNavigationAttemptSharedDigestInput<
      PtcLabBrowserPageLoadEvidenceSummaryPolicyFields['browserPolicyId']
    >,
    PtcLabBrowserPageLoadEvidenceExecutionPolicyFields {}

export interface PtcLabBrowserPageLoadEvidenceExecutionIdentity extends PtcLabBrowserPageLoadEvidenceExecutionDigestInput {
  pageLoadEvidenceAttemptDigest: PtcLabBrowserPageLoadEvidenceAttemptDigest;
}

export type RunPtcLabBrowserPageLoadEvidenceArgs =
  PtcLabBrowserRuntimeOwnerArgs<
    PtcLabBrowserUserUrlNavigationRequest,
    PtcLabAdmittedProfile | undefined
  >;

export function buildPtcLabBrowserPageLoadEvidenceExecutionIdentity(args: {
  browser: PtcLabBrowserPageLoadEvidencePolicy;
  effectiveTimeoutMs: number;
  targetDigest: PtcLabBrowserUserUrlTargetDigest;
}): PtcLabBrowserPageLoadEvidenceExecutionIdentity {
  const digestInput: PtcLabBrowserPageLoadEvidenceExecutionDigestInput = {
    ...buildPtcLabBrowserNavigationAttemptSharedDigestInput(args),
    ...buildPtcLabBrowserPageLoadEvidenceExecutionPolicyFields(args.browser),
  };
  return {
    ...digestInput,
    pageLoadEvidenceAttemptDigest:
      digestPtcLabBrowserNavigationAttempt(digestInput),
  };
}

export function digestPtcLabBrowserPageLoadEvidence(
  value: unknown,
): PtcLabBrowserPageLoadEvidenceDigest {
  return digestPtcStableJson(value);
}

export function browserPageLoadEvidenceFailure(
  reasonCode: PtcLabBrowserPageLoadEvidenceFailureReason,
  message: string,
  phase: PtcLabBrowserPageLoadEvidencePhase,
  extras: Omit<
    PtcLabBrowserPageLoadEvidenceError,
    'kind' | 'ok' | 'reasonCode' | 'message' | 'phase'
  > = {},
): PtcLabBrowserPageLoadEvidenceError {
  return createPtcLabBrowserPhasedFailure({
    kind: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_ERROR_KIND,
    reasonCode,
    message,
    phase,
    extras,
  });
}
