import { runPtcDockerClientCommand } from '../../shared/process-command.js';
import type {
  PtcSessionDockerCommandInvocation,
  PtcSessionDockerCommandResult,
  PtcSessionDockerMappedNonExitCommandResult,
} from './session-docker-contract.js';

type PtcSessionDockerNonExitCommandResult = Exclude<
  PtcSessionDockerCommandResult,
  { kind: 'exit' }
>;

export async function runPtcSessionDockerCommand(
  invocation: PtcSessionDockerCommandInvocation,
): Promise<PtcSessionDockerCommandResult> {
  return await runPtcDockerClientCommand(invocation);
}

export function mapPtcSessionDockerNonExitCommandResult<
  FailedKind extends string,
>(
  result: PtcSessionDockerNonExitCommandResult,
  failedKind: FailedKind,
): PtcSessionDockerMappedNonExitCommandResult<FailedKind, boolean> {
  if (result.kind === 'timeout') {
    return {
      kind: 'timeout',
      stdout: result.stdout,
      stderr: result.stderr,
      processTerminated: result.processTerminated ?? false,
    };
  }
  if (result.kind === 'cancelled') {
    return {
      kind: 'cancelled',
      stdout: result.stdout,
      stderr: result.stderr,
      processTerminated: result.processTerminated ?? false,
    };
  }
  return { kind: failedKind, stdout: result.stdout, stderr: result.stderr };
}
