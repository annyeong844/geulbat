import { buildAllowlistedCommandEnv } from './command-environment.js';

type DockerClientCommandOutputStreamName = 'stdout' | 'stderr';

export type DockerClientCommandResult =
  | { kind: 'exit'; exitCode: number; stdout: string; stderr: string }
  | { kind: 'timeout'; stdout: string; stderr: string }
  | { kind: 'cancelled'; stdout: string; stderr: string }
  | {
      kind: 'output_limit_exceeded';
      stdout: string;
      stderr: string;
      stream: DockerClientCommandOutputStreamName;
      maxBufferedBytesPerStream: number;
    }
  | { kind: 'crash'; stdout: string; stderr: string };

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
  return buildAllowlistedCommandEnv(DOCKER_CLIENT_ENV_KEYS, sourceEnv);
}

export async function runDockerClientCommand(
  invocation: DockerClientCommandInvocation,
): Promise<DockerClientCommandResult> {
  return invocation.signal?.aborted === true
    ? {
        kind: 'cancelled',
        stdout: '',
        stderr: 'docker command cancelled',
      }
    : {
        kind: 'crash',
        stdout: '',
        stderr: 'docker command requires the daemon host command runtime',
      };
}
