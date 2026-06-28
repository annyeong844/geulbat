import { definedPtcProps } from '../../../shared/record-shape.js';
import type {
  PtcLabBrowserEvidenceAdapterChecks,
  PtcLabBrowserEvidenceChecks,
  PtcLabBrowserEvidenceCommonAvailability,
  PtcLabBrowserEvidenceDiagnostics,
  PtcLabBrowserEvidenceDigest,
  PtcLabBrowserEvidenceFailureReason,
  PtcLabBrowserEvidencePhase,
  PtcLabBrowserEvidenceTiming,
  PtcLabBrowserRedactedFinalUrl,
  PtcLabBrowserRedactedRequestedUrl,
  PtcLabBrowserRedirectCount,
  PtcLabBrowserRuntimeOwnedSessionLifecycle,
} from '../../../shared/browser-evidence-contract.js';

export type {
  PtcLabBrowserEvidenceAdapterChecks,
  PtcLabBrowserEvidenceDigest,
  PtcLabBrowserEvidenceFailureReason,
  PtcLabBrowserEvidencePhase,
  PtcLabBrowserRuntimeOwnedSessionLifecycle,
} from '../../../shared/browser-evidence-contract.js';
export type {
  PtcLabBrowserPageLoadEvidenceSummary as SharedPtcLabBrowserPageLoadEvidenceSummary,
  PtcLabBrowserTextEvidenceSummary as SharedPtcLabBrowserTextEvidenceSummary,
} from '../../../shared/browser-evidence-contract.js';
export type {
  PtcLabBrowserNavigationChecks,
  PtcLabBrowserNavigationFailureReason,
  PtcLabBrowserNavigationPhase,
  PtcLabBrowserUserUrlNavigationSummary as SharedPtcLabBrowserUserUrlNavigationSummary,
} from '../../../shared/browser-navigation-contract.js';

export type PtcLabBrowserDiagnostics = PtcLabBrowserEvidenceDiagnostics;

interface PtcLabBrowserFailure<ReasonCode extends string> {
  ok: false;
  reasonCode: ReasonCode;
  message: string;
  diagnostics?: PtcLabBrowserDiagnostics;
}

export type PtcLabBrowserResult<T, Failure> = { ok: true; value: T } | Failure;

export type PtcLabBrowserPhasedFailure<
  Kind extends string,
  ReasonCode extends string,
  Phase extends string,
  Extras extends object = Record<never, never>,
> = PtcLabBrowserFailure<ReasonCode> & {
  kind: Kind;
  phase: Phase;
} & Extras;

export type PtcLabBrowserEvidenceAdapterFailureCode =
  | 'browser_runtime_unavailable'
  | 'navigation_failed'
  | 'redirect_disallowed'
  | 'download_disallowed'
  | 'popup_disallowed'
  | 'evidence_unavailable'
  | 'evidence_output_invalid'
  | 'cleanup_failed'
  | 'cleanup_uncertain';

export type PtcLabBrowserCommandExecutionKind =
  | 'timeout'
  | 'cancelled'
  | 'output_limit_exceeded'
  | 'crash';

interface PtcLabBrowserCommandFailureMapping<
  ReasonCode extends string,
  Phase extends string,
  Extras extends object = Record<never, never>,
> {
  reasonCode: ReasonCode;
  message: string;
  phase: Phase;
  extras: Extras;
}

type PtcLabBrowserAdapterFailureMapping<
  ReasonCode extends string,
  Phase extends string,
> =
  | {
      taintsSession: true;
      reasonCode: ReasonCode;
      message: string;
      phase: Phase;
    }
  | {
      taintsSession: false;
      reasonCode: ReasonCode;
      message: string;
      phase: Phase;
    };

interface PtcLabBrowserFailureEnvelope<
  ReasonCode extends string,
  Phase extends string,
  Details extends object,
> {
  reasonCode: ReasonCode;
  message: string;
  phase: Phase;
  details: Details;
}

export const PTC_LAB_BROWSER_RUNTIME_OWNED_RETAINED_SESSION_LIFECYCLE = {
  mode: 'runtime_owned',
  retainedAfterExecution: true,
  taintedAfterExecution: false,
} as const satisfies PtcLabBrowserRuntimeOwnedSessionLifecycle<false>;

function mapPtcLabBrowserEvidenceCommandFailure(args: {
  executionKind: PtcLabBrowserCommandExecutionKind;
  subject: string;
}): PtcLabBrowserCommandFailureMapping<
  PtcLabBrowserEvidenceFailureReason,
  PtcLabBrowserEvidencePhase,
  Record<never, never> | { diagnostics: PtcLabBrowserDiagnostics }
