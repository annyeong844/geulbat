import type {
  PtcLabAdmittedProfile,
  PtcLabPolicyProjection,
} from './lab-profile.js';
import { sanitizePtcOutput } from './output-redaction.js';
import { runPtcSessionDockerCommand } from './session-docker-command.js';
import type {
  PtcSessionDockerCommandResult,
  PtcSessionDockerCommandRunner,
} from './session-docker-contract.js';
import type { PtcLabBatchCommandFailureReason } from './lab-session-batch-command-contract.js';

export const PTC_LAB_BATCH_COMMAND_MAX_COMMAND_CHARS = 32 * 1024;
export const PTC_LAB_BATCH_COMMAND_OUTPUT_EXCERPT_BYTES = 16 * 1024;

export type PtcLabBatchCommandExecutionResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reasonCode: PtcLabBatchCommandFailureReason;
      message: string;
      diagnostics?: Record<string, string | number | boolean>;
    };

export interface PtcLabBatchCommandRequest {
  command: string;
  timeoutMs?: number;
}

export interface PtcLabBatchCommandSessionHandle {
  profile: 'lab';
  labSessionId: string;
  containerId: string;
  policyId: string;
}

export interface PtcLabBatchCommandRunnerInvocation {
  executable: string;
  args: string[];
  timeoutMs: number;
  maxProcessCount: number;
  signal?: AbortSignal;
}

export type PtcLabBatchCommandRunnerResult =
  | { kind: 'exit'; exitCode: number; stdout: string; stderr: string }
  | {
      kind: 'timeout';
      stdout: string;
      stderr: string;
      processTerminated: boolean;
    }
  | {
      kind: 'cancelled';
      stdout: string;
      stderr: string;
      processTerminated: boolean;
    }
  | {
      kind: 'interpreter_unavailable';
      stdout: string;
      stderr: string;
    }
  | { kind: 'failed'; stdout: string; stderr: string };

export type PtcLabBatchCommandRunner = (
  invocation: PtcLabBatchCommandRunnerInvocation,
) => Promise<PtcLabBatchCommandRunnerResult>;

export interface PtcLabBatchCommandSessionTaint {
  labSessionId: string;
  containerId: string;
  reasonCode: 'ptc_lab_command_timeout' | 'ptc_lab_command_cancelled';
}

export interface RunPtcLabBatchCommandExecutionArgs {
  admission: PtcLabAdmittedProfile | undefined;
  session: PtcLabBatchCommandSessionHandle | undefined;
  request: PtcLabBatchCommandRequest;
  runner?: PtcLabBatchCommandRunner;
  interpreter?: 'bash' | 'sh';
  dockerPath?: string;
  outputExcerptByteLimit?: number;
  now?: () => number;
  signal?: AbortSignal;
  onSessionTainted?: (
    taint: PtcLabBatchCommandSessionTaint,
  ) => Promise<void> | void;
}

export interface PtcLabBatchCommandExecutionSummary {
  ok: true;
  profile: 'lab';
  policyId: string;
  labSessionId: string;
  containerId: string;
  executionClass: 'lab_batch_command';
  interpreter: 'bash' | 'sh';
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  effectiveTimeoutMs: number;
  durationMs: number;
}

export async function runPtcLabBatchCommandExecution(
  args: RunPtcLabBatchCommandExecutionArgs,
): Promise<
  PtcLabBatchCommandExecutionResult<PtcLabBatchCommandExecutionSummary>
