import {
  PTC_LAB_BROWSER_TEXT_EVIDENCE_CAPABILITY,
  PTC_LAB_BROWSER_TEXT_EVIDENCE_RESULT_KIND,
  buildPtcLabBrowserTextEvidenceExecutionIdentity,
  type PtcLabBrowserTextEvidenceExecutionIdentity,
  type PtcLabBrowserTextEvidenceResult,
  type PtcLabBrowserTextEvidenceSummary,
  type RunPtcLabBrowserTextEvidenceArgs,
  browserTextEvidenceFailure,
  digestPtcLabBrowserTextEvidence,
} from './lab-browser-text-evidence-contract.js';
import { buildPtcLabBrowserTextEvidenceSummaryPolicyFields } from '../core/lab-browser-policy-fields.js';
import { parseTextEvidenceStdout } from './lab-browser-text-evidence-output.js';
import { PTC_LAB_BROWSER_TEXT_EVIDENCE_RUNTIME_SCRIPT } from '../core/lab-browser-runtime-script.js';
import {
  readBrowserTextEvidencePolicy,
  validateBrowserTextEvidenceRequest,
  validateBrowserTextEvidenceSession,
  type PtcLabBrowserTextEvidencePolicy,
  type PtcLabBrowserValidatedTextEvidenceRequest,
} from './lab-browser-text-evidence-policy.js';
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

const PTC_LAB_BROWSER_TEXT_EVIDENCE_SUBJECT = 'text evidence';

type RunPtcLabBrowserTextEvidenceRuntimeArgs =
  PtcLabBrowserRuntimeExecutionOwnerArgs<
    PtcLabBrowserTextEvidencePolicy,
    PtcLabBrowserValidatedTextEvidenceRequest
  >;

