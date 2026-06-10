import type {
  PtcSessionDockerCommandResult,
  PtcSessionDockerFailureReason,
  PtcSessionDockerHandle,
} from './session-docker-contract.js';
import {
  PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_CAPABILITY,
  PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_RESULT_KIND,
  type PtcLabBrowserPageLoadEvidenceExecutionIdentity,
  type PtcLabBrowserPageLoadEvidenceFailureReason,
  type PtcLabBrowserPageLoadEvidencePhase,
  type PtcLabBrowserPageLoadEvidenceResult,
  type PtcLabBrowserPageLoadEvidenceSummary,
  type RunPtcLabBrowserPageLoadEvidenceRuntimeArgs,
  browserPageLoadEvidenceFailure,
  buildPtcLabBrowserPageLoadEvidenceSummaryPolicyFields,
  digestPtcLabBrowserPageLoadEvidence,
} from './lab-browser-page-load-evidence-contract.js';
import type {
  PtcLabBrowserPageLoadEvidencePolicy,
  PtcLabBrowserValidatedPageLoadEvidenceRequest,
} from './lab-browser-page-load-evidence-policy.js';
import {
  type ParsedPageLoadEvidenceStdout,
  type PtcLabBrowserPageLoadEvidenceAdapterChecks,
  parsePageLoadEvidenceStdout,
} from './lab-browser-page-load-evidence-output.js';
import {
  closeTaintedPtcDockerSession,
  type PtcSessionTaintCloseOutcome,
} from './session-taint-close.js';

export async function mapBrowserPageLoadEvidenceExecution(args: {
  runArgs: RunPtcLabBrowserPageLoadEvidenceRuntimeArgs;
  execution: PtcSessionDockerCommandResult;
  durationMs: number;
  handle: PtcSessionDockerHandle;
  policy: PtcLabBrowserPageLoadEvidencePolicy;
  request: PtcLabBrowserValidatedPageLoadEvidenceRequest;
  executionIdentity: PtcLabBrowserPageLoadEvidenceExecutionIdentity;
}): Promise<
  PtcLabBrowserPageLoadEvidenceResult<PtcLabBrowserPageLoadEvidenceSummary>
