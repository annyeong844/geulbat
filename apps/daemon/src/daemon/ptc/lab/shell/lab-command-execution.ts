import type {
  PtcLabAdmittedProfile,
  PtcLabPolicyProjection,
} from '../profile/lab-profile.js';
import {
  admitPtcBoundedTimeoutMs,
  admitPtcLabPolicy,
  ptcFailure,
} from '../../shared/lab-spine.js';
import { sanitizePtcOutput } from '../../shared/output-redaction.js';
import {
  mapPtcSessionDockerNonExitCommandResult,
  runPtcSessionDockerCommand,
} from '../session/session-docker-command.js';
import {
  shouldCloseTaintedPtcDockerSessionForCommandResult,
  type PtcSessionTaintCloseCommandDecision,
} from '../session/session-taint-close.js';
import type {
  PtcSessionDockerCommandInvocation,
  PtcSessionDockerCommandResult,
  PtcSessionDockerCommandRunner,
  PtcSessionDockerMappedNonExitCommandResult,
} from '../session/session-docker-contract.js';
import type { PtcLabBatchCommandFailureReason } from './lab-session-batch-command-contract.js';

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

type PtcLabBatchCommandRunnerInvocation = PtcSessionDockerCommandInvocation & {
  maxProcessCount: number;
  maxBufferedBytesPerStream: number;
};

type PtcLabBatchCommandRunnerExitResult = Extract<
  PtcSessionDockerCommandResult,
  { kind: 'exit' }
>;

export type PtcLabBatchCommandRunnerResult =
  | PtcLabBatchCommandRunnerExitResult
  | PtcSessionDockerMappedNonExitCommandResult<'crash', boolean>
  | {
      kind: 'output_limit_exceeded';
      stdout: string;
      stderr: string;
      stream: 'stdout' | 'stderr';
      maxBufferedBytesPerStream: number;
      processTerminated: boolean;
    }
  | {
      kind: 'interpreter_unavailable';
      stdout: string;
      stderr: string;
    };

export type PtcLabBatchCommandRunner = (
  invocation: PtcLabBatchCommandRunnerInvocation,
) => Promise<PtcLabBatchCommandRunnerResult>;

interface PtcLabBatchCommandSessionTaint {
  labSessionId: string;
  containerId: string;
  reasonCode:
    | 'ptc_lab_command_timeout'
    | 'ptc_lab_command_cancelled'
    | 'ptc_lab_command_output_rejected'
    | 'ptc_lab_command_failed';
}

interface RunPtcLabBatchCommandExecutionArgs {
  admission: PtcLabAdmittedProfile | undefined;
  session: PtcLabBatchCommandSessionHandle | undefined;
  request: PtcLabBatchCommandRequest;
  runner?: PtcLabBatchCommandRunner;
  interpreter?: 'bash' | 'sh';
  dockerPath?: string;
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
  const now = args.now ?? (() => performance.now());
  const start = now();
  let runnerResult: PtcLabBatchCommandRunnerResult;
  try {
    runnerResult = await (args.runner ?? runDefaultDockerRunner)({
      executable: args.dockerPath ?? 'docker',
      args: buildPtcLabBatchDockerExecArgs({
        containerId: args.session.containerId,
        interpreter,
        command: request.value.command,
      }),
      timeoutMs: request.value.effectiveTimeoutMs,
      maxProcessCount: policy.shell.maxProcessCount,
      maxBufferedBytesPerStream: policy.shell.maxBufferedBytesPerStream,
      ...(args.signal ? { signal: args.signal } : {}),
    });
  } catch {
    return failure(
      'ptc_lab_command_failed',
      'PTC lab batch command runner failed',
    );
  }
  const durationMs = Math.max(0, now() - start);

  return await mapRunnerResult({
    runnerResult,
    args,
    session: args.session,
    policy,
    interpreter,
    effectiveTimeoutMs: request.value.effectiveTimeoutMs,
    durationMs,
  });
}

function readAdmittedBatchCommandPolicy(
  admission: PtcLabAdmittedProfile | undefined,
): PtcLabBatchCommandExecutionResult<PtcLabPolicyProjection> {
  const labPolicy = admitPtcLabPolicy(admission);
  if (!labPolicy.ok) {
    return failure(
      'ptc_lab_admission_required',
      'PTC lab batch command requires an admitted lab profile',
    );
  }
  if (labPolicy.value.shell.mode !== 'batch_command') {
    return failure(
      'ptc_lab_shell_disabled',
      'PTC lab batch command requires batch_command shell mode',
    );
  }
  if (
    labPolicy.value.shell.maxCommandMs <= 0 ||
    labPolicy.value.shell.maxProcessCount <= 0 ||
    labPolicy.value.shell.maxBufferedBytesPerStream <= 0
  ) {
    return failure(
      'ptc_lab_shell_disabled',
      'PTC lab batch command shell policy is disabled',
    );
  }
  return { ok: true, value: labPolicy.value };
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
    request.command.trim().length === 0
  ) {
    return failure(
      'ptc_lab_command_invalid',
      'PTC lab batch command input is invalid',
    );
  }

  const timeout = admitPtcBoundedTimeoutMs({
    timeoutMs: request.timeoutMs,
    defaultTimeoutMs: policy.shell.maxCommandMs,
    maxTimeoutMs: policy.shell.maxCommandMs,
  });
  if (!timeout.ok) {
    return failure(
      'ptc_lab_command_invalid',
      'PTC lab batch command timeout is invalid',
    );
  }

  return {
    ok: true,
    value: { command: request.command, effectiveTimeoutMs: timeout.value },
  };
}

