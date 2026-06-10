import {
  PTC_LAB_BROWSER_OWNER_PREFLIGHT_SCRIPT,
  type PtcLabBrowserOwnerPreflightSummary,
  type PtcLabBrowserOwnerResult,
  type RunPtcLabBrowserOwnerPreflightArgs,
  browserOwnerFailure,
} from './lab-browser-owner-contract.js';
import {
  readBrowserPreflightPolicy,
  validateBrowserPreflightRequest,
  validateBrowserPreflightSession,
} from './lab-browser-owner-policy.js';
import {
  browserSessionUnavailable,
  mapBrowserPreflightExecution,
} from './lab-browser-owner-result.js';
import { runPtcLabBrowserFixedCommandAttempt } from './lab-browser-fixed-command.js';

export async function runPtcLabBrowserOwnerPreflight(
  args: RunPtcLabBrowserOwnerPreflightArgs,
): Promise<PtcLabBrowserOwnerResult<PtcLabBrowserOwnerPreflightSummary>> {
  const policy = readBrowserPreflightPolicy(args.admission);
  if (!policy.ok) {
    return policy;
  }
  const request = validateBrowserPreflightRequest({
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
      browserOwnerFailure(
        'ptc_lab_browser_execution_failed',
        'PTC lab browser owner preflight runner failed',
        { commandResultKind: 'thrown' },
      ),
    runtimeScript: PTC_LAB_BROWSER_OWNER_PREFLIGHT_SCRIPT,
    sessionManager: args.sessionManager,
    sessionUnavailable: browserSessionUnavailable,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
    timeoutMs: request.value.timeoutMs,
    validateSession: (handle) => {
      const sessionValidation = validateBrowserPreflightSession({
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

  return await mapBrowserPreflightExecution({
    runArgs: args,
    execution: commandAttempt.execution,
    durationMs: commandAttempt.durationMs,
    handle: commandAttempt.handle,
    policy: policy.value,
    request: request.value,
  });
}
