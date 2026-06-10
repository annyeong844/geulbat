import { runPtcSessionDockerCommand } from './session-docker-command.js';
import type {
  PtcSessionDockerCommandResult,
  PtcSessionDockerCommandRunner,
  PtcSessionDockerFailureReason,
  PtcSessionDockerHandle,
  PtcSessionDockerIdentity,
  PtcSessionDockerManager,
} from './session-docker-contract.js';

export interface RunPtcLabBrowserFixedCommandAttemptArgs<FailureResult> {
  commandRunner?: PtcSessionDockerCommandRunner;
  dockerPath?: string;
  identity: PtcSessionDockerIdentity;
  now?: () => number;
  runnerThrew: () => FailureResult;
  runtimeScript: string;
  sessionManager: PtcSessionDockerManager;
  sessionUnavailable: (
    reasonCode: PtcSessionDockerFailureReason | 'session_manager_threw',
  ) => FailureResult;
  signal?: AbortSignal;
  timeoutMs: number;
  validateSession: (
    handle: PtcSessionDockerHandle,
  ) => { ok: true } | { ok: false; failure: FailureResult };
}

export type PtcLabBrowserFixedCommandAttemptResult<FailureResult> =
  | {
      ok: true;
      durationMs: number;
      execution: PtcSessionDockerCommandResult;
      handle: PtcSessionDockerHandle;
    }
  | { ok: false; failure: FailureResult };

export async function runPtcLabBrowserFixedCommandAttempt<FailureResult>(
  args: RunPtcLabBrowserFixedCommandAttemptArgs<FailureResult>,
): Promise<PtcLabBrowserFixedCommandAttemptResult<FailureResult>> {
  let handle: PtcSessionDockerHandle;
  try {
    const session = await args.sessionManager.getOrCreate(
      args.identity,
      args.signal === undefined ? undefined : { signal: args.signal },
    );
    if (!session.ok) {
      return {
        ok: false,
        failure: args.sessionUnavailable(session.reasonCode),
      };
    }
    handle = session.value;
  } catch {
    return {
      ok: false,
      failure: args.sessionUnavailable('session_manager_threw'),
    };
  }

  const sessionValidation = args.validateSession(handle);
  if (!sessionValidation.ok) {
    return { ok: false, failure: sessionValidation.failure };
  }

  const now = args.now ?? Date.now;
  const start = now();
  let execution: PtcSessionDockerCommandResult;
  try {
    execution = await (args.commandRunner ?? runPtcSessionDockerCommand)({
      executable: args.dockerPath ?? 'docker',
      args: ['exec', handle.containerId, 'node', '-e', args.runtimeScript],
      timeoutMs: args.timeoutMs,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
  } catch {
    return { ok: false, failure: args.runnerThrew() };
  }

  return {
    durationMs: Math.max(0, now() - start),
    execution,
    handle,
    ok: true,
  };
}
