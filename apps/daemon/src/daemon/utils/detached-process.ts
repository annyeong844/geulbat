export type DetachedProcessOutputStreamName = 'stdout' | 'stderr';

export interface DetachedProcessOutputBufferPolicy {
  maxBufferedBytesPerStream: number;
}

export interface DetachedProcessOutputSegment {
  stdout: string;
  stderr: string;
}

export interface DetachedProcessOutputOffsets {
  stdoutBytes: number;
  stderrBytes: number;
}

export interface DetachedProcessPreparedOutputDelivery {
  output: DetachedProcessOutputSegment;
  offsets: DetachedProcessOutputOffsets;
}

// `processTerminated` only describes the external child observed by the
// process owner. Container callers must not treat it as proof that every
// descendant is gone; container isolation remains the caller's responsibility.
export type DetachedProcessExitInfo =
  | { kind: 'exit'; exitCode: number; processTerminated: true }
  | { kind: 'signal'; exitCode: null; processTerminated: false }
  | { kind: 'timeout'; exitCode: null; processTerminated: false }
  | {
      kind: 'output_limit_exceeded';
      exitCode: null;
      processTerminated: false;
      stream: DetachedProcessOutputStreamName;
      maxBufferedBytesPerStream: number;
    }
  | {
      kind: 'spawn_failed';
      exitCode: null;
      processTerminated: false;
      message: string;
    };

export interface DetachedProcessHandle {
  readonly outputRef?: string;
  drainNewOutput(): DetachedProcessOutputSegment;
  prepareOutputDelivery?(): DetachedProcessPreparedOutputDelivery;
  commitPreparedOutputDelivery?(): void;
  getOutputRevision?(): number;
  waitForOutputChange?(
    afterRevision: number,
    abortSignal?: AbortSignal,
  ): Promise<number>;
  readonly exit: Promise<DetachedProcessExitInfo>;
  terminate(args: { graceMs: number }): void;
}

export interface HostRoutedDetachedProcessHandle extends DetachedProcessHandle {
  readonly outputRef: string;
  prepareOutputDelivery(): DetachedProcessPreparedOutputDelivery;
  commitPreparedOutputDelivery(): void;
  getOutputRevision(): number;
  waitForOutputChange(
    afterRevision: number,
    abortSignal?: AbortSignal,
  ): Promise<number>;
  writeInput(
    chars: string,
  ): Promise<{ ok: true } | { ok: false; message: string }>;
  stop(): void;
}

export type DetachedProcessStartResult<Handle> =
  | { ok: true; handle: Handle }
  | { ok: false; reasonCode: 'spawn_failed'; message: string };
