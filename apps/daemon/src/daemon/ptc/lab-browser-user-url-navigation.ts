import {
  PTC_LAB_BROWSER_USER_URL_NAVIGATION_RUNTIME_SCRIPT,
  buildPtcLabBrowserUserUrlNavigationExecutionIdentity,
  type PtcLabBrowserUserUrlNavigationResult,
  type PtcLabBrowserUserUrlNavigationSummary,
  type RunPtcLabBrowserUserUrlNavigationArgs,
  type RunPtcLabBrowserUserUrlNavigationRuntimeArgs,
  browserUserUrlNavigationFailure,
} from './lab-browser-user-url-navigation-contract.js';
import {
  readBrowserUserUrlNavigationPolicy,
  validateBrowserUserUrlNavigationRequest,
  validateBrowserUserUrlNavigationRuntimeInput,
  validateBrowserUserUrlNavigationSession,
} from './lab-browser-user-url-navigation-policy.js';
import {
  browserUserUrlNavigationSessionUnavailable,
  mapBrowserUserUrlNavigationExecution,
} from './lab-browser-user-url-navigation-result.js';
import { runPtcLabBrowserRuntimeCommandAttempt } from './lab-browser-navigation-runtime-command.js';
import { classifyPtcLabBrowserRuntimeCommandOutcome } from './lab-browser-runtime-cleanup.js';

export async function runPtcLabBrowserUserUrlNavigation(
  args: RunPtcLabBrowserUserUrlNavigationArgs,
): Promise<
  PtcLabBrowserUserUrlNavigationResult<PtcLabBrowserUserUrlNavigationSummary>
> {
  const ownerStartMs = (args.now ?? Date.now)();
  const policy = readBrowserUserUrlNavigationPolicy(args.admission);
  if (!policy.ok) {
    return policy;
  }
  const request = validateBrowserUserUrlNavigationRequest({
    request: args.request,
    maxTimeoutMs: policy.value.browser.maxActionMs,
  });
  if (!request.ok) {
    return request;
  }

  return await runPtcLabBrowserUserUrlNavigationRuntime({
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

export async function runPtcLabBrowserUserUrlNavigationRuntime(
  args: RunPtcLabBrowserUserUrlNavigationRuntimeArgs,
): Promise<
  PtcLabBrowserUserUrlNavigationResult<PtcLabBrowserUserUrlNavigationSummary>
> {
  const now = args.now ?? Date.now;
  const start = args.ownerStartMs ?? now();
  const policy = readBrowserUserUrlNavigationPolicy(args.admission);
  if (!policy.ok) {
    return policy;
  }
  const request = validateBrowserUserUrlNavigationRuntimeInput({
    input: args.input,
    maxTimeoutMs: policy.value.browser.maxActionMs,
  });
  if (!request.ok) {
    return request;
  }

  const executionIdentity =
    buildPtcLabBrowserUserUrlNavigationExecutionIdentity({
      browser: policy.value.browser,
      effectiveTimeoutMs: request.value.timeoutMs,
      targetDigest: request.value.target.targetDigest,
    });
  const runtimeAttempt = await runPtcLabBrowserRuntimeCommandAttempt({
    attemptDigest: executionIdentity.navigationAttemptDigest,
    ...(args.commandRunner === undefined
      ? {}
      : { commandRunner: args.commandRunner }),
    ...(args.dockerPath === undefined ? {} : { dockerPath: args.dockerPath }),
    identity: args.identity,
    inputEnvelope: {
      targetUrl: request.value.target.url,
      timeoutMs: request.value.timeoutMs,
      loadWaitState: 'domcontentloaded',
    },
    ownerKind: 'user_url_navigation',
    runtimeScript: PTC_LAB_BROWSER_USER_URL_NAVIGATION_RUNTIME_SCRIPT,
    sessionManager: args.sessionManager,
    sessionUnavailable: browserUserUrlNavigationSessionUnavailable,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
    timeoutMs: request.value.timeoutMs,
    validateSession: (handle) => {
      const sessionValidation = validateBrowserUserUrlNavigationSession({
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
      cancelled: 'PTC lab browser user URL navigation was cancelled',
      cleanupUncertain:
        'PTC lab browser user URL navigation input cleanup was not proven',
      executionFailed: 'PTC lab browser user URL navigation failed to execute',
      inputPrepareFailed:
        'PTC lab browser user URL navigation input envelope could not be prepared',
      runnerThrew: 'PTC lab browser user URL navigation runner failed',
      timedOut: 'PTC lab browser user URL navigation timed out',
    },
    outcome: runtimeAttempt.outcome,
  });
  if (!runtimeClassification.ok) {
    const { failure } = runtimeClassification;
    return browserUserUrlNavigationFailure(
      failure.reasonCode,
      failure.message,
      failure.phase,
      {
        targetDigest: executionIdentity.targetDigest,
        navigationAttemptDigest: executionIdentity.navigationAttemptDigest,
        ...failure.details,
      },
    );
  }

  return await mapBrowserUserUrlNavigationExecution({
    runArgs: args,
    execution: runtimeClassification.execution,
    durationMs: Math.max(0, now() - start),
    handle: runtimeAttempt.handle,
    policy: policy.value,
    request: request.value,
    executionIdentity,
  });
}
