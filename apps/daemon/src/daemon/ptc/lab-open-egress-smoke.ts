import { isRecord } from '@geulbat/protocol/runtime-utils';
import type { PtcLabAdmittedProfile } from './lab-profile.js';
import {
  buildPtcLabNetworkTelemetrySummary,
  doesPtcLabOpenNetworkSessionMatchPolicy,
  type PtcLabNetworkTelemetrySummary,
} from './lab-network-policy.js';
import { buildPtcLabPublicSessionId } from './lab-session-public-id.js';
import { runPtcSessionDockerCommand } from './session-docker-command.js';
import {
  closeTaintedPtcDockerSession,
  type PtcSessionTaintCloseOutcome,
} from './session-taint-close.js';
import type {
  PtcSessionDockerCommandResult,
  PtcSessionDockerCommandRunner,
  PtcSessionDockerFailureReason,
  PtcSessionDockerHandle,
  PtcSessionDockerIdentity,
  PtcSessionDockerManager,
} from './session-docker-contract.js';

export const PTC_LAB_OPEN_EGRESS_SMOKE_POLICY_ID =
  'ptc_lab_open_egress_smoke_v1' as const;
export const PTC_LAB_OPEN_EGRESS_SMOKE_TARGET_POLICY_ID =
  'ptc_lab_open_egress_iana_example_https_head_v1' as const;
const PTC_LAB_OPEN_EGRESS_SMOKE_DEFAULT_TIMEOUT_MS = 5_000;
const PTC_LAB_OPEN_EGRESS_SMOKE_MAX_TIMEOUT_MS = 15_000;
const MAX_SMOKE_STDOUT_BYTES = 4 * 1024;

export const PTC_LAB_OPEN_EGRESS_SMOKE_SCRIPT = String.raw`
const https = require('node:https');

function finish(exitCode, payload) {
  process.stdout.write(JSON.stringify(payload) + '\n', () => {
    process.exit(exitCode);
  });
}

const request = https.request('https://example.com/', {
  method: 'HEAD',
  timeout: 4_000,
  headers: { 'user-agent': 'geulbat-ptc-open-egress-smoke/1' },
}, (response) => {
  response.resume();
  const statusCode = typeof response.statusCode === 'number' ? response.statusCode : 0;
  const statusClass = Math.trunc(statusCode / 100);
  const ok = statusClass >= 2 && statusClass <= 4;
  finish(ok ? 0 : 2, { ok, statusClass });
});

request.on('timeout', () => {
  request.destroy(new Error('ptc_open_egress_smoke_timeout'));
});
request.on('error', () => {
  finish(2, { ok: false, errorCode: 'egress_request_failed' });
});
request.end();
`;

export type PtcLabOpenEgressSmokeFailureReason =
  | 'ptc_lab_open_egress_admission_required'
  | 'ptc_lab_open_egress_policy_disabled'
  | 'ptc_lab_open_egress_policy_mismatch'
  | 'ptc_lab_open_egress_request_invalid'
  | 'ptc_lab_open_egress_session_unavailable'
  | 'ptc_lab_open_egress_execution_failed'
  | 'ptc_lab_open_egress_timeout'
  | 'ptc_lab_open_egress_cancelled'
  | 'ptc_lab_open_egress_output_invalid';

export type PtcLabOpenEgressSmokeResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reasonCode: PtcLabOpenEgressSmokeFailureReason;
      message: string;
      diagnostics?: Record<string, string | number | boolean>;
    };

export interface PtcLabOpenEgressSmokeRequest {
  smokeId: string;
  timeoutMs?: number;
}

export interface PtcLabOpenEgressSmokeSummary {
  ok: true;
  profile: 'lab';
  policyId: string;
  labSessionId: string;
  smokeId: string;
  smokePolicyId: typeof PTC_LAB_OPEN_EGRESS_SMOKE_POLICY_ID;
  targetPolicyId: typeof PTC_LAB_OPEN_EGRESS_SMOKE_TARGET_POLICY_ID;
  executionClass: 'ptc_lab_open_egress_smoke';
  exitCode: number;
  durationMs: number;
  networkTelemetry: PtcLabNetworkTelemetrySummary;
}

export interface RunPtcLabOpenEgressSmokeArgs {
  admission: PtcLabAdmittedProfile | undefined;
  identity: PtcSessionDockerIdentity;
  sessionManager: PtcSessionDockerManager;
  request: PtcLabOpenEgressSmokeRequest;
  commandRunner?: PtcSessionDockerCommandRunner;
  dockerPath?: string;
  now?: () => number;
  signal?: AbortSignal;
}

