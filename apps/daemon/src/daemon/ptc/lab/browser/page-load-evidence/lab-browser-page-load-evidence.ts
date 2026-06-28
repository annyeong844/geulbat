import {
  PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_CAPABILITY,
  PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_RESULT_KIND,
  buildPtcLabBrowserPageLoadEvidenceExecutionIdentity,
  type PtcLabBrowserPageLoadEvidenceExecutionIdentity,
  type PtcLabBrowserPageLoadEvidenceResult,
  type PtcLabBrowserPageLoadEvidenceSummary,
  type RunPtcLabBrowserPageLoadEvidenceArgs,
  browserPageLoadEvidenceFailure,
  digestPtcLabBrowserPageLoadEvidence,
} from './lab-browser-page-load-evidence-contract.js';
import { buildPtcLabBrowserPageLoadEvidenceSummaryPolicyFields } from '../core/lab-browser-policy-fields.js';
import { parsePageLoadEvidenceStdout } from './lab-browser-page-load-evidence-output.js';
import { PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_RUNTIME_SCRIPT } from '../core/lab-browser-runtime-script.js';
import {
  readBrowserPageLoadEvidencePolicy,
  validateBrowserPageLoadEvidenceRequest,
  validateBrowserPageLoadEvidenceSession,
  type PtcLabBrowserPageLoadEvidencePolicy,
  type PtcLabBrowserValidatedPageLoadEvidenceRequest,
} from './lab-browser-page-load-evidence-policy.js';
import {
  arePtcLabBrowserEvidenceAdapterChecksComplete,
  buildPtcLabBrowserEvidenceCommonAvailability,
  buildPtcLabBrowserEvidencePublicBaseFields,
  buildPtcLabBrowserEvidenceSummarySharedFields,
  mapPtcLabBrowserEvidenceAdapterFailureToResult,
  mapPtcLabBrowserEvidenceCommandFailureResult,
} from '../core/lab-browser-result-contract.js';
import {
  runPtcLabBrowserRuntimeExecution,
  type PtcLabBrowserRuntimeExecutionOwnerArgs,
} from '../core/lab-browser-runtime-execution.js';
import { toPtcLabBrowserTaintedSessionEnvelope } from '../core/lab-browser-runtime-cleanup.js';
import { definedPtcProps } from '../../../shared/record-shape.js';
import type {
  PtcSessionDockerCommandResult,
  PtcSessionDockerFailureReason,
} from '../../session/session-docker-contract.js';
import {
  closeTaintedPtcDockerSession,
  type PtcSessionTaintCloseInput,
} from '../../session/session-taint-close.js';

const PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_SUBJECT = 'page-load evidence';

type RunPtcLabBrowserPageLoadEvidenceRuntimeArgs =
  PtcLabBrowserRuntimeExecutionOwnerArgs<
    PtcLabBrowserPageLoadEvidencePolicy,
    PtcLabBrowserValidatedPageLoadEvidenceRequest
  >;

export async function runPtcLabBrowserPageLoadEvidence(
  args: RunPtcLabBrowserPageLoadEvidenceArgs,
): Promise<
  PtcLabBrowserPageLoadEvidenceResult<PtcLabBrowserPageLoadEvidenceSummary>
> {
  const ownerStartMs = (args.now ?? Date.now)();
  const policy = readBrowserPageLoadEvidencePolicy(args.admission);
  if (!policy.ok) {
    return policy;
  }
  const request = validateBrowserPageLoadEvidenceRequest({
    request: args.request,
    maxTimeoutMs: policy.value.browser.maxNavigationMs,
  });
  if (!request.ok) {
    return request;
  }

  return await runPtcLabBrowserPageLoadEvidenceRuntime({
    policy: policy.value,
    request: request.value,
    identity: args.identity,
    sessionManager: args.sessionManager,
    ownerStartMs,
    ...definedPtcProps({
      commandRunner: args.commandRunner,
      dockerPath: args.dockerPath,
      now: args.now,
      signal: args.signal,
    }),
  });
}

async function runPtcLabBrowserPageLoadEvidenceRuntime(
  args: RunPtcLabBrowserPageLoadEvidenceRuntimeArgs,
): Promise<
  PtcLabBrowserPageLoadEvidenceResult<PtcLabBrowserPageLoadEvidenceSummary>
