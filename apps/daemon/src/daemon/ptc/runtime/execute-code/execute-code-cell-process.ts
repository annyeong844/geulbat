import { spawn } from 'node:child_process';
import { buildDockerClientProcessEnv } from '../../../docker-client-command.js';

type ExecuteCodeCellOutputStreamName = 'stdout' | 'stderr';

interface ExecuteCodeCellOutputBufferPolicy {
  maxBufferedBytesPerStream: number;
}

export interface DetachedProcessOutputSegment {
  stdout: string;
  stderr: string;
}

// `processTerminated` only describes the spawned child process observed by this
// runner. Docker exec callers must not treat it as proof that every descendant
// inside the container is gone; container isolation remains the caller's
// taint-close responsibility.
export type DetachedProcessExitInfo =
  | { kind: 'exit'; exitCode: number; processTerminated: true }
  | { kind: 'signal'; exitCode: null; processTerminated: false }
  | { kind: 'timeout'; exitCode: null; processTerminated: false }
  | {
      kind: 'output_limit_exceeded';
      exitCode: null;
      processTerminated: false;
      stream: ExecuteCodeCellOutputStreamName;
      maxBufferedBytesPerStream: number;
    }
  | {
      kind: 'spawn_failed';
      exitCode: null;
      processTerminated: false;
      message: string;
    };

export interface DetachedProcessHandle {
  drainNewOutput(): DetachedProcessOutputSegment;
  getOutputRevision?(): number;
  waitForOutputChange?(
    afterRevision: number,
    abortSignal?: AbortSignal,
  ): Promise<number>;
  readonly exit: Promise<DetachedProcessExitInfo>;
  terminate(args: { graceMs: number }): void;
}

export interface ExecuteCodeCellProcessInvocation {
  executable: string;
  args: string[];
  timeoutMs?: number;
  redactionMarkers?: readonly string[];
  redactionReplacement?: string;
  outputBufferPolicy?: ExecuteCodeCellOutputBufferPolicy;
}

type ExecuteCodeCellProcessStartResult =
  | { ok: true; handle: DetachedProcessHandle }
  | { ok: false; reasonCode: 'spawn_failed'; message: string };

export function startExecuteCodeCellProcess(
  invocation: ExecuteCodeCellProcessInvocation,
): ExecuteCodeCellProcessStartResult {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(invocation.executable, invocation.args, {
      env: buildDockerClientProcessEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return {
      ok: false,
      reasonCode: 'spawn_failed',
      message: getErrorMessage(error),
    };
  }

  const stdout = new DetachedOutputStream({
    redactionMarkers: invocation.redactionMarkers ?? [],
    redactionReplacement: invocation.redactionReplacement,
    outputBufferPolicy: invocation.outputBufferPolicy,
  });
  const stderr = new DetachedOutputStream({
    redactionMarkers: invocation.redactionMarkers ?? [],
    redactionReplacement: invocation.redactionReplacement,
    outputBufferPolicy: invocation.outputBufferPolicy,
  });

  let closed = false;
  let terminating = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let terminalOverride: DetachedProcessExitInfo | undefined;
  let outputRevision = 0;
  const outputWaiters = new Set<(nextRevision: number) => void>();
  let resolveExit: (exit: DetachedProcessExitInfo) => void;
  const exit = new Promise<DetachedProcessExitInfo>((resolve) => {
    resolveExit = resolve;
  });

  const finish = (exitInfo: DetachedProcessExitInfo): void => {
    if (closed) {
      return;
    }
    closed = true;
    if (forceKillTimer !== undefined) {
      clearTimeout(forceKillTimer);
    }
    if (timeoutTimer !== undefined) {
      clearTimeout(timeoutTimer);
    }
    resolveExit(exitInfo);
  };
  const bumpOutputRevision = (): void => {
    outputRevision += 1;
    const waiters = [...outputWaiters];
    outputWaiters.clear();
    for (const waiter of waiters) {
      waiter(outputRevision);
    }
  };
  const terminateWith = (exitInfo: DetachedProcessExitInfo): void => {
    if (closed || terminating) {
      return;
    }
    terminating = true;
    terminalOverride = exitInfo;
    child.kill('SIGTERM');
    child.kill('SIGKILL');
  };
  const waitForOutputChange = (
    afterRevision: number,
    abortSignal?: AbortSignal,
  ): Promise<number> => {
    if (outputRevision !== afterRevision) {
      return Promise.resolve(outputRevision);
    }

    return new Promise<number>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        outputWaiters.delete(onOutputChange);
        abortSignal?.removeEventListener('abort', onAbort);
        fn();
      };
      const onAbort = () => {
        finish(() => reject(new Error('detached process output wait aborted')));
      };
      const onOutputChange = (nextRevision: number) => {
        if (nextRevision === afterRevision) {
          return;
        }
        finish(() => resolve(nextRevision));
      };

      if (abortSignal?.aborted) {
        onAbort();
        return;
      }
      outputWaiters.add(onOutputChange);
      abortSignal?.addEventListener('abort', onAbort, { once: true });
    });
  };
  if (invocation.timeoutMs !== undefined) {
    timeoutTimer = setTimeout(() => {
      terminateWith({
        kind: 'timeout',
        exitCode: null,
        processTerminated: false,
      });
    }, invocation.timeoutMs);
    timeoutTimer.unref?.();
  }

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    const appended = stdout.append(chunk);
    if (!appended.ok) {
      terminateWith({
        kind: 'output_limit_exceeded',
        exitCode: null,
        processTerminated: false,
        stream: 'stdout',
        maxBufferedBytesPerStream: appended.maxBufferedBytesPerStream,
      });
    }
    bumpOutputRevision();
  });
  child.stderr?.on('data', (chunk: string) => {
    const appended = stderr.append(chunk);
    if (!appended.ok) {
      terminateWith({
        kind: 'output_limit_exceeded',
        exitCode: null,
        processTerminated: false,
        stream: 'stderr',
        maxBufferedBytesPerStream: appended.maxBufferedBytesPerStream,
      });
    }
    bumpOutputRevision();
  });
  child.on('error', (error) => {
    finish({
      kind: 'spawn_failed',
      exitCode: null,
      processTerminated: false,
      message: error.message,
    });
  });
  child.on('close', (exitCode, signal) => {
    if (terminalOverride !== undefined) {
      finish(terminalOverride);
      return;
    }
    if (terminating || signal !== null) {
      finish({
        kind: 'signal',
        exitCode: null,
        processTerminated: false,
      });
      return;
    }
    finish({
      kind: 'exit',
      exitCode: exitCode ?? 1,
      processTerminated: true,
    });
  });

  const handle: DetachedProcessHandle = {
    drainNewOutput() {
      const terminal = closed;
      const stdoutSegment = stdout.drain({ terminal });
      const stderrSegment = stderr.drain({ terminal });
      return {
        stdout: stdoutSegment.output,
        stderr: stderrSegment.output,
      };
    },
    getOutputRevision() {
      return outputRevision;
    },
    waitForOutputChange,
    exit,
    terminate(args) {
      if (closed || terminating) {
        return;
      }
      terminating = true;
      terminalOverride = {
        kind: 'signal',
        exitCode: null,
        processTerminated: false,
      };
      child.kill('SIGTERM');
      if (args.graceMs <= 0) {
        child.kill('SIGKILL');
        return;
      }
      forceKillTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, args.graceMs);
      forceKillTimer.unref?.();
    },
  };

  return { ok: true, handle };
}