export async function runPtcLabBrowserTextEvidence(
  args: RunPtcLabBrowserTextEvidenceArgs,
): Promise<PtcLabBrowserTextEvidenceResult<PtcLabBrowserTextEvidenceSummary>> {
  const ownerStartMs = (args.now ?? Date.now)();
  const policy = readBrowserTextEvidencePolicy(args.admission);
  if (!policy.ok) {
    return policy;
  }
  const request = validateBrowserTextEvidenceRequest({
    request: args.request,
    maxTimeoutMs: policy.value.browser.maxNavigationMs,
  });
  if (!request.ok) {
    return request;
  }

  return await runPtcLabBrowserTextEvidenceRuntime({
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

async function runPtcLabBrowserTextEvidenceRuntime(
  args: RunPtcLabBrowserTextEvidenceRuntimeArgs,
): Promise<PtcLabBrowserTextEvidenceResult<PtcLabBrowserTextEvidenceSummary>> {
  const now = args.now ?? Date.now;
  const start = args.ownerStartMs ?? now();

  const executionIdentity = buildPtcLabBrowserTextEvidenceExecutionIdentity({
    browser: args.policy.browser,
    effectiveTimeoutMs: args.request.timeoutMs,
    targetDigest: args.request.target.targetDigest,
  });
  const runtimeExecution = await runPtcLabBrowserRuntimeExecution({
    command: {
      attemptDigest: executionIdentity.textEvidenceAttemptDigest,
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
      ownerKind: 'dom_text_evidence',
      outputBufferPolicy: {
        maxBufferedBytesPerStream: args.policy.shell.maxBufferedBytesPerStream,
      },
      runtimeScript: PTC_LAB_BROWSER_TEXT_EVIDENCE_RUNTIME_SCRIPT,
      sessionManager: args.sessionManager,
      sessionUnavailable: browserTextEvidenceSessionUnavailable,
      ...definedPtcProps({ signal: args.signal }),
      timeoutMs: args.request.timeoutMs,
      validateSession: (handle) => {
        const sessionValidation = validateBrowserTextEvidenceSession({
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
      cancelled: 'PTC lab browser text evidence was cancelled',
      cleanupUncertain:
        'PTC lab browser text evidence input cleanup was not proven',
      executionFailed: 'PTC lab browser text evidence failed to execute',
      inputPrepareFailed:
        'PTC lab browser text evidence input envelope could not be prepared',
      runnerThrew: 'PTC lab browser text evidence runner failed',
      timedOut: 'PTC lab browser text evidence timed out',
    },
    mapFailure: (failure) =>
      browserTextEvidenceFailure(
        failure.reasonCode,
        failure.message,
        failure.phase,
        {
          ...textEvidenceAttemptDetails(executionIdentity),
          ...failure.details,
        },
      ),
  });
  if (!runtimeExecution.ok) {
    return runtimeExecution.failure;
  }

  return await mapBrowserTextEvidenceExecution({
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

async function mapBrowserTextEvidenceExecution(args: {
  sessionTaintClose: PtcSessionTaintCloseInput;
  execution: PtcSessionDockerCommandResult;
  durationMs: number;
  policy: PtcLabBrowserTextEvidencePolicy;
  request: PtcLabBrowserValidatedTextEvidenceRequest;
  executionIdentity: PtcLabBrowserTextEvidenceExecutionIdentity;
}): Promise<PtcLabBrowserTextEvidenceResult<PtcLabBrowserTextEvidenceSummary>> {
  const attemptDetails = textEvidenceAttemptDetails(args.executionIdentity);
  const closeTaintedSession = async () =>
    toPtcLabBrowserTaintedSessionEnvelope(
      await closeTaintedPtcDockerSession(args.sessionTaintClose),
    );

  if (args.execution.kind !== 'exit') {
    return await mapPtcLabBrowserEvidenceCommandFailureResult({
      attemptDetails,
      closeTaintedSession,
      executionKind: args.execution.kind,
      subject: PTC_LAB_BROWSER_TEXT_EVIDENCE_SUBJECT,
      toFailure: (failure) =>
        browserTextEvidenceFailure(
          failure.reasonCode,
          failure.message,
          failure.phase,
          failure.details,
        ),
    });
  }

  const parsed = parseTextEvidenceStdout({
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
      subject: PTC_LAB_BROWSER_TEXT_EVIDENCE_SUBJECT,
      toFailure: (failure) =>
        browserTextEvidenceFailure(
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
    return textEvidenceOutputInvalid(
      'PTC lab browser text evidence stdout has inconsistent success shape',
      args.executionIdentity,
    );
  }

  const visibleText = parsed.value.visibleText;
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
    visibleText: 'available',
    ...buildPtcLabBrowserEvidenceCommonAvailability({
      navigationDurationMs: parsed.value.navigationDurationMs,
    }),
  } satisfies PtcLabBrowserTextEvidenceSummary['evidenceAvailability'];
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
    textEvidenceAttemptDigest: args.executionIdentity.textEvidenceAttemptDigest,
    visibleText,
    evidenceAvailability,
  };
  const textEvidenceDigest = digestPtcLabBrowserTextEvidence(publicEvidence);

  return {
    ok: true,
    value: {
      kind: PTC_LAB_BROWSER_TEXT_EVIDENCE_RESULT_KIND,
      ok: true,
      profile: 'lab',
      capability: PTC_LAB_BROWSER_TEXT_EVIDENCE_CAPABILITY,
      textEvidenceDigest,
      sessionLifecycle: sharedEvidence.sessionLifecycle,
      ...buildPtcLabBrowserTextEvidenceSummaryPolicyFields(args.policy.browser),
      requestedUrl: sharedEvidence.requestedUrl,
      ...publicEvidence,
      checks: sharedEvidence.checks,
    },
  };
}

function browserTextEvidenceSessionUnavailable(
  reasonCode: PtcSessionDockerFailureReason | 'session_manager_threw',
): PtcLabBrowserTextEvidenceResult<never> {
  return browserTextEvidenceFailure(
    'ptc_lab_browser_session_unavailable',
    'PTC lab browser text evidence session is unavailable',
    'session_acquisition',
    { diagnostics: { sessionReasonCode: reasonCode } },
  );
}

function textEvidenceOutputInvalid(
  message: string,
  executionIdentity?: PtcLabBrowserTextEvidenceExecutionIdentity,
): PtcLabBrowserTextEvidenceResult<never> {
  return browserTextEvidenceFailure(
    'ptc_lab_browser_evidence_output_invalid',
    message,
    'output_serialization',
    executionIdentity === undefined
      ? {}
      : textEvidenceAttemptDetails(executionIdentity),
  );
}

function textEvidenceAttemptDetails(
  executionIdentity: PtcLabBrowserTextEvidenceExecutionIdentity,
) {
  return {
    targetDigest: executionIdentity.targetDigest,
    textEvidenceAttemptDigest: executionIdentity.textEvidenceAttemptDigest,
  };
}