> {
  if (args.executionKind === 'timeout') {
    return {
      reasonCode: 'ptc_lab_browser_timeout',
      message: `PTC lab browser ${args.subject} timed out`,
      phase: 'navigation',
      extras: {},
    };
  }
  if (args.executionKind === 'cancelled') {
    return {
      reasonCode: 'ptc_lab_browser_cancelled',
      message: `PTC lab browser ${args.subject} was cancelled`,
      phase: 'navigation',
      extras: {},
    };
  }
  if (
    args.executionKind === 'crash' ||
    args.executionKind === 'output_limit_exceeded'
  ) {
    return {
      reasonCode: 'ptc_lab_browser_navigation_failed',
      message: `PTC lab browser ${args.subject} failed to execute`,
      phase: 'navigation',
      extras: { diagnostics: { commandResultKind: args.executionKind } },
    };
  }
  const exhausted: never = args.executionKind;
  return exhausted;
}

export async function mapPtcLabBrowserCommandFailureToResult<
  AttemptDetails extends object,
  TaintEnvelope extends object,
  ReasonCode extends string,
  Phase extends string,
  Extras extends object,
  Failure,
>(args: {
  attemptDetails: AttemptDetails;
  closeTaintedSession: () => Promise<TaintEnvelope>;
  executionKind: PtcLabBrowserCommandExecutionKind;
  mapFailure: (
    executionKind: PtcLabBrowserCommandExecutionKind,
  ) => PtcLabBrowserCommandFailureMapping<ReasonCode, Phase, Extras>;
  toFailure: (
    failure: PtcLabBrowserFailureEnvelope<
      ReasonCode,
      Phase,
      AttemptDetails & Extras & TaintEnvelope
    >,
  ) => Failure;
}): Promise<Failure> {
  const commandFailure = args.mapFailure(args.executionKind);
  const taint = await args.closeTaintedSession();
  return args.toFailure({
    reasonCode: commandFailure.reasonCode,
    message: commandFailure.message,
    phase: commandFailure.phase,
    details: {
      ...args.attemptDetails,
      ...commandFailure.extras,
      ...taint,
    },
  });
}

export async function mapPtcLabBrowserEvidenceCommandFailureResult<
  AttemptDetails extends object,
  TaintEnvelope extends object,
  Failure,
>(args: {
  attemptDetails: AttemptDetails;
  closeTaintedSession: () => Promise<TaintEnvelope>;
  executionKind: PtcLabBrowserCommandExecutionKind;
  subject: string;
  toFailure: (
    failure: PtcLabBrowserFailureEnvelope<
      PtcLabBrowserEvidenceFailureReason,
      PtcLabBrowserEvidencePhase,
      AttemptDetails &
        (Record<never, never> | { diagnostics: PtcLabBrowserDiagnostics }) &
        TaintEnvelope
    >,
  ) => Failure;
}): Promise<Failure> {
  return await mapPtcLabBrowserCommandFailureToResult({
    attemptDetails: args.attemptDetails,
    closeTaintedSession: args.closeTaintedSession,
    executionKind: args.executionKind,
    mapFailure: (executionKind) =>
      mapPtcLabBrowserEvidenceCommandFailure({
        executionKind,
        subject: args.subject,
      }),
    toFailure: args.toFailure,
  });
}

function mapPtcLabBrowserEvidenceAdapterFailureResult(args: {
  errorCode: PtcLabBrowserEvidenceAdapterFailureCode;
  subject: string;
}): PtcLabBrowserAdapterFailureMapping<
  PtcLabBrowserEvidenceFailureReason,
  PtcLabBrowserEvidencePhase
> {
  if (
    args.errorCode === 'cleanup_failed' ||
    args.errorCode === 'cleanup_uncertain'
  ) {
    return {
      taintsSession: true,
      reasonCode:
        args.errorCode === 'cleanup_failed'
          ? 'ptc_lab_browser_cleanup_failed'
          : 'ptc_lab_browser_cleanup_uncertain',
      message: `PTC lab browser ${args.subject} cleanup was not proven`,
      phase: 'cleanup',
    };
  }

  const failure = mapPtcLabBrowserEvidenceAdapterFailure(args.errorCode);
  return {
    taintsSession: false,
    reasonCode: failure.reasonCode,
    message:
      args.errorCode === 'browser_runtime_unavailable'
        ? 'PTC lab browser runtime is unavailable'
        : `PTC lab browser ${args.subject} failed`,
    phase: failure.phase,
  };
}

export async function mapPtcLabBrowserAdapterFailureToResult<
  AttemptDetails extends object,
  TaintEnvelope extends object,
  ErrorCode extends string,
  ReasonCode extends string,
  Phase extends string,
  Failure,
