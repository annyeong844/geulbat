type ExecuteCodeCellOutputStreamName = 'stdout' | 'stderr';

interface ExecuteCodeCellOutputBufferPolicy {
  maxBufferedBytesPerStream: number;
}

export interface DetachedProcessOutputSegment {
  stdout: string;
  stderr: string;
}

// `processTerminated` only describes the external docker exec child observed by
// the injected runner. Docker exec callers must not treat it as proof that every
// descendant inside the container is gone; container isolation remains the
// caller's taint-close responsibility.
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
  cellId: string;
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

export type StartPtcExecuteCodeCellProcess = (
  invocation: ExecuteCodeCellProcessInvocation,
) =>
  | ExecuteCodeCellProcessStartResult
  | Promise<ExecuteCodeCellProcessStartResult>;