> {
  if (args.execution.kind === 'timeout') {
    const taint = toPageLoadEvidenceTaintEnvelope(
      await closeTaintedPtcDockerSession(args.runArgs),
    );
    return browserPageLoadEvidenceFailure(
      'ptc_lab_browser_timeout',
      'PTC lab browser page-load evidence timed out',
      'navigation',
      {
        targetDigest: args.executionIdentity.targetDigest,
        pageLoadEvidenceAttemptDigest:
          args.executionIdentity.pageLoadEvidenceAttemptDigest,
        ...taint,
      },
    );
  }
  if (args.execution.kind === 'cancelled') {
    const taint = toPageLoadEvidenceTaintEnvelope(
      await closeTaintedPtcDockerSession(args.runArgs),
    );
    return browserPageLoadEvidenceFailure(
      'ptc_lab_browser_cancelled',
      'PTC lab browser page-load evidence was cancelled',
      'navigation',
      {
        targetDigest: args.executionIdentity.targetDigest,
        pageLoadEvidenceAttemptDigest:
          args.executionIdentity.pageLoadEvidenceAttemptDigest,
        ...taint,
      },
    );
  }
  if (args.execution.kind === 'crash') {
    const taint = toPageLoadEvidenceTaintEnvelope(
      await closeTaintedPtcDockerSession(args.runArgs),
    );
    return browserPageLoadEvidenceFailure(
      'ptc_lab_browser_navigation_failed',
      'PTC lab browser page-load evidence failed to execute',
      'navigation',
      {
        targetDigest: args.executionIdentity.targetDigest,
        pageLoadEvidenceAttemptDigest:
          args.executionIdentity.pageLoadEvidenceAttemptDigest,
        diagnostics: { commandResultKind: 'crash' },
        ...taint,
      },
    );
  }

  const parsed = parsePageLoadEvidenceStdout({
    stdout: args.execution.stdout,
    targetUrl: args.request.target.url,
    maxTitleChars: args.policy.browser.maxTitleChars,
  });
  if (!parsed.ok) {
    return parsed;
  }
  if (!parsed.value.ok) {
    if (
      parsed.value.errorCode === 'cleanup_failed' ||
      parsed.value.errorCode === 'cleanup_uncertain'
    ) {
      const taint = toPageLoadEvidenceTaintEnvelope(
        await closeTaintedPtcDockerSession(args.runArgs),
      );
      return browserPageLoadEvidenceFailure(
        parsed.value.errorCode === 'cleanup_failed'
          ? 'ptc_lab_browser_cleanup_failed'
          : 'ptc_lab_browser_cleanup_uncertain',
        'PTC lab browser page-load evidence cleanup was not proven',
        'cleanup',
        {
          targetDigest: args.executionIdentity.targetDigest,
          pageLoadEvidenceAttemptDigest:
            args.executionIdentity.pageLoadEvidenceAttemptDigest,
          ...taint,
        },
      );
    }

    return browserPageLoadEvidenceFailure(
      mapPageLoadEvidenceErrorCode(parsed.value.errorCode),
      parsed.value.errorCode === 'browser_runtime_unavailable'
        ? 'PTC lab browser runtime is unavailable'
        : 'PTC lab browser page-load evidence failed',
      mapPageLoadEvidenceErrorPhase(parsed.value.errorCode),
      {
        targetDigest: args.executionIdentity.targetDigest,
        pageLoadEvidenceAttemptDigest:
          args.executionIdentity.pageLoadEvidenceAttemptDigest,
        sessionLifecycle: {
          mode: 'runtime_owned',
          retainedAfterExecution: true,
          taintedAfterExecution: false,
        },
      },
    );
  }
  if (args.execution.exitCode !== 0 || !allChecksPassed(parsed.value.checks)) {
    return outputInvalid(
      'PTC lab browser page-load evidence stdout has inconsistent success shape',
      args.executionIdentity,
    );
  }

  const timing = {
    policyId: args.policy.browser.timingPolicyId,
    ownerDurationMs: args.durationMs,
    ...(parsed.value.navigationDurationMs === undefined
      ? {}
      : { navigationDurationMs: parsed.value.navigationDurationMs }),
  };
  const responseStatus =
    parsed.value.responseStatus === undefined
      ? undefined
      : {
          policyId: args.policy.browser.responseStatusPolicyId,
          code: parsed.value.responseStatus.code,
          source: parsed.value.responseStatus.source,
        };
  const title =
    parsed.value.title === undefined
      ? undefined
      : { policyId: args.policy.browser.titlePolicyId, ...parsed.value.title };
  const evidenceAvailability = {
    responseStatus:
      responseStatus === undefined
        ? ('unavailable_allowed' as const)
        : ('available' as const),
    title:
      title === undefined
        ? ('unavailable_allowed' as const)
        : title.redacted
          ? ('redacted' as const)
          : ('available' as const),
    finalUrl: 'available' as const,
    navigationTiming:
      parsed.value.navigationDurationMs === undefined
        ? ('unavailable_allowed' as const)
        : ('available' as const),
  };
  const finalUrl = {
    digest: parsed.value.finalUrlDigest,
    digestPolicyId: args.policy.browser.finalUrlDigestPolicyId,
    echoPolicyId: args.policy.browser.finalUrlEchoPolicyId,
    redacted: true as const,
  };
  const publicEvidence = {
    targetDigest: args.executionIdentity.targetDigest,
    pageLoadEvidenceAttemptDigest:
      args.executionIdentity.pageLoadEvidenceAttemptDigest,
    finalUrl,
    loadOutcome: parsed.value.loadOutcome,
    loadState: parsed.value.loadState,
    ...(responseStatus === undefined ? {} : { responseStatus }),
    ...(title === undefined ? {} : { title }),
    redirects: {
      policyId: args.policy.browser.redirectCountPolicyId,
      count: parsed.value.redirectCount,
    },
    timing,
    evidenceAvailability,
  };
  const pageLoadEvidenceDigest =
    digestPtcLabBrowserPageLoadEvidence(publicEvidence);

  return {
    ok: true,
    value: {
      kind: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_RESULT_KIND,
      ok: true,
      profile: 'lab',
      capability: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_CAPABILITY,
      pageLoadEvidenceDigest,
      sessionLifecycle: {
        mode: 'runtime_owned',
        retainedAfterExecution: true,
        taintedAfterExecution: false,
      },
      ...buildPtcLabBrowserPageLoadEvidenceSummaryPolicyFields(
        args.policy.browser,
      ),
      requestedUrl: {
        digest: args.executionIdentity.targetDigest,
        echoPolicyId: args.policy.browser.requestedUrlEchoPolicyId,
        redacted: true,
      },
      ...publicEvidence,
      checks: { targetVerified: true, ...parsed.value.checks },
    },
  };
}

