import type { PtcLabAdmittedProfile } from './lab-profile.js';
import {
  runPtcLabBatchCommandExecution,
  type PtcLabBatchCommandExecutionResult,
  type PtcLabBatchCommandExecutionSummary,
  type PtcLabBatchCommandFailureReason,
  type PtcLabBatchCommandRequest,
  type PtcLabBatchCommandRunner,
  type PtcLabBatchCommandSessionHandle,
} from './lab-command-execution.js';
import type {
  PtcSessionDockerFailureReason,
  PtcSessionDockerHandle,
  PtcSessionDockerIdentity,
  PtcSessionDockerManager,
} from './session-docker.js';

export type PtcLabSessionBatchCommandFailureReason =
  | PtcLabBatchCommandFailureReason
  | 'ptc_lab_session_unavailable'
  | 'ptc_lab_session_busy';

export type PtcLabSessionBatchCommandResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reasonCode: PtcLabSessionBatchCommandFailureReason;
      message: string;
      diagnostics?: Record<string, string | number | boolean>;
    };

export type PtcLabSessionBatchCommandExecutor =
  typeof runPtcLabBatchCommandExecution;

export interface CreatePtcLabSessionBatchCommandRunnerArgs {
  sessionManager: PtcSessionDockerManager;
  commandExecutor?: PtcLabSessionBatchCommandExecutor;
}

export interface RunPtcLabSessionBatchCommandArgs {
  admission: PtcLabAdmittedProfile | undefined;
  identity: PtcSessionDockerIdentity;
  request: PtcLabBatchCommandRequest;
  runner?: PtcLabBatchCommandRunner;
  interpreter?: 'bash' | 'sh';
  dockerPath?: string;
  outputExcerptByteLimit?: number;
  now?: () => number;
  signal?: AbortSignal;
}

export interface PtcLabSessionBatchCommandRunner {
  runPtcLabSessionBatchCommand(
    args: RunPtcLabSessionBatchCommandArgs,
  ): Promise<
    PtcLabSessionBatchCommandResult<PtcLabBatchCommandExecutionSummary>
  >;
}

export function createPtcLabSessionBatchCommandRunner(
  args: CreatePtcLabSessionBatchCommandRunnerArgs,
): PtcLabSessionBatchCommandRunner {
  const commandExecutor =
    args.commandExecutor ?? runPtcLabBatchCommandExecution;
  const activeCommands = new Set<string>();

  return {
    async runPtcLabSessionBatchCommand(runArgs) {
      if (
        runArgs.admission === undefined ||
        runArgs.admission.metadata.selectedProfile !== 'lab' ||
        runArgs.admission.labPolicy === undefined
      ) {
        return failure(
          'ptc_lab_admission_required',
          'PTC lab batch command requires an admitted lab profile',
        );
      }

      let handle: PtcSessionDockerHandle;
      try {
        const session = await args.sessionManager.getOrCreate(
          runArgs.identity,
          runArgs.signal === undefined ? undefined : { signal: runArgs.signal },
        );
        if (!session.ok) {
          return sessionUnavailable(session.reasonCode);
        }
        handle = session.value;
      } catch {
        return sessionUnavailable('session_manager_threw');
      }

      const busyKey = handle.reuseKey.identityHash;
      if (activeCommands.has(busyKey)) {
        return failure(
          'ptc_lab_session_busy',
          'PTC lab session already has an active batch command',
        );
      }

      activeCommands.add(busyKey);
      try {
        const sessionHandle = projectBatchSessionHandle({
          handle,
          policyId: runArgs.admission.labPolicy.policyId,
        });

        let taintCloseDiagnostics:
          | { sessionCloseFailed: true; sessionReasonCode?: string }
          | undefined;

        let command: PtcLabBatchCommandExecutionResult<PtcLabBatchCommandExecutionSummary>;
        try {
          command = await commandExecutor({
            admission: runArgs.admission,
            session: sessionHandle,
            request: runArgs.request,
            ...(runArgs.runner ? { runner: runArgs.runner } : {}),
            ...(runArgs.interpreter
              ? { interpreter: runArgs.interpreter }
              : {}),
            ...(runArgs.dockerPath ? { dockerPath: runArgs.dockerPath } : {}),
            ...(runArgs.outputExcerptByteLimit !== undefined
              ? { outputExcerptByteLimit: runArgs.outputExcerptByteLimit }
              : {}),
            ...(runArgs.now ? { now: runArgs.now } : {}),
            ...(runArgs.signal ? { signal: runArgs.signal } : {}),
            onSessionTainted: async () => {
              try {
                const close = await args.sessionManager.close(runArgs.identity);
                if (!close.ok) {
                  taintCloseDiagnostics = {
                    sessionCloseFailed: true,
                    sessionReasonCode: close.reasonCode,
                  };
                }
              } catch {
                taintCloseDiagnostics = { sessionCloseFailed: true };
              }
            },
          });
        } catch {
          return failure(
            'ptc_lab_command_failed',
            'PTC lab batch command execution failed',
          );
        }

        return mergeTaintDiagnostics(command, taintCloseDiagnostics);
      } finally {
        activeCommands.delete(busyKey);
      }
    },
  };
}

function projectBatchSessionHandle(args: {
  handle: PtcSessionDockerHandle;
  policyId: string;
}): PtcLabBatchCommandSessionHandle {
  return {
    profile: 'lab',
    labSessionId: `ptc-lab-${args.handle.reuseKey.identityHash.slice(0, 32)}`,
    containerId: args.handle.containerId,
    policyId: args.policyId,
  };
}

function mergeTaintDiagnostics(
  command: PtcLabBatchCommandExecutionResult<PtcLabBatchCommandExecutionSummary>,
  taintCloseDiagnostics:
    | { sessionCloseFailed: true; sessionReasonCode?: string }
    | undefined,
): PtcLabSessionBatchCommandResult<PtcLabBatchCommandExecutionSummary> {
  if (command.ok || taintCloseDiagnostics === undefined) {
    return command;
  }
  if (
    command.reasonCode !== 'ptc_lab_command_timeout' &&
    command.reasonCode !== 'ptc_lab_command_cancelled'
  ) {
    return command;
  }
  return {
    ...command,
    diagnostics: {
      ...(command.diagnostics ?? {}),
      ...taintCloseDiagnostics,
    },
  };
}

function sessionUnavailable(
  reasonCode: PtcSessionDockerFailureReason | 'session_manager_threw',
): PtcLabSessionBatchCommandResult<never> {
  return failure(
    'ptc_lab_session_unavailable',
    'PTC lab session container is unavailable',
    { sessionReasonCode: reasonCode },
  );
}

function failure(
  reasonCode: PtcLabSessionBatchCommandFailureReason,
  message: string,
  diagnostics?: Record<string, string | number | boolean>,
): PtcLabSessionBatchCommandResult<never> {
  return diagnostics === undefined
    ? { ok: false, reasonCode, message }
    : { ok: false, reasonCode, message, diagnostics };
}
