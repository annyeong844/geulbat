import { spawn } from 'node:child_process';

type BoundedChildProcessOutputStreamName = 'stdout' | 'stderr';

interface BoundedChildProcessOutputBufferPolicy {
  maxBufferedBytesPerStream: number;
}

export type BoundedChildProcessResult =
  | { kind: 'exit'; exitCode: number; stdout: string; stderr: string }
  | { kind: 'timeout'; stdout: string; stderr: string }
  | { kind: 'cancelled'; stdout: string; stderr: string }
  | BoundedChildProcessOutputLimitResult
  | { kind: 'crash'; stdout: string; stderr: string };

interface BoundedChildProcessOutputLimitResult {
  kind: 'output_limit_exceeded';
  stdout: string;
  stderr: string;
  stream: BoundedChildProcessOutputStreamName;
  maxBufferedBytesPerStream: number;
}

interface BoundedChildProcessInvocation {
  executable: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  cancelledStderr?: string;
  outputBufferPolicy?: BoundedChildProcessOutputBufferPolicy;
}

export function buildAllowlistedChildProcessEnv(
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

export async function runBoundedChildProcess(
  invocation: BoundedChildProcessInvocation,
): Promise<BoundedChildProcessResult> {
  if (invocation.signal?.aborted) {
    return {
      kind: 'cancelled',
      stdout: '',
      stderr: invocation.cancelledStderr ?? 'process command cancelled',
    };
  }

  return await new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(invocation.executable, invocation.args, {
        ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
        env: invocation.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error: unknown) {
      resolve({
        kind: 'crash',
        stdout: '',
        stderr:
          error instanceof Error ? error.message : 'process command failed',
      });
      return;
    }
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (!stdoutStream || !stderrStream) {
      resolve({
        kind: 'crash',
        stdout: '',
        stderr: 'process command failed to open output streams',
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let stdoutBufferedBytes = 0;
    let stderrBufferedBytes = 0;
    let settled = false;
    let pendingTermination:
      | 'timeout'
      | 'cancelled'
      | BoundedChildProcessOutputLimitResult
      | null = null;

    const finish = (result: BoundedChildProcessResult): void => {
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
      kind: 'timeout' | 'cancelled' | BoundedChildProcessOutputLimitResult,
    ): void => {
      if (settled || pendingTermination) {
        return;
      }
      pendingTermination = kind;
      child.kill('SIGTERM');
      child.kill('SIGKILL');
    };
    const appendOutput = (
      stream: BoundedChildProcessOutputStreamName,
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

    stdoutStream.setEncoding('utf8');
    stderrStream.setEncoding('utf8');
    stdoutStream.on('data', (chunk: string) => {
      appendOutput('stdout', chunk);
    });
    stderrStream.on('data', (chunk: string) => {
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
