import { spawn } from 'node:child_process';
import type {
  ProcessOutputBufferPolicy,
  ProcessOutputStreamName,
} from './process-command-detached.js';
export {
  startBoundedProcessCommand,
  type DetachedProcessExitInfo,
  type DetachedProcessHandle,
  type DetachedProcessOutputSegment,
  type ProcessOutputBufferPolicy,
  type ProcessOutputStreamName,
  type StartBoundedProcessCommandInvocation,
  type StartBoundedProcessCommandResult,
} from './process-command-detached.js';

export type ProcessCommandResult =
  | { kind: 'exit'; exitCode: number; stdout: string; stderr: string }
  | { kind: 'timeout'; stdout: string; stderr: string }
  | { kind: 'cancelled'; stdout: string; stderr: string }
  | ProcessOutputLimitExceededCommandResult
  | { kind: 'crash'; stdout: string; stderr: string };

export type BoundedProcessCommandResult = ProcessCommandResult;

export interface ProcessOutputLimitExceededCommandResult {
  kind: 'output_limit_exceeded';
  stdout: string;
  stderr: string;
  stream: ProcessOutputStreamName;
  maxBufferedBytesPerStream: number;
}

export interface BoundedProcessCommandInvocation {
  executable: string;
  args: string[];
  timeoutMs?: number;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  cancelledStderr?: string;
  outputBufferPolicy?: ProcessOutputBufferPolicy;
}

export type DockerClientCommandResult = ProcessCommandResult;

export interface DockerClientCommandInvocation {
  executable: string;
  args: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  outputBufferPolicy?: ProcessOutputBufferPolicy;
}

export type DockerClientCommandRunner = (
  invocation: DockerClientCommandInvocation,
) => Promise<DockerClientCommandResult>;

export const DOCKER_CLIENT_ENV_KEYS = [
  'DOCKER_API_VERSION',
  'DOCKER_CERT_PATH',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_HOST',
  'DOCKER_TLS_VERIFY',
  'DOCKER_BUILDKIT',
] as const;

export function buildAllowlistedProcessEnv(
  keys: readonly string[],
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    PATH: sourceEnv.PATH ?? '',
    ...Object.fromEntries(
      keys.flatMap((key) => {
        const value = sourceEnv[key];
        return value === undefined ? [] : [[key, value]];
      }),
    ),
  };
}

export function buildDockerClientProcessEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return buildAllowlistedProcessEnv(DOCKER_CLIENT_ENV_KEYS, sourceEnv);
}

export async function runBoundedProcessCommand(
  invocation: BoundedProcessCommandInvocation,
): Promise<BoundedProcessCommandResult> {
  if (invocation.signal?.aborted) {
    return {
      kind: 'cancelled',
      stdout: '',
      stderr: invocation.cancelledStderr ?? 'process command cancelled',
    };
  }

  return await new Promise((resolve) => {
    const child = spawn(invocation.executable, invocation.args, {
      env: invocation.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stdoutBufferedBytes = 0;
    let stderrBufferedBytes = 0;
    let settled = false;
    let pendingTermination:
      | 'timeout'
      | 'cancelled'
      | ProcessOutputLimitExceededCommandResult
      | null = null;

    const finish = (result: BoundedProcessCommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      invocation.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const terminate = (
      kind: 'timeout' | 'cancelled' | ProcessOutputLimitExceededCommandResult,
    ): void => {
      if (settled || pendingTermination) {
        return;
      }
      pendingTermination = kind;
      child.kill('SIGTERM');
      child.kill('SIGKILL');
    };
    const appendOutput = (
      stream: ProcessOutputStreamName,
      chunk: string,
    ): void => {
      const maxBufferedBytes =
        invocation.outputBufferPolicy?.maxBufferedBytesPerStream;
      const chunkBytes = Buffer.byteLength(chunk, 'utf8');
      if (stream === 'stdout') {
        if (
          maxBufferedBytes !== undefined &&
          stdoutBufferedBytes + chunkBytes > maxBufferedBytes
        ) {
          terminate({
            kind: 'output_limit_exceeded',
            stdout,
            stderr,
            stream,
            maxBufferedBytesPerStream: maxBufferedBytes,
          });
          return;
        }
        stdout += chunk;
        stdoutBufferedBytes += chunkBytes;
        return;
      }
      if (
        maxBufferedBytes !== undefined &&
        stderrBufferedBytes + chunkBytes > maxBufferedBytes
      ) {
        terminate({
          kind: 'output_limit_exceeded',
          stdout,
          stderr,
          stream,
          maxBufferedBytesPerStream: maxBufferedBytes,
        });
        return;
      }
      stderr += chunk;
      stderrBufferedBytes += chunkBytes;
    };

    const timer =
      invocation.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            terminate('timeout');
          }, invocation.timeoutMs);
    timer?.unref?.();

    const onAbort = (): void => {
      terminate('cancelled');
    };
    invocation.signal?.addEventListener('abort', onAbort, { once: true });
    if (invocation.signal?.aborted) {
      terminate('cancelled');
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      appendOutput('stdout', chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      appendOutput('stderr', chunk);
    });
    child.on('error', (error) => {
      finish({ kind: 'crash', stdout, stderr: error.message });
    });
    child.on('close', (exitCode) => {
      if (pendingTermination) {
        if (typeof pendingTermination === 'string') {
          finish({ kind: pendingTermination, stdout, stderr });
          return;
        }
        finish(pendingTermination);
        return;
      }
      finish({ kind: 'exit', exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}

export async function runDockerClientCommand(
  invocation: DockerClientCommandInvocation,
): Promise<DockerClientCommandResult> {
  return await runBoundedProcessCommand({
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