class DetachedOutputStream {
  private pending = '';
  private pendingBytes = 0;

  readonly #redactionMarkers: readonly string[];
  readonly #redactionReplacement: string;
  readonly #streamHoldbackChars: number;
  readonly #maxBufferedBytesPerStream: number | undefined;

  constructor(args: {
    redactionMarkers: readonly string[];
    redactionReplacement: string | undefined;
    outputBufferPolicy: ExecuteCodeCellOutputBufferPolicy | undefined;
  }) {
    this.#redactionMarkers = args.redactionMarkers.filter(
      (marker) => marker.length > 0,
    );
    this.#redactionReplacement = args.redactionReplacement ?? '[redacted]';
    this.#streamHoldbackChars = Math.max(
      0,
      ...this.#redactionMarkers.map((marker) => marker.length - 1),
    );
    this.#maxBufferedBytesPerStream =
      args.outputBufferPolicy?.maxBufferedBytesPerStream;
  }

  append(
    chunk: string,
  ): { ok: true } | { ok: false; maxBufferedBytesPerStream: number } {
    const chunkBytes = Buffer.byteLength(chunk, 'utf8');
    if (
      this.#maxBufferedBytesPerStream !== undefined &&
      this.pendingBytes + chunkBytes > this.#maxBufferedBytesPerStream
    ) {
      return {
        ok: false,
        maxBufferedBytesPerStream: this.#maxBufferedBytesPerStream,
      };
    }
    this.pending += chunk;
    this.pendingBytes += chunkBytes;
    return { ok: true };
  }

  drain(args: { terminal: boolean }): { output: string } {
    if (this.pending.length === 0) {
      return { output: '' };
    }

    if (this.#redactionMarkers.length === 0) {
      const output = this.pending;
      this.pending = '';
      this.pendingBytes = 0;
      return { output };
    }

    const drainLength = args.terminal
      ? this.pending.length
      : Math.max(0, this.pending.length - this.#streamHoldbackChars);
    if (drainLength === 0) {
      return { output: '' };
    }

    const output = this.pending.slice(0, drainLength);
    this.pending = this.pending.slice(drainLength);
    this.pendingBytes = Buffer.byteLength(this.pending, 'utf8');
    return {
      output: redactMarkers(
        output,
        this.#redactionMarkers,
        this.#redactionReplacement,
      ),
    };
  }
}

function redactMarkers(
  value: string,
  markers: readonly string[],
  replacement: string,
): string {
  let redacted = value;
  for (const marker of markers) {
    redacted = redacted.replaceAll(marker, replacement);
  }
  return redacted;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