> {
  const policyResult = readAdmittedBatchCommandPolicy(args.admission);
  if (!policyResult.ok) {
    return policyResult;
  }
  const policy = policyResult.value;

  if (!args.session) {
    return failure(
      'ptc_lab_session_unavailable',
      'PTC lab command session is unavailable',
    );
  }
  if (
    args.session.profile !== 'lab' ||
    args.session.policyId !== policy.policyId
  ) {
    return failure(
      'ptc_lab_policy_mismatch',
      'PTC lab command session does not match admitted policy',
    );
  }

  const request = validateCommandRequest(args.request, policy);
  if (!request.ok) {
    return request;
  }

  const interpreter = args.interpreter ?? 'bash';
  const outputLimit =
    args.outputExcerptByteLimit ?? PTC_LAB_BATCH_COMMAND_OUTPUT_EXCERPT_BYTES;
  const start = (args.now ?? Date.now)();
  let runnerResult: PtcLabBatchCommandRunnerResult;
  try {
    runnerResult = await (args.runner ?? runDefaultDockerRunner)({
      executable: args.dockerPath ?? 'docker',
      args: buildDockerExecArgs({
        containerId: args.session.containerId,
        interpreter,
        command: request.value.command,
      }),
      timeoutMs: request.value.effectiveTimeoutMs,
      maxProcessCount: policy.shell.maxProcessCount,
      ...(args.signal ? { signal: args.signal } : {}),
    });
  } catch {
    return failure(
      'ptc_lab_command_failed',
      'PTC lab batch command runner failed',
    );
  }
  const durationMs = Math.max(0, (args.now ?? Date.now)() - start);

  return await mapRunnerResult({
    runnerResult,
    args,
    session: args.session,
    policy,
    interpreter,
    effectiveTimeoutMs: request.value.effectiveTimeoutMs,
    durationMs,
    outputLimit,
  });
}

function readAdmittedBatchCommandPolicy(
  admission: PtcLabAdmittedProfile | undefined,
): PtcLabBatchCommandExecutionResult<PtcLabPolicyProjection> {
  if (
    admission === undefined ||
    admission.metadata.selectedProfile !== 'lab' ||
    admission.labPolicy === undefined
  ) {
    return failure(
      'ptc_lab_admission_required',
      'PTC lab batch command requires an admitted lab profile',
    );
  }
  if (admission.labPolicy.shell.mode !== 'batch_command') {
    return failure(
      'ptc_lab_shell_disabled',
      'PTC lab batch command requires batch_command shell mode',
    );
  }
  if (
    admission.labPolicy.shell.maxCommandMs <= 0 ||
    admission.labPolicy.shell.maxProcessCount <= 0
  ) {
    return failure(
      'ptc_lab_shell_disabled',
      'PTC lab batch command shell policy is disabled',
    );
  }
  return { ok: true, value: admission.labPolicy };
}

function validateCommandRequest(
  request: PtcLabBatchCommandRequest,
  policy: PtcLabPolicyProjection,
): PtcLabBatchCommandExecutionResult<{
  command: string;
  effectiveTimeoutMs: number;
}> {
  if (
    typeof request.command !== 'string' ||
    request.command.trim().length === 0 ||
    request.command.length > PTC_LAB_BATCH_COMMAND_MAX_COMMAND_CHARS
  ) {
    return failure(
      'ptc_lab_command_invalid',
      'PTC lab batch command input is invalid',
    );
  }

  const effectiveTimeoutMs = request.timeoutMs ?? policy.shell.maxCommandMs;
  if (
    !Number.isFinite(effectiveTimeoutMs) ||
    !Number.isInteger(effectiveTimeoutMs) ||
    effectiveTimeoutMs <= 0 ||
    effectiveTimeoutMs > policy.shell.maxCommandMs
  ) {
    return failure(
      'ptc_lab_command_invalid',
      'PTC lab batch command timeout is invalid',
    );
  }

  return { ok: true, value: { command: request.command, effectiveTimeoutMs } };
}

function buildDockerExecArgs(args: {
  containerId: string;
  interpreter: 'bash' | 'sh';
  command: string;
}): string[] {
  const executable = args.interpreter === 'bash' ? '/bin/bash' : '/bin/sh';
  return ['exec', args.containerId, executable, '-lc', args.command];
}

const runDefaultDockerRunner: PtcLabBatchCommandRunner =
  adaptPtcSessionDockerCommandRunner(runPtcSessionDockerCommand);

export function adaptPtcSessionDockerCommandRunner(
  commandRunner: PtcSessionDockerCommandRunner,
): PtcLabBatchCommandRunner {
  return async (invocation) => {
    const result = await commandRunner({
      executable: invocation.executable,
      args: invocation.args,
      timeoutMs: invocation.timeoutMs,
      ...(invocation.signal ? { signal: invocation.signal } : {}),
    });
    return mapPtcSessionDockerCommandResult(result);
  };
}

