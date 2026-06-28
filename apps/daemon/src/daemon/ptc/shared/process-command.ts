import {
  buildDockerClientProcessEnv,
  runDockerClientCommand,
  startBoundedProcessCommand,
  type DockerClientCommandInvocation,
  type DockerClientCommandResult,
  type StartBoundedProcessCommandInvocation,
  type StartBoundedProcessCommandResult,
} from '@geulbat/shared-utils/process-command';
export type {
  DetachedProcessExitInfo,
  DetachedProcessHandle,
  DetachedProcessOutputSegment,
} from '@geulbat/shared-utils/process-command';

type PtcDockerClientExitCommandResult = Extract<
  DockerClientCommandResult,
  { kind: 'exit' }
>;
type PtcDockerClientCrashCommandResult = Extract<
  DockerClientCommandResult,
  { kind: 'crash' }
>;
type PtcDockerClientTimeoutCommandResult = Extract<
  DockerClientCommandResult,
  { kind: 'timeout' }
> & { processTerminated?: boolean };
type PtcDockerClientCancelledCommandResult = Extract<
  DockerClientCommandResult,
  { kind: 'cancelled' }
> & { processTerminated?: boolean };
type PtcDockerClientOutputLimitCommandResult = Extract<
  DockerClientCommandResult,
  { kind: 'output_limit_exceeded' }
> & { processTerminated?: boolean };

export type PtcDockerClientCommandInvocation = DockerClientCommandInvocation;
export type PtcDockerClientCommandResult =
  | PtcDockerClientExitCommandResult
  | PtcDockerClientTimeoutCommandResult
  | PtcDockerClientCancelledCommandResult
  | PtcDockerClientOutputLimitCommandResult
  | PtcDockerClientCrashCommandResult;
export type PtcDockerClientProcessInvocation = Omit<
  StartBoundedProcessCommandInvocation,
  'env'
>;
export type PtcDockerClientProcessResult = StartBoundedProcessCommandResult;

export async function runPtcDockerClientCommand(
  invocation: PtcDockerClientCommandInvocation,
): Promise<PtcDockerClientCommandResult> {
  return await runDockerClientCommand(invocation);
}

export function startPtcDockerClientProcess(
  invocation: PtcDockerClientProcessInvocation,
): PtcDockerClientProcessResult {
  return startBoundedProcessCommand({
    ...invocation,
    env: buildDockerClientProcessEnv(),
  });
}
