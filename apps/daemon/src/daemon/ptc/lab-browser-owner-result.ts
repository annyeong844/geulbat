import { isRecord } from '@geulbat/protocol/runtime-utils';
import { buildPtcLabNetworkTelemetrySummary } from './lab-network-policy.js';
import { buildPtcLabPublicSessionId } from './lab-session-public-id.js';
import type {
  PtcSessionDockerCommandResult,
  PtcSessionDockerFailureReason,
  PtcSessionDockerHandle,
} from './session-docker-contract.js';
import {
  type PtcLabBrowserOwnerPreflightSummary,
  type PtcLabBrowserOwnerResult,
  type RunPtcLabBrowserOwnerPreflightArgs,
  browserOwnerFailure,
} from './lab-browser-owner-contract.js';
import type {
  PtcLabBrowserPreflightPolicy,
  PtcLabBrowserValidatedPreflightRequest,
} from './lab-browser-owner-policy.js';
import {
  admitPtcLabBrowserJsonLineOutput,
  type PtcLabBrowserJsonLineOutputAdmissionReason,
} from './lab-browser-json-line-output.js';
import {
  closeTaintedPtcDockerSession,
  type PtcSessionTaintCloseOutcome,
} from './session-taint-close.js';

const PTC_LAB_BROWSER_PREFLIGHT_MAX_STDOUT_BYTES = 4 * 1024;

export async function mapBrowserPreflightExecution(args: {
  runArgs: RunPtcLabBrowserOwnerPreflightArgs;
  execution: PtcSessionDockerCommandResult;
  durationMs: number;
  handle: PtcSessionDockerHandle;
  policy: PtcLabBrowserPreflightPolicy;
  request: PtcLabBrowserValidatedPreflightRequest;
}): Promise<PtcLabBrowserOwnerResult<PtcLabBrowserOwnerPreflightSummary>> {
  if (args.execution.kind === 'timeout') {
    const diagnostics = toBrowserPreflightTaintDiagnostics(
      await closeTaintedPtcDockerSession(args.runArgs),
    );
    return browserOwnerFailure(
      'ptc_lab_browser_timeout',
      'PTC lab browser owner preflight timed out',
      diagnostics,
    );
  }
  if (args.execution.kind === 'cancelled') {
    const diagnostics = toBrowserPreflightTaintDiagnostics(
      await closeTaintedPtcDockerSession(args.runArgs),
    );
    return browserOwnerFailure(
      'ptc_lab_browser_cancelled',
      'PTC lab browser owner preflight was cancelled',
      diagnostics,
    );
  }
  if (args.execution.kind === 'crash') {
    return browserOwnerFailure(
      'ptc_lab_browser_execution_failed',
      'PTC lab browser owner preflight failed to execute',
      { commandResultKind: 'crash' },
    );
  }

  const parsed = parsePreflightStdout(args.execution.stdout);
  if (!parsed.ok) {
    return parsed;
  }

  const outcome = args.execution.exitCode === 0 ? 'completed' : 'failed';
  return {
    ok: true,
    value: {
      ok: true,
      profile: 'lab',
      policyId: args.policy.policyId,
      labSessionId: buildPtcLabPublicSessionId(args.handle),
      probeId: args.request.probeId,
      browserPolicyId: args.policy.browser.browserPolicyId,
      browserMode: args.policy.browser.mode,
      executionClass: 'ptc_lab_browser_owner_preflight',
      exitCode: args.execution.exitCode,
      durationMs: args.durationMs,
      browserTelemetryPolicyId: args.policy.browser.telemetryPolicyId,
      browserOutputPolicy: args.policy.browser.outputPolicy,
      browserProfile: 'none',
      browserCookies: 'none',
      artifactExported: false,
      networkTelemetry: buildPtcLabNetworkTelemetrySummary({
        policy: args.policy.network,
        ownerKind: 'browser',
        outcome,
        networkOpened: true,
        durationMs: args.durationMs,
        metricsCoverage: 'owner_outcome_only',
      }),
    },
  };
}

export function browserSessionUnavailable(
  reasonCode: PtcSessionDockerFailureReason | 'session_manager_threw',
): PtcLabBrowserOwnerResult<never> {
  return browserOwnerFailure(
    'ptc_lab_browser_session_unavailable',
    'PTC lab browser owner session is unavailable',
    { sessionReasonCode: reasonCode },
  );
}

function toBrowserPreflightTaintDiagnostics(
  outcome: PtcSessionTaintCloseOutcome,
): Record<string, string | number | boolean> | undefined {
  if (outcome.closeProven) {
    return undefined;
  }
  return {
    sessionCloseFailed: true,
    ...(outcome.closeStatus === 'failed_result'
      ? { sessionReasonCode: outcome.sessionReasonCode }
      : {}),
  };
}

function parsePreflightStdout(stdout: string): PtcLabBrowserOwnerResult<void> {
  const admitted = admitPtcLabBrowserJsonLineOutput({
    maxStdoutBytes: PTC_LAB_BROWSER_PREFLIGHT_MAX_STDOUT_BYTES,
    stdout,
  });
  if (!admitted.ok) {
    return browserOwnerFailure(
      'ptc_lab_browser_output_invalid',
      preflightAdmissionMessage(admitted.reason),
    );
  }
  const parsed = admitted.value;
  if (
    !isRecord(parsed) ||
    parsed.ok !== true ||
    parsed.capability !== 'ptc_lab_browser_owner_preflight'
  ) {
    return browserOwnerFailure(
      'ptc_lab_browser_output_invalid',
      'PTC lab browser owner preflight stdout has invalid shape',
    );
  }
  return { ok: true, value: undefined };
}

function preflightAdmissionMessage(
  reason: PtcLabBrowserJsonLineOutputAdmissionReason,
): string {
  if (reason === 'stdout_too_large') {
    return 'PTC lab browser owner preflight stdout is too large';
  }
  if (reason === 'stdout_not_one_json_line') {
    return 'PTC lab browser owner preflight stdout must be one JSON line';
  }
  if (reason === 'stdout_invalid_json') {
    return 'PTC lab browser owner preflight stdout is not valid JSON';
  }
  return 'PTC lab browser owner preflight stdout contains forbidden browser output';
}
