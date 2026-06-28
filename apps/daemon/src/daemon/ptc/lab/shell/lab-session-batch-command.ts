import type { PtcLabAdmittedProfile } from '../profile/lab-profile.js';
import { admitPtcLabPolicy, ptcFailure } from '../../shared/lab-spine.js';
import {
  runPtcLabBatchCommandExecution,
  type PtcLabBatchCommandExecutionResult,
  type PtcLabBatchCommandExecutionSummary,
  type PtcLabBatchCommandRequest,
  type PtcLabBatchCommandRunner,
  type PtcLabBatchCommandSessionHandle,
} from './lab-command-execution.js';
import type { PtcLabSessionBatchCommandFailureReason } from './lab-session-batch-command-contract.js';
import { buildPtcLabPublicSessionId } from './lab-session-public-id.js';
import {
  closeTaintedPtcDockerSession,
  type PtcSessionTaintCloseDiagnostics,
  toPtcSessionTaintCloseDiagnostics,
} from '../session/session-taint-close.js';
import type {
  PtcSessionDockerFailureReason,
  PtcSessionDockerHandle,
  PtcSessionDockerIdentity,
  PtcSessionDockerManager,
} from '../session/session-docker-contract.js';

type PtcLabSessionBatchCommandResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reasonCode: PtcLabSessionBatchCommandFailureReason;
      message: string;
      diagnostics?: Record<string, string | number | boolean>;
    };

type PtcLabSessionBatchCommandExecutor = typeof runPtcLabBatchCommandExecution;

interface CreatePtcLabSessionBatchCommandRunnerArgs {
  sessionManager: PtcSessionDockerManager;
  commandExecutor?: PtcLabSessionBatchCommandExecutor;
}

interface RunPtcLabSessionBatchCommandArgs {
  admission: PtcLabAdmittedProfile | undefined;
  identity: PtcSessionDockerIdentity;
  request: PtcLabBatchCommandRequest;
  runner?: PtcLabBatchCommandRunner;
  interpreter?: 'bash' | 'sh';
  dockerPath?: string;
  now?: () => number;
  signal?: AbortSignal;
}

interface PtcLabSessionBatchCommandRunner {
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
      const labPolicy = admitPtcLabPolicy(runArgs.admission);
      if (!labPolicy.ok) {
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
          policyId: labPolicy.value.policyId,
        });

        let taintCloseDiagnostics: PtcSessionTaintCloseDiagnostics | undefined;

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
            ...(runArgs.now ? { now: runArgs.now } : {}),
            ...(runArgs.signal ? { signal: runArgs.signal } : {}),
            onSessionTainted: async () => {
              taintCloseDiagnostics = toPtcSessionTaintCloseDiagnostics(
                await closeTaintedPtcDockerSession({
                  identity: runArgs.identity,
                  sessionManager: args.sessionManager,
                }),
              );
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
    labSessionId: buildPtcLabPublicSessionId(args.handle),
    containerId: args.handle.containerId,
    policyId: args.policyId,
  };
}

function mergeTaintDiagnostics(
  command: PtcLabBatchCommandExecutionResult<PtcLabBatchCommandExecutionSummary>,
  taintCloseDiagnostics: PtcSessionTaintCloseDiagnostics | undefined,
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

const failure = ptcFailure<PtcLabSessionBatchCommandFailureReason>;