> {
  const now = args.now ?? Date.now;
  const start = args.ownerStartMs ?? now();

  const executionIdentity = buildPtcLabBrowserPageLoadEvidenceExecutionIdentity(
    {
      browser: args.policy.browser,
      effectiveTimeoutMs: args.request.timeoutMs,
      targetDigest: args.request.target.targetDigest,
    },
  );
  const runtimeExecution = await runPtcLabBrowserRuntimeExecution({
    command: {
      attemptDigest: executionIdentity.pageLoadEvidenceAttemptDigest,
      ...definedPtcProps({
        commandRunner: args.commandRunner,
        dockerPath: args.dockerPath,
      }),
      identity: args.identity,
      inputEnvelope: {
        targetUrl: args.request.target.url,
        timeoutMs: args.request.timeoutMs,
        loadWaitState: 'domcontentloaded',
      },
      ownerKind: 'page_load_evidence',
      outputBufferPolicy: {
        maxBufferedBytesPerStream: args.policy.shell.maxBufferedBytesPerStream,
      },
      runtimeScript: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_RUNTIME_SCRIPT,
      sessionManager: args.sessionManager,
      sessionUnavailable: browserPageLoadEvidenceSessionUnavailable,
      ...definedPtcProps({ signal: args.signal }),
      timeoutMs: args.request.timeoutMs,
      validateSession: (handle) => {
        const sessionValidation = validateBrowserPageLoadEvidenceSession({
          handle,
          policyId: args.policy.policyId,
          browser: args.policy.browser,
          network: args.policy.network,
        });
        return sessionValidation.ok
          ? { ok: true }
          : { ok: false, failure: sessionValidation };
      },
    },
    messages: {
      cancelled: 'PTC lab browser page-load evidence was cancelled',
      cleanupUncertain:
        'PTC lab browser page-load evidence input cleanup was not proven',
      executionFailed: 'PTC lab browser page-load evidence failed to execute',
      inputPrepareFailed:
        'PTC lab browser page-load evidence input envelope could not be prepared',
      runnerThrew: 'PTC lab browser page-load evidence runner failed',
      timedOut: 'PTC lab browser page-load evidence timed out',
    },
    mapFailure: (failure) =>
      browserPageLoadEvidenceFailure(
        failure.reasonCode,
        failure.message,
        failure.phase,
        {
          ...pageLoadEvidenceAttemptDetails(executionIdentity),
          ...failure.details,
        },
      ),
  });
  if (!runtimeExecution.ok) {
    return runtimeExecution.failure;
  }

  return await mapBrowserPageLoadEvidenceExecution({
    sessionTaintClose: {
      identity: args.identity,
      sessionManager: args.sessionManager,
    },
    execution: runtimeExecution.execution,
    durationMs: Math.max(0, now() - start),
    policy: args.policy,
    request: args.request,
    executionIdentity,
  });
}

async function mapBrowserPageLoadEvidenceExecution(args: {
  sessionTaintClose: PtcSessionTaintCloseInput;
  execution: PtcSessionDockerCommandResult;
  durationMs: number;
  policy: PtcLabBrowserPageLoadEvidencePolicy;
  request: PtcLabBrowserValidatedPageLoadEvidenceRequest;
  executionIdentity: PtcLabBrowserPageLoadEvidenceExecutionIdentity;
}): Promise<
  PtcLabBrowserPageLoadEvidenceResult<PtcLabBrowserPageLoadEvidenceSummary>
