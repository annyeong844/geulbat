import { isRecord } from '@geulbat/protocol/runtime-utils';
import { buildPtcLabPublicSessionId } from './lab-session-public-id.js';
import type {
  PtcSessionDockerCommandResult,
  PtcSessionDockerFailureReason,
  PtcSessionDockerHandle,
} from './session-docker-contract.js';
import {
  type PtcLabBrowserFixedRuntimeProbeChecks,
  type PtcLabBrowserFixedRuntimeProbeSummary,
  type PtcLabBrowserRuntimeFailureReason,
  type PtcLabBrowserRuntimeResult,
  type RunPtcLabBrowserFixedRuntimeProbeArgs,
  PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_CAPABILITY,
  browserRuntimeFailure,
} from './lab-browser-runtime-contract.js';
import type {
  PtcLabBrowserRuntimePolicy,
  PtcLabBrowserValidatedRuntimeRequest,
} from './lab-browser-runtime-policy.js';
import {
  formatPtcLabBrowserAdapterStdoutParseFailure,
  parsePtcLabBrowserAdapterStdout,
} from './lab-browser-json-line-output.js';
import { PTC_LAB_BROWSER_SUMMARY_ONLY_EXTRA_FORBIDDEN_OUTPUT_KEYS } from './lab-browser-output-guard.js';
import {
  closeTaintedPtcDockerSession,
  type PtcSessionTaintCloseOutcome,
} from './session-taint-close.js';

const PTC_LAB_BROWSER_RUNTIME_MAX_STDOUT_BYTES = 4 * 1024;

type ParsedRuntimeStdout =
  | { ok: true; checks: PtcLabBrowserFixedRuntimeProbeChecks }
  | {
      ok: false;
      checks: PtcLabBrowserFixedRuntimeProbeChecks;
      errorCode: RuntimeStdoutErrorCode;
    };

type RuntimeStdoutErrorCode =
  | 'browser_runtime_unavailable'
  | 'execution_failed'
  | 'cleanup_failed'
  | 'cleanup_uncertain';

const RUNTIME_STDOUT_ERROR_CODES = [
  'browser_runtime_unavailable',
  'execution_failed',
  'cleanup_failed',
  'cleanup_uncertain',
] as const satisfies readonly RuntimeStdoutErrorCode[];

export async function mapBrowserRuntimeExecution(args: {
  runArgs: RunPtcLabBrowserFixedRuntimeProbeArgs;
  execution: PtcSessionDockerCommandResult;
  durationMs: number;
  handle: PtcSessionDockerHandle;
  policy: PtcLabBrowserRuntimePolicy;
  request: PtcLabBrowserValidatedRuntimeRequest;
}): Promise<PtcLabBrowserRuntimeResult<PtcLabBrowserFixedRuntimeProbeSummary>> {
  if (args.execution.kind === 'timeout') {
    const diagnostics = toBrowserRuntimeTaintDiagnostics(
      await closeTaintedPtcDockerSession(args.runArgs),
    );
    return browserRuntimeFailure(
      'ptc_lab_browser_timeout',
      'PTC lab browser runtime probe timed out',
      diagnostics,
    );
  }
  if (args.execution.kind === 'cancelled') {
    const diagnostics = toBrowserRuntimeTaintDiagnostics(
      await closeTaintedPtcDockerSession(args.runArgs),
    );
    return browserRuntimeFailure(
      'ptc_lab_browser_cancelled',
      'PTC lab browser runtime probe was cancelled',
      diagnostics,
    );
  }
  if (args.execution.kind === 'crash') {
    const diagnostics = toBrowserRuntimeTaintDiagnostics(
      await closeTaintedPtcDockerSession(args.runArgs),
    );
    return browserRuntimeFailure(
      'ptc_lab_browser_execution_failed',
      'PTC lab browser runtime probe failed to execute',
      { commandResultKind: 'crash', ...(diagnostics ?? {}) },
    );
  }

  const parsed = parseRuntimeStdout(args.execution.stdout);
  if (!parsed.ok) {
    return parsed;
  }
  if (!parsed.value.ok) {
    if (
      parsed.value.errorCode === 'cleanup_failed' ||
      parsed.value.errorCode === 'cleanup_uncertain'
    ) {
      const diagnostics = toBrowserRuntimeTaintDiagnostics(
        await closeTaintedPtcDockerSession(args.runArgs),
      );
      return browserRuntimeFailure(
        parsed.value.errorCode === 'cleanup_failed'
          ? 'ptc_lab_browser_cleanup_failed'
          : 'ptc_lab_browser_cleanup_uncertain',
        'PTC lab browser runtime probe cleanup was not proven',
        diagnostics,
      );
    }
    return browserRuntimeFailure(
      mapRuntimeErrorCode(parsed.value.errorCode),
      parsed.value.errorCode === 'browser_runtime_unavailable'
        ? 'PTC lab browser runtime is unavailable'
        : 'PTC lab browser runtime probe failed',
    );
  }
  if (args.execution.exitCode !== 0 || !allChecksPassed(parsed.value.checks)) {
    return browserRuntimeFailure(
      'ptc_lab_browser_output_invalid',
      'PTC lab browser runtime probe stdout has inconsistent success shape',
    );
  }

  return {
    ok: true,
    value: {
      ok: true,
      profile: 'lab',
      capability: PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_CAPABILITY,
      policyId: args.policy.policyId,
      labSessionId: buildPtcLabPublicSessionId(args.handle),
      probeId: args.request.probeId,
      browserPolicyId: args.policy.browser.browserPolicyId,
      browserMode: args.policy.browser.mode,
      browserRuntimeEnginePolicyId: args.policy.browser.runtimeEnginePolicyId,
      browserNetworkPolicyId: args.policy.browser.networkPolicyId,
      browserTelemetryPolicyId: args.policy.browser.telemetryPolicyId,
      browserOutputPolicy: args.policy.browser.outputPolicy,
      browserProfilePolicyId: args.policy.browser.profilePolicyId,
      browserCookieStorePolicyId: args.policy.browser.cookieStorePolicyId,
      browserArtifactExportPolicyId: args.policy.browser.artifactExportPolicyId,
      browserProfile: 'none',
      browserCookies: 'none',
      artifactExported: false,
      checks: parsed.value.checks,
      durationMs: args.durationMs,
    },
  };
}

