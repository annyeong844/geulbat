import {
  PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_SCRIPT,
  type PtcLabBrowserFixedRuntimeProbeSummary,
  type PtcLabBrowserRuntimeResult,
  type RunPtcLabBrowserFixedRuntimeProbeArgs,
  browserRuntimeFailure,
} from './lab-browser-runtime-contract.js';
import {
  readBrowserRuntimePolicy,
  validateBrowserRuntimeRequest,
  validateBrowserRuntimeSession,
} from './lab-browser-runtime-policy.js';
import {
  browserRuntimeSessionUnavailable,
  mapBrowserRuntimeExecution,
} from './lab-browser-runtime-result.js';
import { runPtcLabBrowserFixedCommandAttempt } from './lab-browser-fixed-command.js';

export async function runPtcLabBrowserFixedRuntimeProbe(
  args: RunPtcLabBrowserFixedRuntimeProbeArgs,
): Promise<PtcLabBrowserRuntimeResult<PtcLabBrowserFixedRuntimeProbeSummary>> {
  const policy = readBrowserRuntimePolicy(args.admission);
  if (!policy.ok) {
    return policy;
  }
  const request = validateBrowserRuntimeRequest({
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
      browserRuntimeFailure(
        'ptc_lab_browser_execution_failed',
        'PTC lab browser runtime probe runner failed',
        { commandResultKind: 'thrown' },
      ),
    runtimeScript: PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_SCRIPT,
    sessionManager: args.sessionManager,
    sessionUnavailable: browserRuntimeSessionUnavailable,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
    timeoutMs: request.value.timeoutMs,
    validateSession: (handle) => {
      const sessionValidation = validateBrowserRuntimeSession({
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

  return await mapBrowserRuntimeExecution({
    runArgs: args,
    execution: commandAttempt.execution,
    durationMs: commandAttempt.durationMs,
    handle: commandAttempt.handle,
    policy: policy.value,
    request: request.value,
  });
}
