import {
  buildPtcLabBrowserPageLoadEvidenceExecutionIdentity,
  type PtcLabBrowserPageLoadEvidenceResult,
  type PtcLabBrowserPageLoadEvidenceSummary,
  type RunPtcLabBrowserPageLoadEvidenceArgs,
  type RunPtcLabBrowserPageLoadEvidenceRuntimeArgs,
  browserPageLoadEvidenceFailure,
} from './lab-browser-page-load-evidence-contract.js';
import { PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_RUNTIME_SCRIPT } from './lab-browser-page-load-evidence-runtime-script.js';
import {
  readBrowserPageLoadEvidencePolicy,
  validateBrowserPageLoadEvidenceRequest,
  validateBrowserPageLoadEvidenceRuntimeInput,
  validateBrowserPageLoadEvidenceSession,
} from './lab-browser-page-load-evidence-policy.js';
import {
  browserPageLoadEvidenceSessionUnavailable,
  mapBrowserPageLoadEvidenceExecution,
} from './lab-browser-page-load-evidence-result.js';
import { runPtcLabBrowserRuntimeCommandAttempt } from './lab-browser-navigation-runtime-command.js';
import { classifyPtcLabBrowserRuntimeCommandOutcome } from './lab-browser-runtime-cleanup.js';

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
    admission: args.admission,
    identity: args.identity,
    sessionManager: args.sessionManager,
    input: {
      target: request.value.target,
      timeoutMs: request.value.timeoutMs,
    },
    ownerStartMs,
    ...(args.commandRunner === undefined
      ? {}
      : { commandRunner: args.commandRunner }),
    ...(args.dockerPath === undefined ? {} : { dockerPath: args.dockerPath }),
    ...(args.now === undefined ? {} : { now: args.now }),
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  });
}

export async function runPtcLabBrowserPageLoadEvidenceRuntime(
  args: RunPtcLabBrowserPageLoadEvidenceRuntimeArgs,
): Promise<
  PtcLabBrowserPageLoadEvidenceResult<PtcLabBrowserPageLoadEvidenceSummary>
> {
  const now = args.now ?? Date.now;
  const start = args.ownerStartMs ?? now();
  const policy = readBrowserPageLoadEvidencePolicy(args.admission);
  if (!policy.ok) {
    return policy;
  }
  const request = validateBrowserPageLoadEvidenceRuntimeInput({
    input: args.input,
    maxTimeoutMs: policy.value.browser.maxNavigationMs,
  });
  if (!request.ok) {
    return request;
  }

  const executionIdentity = buildPtcLabBrowserPageLoadEvidenceExecutionIdentity(
    {
      browser: policy.value.browser,
      effectiveTimeoutMs: request.value.timeoutMs,
      targetDigest: request.value.target.targetDigest,
    },
  );
  const runtimeAttempt = await runPtcLabBrowserRuntimeCommandAttempt({
    attemptDigest: executionIdentity.pageLoadEvidenceAttemptDigest,
    ...(args.commandRunner === undefined
      ? {}
      : { commandRunner: args.commandRunner }),
    ...(args.dockerPath === undefined ? {} : { dockerPath: args.dockerPath }),
    identity: args.identity,
    inputEnvelope: {
      targetUrl: request.value.target.url,
      timeoutMs: request.value.timeoutMs,
      loadWaitState: 'domcontentloaded',
      maxTitleChars: policy.value.browser.maxTitleChars,
    },
    ownerKind: 'page_load_evidence',
    runtimeScript: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_RUNTIME_SCRIPT,
    sessionManager: args.sessionManager,
    sessionUnavailable: browserPageLoadEvidenceSessionUnavailable,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
    timeoutMs: request.value.timeoutMs,
    validateSession: (handle) => {
      const sessionValidation = validateBrowserPageLoadEvidenceSession({
        handle,
        policyId: policy.value.policyId,
        browser: policy.value.browser,
        network: policy.value.network,
      });
      return sessionValidation.ok
        ? { ok: true }
        : { ok: false, failure: sessionValidation };
    },
  });
  if (!runtimeAttempt.ok) {
    return runtimeAttempt.failure;
  }

  const runtimeClassification = classifyPtcLabBrowserRuntimeCommandOutcome({
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
    outcome: runtimeAttempt.outcome,
  });
  if (!runtimeClassification.ok) {
    const { failure } = runtimeClassification;
    return browserPageLoadEvidenceFailure(
      failure.reasonCode,
      failure.message,
      failure.phase,
      {
        targetDigest: executionIdentity.targetDigest,
        pageLoadEvidenceAttemptDigest:
          executionIdentity.pageLoadEvidenceAttemptDigest,
        ...failure.details,
      },
    );
  }

  return await mapBrowserPageLoadEvidenceExecution({
    runArgs: args,
    execution: runtimeClassification.execution,
    durationMs: Math.max(0, now() - start),
    handle: runtimeAttempt.handle,
    policy: policy.value,
    request: request.value,
    executionIdentity,
  });
}
