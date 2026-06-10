import {
  buildAllowlistedProcessEnv,
  runBoundedProcessCommand,
} from '@geulbat/shared-utils/process-command';
import type {
  PtcSessionDockerCommandInvocation,
  PtcSessionDockerCommandResult,
} from './session-docker-contract.js';

const MAX_DOCKER_OUTPUT_BYTES = 64 * 1024;

export async function runPtcSessionDockerCommand(
  invocation: PtcSessionDockerCommandInvocation,
): Promise<PtcSessionDockerCommandResult> {
  return await runBoundedProcessCommand({
    executable: invocation.executable,
    args: invocation.args,
    timeoutMs: invocation.timeoutMs,
    env: buildDockerClientEnv(),
    maxOutputBytes: MAX_DOCKER_OUTPUT_BYTES,
    ...(invocation.signal ? { signal: invocation.signal } : {}),
    cancelledStderr: 'docker command cancelled',
  });
}

const DOCKER_CLIENT_ENV_KEYS = [
  'DOCKER_API_VERSION',
  'DOCKER_CERT_PATH',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_HOST',
  'DOCKER_TLS_VERIFY',
  'DOCKER_BUILDKIT',
] as const;

function buildDockerClientEnv(): NodeJS.ProcessEnv {
  return buildAllowlistedProcessEnv(DOCKER_CLIENT_ENV_KEYS);
}