export function browserPageLoadEvidenceSessionUnavailable(
  reasonCode: PtcSessionDockerFailureReason | 'session_manager_threw',
): PtcLabBrowserPageLoadEvidenceResult<never> {
  return browserPageLoadEvidenceFailure(
    'ptc_lab_browser_session_unavailable',
    'PTC lab browser page-load evidence session is unavailable',
    'session_acquisition',
    { diagnostics: { sessionReasonCode: reasonCode } },
  );
}

function toPageLoadEvidenceTaintEnvelope(
  outcome: PtcSessionTaintCloseOutcome,
): Pick<
  Extract<PtcLabBrowserPageLoadEvidenceResult<never>, { ok: false }>,
  'diagnostics' | 'sessionLifecycle'
> {
  const sessionLifecycle = {
    mode: 'runtime_owned' as const,
    retainedAfterExecution: false,
    taintedAfterExecution: true,
  };
  if (outcome.closeProven) {
    return { sessionLifecycle };
  }
  return {
    sessionLifecycle,
    diagnostics: {
      sessionTainted: true,
      sessionCloseFailed: true,
      ...(outcome.closeStatus === 'failed_result'
        ? { sessionReasonCode: outcome.sessionReasonCode }
        : {}),
    },
  };
}

function outputInvalid(
  message: string,
  executionIdentity?: PtcLabBrowserPageLoadEvidenceExecutionIdentity,
): PtcLabBrowserPageLoadEvidenceResult<never> {
  return browserPageLoadEvidenceFailure(
    'ptc_lab_browser_evidence_output_invalid',
    message,
    'output_serialization',
    executionIdentity === undefined
      ? {}
      : {
          targetDigest: executionIdentity.targetDigest,
          pageLoadEvidenceAttemptDigest:
            executionIdentity.pageLoadEvidenceAttemptDigest,
        },
  );
}

function mapPageLoadEvidenceErrorCode(
  errorCode: Extract<ParsedPageLoadEvidenceStdout, { ok: false }>['errorCode'],
): PtcLabBrowserPageLoadEvidenceFailureReason {
  if (errorCode === 'browser_runtime_unavailable') {
    return 'ptc_lab_browser_runtime_unavailable';
  }
  if (errorCode === 'redirect_disallowed') {
    return 'ptc_lab_browser_redirect_disallowed';
  }
  if (errorCode === 'download_disallowed') {
    return 'ptc_lab_browser_download_disallowed';
  }
  if (errorCode === 'popup_disallowed') {
    return 'ptc_lab_browser_popup_disallowed';
  }
  if (errorCode === 'permission_disallowed') {
    return 'ptc_lab_browser_permission_disallowed';
  }
  if (errorCode === 'evidence_unavailable') {
    return 'ptc_lab_browser_evidence_unavailable';
  }
  if (errorCode === 'evidence_output_invalid') {
    return 'ptc_lab_browser_evidence_output_invalid';
  }
  return 'ptc_lab_browser_navigation_failed';
}

function mapPageLoadEvidenceErrorPhase(
  errorCode: Extract<ParsedPageLoadEvidenceStdout, { ok: false }>['errorCode'],
): PtcLabBrowserPageLoadEvidencePhase {
  if (errorCode === 'browser_runtime_unavailable') {
    return 'runtime_start';
  }
  if (errorCode === 'redirect_disallowed') {
    return 'redirect_revalidation';
  }
  if (errorCode === 'download_disallowed') {
    return 'download_policy';
  }
  if (errorCode === 'popup_disallowed') {
    return 'popup_policy';
  }
  if (errorCode === 'permission_disallowed') {
    return 'permission_policy';
  }
  if (errorCode === 'evidence_unavailable') {
    return 'evidence_capture';
  }
  if (errorCode === 'evidence_output_invalid') {
    return 'evidence_sanitization';
  }
  return 'navigation';
}

function allChecksPassed(
  checks: PtcLabBrowserPageLoadEvidenceAdapterChecks,
): boolean {
  return (
    checks.engineAvailable &&
    checks.contextCreated &&
    checks.navigationStarted &&
    checks.navigationSettled &&
    checks.redirectPolicyEnforced &&
    checks.downloadPolicyEnforced &&
    checks.popupPolicyEnforced &&
    checks.permissionPolicyEnforced &&
    checks.evidenceSanitized &&
    checks.cleanupCompleted
  );
}
