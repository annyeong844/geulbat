import {
  buildAllowlistedChildProcessEnv,
  runBoundedChildProcess,
  type BoundedChildProcessResult,
} from './bounded-child-process.js';

export type DockerClientCommandResult = BoundedChildProcessResult;

export interface DockerClientCommandInvocation {
  executable: string;
  args: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  outputBufferPolicy?: { maxBufferedBytesPerStream: number };
}

export type DockerClientCommandRunner = (
  invocation: DockerClientCommandInvocation,
) => Promise<DockerClientCommandResult>;

const DOCKER_CLIENT_ENV_KEYS = [
  'DOCKER_API_VERSION',
  'DOCKER_CERT_PATH',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_HOST',
  'DOCKER_TLS_VERIFY',
  'DOCKER_BUILDKIT',
] as const;

export function buildDockerClientProcessEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return buildAllowlistedChildProcessEnv(DOCKER_CLIENT_ENV_KEYS, sourceEnv);
}

export async function runDockerClientCommand(
  invocation: DockerClientCommandInvocation,
): Promise<DockerClientCommandResult> {
  return await runBoundedChildProcess({
    executable: invocation.executable,
    args: invocation.args,
    env: buildDockerClientProcessEnv(),
    ...(invocation.timeoutMs === undefined
      ? {}
      : { timeoutMs: invocation.timeoutMs }),
    ...(invocation.signal ? { signal: invocation.signal } : {}),
    ...(invocation.outputBufferPolicy
      ? { outputBufferPolicy: invocation.outputBufferPolicy }
      : {}),
    cancelledStderr: 'docker command cancelled',
  });
}