>(args: {
  attemptDetails: AttemptDetails;
  closeTaintedSession: () => Promise<TaintEnvelope>;
  errorCode: ErrorCode;
  mapFailure: (
    errorCode: ErrorCode,
  ) => PtcLabBrowserAdapterFailureMapping<ReasonCode, Phase>;
  toFailure: (
    failure: PtcLabBrowserFailureEnvelope<
      ReasonCode,
      Phase,
      | (AttemptDetails & TaintEnvelope)
      | (AttemptDetails & {
          sessionLifecycle: typeof PTC_LAB_BROWSER_RUNTIME_OWNED_RETAINED_SESSION_LIFECYCLE;
        })
    >,
  ) => Failure;
}): Promise<Failure> {
  const failure = args.mapFailure(args.errorCode);
  if (failure.taintsSession) {
    const taint = await args.closeTaintedSession();
    return args.toFailure({
      reasonCode: failure.reasonCode,
      message: failure.message,
      phase: failure.phase,
      details: {
        ...args.attemptDetails,
        ...taint,
      },
    });
  }

  return args.toFailure({
    reasonCode: failure.reasonCode,
    message: failure.message,
    phase: failure.phase,
    details: {
      ...args.attemptDetails,
      sessionLifecycle:
        PTC_LAB_BROWSER_RUNTIME_OWNED_RETAINED_SESSION_LIFECYCLE,
    },
  });
}

export async function mapPtcLabBrowserEvidenceAdapterFailureToResult<
  AttemptDetails extends object,
  TaintEnvelope extends object,
  Failure,
>(args: {
  attemptDetails: AttemptDetails;
  closeTaintedSession: () => Promise<TaintEnvelope>;
  errorCode: PtcLabBrowserEvidenceAdapterFailureCode;
  subject: string;
  toFailure: (
    failure: PtcLabBrowserFailureEnvelope<
      PtcLabBrowserEvidenceFailureReason,
      PtcLabBrowserEvidencePhase,
      | (AttemptDetails & TaintEnvelope)
      | (AttemptDetails & {
          sessionLifecycle: typeof PTC_LAB_BROWSER_RUNTIME_OWNED_RETAINED_SESSION_LIFECYCLE;
        })
    >,
  ) => Failure;
}): Promise<Failure> {
  return await mapPtcLabBrowserAdapterFailureToResult({
    attemptDetails: args.attemptDetails,
    closeTaintedSession: args.closeTaintedSession,
    errorCode: args.errorCode,
    mapFailure: (errorCode) =>
      mapPtcLabBrowserEvidenceAdapterFailureResult({
        errorCode,
        subject: args.subject,
      }),
    toFailure: args.toFailure,
  });
}

export function buildPtcLabBrowserEvidencePublicBaseFields<
  TargetDigest extends PtcLabBrowserEvidenceDigest,
  FinalUrl,
  LoadOutcome extends string,
  LoadState extends string,
  Redirects,
  Timing,
>(args: {
  targetDigest: TargetDigest;
  finalUrl: FinalUrl;
  loadOutcome: LoadOutcome;
  loadState: LoadState;
  redirects: Redirects;
  timing: Timing;
}): {
  targetDigest: TargetDigest;
  finalUrl: FinalUrl;
  loadOutcome: LoadOutcome;
  loadState: LoadState;
  redirects: Redirects;
  timing: Timing;
} {
  return {
    targetDigest: args.targetDigest,
    finalUrl: args.finalUrl,
    loadOutcome: args.loadOutcome,
    loadState: args.loadState,
    redirects: args.redirects,
    timing: args.timing,
  };
}

export function buildPtcLabBrowserEvidenceCommonAvailability(args: {
  navigationDurationMs?: number | undefined;
}): PtcLabBrowserEvidenceCommonAvailability {
  return {
    finalUrl: 'available',
    navigationTiming:
      args.navigationDurationMs === undefined
        ? 'unavailable_allowed'
        : 'available',
  };
}

function mapPtcLabBrowserEvidenceAdapterFailure(
  errorCode: PtcLabBrowserEvidenceAdapterFailureCode,
): {
  reasonCode: PtcLabBrowserEvidenceFailureReason;
  phase: PtcLabBrowserEvidencePhase;
} {
  switch (errorCode) {
    case 'browser_runtime_unavailable':
      return {
        reasonCode: 'ptc_lab_browser_runtime_unavailable',
        phase: 'runtime_start',
      };
    case 'navigation_failed':
      return {
        reasonCode: 'ptc_lab_browser_navigation_failed',
        phase: 'navigation',
      };
    case 'redirect_disallowed':
      return {
        reasonCode: 'ptc_lab_browser_redirect_disallowed',
        phase: 'redirect_revalidation',
      };
    case 'download_disallowed':
      return {
        reasonCode: 'ptc_lab_browser_download_disallowed',
        phase: 'download_policy',
      };
    case 'popup_disallowed':
      return {
        reasonCode: 'ptc_lab_browser_popup_disallowed',
        phase: 'popup_policy',
      };
    case 'evidence_unavailable':
      return {
        reasonCode: 'ptc_lab_browser_evidence_unavailable',
        phase: 'evidence_capture',
      };
    case 'evidence_output_invalid':
      return {
        reasonCode: 'ptc_lab_browser_evidence_output_invalid',
        phase: 'evidence_capture',
      };
    case 'cleanup_failed':
      return {
        reasonCode: 'ptc_lab_browser_cleanup_failed',
        phase: 'cleanup',
      };
    case 'cleanup_uncertain':
      return {
        reasonCode: 'ptc_lab_browser_cleanup_uncertain',
        phase: 'cleanup',
      };
  }
  const exhausted: never = errorCode;
  return exhausted;
}