> {
  const attemptDetails = pageLoadEvidenceAttemptDetails(args.executionIdentity);
  const closeTaintedSession = async () =>
    toPtcLabBrowserTaintedSessionEnvelope(
      await closeTaintedPtcDockerSession(args.sessionTaintClose),
    );

  if (args.execution.kind !== 'exit') {
    return await mapPtcLabBrowserEvidenceCommandFailureResult({
      attemptDetails,
      closeTaintedSession,
      executionKind: args.execution.kind,
      subject: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_SUBJECT,
      toFailure: (failure) =>
        browserPageLoadEvidenceFailure(
          failure.reasonCode,
          failure.message,
          failure.phase,
          failure.details,
        ),
    });
  }

  const parsed = parsePageLoadEvidenceStdout({
    stdout: args.execution.stdout,
    targetUrl: args.request.target.url,
  });
  if (!parsed.ok) {
    return parsed;
  }
  if (!parsed.value.ok) {
    return await mapPtcLabBrowserEvidenceAdapterFailureToResult({
      attemptDetails,
      closeTaintedSession,
      errorCode: parsed.value.errorCode,
      subject: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_SUBJECT,
      toFailure: (failure) =>
        browserPageLoadEvidenceFailure(
          failure.reasonCode,
          failure.message,
          failure.phase,
          failure.details,
        ),
    });
  }
  if (
    args.execution.exitCode !== 0 ||
    !arePtcLabBrowserEvidenceAdapterChecksComplete(parsed.value.checks)
  ) {
    return pageLoadEvidenceOutputInvalid(
      'PTC lab browser page-load evidence stdout has inconsistent success shape',
      args.executionIdentity,
    );
  }

  const responseStatus =
    parsed.value.responseStatus === undefined
      ? undefined
      : {
          policyId: args.policy.browser.responseStatusPolicyId,
          code: parsed.value.responseStatus.code,
          source: parsed.value.responseStatus.source,
        };
  const title =
    parsed.value.title === undefined ? undefined : parsed.value.title;
  const sharedEvidence = buildPtcLabBrowserEvidenceSummarySharedFields({
    checks: parsed.value.checks,
    finalUrlDigest: parsed.value.finalUrlDigest,
    finalUrlDigestPolicyId: args.policy.browser.finalUrlDigestPolicyId,
    finalUrlEchoPolicyId: args.policy.browser.finalUrlEchoPolicyId,
    navigationDurationMs: parsed.value.navigationDurationMs,
    ownerDurationMs: args.durationMs,
    redirectCount: parsed.value.redirectCount,
    redirectCountPolicyId: args.policy.browser.redirectCountPolicyId,
    requestedUrlEchoPolicyId: args.policy.browser.requestedUrlEchoPolicyId,
    targetDigest: args.executionIdentity.targetDigest,
    timingPolicyId: args.policy.browser.timingPolicyId,
  });
  const evidenceAvailability = {
    responseStatus:
      responseStatus === undefined ? 'unavailable_allowed' : 'available',
    title: title === undefined ? 'unavailable_allowed' : 'available',
    ...buildPtcLabBrowserEvidenceCommonAvailability({
      navigationDurationMs: parsed.value.navigationDurationMs,
    }),
  } satisfies PtcLabBrowserPageLoadEvidenceSummary['evidenceAvailability'];
  const publicEvidenceBase = buildPtcLabBrowserEvidencePublicBaseFields({
    targetDigest: sharedEvidence.targetDigest,
    finalUrl: sharedEvidence.finalUrl,
    loadOutcome: parsed.value.loadOutcome,
    loadState: parsed.value.loadState,
    redirects: sharedEvidence.redirects,
    timing: sharedEvidence.timing,
  });
  const publicEvidence = {
    ...publicEvidenceBase,
    pageLoadEvidenceAttemptDigest:
      args.executionIdentity.pageLoadEvidenceAttemptDigest,
    ...definedPtcProps({ responseStatus, title }),
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
      sessionLifecycle: sharedEvidence.sessionLifecycle,
      ...buildPtcLabBrowserPageLoadEvidenceSummaryPolicyFields(
        args.policy.browser,
      ),
      requestedUrl: sharedEvidence.requestedUrl,
      ...publicEvidence,
      checks: sharedEvidence.checks,
    },
  };
}

function browserPageLoadEvidenceSessionUnavailable(
  reasonCode: PtcSessionDockerFailureReason | 'session_manager_threw',
): PtcLabBrowserPageLoadEvidenceResult<never> {
  return browserPageLoadEvidenceFailure(
    'ptc_lab_browser_session_unavailable',
    'PTC lab browser page-load evidence session is unavailable',
    'session_acquisition',
    { diagnostics: { sessionReasonCode: reasonCode } },
  );
}

function pageLoadEvidenceOutputInvalid(
  message: string,
  executionIdentity?: PtcLabBrowserPageLoadEvidenceExecutionIdentity,
): PtcLabBrowserPageLoadEvidenceResult<never> {
  return browserPageLoadEvidenceFailure(
    'ptc_lab_browser_evidence_output_invalid',
    message,
    'output_serialization',
    executionIdentity === undefined
      ? {}
      : pageLoadEvidenceAttemptDetails(executionIdentity),
  );
}

function pageLoadEvidenceAttemptDetails(
  executionIdentity: PtcLabBrowserPageLoadEvidenceExecutionIdentity,
) {
  return {
    targetDigest: executionIdentity.targetDigest,
    pageLoadEvidenceAttemptDigest:
      executionIdentity.pageLoadEvidenceAttemptDigest,
  };
}
