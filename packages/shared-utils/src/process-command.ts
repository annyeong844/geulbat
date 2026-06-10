import { spawn } from 'node:child_process';

export type BoundedProcessCommandResult =
  | { kind: 'exit'; exitCode: number; stdout: string; stderr: string }
  | { kind: 'timeout'; stdout: string; stderr: string }
  | { kind: 'cancelled'; stdout: string; stderr: string }
  | { kind: 'crash'; stdout: string; stderr: string };

export interface BoundedProcessCommandInvocation {
  executable: string;
  args: string[];
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  maxOutputBytes: number;
  signal?: AbortSignal;
  cancelledStderr?: string;
}

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
    let settled = false;
    let pendingTermination: 'timeout' | 'cancelled' | null = null;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: BoundedProcessCommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      invocation.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const terminate = (kind: 'timeout' | 'cancelled'): void => {
      if (settled || pendingTermination) {
        return;
      }
      pendingTermination = kind;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 1_000);
      forceKillTimer.unref?.();
    };

    const timer = setTimeout(() => {
      terminate('timeout');
    }, invocation.timeoutMs);
    timer.unref?.();

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
      stdout = appendBoundedProcessOutput(
        stdout,
        chunk,
        invocation.maxOutputBytes,
      );
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = appendBoundedProcessOutput(
        stderr,
        chunk,
        invocation.maxOutputBytes,
      );
    });
    child.on('error', (error) => {
      finish({ kind: 'crash', stdout, stderr: error.message });
    });
    child.on('close', (exitCode) => {
      if (pendingTermination) {
        finish({ kind: pendingTermination, stdout, stderr });
        return;
      }
      finish({ kind: 'exit', exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}

function appendBoundedProcessOutput(
  current: string,
  chunk: string,
  maxOutputBytes: number,
): string {
  if (current.includes('[truncated]')) {
    return current;
  }
  const next = current + chunk;
  if (Buffer.byteLength(next, 'utf8') <= maxOutputBytes) {
    return next;
  }
  return `${next.slice(0, maxOutputBytes)}\n[truncated]`;
}