export function arePtcLabBrowserEvidenceAdapterChecksComplete(
  checks: PtcLabBrowserEvidenceAdapterChecks,
): boolean {
  return (
    checks.engineAvailable &&
    checks.contextCreated &&
    checks.navigationStarted &&
    checks.navigationSettled &&
    checks.redirectPolicyEnforced &&
    checks.downloadPolicyEnforced &&
    checks.popupPolicyEnforced &&
    checks.evidenceCaptured &&
    checks.cleanupCompleted
  );
}

export function buildPtcLabBrowserEvidenceSummarySharedFields<
  TargetDigest extends PtcLabBrowserEvidenceDigest,
  FinalUrlDigest extends PtcLabBrowserEvidenceDigest,
  RequestedUrlEchoPolicyId extends string,
  FinalUrlDigestPolicyId extends string,
  FinalUrlEchoPolicyId extends string,
  RedirectCountPolicyId extends string,
  TimingPolicyId extends string,
>(args: {
  checks: PtcLabBrowserEvidenceAdapterChecks;
  finalUrlDigest: FinalUrlDigest;
  finalUrlDigestPolicyId: FinalUrlDigestPolicyId;
  finalUrlEchoPolicyId: FinalUrlEchoPolicyId;
  navigationDurationMs?: number | undefined;
  ownerDurationMs: number;
  redirectCount: number;
  redirectCountPolicyId: RedirectCountPolicyId;
  requestedUrlEchoPolicyId: RequestedUrlEchoPolicyId;
  targetDigest: TargetDigest;
  timingPolicyId: TimingPolicyId;
}): {
  checks: PtcLabBrowserEvidenceChecks;
  finalUrl: PtcLabBrowserRedactedFinalUrl<
    FinalUrlDigest,
    FinalUrlDigestPolicyId,
    FinalUrlEchoPolicyId
  >;
  redirects: PtcLabBrowserRedirectCount<RedirectCountPolicyId>;
  requestedUrl: PtcLabBrowserRedactedRequestedUrl<
    TargetDigest,
    RequestedUrlEchoPolicyId
  >;
  sessionLifecycle: PtcLabBrowserRuntimeOwnedSessionLifecycle<false>;
  targetDigest: TargetDigest;
  timing: PtcLabBrowserEvidenceTiming<TimingPolicyId>;
} {
  return {
    targetDigest: args.targetDigest,
    finalUrl: {
      digest: args.finalUrlDigest,
      digestPolicyId: args.finalUrlDigestPolicyId,
      echoPolicyId: args.finalUrlEchoPolicyId,
      redacted: true,
    },
    redirects: {
      policyId: args.redirectCountPolicyId,
      count: args.redirectCount,
    },
    requestedUrl: {
      digest: args.targetDigest,
      echoPolicyId: args.requestedUrlEchoPolicyId,
      redacted: true,
    },
    sessionLifecycle: PTC_LAB_BROWSER_RUNTIME_OWNED_RETAINED_SESSION_LIFECYCLE,
    timing: {
      policyId: args.timingPolicyId,
      ownerDurationMs: args.ownerDurationMs,
      ...definedPtcProps({
        navigationDurationMs: args.navigationDurationMs,
      }),
    },
    checks: { targetVerified: true, ...args.checks },
  };
}

export function createPtcLabBrowserPhasedFailure<
  Kind extends string,
  ReasonCode extends string,
  Phase extends string,
  Extras extends object = Record<never, never>,
>(args: {
  kind: Kind;
  reasonCode: ReasonCode;
  message: string;
  phase: Phase;
  extras?: Extras;
}): PtcLabBrowserPhasedFailure<Kind, ReasonCode, Phase, Extras> {
  return {
    ...args.extras,
    kind: args.kind,
    ok: false,
    reasonCode: args.reasonCode,
    message: args.message,
    phase: args.phase,
  } as PtcLabBrowserPhasedFailure<Kind, ReasonCode, Phase, Extras>;
}