export function buildPtcLabBatchDockerExecArgs(args: {
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
      ...(invocation.timeoutMs === undefined
        ? {}
        : { timeoutMs: invocation.timeoutMs }),
      ...(invocation.signal ? { signal: invocation.signal } : {}),
      outputBufferPolicy: {
        maxBufferedBytesPerStream: invocation.maxBufferedBytesPerStream,
      },
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
  if (result.kind === 'output_limit_exceeded') {
    return {
      kind: 'output_limit_exceeded',
      stdout: result.stdout,
      stderr: result.stderr,
      stream: result.stream,
      maxBufferedBytesPerStream: result.maxBufferedBytesPerStream,
      processTerminated: result.processTerminated ?? false,
    };
  }
  return mapPtcSessionDockerNonExitCommandResult(result, 'crash');
}

async function mapRunnerResult(args: {
  runnerResult: PtcLabBatchCommandRunnerResult;
  args: RunPtcLabBatchCommandExecutionArgs;
  session: PtcLabBatchCommandSessionHandle;
  policy: PtcLabPolicyProjection;
  interpreter: 'bash' | 'sh';
  effectiveTimeoutMs: number;
  durationMs: number;
}): Promise<
  PtcLabBatchCommandExecutionResult<PtcLabBatchCommandExecutionSummary>
> {
  switch (args.runnerResult.kind) {
    case 'exit': {
      const stdout = sanitizePtcOutput(args.runnerResult.stdout);
      const stderr = sanitizePtcOutput(args.runnerResult.stderr);
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
          stdout,
          stderr,
          effectiveTimeoutMs: args.effectiveTimeoutMs,
          durationMs: args.durationMs,
        },
      };
    }
    case 'timeout': {
      const timeoutTaint = await maybeTaintSession({
        args: args.args,
        commandResult: args.runnerResult,
        session: args.session,
        reasonCode: 'ptc_lab_command_timeout',
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
        commandResult: args.runnerResult,
        session: args.session,
        reasonCode: 'ptc_lab_command_cancelled',
      });
      return failure(
        'ptc_lab_command_cancelled',
        'PTC lab batch command was cancelled',
        cancelTaint.ok ? undefined : { taintHookFailed: true },
      );
    }
    case 'output_limit_exceeded': {
      const outputTaint = await maybeTaintSession({
        args: args.args,
        commandResult: args.runnerResult,
        session: args.session,
        reasonCode: 'ptc_lab_command_output_rejected',
      });
      return failure(
        'ptc_lab_command_output_rejected',
        'PTC lab batch command output exceeded the policy buffer budget',
        {
          outputStream: args.runnerResult.stream,
          maxBufferedBytesPerStream:
            args.runnerResult.maxBufferedBytesPerStream,
          ...(outputTaint.ok ? {} : { taintHookFailed: true }),
        },
      );
    }
    case 'interpreter_unavailable':
      return failure(
        'ptc_lab_interpreter_unavailable',
        'PTC lab batch command interpreter is unavailable',
      );
    case 'crash': {
      const crashTaint = await maybeTaintSession({
        args: args.args,
        commandResult: args.runnerResult,
        session: args.session,
        reasonCode: 'ptc_lab_command_failed',
      });
      return failure(
        'ptc_lab_command_failed',
        'PTC lab batch command failed',
        crashTaint.ok ? undefined : { taintHookFailed: true },
      );
    }
  }
}

async function maybeTaintSession(args: {
  args: RunPtcLabBatchCommandExecutionArgs;
  commandResult: PtcSessionTaintCloseCommandDecision;
  session: PtcLabBatchCommandSessionHandle;
  reasonCode:
    | 'ptc_lab_command_timeout'
    | 'ptc_lab_command_cancelled'
    | 'ptc_lab_command_output_rejected'
    | 'ptc_lab_command_failed';
}): Promise<{ ok: true } | { ok: false }> {
  if (!shouldCloseTaintedPtcDockerSessionForCommandResult(args.commandResult)) {
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

const failure = ptcFailure<PtcLabBatchCommandFailureReason>;