export async function runPtcLabOpenEgressSmoke(
  args: RunPtcLabOpenEgressSmokeArgs,
): Promise<PtcLabOpenEgressSmokeResult<PtcLabOpenEgressSmokeSummary>> {
  const policy = readOpenEgressPolicy(args.admission);
  if (!policy.ok) {
    return policy;
  }
  const request = validateSmokeRequest(args.request);
  if (!request.ok) {
    return request;
  }

  let handle: PtcSessionDockerHandle;
  try {
    const session = await args.sessionManager.getOrCreate(
      args.identity,
      args.signal === undefined ? undefined : { signal: args.signal },
    );
    if (!session.ok) {
      return sessionUnavailable(session.reasonCode);
    }
    handle = session.value;
  } catch {
    return sessionUnavailable('session_manager_threw');
  }

  const sessionValidation = validateSmokeSession({
    handle,
    policyId: policy.value.policyId,
    network: policy.value.network,
  });
  if (!sessionValidation.ok) {
    return sessionValidation;
  }

  const start = (args.now ?? Date.now)();
  let execution: PtcSessionDockerCommandResult;
  try {
    execution = await (args.commandRunner ?? runPtcSessionDockerCommand)({
      executable: args.dockerPath ?? 'docker',
      args: [
        'exec',
        handle.containerId,
        'node',
        '-e',
        PTC_LAB_OPEN_EGRESS_SMOKE_SCRIPT,
      ],
      timeoutMs: request.value.timeoutMs,
      ...(args.signal ? { signal: args.signal } : {}),
    });
  } catch {
    return failure(
      'ptc_lab_open_egress_execution_failed',
      'PTC lab open egress smoke runner failed',
      { commandResultKind: 'thrown' },
    );
  }

  const durationMs = Math.max(0, (args.now ?? Date.now)() - start);
  return await mapSmokeExecution({
    args,
    execution,
    durationMs,
    handle,
    policyId: policy.value.policyId,
    networkPolicy: policy.value.network,
    request: request.value,
  });
}

function readOpenEgressPolicy(
  admission: PtcLabAdmittedProfile | undefined,
): PtcLabOpenEgressSmokeResult<{
  policyId: string;
  network: Extract<
    NonNullable<PtcLabAdmittedProfile['labPolicy']>['network'],
    { mode: 'open' }
  >;
}> {
  if (
    admission === undefined ||
    admission.metadata.selectedProfile !== 'lab' ||
    admission.labPolicy === undefined
  ) {
    return failure(
      'ptc_lab_open_egress_admission_required',
      'PTC lab open egress smoke requires an admitted lab profile',
    );
  }
  if (admission.labPolicy.network.mode !== 'open') {
    return failure(
      'ptc_lab_open_egress_policy_disabled',
      'PTC lab open egress policy is disabled',
    );
  }
  if (admission.labPolicy.network.metricsCoverage === 'runtime_observed') {
    return failure(
      'ptc_lab_open_egress_policy_disabled',
      'PTC lab runtime-observed network telemetry is not supported',
    );
  }
  return {
    ok: true,
    value: {
      policyId: admission.labPolicy.policyId,
      network: admission.labPolicy.network,
    },
  };
}

function validateSmokeRequest(
  request: PtcLabOpenEgressSmokeRequest,
): PtcLabOpenEgressSmokeResult<{
  smokeId: string;
  timeoutMs: number;
}> {
  if (!isSafeSmokeId(request.smokeId)) {
    return requestInvalid();
  }
  const timeoutMs =
    request.timeoutMs ?? PTC_LAB_OPEN_EGRESS_SMOKE_DEFAULT_TIMEOUT_MS;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > PTC_LAB_OPEN_EGRESS_SMOKE_MAX_TIMEOUT_MS
  ) {
    return requestInvalid();
  }
  return { ok: true, value: { smokeId: request.smokeId, timeoutMs } };
}

function validateSmokeSession(args: {
  handle: PtcSessionDockerHandle;
  policyId: string;
  network: Extract<
    NonNullable<PtcLabAdmittedProfile['labPolicy']>['network'],
    { mode: 'open' }
  >;
}): PtcLabOpenEgressSmokeResult<void> {
  if (!doesPtcLabOpenNetworkSessionMatchPolicy(args)) {
    return failure(
      'ptc_lab_open_egress_policy_mismatch',
      'PTC lab open egress session does not match admitted policy',
    );
  }
  return { ok: true, value: undefined };
}