export function browserRuntimeSessionUnavailable(
  reasonCode: PtcSessionDockerFailureReason | 'session_manager_threw',
): PtcLabBrowserRuntimeResult<never> {
  return browserRuntimeFailure(
    'ptc_lab_browser_session_unavailable',
    'PTC lab browser runtime session is unavailable',
    { sessionReasonCode: reasonCode },
  );
}

function toBrowserRuntimeTaintDiagnostics(
  outcome: PtcSessionTaintCloseOutcome,
): Record<string, string | number | boolean> | undefined {
  if (outcome.closeProven) {
    return undefined;
  }
  return {
    sessionTainted: true,
    sessionCloseFailed: true,
    ...(outcome.closeStatus === 'failed_result'
      ? { sessionReasonCode: outcome.sessionReasonCode }
      : {}),
  };
}

function parseRuntimeStdout(
  stdout: string,
): PtcLabBrowserRuntimeResult<ParsedRuntimeStdout> {
  const parsed = parsePtcLabBrowserAdapterStdout({
    capability: PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_CAPABILITY,
    errorCodes: RUNTIME_STDOUT_ERROR_CODES,
    extraForbiddenKeys:
      PTC_LAB_BROWSER_SUMMARY_ONLY_EXTRA_FORBIDDEN_OUTPUT_KEYS,
    isChecks,
    maxStdoutBytes: PTC_LAB_BROWSER_RUNTIME_MAX_STDOUT_BYTES,
    stdout,
  });
  if (!parsed.ok) {
    return outputInvalid(
      formatPtcLabBrowserAdapterStdoutParseFailure({
        reason: parsed.reason,
        subject: 'runtime probe',
      }),
    );
  }
  return { ok: true, value: parsed.value };
}

function outputInvalid(message: string): PtcLabBrowserRuntimeResult<never> {
  return browserRuntimeFailure('ptc_lab_browser_output_invalid', message);
}

function mapRuntimeErrorCode(
  errorCode: Extract<ParsedRuntimeStdout, { ok: false }>['errorCode'],
): PtcLabBrowserRuntimeFailureReason {
  return errorCode === 'browser_runtime_unavailable'
    ? 'ptc_lab_browser_runtime_unavailable'
    : 'ptc_lab_browser_execution_failed';
}

function allChecksPassed(
  checks: PtcLabBrowserFixedRuntimeProbeChecks,
): boolean {
  return (
    checks.engineAvailable &&
    checks.contextCreated &&
    checks.controlledDocumentReady &&
    checks.cleanupCompleted
  );
}

function isChecks(
  value: unknown,
): value is PtcLabBrowserFixedRuntimeProbeChecks {
  return (
    isRecord(value) &&
    typeof value.engineAvailable === 'boolean' &&
    typeof value.contextCreated === 'boolean' &&
    typeof value.controlledDocumentReady === 'boolean' &&
    typeof value.cleanupCompleted === 'boolean'
  );
}