function mapPtcSessionDockerCommandResult(
  result: PtcSessionDockerCommandResult,
): PtcLabBatchCommandRunnerResult {
  if (result.kind === 'exit') {
    if (result.exitCode === 126 || result.exitCode === 127) {
      return {
        kind: 'interpreter_unavailable',
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }
    return {
      kind: 'exit',
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  if (result.kind === 'timeout') {
    return {
      kind: 'timeout',
      stdout: result.stdout,
      stderr: result.stderr,
      processTerminated: false,
    };
  }
  if (result.kind === 'cancelled') {
    return {
      kind: 'cancelled',
      stdout: result.stdout,
      stderr: result.stderr,
      processTerminated: false,
    };
  }
  return { kind: 'failed', stdout: result.stdout, stderr: result.stderr };
}

async function mapRunnerResult(args: {
  runnerResult: PtcLabBatchCommandRunnerResult;
  args: RunPtcLabBatchCommandExecutionArgs;
  session: PtcLabBatchCommandSessionHandle;
  policy: PtcLabPolicyProjection;
  interpreter: 'bash' | 'sh';
  effectiveTimeoutMs: number;
  durationMs: number;
  outputLimit: number;
}): Promise<
  PtcLabBatchCommandExecutionResult<PtcLabBatchCommandExecutionSummary>
> {
  switch (args.runnerResult.kind) {
    case 'exit': {
      const stdout = sanitizePtcOutput(
        args.runnerResult.stdout,
        args.outputLimit,
      );
      const stderr = sanitizePtcOutput(
        args.runnerResult.stderr,
        args.outputLimit,
      );
      return {
        ok: true,
        value: {
          ok: true,
          profile: 'lab',
          policyId: args.policy.policyId,
          labSessionId: args.session.labSessionId,
          containerId: args.session.containerId,
          executionClass: 'lab_batch_command',
          interpreter: args.interpreter,
          exitCode: args.runnerResult.exitCode,
          stdout: stdout.value,
          stderr: stderr.value,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          effectiveTimeoutMs: args.effectiveTimeoutMs,
          durationMs: args.durationMs,
        },
      };
    }
    case 'timeout': {
      const timeoutTaint = await maybeTaintSession({
        args: args.args,
        session: args.session,
        reasonCode: 'ptc_lab_command_timeout',
        processTerminated: args.runnerResult.processTerminated,
      });
      return failure(
        'ptc_lab_command_timeout',
        'PTC lab batch command timed out',
        timeoutTaint.ok ? undefined : { taintHookFailed: true },
      );
    }
    case 'cancelled': {
      const cancelTaint = await maybeTaintSession({
        args: args.args,
        session: args.session,
        reasonCode: 'ptc_lab_command_cancelled',
        processTerminated: args.runnerResult.processTerminated,
      });
      return failure(
        'ptc_lab_command_cancelled',
        'PTC lab batch command was cancelled',
        cancelTaint.ok ? undefined : { taintHookFailed: true },
      );
    }
    case 'interpreter_unavailable':
      return failure(
        'ptc_lab_interpreter_unavailable',
        'PTC lab batch command interpreter is unavailable',
      );
    case 'failed':
      return failure('ptc_lab_command_failed', 'PTC lab batch command failed');
  }
}

async function maybeTaintSession(args: {
  args: RunPtcLabBatchCommandExecutionArgs;
  session: PtcLabBatchCommandSessionHandle;
  reasonCode: 'ptc_lab_command_timeout' | 'ptc_lab_command_cancelled';
  processTerminated: boolean;
}): Promise<{ ok: true } | { ok: false }> {
  if (args.processTerminated) {
    return { ok: true };
  }
  try {
    await args.args.onSessionTainted?.({
      labSessionId: args.session.labSessionId,
      containerId: args.session.containerId,
      reasonCode: args.reasonCode,
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

function failure(
  reasonCode: PtcLabBatchCommandFailureReason,
  message: string,
  diagnostics?: Record<string, string | number | boolean>,
): PtcLabBatchCommandExecutionResult<never> {
  return diagnostics === undefined
    ? { ok: false, reasonCode, message }
    : { ok: false, reasonCode, message, diagnostics };
}
