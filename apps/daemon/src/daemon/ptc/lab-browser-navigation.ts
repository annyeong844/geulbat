import {
  PTC_LAB_BROWSER_FIXED_NAVIGATION_PROBE_SCRIPT,
  type PtcLabBrowserFixedNavigationProbeSummary,
  type PtcLabBrowserNavigationResult,
  type RunPtcLabBrowserFixedNavigationProbeArgs,
  browserNavigationFailure,
} from './lab-browser-navigation-contract.js';
import {
  readBrowserNavigationPolicy,
  validateBrowserNavigationRequest,
  validateBrowserNavigationSession,
} from './lab-browser-navigation-policy.js';
import {
  browserNavigationSessionUnavailable,
  mapBrowserNavigationExecution,
} from './lab-browser-navigation-result.js';
import { runPtcLabBrowserFixedCommandAttempt } from './lab-browser-fixed-command.js';

export async function runPtcLabBrowserFixedNavigationProbe(
  args: RunPtcLabBrowserFixedNavigationProbeArgs,
): Promise<
  PtcLabBrowserNavigationResult<PtcLabBrowserFixedNavigationProbeSummary>
> {
  const policy = readBrowserNavigationPolicy(args.admission);
  if (!policy.ok) {
    return policy;
  }
  const request = validateBrowserNavigationRequest({
    request: args.request,
    maxTimeoutMs: policy.value.browser.maxActionMs,
  });
  if (!request.ok) {
    return request;
  }

  const commandAttempt = await runPtcLabBrowserFixedCommandAttempt({
    ...(args.commandRunner === undefined
      ? {}
      : { commandRunner: args.commandRunner }),
    ...(args.dockerPath === undefined ? {} : { dockerPath: args.dockerPath }),
    identity: args.identity,
    ...(args.now === undefined ? {} : { now: args.now }),
    runnerThrew: () =>
      browserNavigationFailure(
        'ptc_lab_browser_navigation_failed',
        'PTC lab browser navigation probe runner failed',
        { commandResultKind: 'thrown' },
      ),
    runtimeScript: PTC_LAB_BROWSER_FIXED_NAVIGATION_PROBE_SCRIPT,
    sessionManager: args.sessionManager,
    sessionUnavailable: browserNavigationSessionUnavailable,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
    timeoutMs: request.value.timeoutMs,
    validateSession: (handle) => {
      const sessionValidation = validateBrowserNavigationSession({
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
  if (!commandAttempt.ok) {
    return commandAttempt.failure;
  }

  return await mapBrowserNavigationExecution({
    runArgs: args,
    execution: commandAttempt.execution,
    durationMs: commandAttempt.durationMs,
    handle: commandAttempt.handle,
    policy: policy.value,
    request: request.value,
  });
}