async function mapSmokeExecution(args: {
  args: RunPtcLabOpenEgressSmokeArgs;
  execution: PtcSessionDockerCommandResult;
  durationMs: number;
  handle: PtcSessionDockerHandle;
  policyId: string;
  networkPolicy: Extract<
    NonNullable<PtcLabAdmittedProfile['labPolicy']>['network'],
    { mode: 'open' }
  >;
  request: { smokeId: string; timeoutMs: number };
}): Promise<PtcLabOpenEgressSmokeResult<PtcLabOpenEgressSmokeSummary>> {
  if (args.execution.kind === 'timeout') {
    const diagnostics = toOpenEgressTaintDiagnostics(
      await closeTaintedPtcDockerSession(args.args),
    );
    return failure(
      'ptc_lab_open_egress_timeout',
      'PTC lab open egress smoke timed out',
      diagnostics,
    );
  }
  if (args.execution.kind === 'cancelled') {
    const diagnostics = toOpenEgressTaintDiagnostics(
      await closeTaintedPtcDockerSession(args.args),
    );
    return failure(
      'ptc_lab_open_egress_cancelled',
      'PTC lab open egress smoke was cancelled',
      diagnostics,
    );
  }
  if (args.execution.kind === 'crash') {
    return failure(
      'ptc_lab_open_egress_execution_failed',
      'PTC lab open egress smoke failed to execute',
      { commandResultKind: 'crash' },
    );
  }

  const parsed = parseSmokeStdout(args.execution.stdout);
  if (!parsed.ok) {
    return parsed;
  }

  const outcome = args.execution.exitCode === 0 ? 'completed' : 'failed';
  const telemetry = buildPtcLabNetworkTelemetrySummary({
    policy: args.networkPolicy,
    ownerKind: 'network_smoke',
    outcome,
    networkOpened: true,
    durationMs: args.durationMs,
    metricsCoverage: 'owner_outcome_only',
  });

  return {
    ok: true,
    value: {
      ok: true,
      profile: 'lab',
      policyId: args.policyId,
      labSessionId: buildPtcLabPublicSessionId(args.handle),
      smokeId: args.request.smokeId,
      smokePolicyId: PTC_LAB_OPEN_EGRESS_SMOKE_POLICY_ID,
      targetPolicyId: PTC_LAB_OPEN_EGRESS_SMOKE_TARGET_POLICY_ID,
      executionClass: 'ptc_lab_open_egress_smoke',
      exitCode: args.execution.exitCode,
      durationMs: args.durationMs,
      networkTelemetry: telemetry,
    },
  };
}

function toOpenEgressTaintDiagnostics(
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

function parseSmokeStdout(stdout: string): PtcLabOpenEgressSmokeResult<void> {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_SMOKE_STDOUT_BYTES) {
    return failure(
      'ptc_lab_open_egress_output_invalid',
      'PTC lab open egress smoke stdout is too large',
    );
  }
  const trimmed = stdout.trim();
  if (trimmed.length === 0 || trimmed.includes('\n')) {
    return failure(
      'ptc_lab_open_egress_output_invalid',
      'PTC lab open egress smoke stdout must be one JSON line',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return failure(
      'ptc_lab_open_egress_output_invalid',
      'PTC lab open egress smoke stdout is not valid JSON',
    );
  }
  if (!isRecord(parsed) || typeof parsed.ok !== 'boolean') {
    return failure(
      'ptc_lab_open_egress_output_invalid',
      'PTC lab open egress smoke stdout has invalid shape',
    );
  }
  return { ok: true, value: undefined };
}

function sessionUnavailable(
  reasonCode: PtcSessionDockerFailureReason | 'session_manager_threw',
): PtcLabOpenEgressSmokeResult<never> {
  return failure(
    'ptc_lab_open_egress_session_unavailable',
    'PTC lab open egress session is unavailable',
    { sessionReasonCode: reasonCode },
  );
}

function requestInvalid(): PtcLabOpenEgressSmokeResult<never> {
  return failure(
    'ptc_lab_open_egress_request_invalid',
    'PTC lab open egress smoke request is invalid',
  );
}

function failure(
  reasonCode: PtcLabOpenEgressSmokeFailureReason,
  message: string,
  diagnostics?: Record<string, string | number | boolean>,
): PtcLabOpenEgressSmokeResult<never> {
  return diagnostics === undefined
    ? { ok: false, reasonCode, message }
    : { ok: false, reasonCode, message, diagnostics };
}

function isSafeSmokeId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(value);
}
