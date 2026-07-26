import type { HostCommandRuntime } from '../command-host/contract.js';
import {
  type HostCommandSnapshot,
  type HostCommandStatus,
  SYSTEM_SESSION_OWNER,
} from './host-command-output-store.js';
import { runDetached } from './utils/run-detached.js';

type DetachedProcessOutputStreamName = 'stdout' | 'stderr';

interface HostRoutedDetachedProcessOutputBufferPolicy {
  maxBufferedBytesPerStream: number;
}

interface HostRoutedDetachedProcessOutputSegment {
  stdout: string;
  stderr: string;
}

type HostRoutedDetachedProcessExitInfo =
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

interface HostRoutedDetachedProcessHandleContract {
  drainNewOutput(): HostRoutedDetachedProcessOutputSegment;
  getOutputRevision(): number;
  waitForOutputChange(
    afterRevision: number,
    abortSignal?: AbortSignal,
  ): Promise<number>;
  readonly exit: Promise<HostRoutedDetachedProcessExitInfo>;
  terminate(args: { graceMs: number }): void;
}

interface HostRoutedDetachedProcessInvocation {
  callId: string;
  executable: string;
  args: readonly string[];
  timeoutMs?: number;
  redactionMarkers?: readonly string[];
  redactionReplacement?: string;
  outputBufferPolicy?: HostRoutedDetachedProcessOutputBufferPolicy;
}

type HostRoutedDetachedProcessStartResult =
  | { ok: true; handle: HostRoutedDetachedProcessHandleContract }
  | { ok: false; reasonCode: 'spawn_failed'; message: string };

/**
 * 증분 drain·output-change wait·명시 종료가 필요한 직접 자식을
 * command-host system session으로 옮긴다. marker 원문은 command-host
 * ingestion 전에 지워지고, 데몬은 정제된 페이지와 종료 상태만 관찰한다.
 */
export function createHostRoutedDetachedProcessStarter(args: {
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  pageLimitBytes: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  runId: string;
}): (
  invocation: HostRoutedDetachedProcessInvocation,
) => Promise<HostRoutedDetachedProcessStartResult> {
  return (invocation) =>
    startHostRoutedDetachedProcess({ ...args, invocation });
}

async function startHostRoutedDetachedProcess(args: {
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  pageLimitBytes: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  runId: string;
  invocation: HostRoutedDetachedProcessInvocation;
}): Promise<HostRoutedDetachedProcessStartResult> {
  const markers = (args.invocation.redactionMarkers ?? []).filter(
    (marker) => marker.length > 0,
  );
  const started = await args.hostCommands.start({
    executable: args.invocation.executable,
    args: [...args.invocation.args],
    cwd: args.cwd,
    env: args.env,
    stateRoot: args.stateRoot,
    threadId: SYSTEM_SESSION_OWNER,
    owner: 'system',
    streamMode: 'lossless',
    runId: args.runId,
    callId: args.invocation.callId,
    stdinMode: 'closed',
    ...(args.invocation.timeoutMs === undefined
      ? {}
      : { timeoutMs: args.invocation.timeoutMs }),
    ...(markers.length === 0
      ? {}
      : {
          outputRedaction: {
            exactMarkers: markers,
            replacement: args.invocation.redactionReplacement ?? '[redacted]',
          },
        }),
  });
  if (!started.ok) {
    return {
      ok: false,
      reasonCode: 'spawn_failed',
      message: started.message,
    };
  }

  const claimed = await args.hostCommands.waitForInitialResult({
    stateRoot: args.stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 0,
  });
  if (!claimed.ok) {
    await terminateUnclaimedHostSession({
      hostCommands: args.hostCommands,
      stateRoot: args.stateRoot,
      outputRef: started.outputRef,
    });
    return {
      ok: false,
      reasonCode: 'spawn_failed',
      message: `detached command-host claim failed: ${claimed.message}`,
    };
  }

  const handle = new HostRoutedDetachedProcessHandle({
    hostCommands: args.hostCommands,
    stateRoot: args.stateRoot,
    outputRef: started.outputRef,
    pageLimitBytes: args.pageLimitBytes,
    outputBufferPolicy: args.invocation.outputBufferPolicy,
  });
  handle.begin(claimed.value);
  return { ok: true, handle };
}

class HostRoutedDetachedProcessHandle implements HostRoutedDetachedProcessHandleContract {
  readonly exit: Promise<HostRoutedDetachedProcessExitInfo>;

  private readonly hostCommands: HostCommandRuntime;
  private readonly stateRoot: string;
  private readonly outputRef: string;
  private readonly pageLimitBytes: number;
  private readonly stdout: DetachedOutputBuffer;
  private readonly stderr: DetachedOutputBuffer;
  private readonly resolveExit: (
    exit: HostRoutedDetachedProcessExitInfo,
  ) => void;
  private readonly outputWaiters = new Set<(nextRevision: number) => void>();
  private outputRevision = 0;
  private closed = false;
  private terminationRequested = false;
  private discardFurtherOutput = false;
  private terminalOverride: HostRoutedDetachedProcessExitInfo | undefined;

  constructor(args: {
    hostCommands: HostCommandRuntime;
    stateRoot: string;
    outputRef: string;
    pageLimitBytes: number;
    outputBufferPolicy: HostRoutedDetachedProcessOutputBufferPolicy | undefined;
  }) {
    this.hostCommands = args.hostCommands;
    this.stateRoot = args.stateRoot;
    this.outputRef = args.outputRef;
    this.pageLimitBytes = args.pageLimitBytes;
    this.stdout = new DetachedOutputBuffer(args.outputBufferPolicy);
    this.stderr = new DetachedOutputBuffer(args.outputBufferPolicy);
    let resolveExit: (exit: HostRoutedDetachedProcessExitInfo) => void = () =>
      undefined;
    this.exit = new Promise((resolve) => {
      resolveExit = resolve;
    });
    this.resolveExit = resolveExit;
  }

  begin(initial: HostCommandSnapshot): void {
    if (initial.outputRef === null) {
      this.appendInlineOutput('stdout', initial.stdout ?? '');
      this.appendInlineOutput('stderr', initial.stderr ?? '');
      this.finish(this.terminalOverride ?? exitFromSnapshot(initial));
      return;
    }
    runDetached('command-host/detached-output', async () => {
      try {
        await this.readLoop(initial);
      } catch (error: unknown) {
        this.finish({
          kind: 'spawn_failed',
          exitCode: null,
          processTerminated: false,
          message: `detached command-host observation failed: ${getErrorMessage(error)}`,
        });
      }
    });
  }

  drainNewOutput(): HostRoutedDetachedProcessOutputSegment {
    return {
      stdout: this.stdout.drain(),
      stderr: this.stderr.drain(),
    };
  }

  getOutputRevision(): number {
    return this.outputRevision;
  }

  waitForOutputChange(
    afterRevision: number,
    abortSignal?: AbortSignal,
  ): Promise<number> {
    if (this.outputRevision !== afterRevision) {
      return Promise.resolve(this.outputRevision);
    }
    return new Promise<number>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        this.outputWaiters.delete(onOutputChange);
        abortSignal?.removeEventListener('abort', onAbort);
        fn();
      };
      const onAbort = () => {
        finish(() => reject(new Error('detached process output wait aborted')));
      };
      const onOutputChange = (nextRevision: number) => {
        if (nextRevision !== afterRevision) {
          finish(() => resolve(nextRevision));
        }
      };
      if (abortSignal?.aborted === true) {
        onAbort();
        return;
      }
      this.outputWaiters.add(onOutputChange);
      abortSignal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  terminate(_args: { graceMs: number }): void {
    if (this.closed || this.terminationRequested) {
      return;
    }
    this.terminalOverride = {
      kind: 'signal',
      exitCode: null,
      processTerminated: false,
    };
    this.requestTermination();
  }

  private async readLoop(initial: HostCommandSnapshot): Promise<void> {
    const offsets: Record<DetachedProcessOutputStreamName, number> = {
      stdout: 0,
      stderr: 0,
    };
    let snapshot = initial;
    for (;;) {
      const stdout = await this.readAvailableStream('stdout', offsets.stdout);
      if (!stdout.ok) {
        this.finish(hostReadFailure(stdout.message));
        return;
      }
      offsets.stdout = stdout.nextOffset;
      snapshot = stdout.snapshot;

      const stderr = await this.readAvailableStream('stderr', offsets.stderr);
      if (!stderr.ok) {
        this.finish(hostReadFailure(stderr.message));
        return;
      }
      offsets.stderr = stderr.nextOffset;
      snapshot = stderr.snapshot;

      if (stdout.hasMore || stderr.hasMore) {
        continue;
      }
      if (snapshot.status !== 'running') {
        this.finish(this.terminalOverride ?? exitFromSnapshot(snapshot));
        return;
      }
      const changed = await this.hostCommands.interact({
        stateRoot: this.stateRoot,
        threadId: SYSTEM_SESSION_OWNER,
        owner: 'system',
        outputRef: this.outputRef,
        afterRevision: snapshot.revision,
      });
      if (!changed.ok) {
        this.finish(hostReadFailure(changed.message));
        return;
      }
      snapshot = changed.value.snapshot;
    }
  }

  private async readAvailableStream(
    stream: DetachedProcessOutputStreamName,
    offset: number,
  ): Promise<
    | {
        ok: true;
        nextOffset: number;
        hasMore: boolean;
        snapshot: HostCommandSnapshot;
      }
    | { ok: false; message: string }
  > {
    const observed = await this.hostCommands.interact({
      stateRoot: this.stateRoot,
      threadId: SYSTEM_SESSION_OWNER,
      owner: 'system',
      outputRef: this.outputRef,
      yieldTimeMs: 0,
      page: {
        stream,
        offsetBytes: offset,
        limitBytes: this.pageLimitBytes,
      },
    });
    if (!observed.ok) {
      return { ok: false, message: observed.message };
    }
    const page = observed.value.page;
    if (page === null) {
      return {
        ok: true,
        nextOffset: offset,
        hasMore: false,
        snapshot: observed.value.snapshot,
      };
    }
    if (page.offsetBytes !== offset) {
      return {
        ok: false,
        message: `detached command-host output gap: requested ${offset}, received ${page.offsetBytes}.`,
      };
    }
    if (page.endOffsetBytes > offset) {
      this.appendPage(stream, page.content);
    }
    return {
      ok: true,
      nextOffset: page.endOffsetBytes,
      hasMore: page.hasMore,
      snapshot: observed.value.snapshot,
    };
  }

  private appendInlineOutput(
    stream: DetachedProcessOutputStreamName,
    output: string,
  ): void {
    if (output.length > 0) {
      this.appendPage(stream, output);
    }
  }

  private appendPage(
    stream: DetachedProcessOutputStreamName,
    output: string,
  ): void {
    if (this.discardFurtherOutput || output.length === 0) {
      return;
    }
    const buffer = stream === 'stdout' ? this.stdout : this.stderr;
    const appended = buffer.append(output);
    if (!appended.ok) {
      this.discardFurtherOutput = true;
      this.terminalOverride = {
        kind: 'output_limit_exceeded',
        exitCode: null,
        processTerminated: false,
        stream,
        maxBufferedBytesPerStream: appended.maxBufferedBytesPerStream,
      };
      this.requestTermination();
      return;
    }
    this.bumpOutputRevision();
  }

  private requestTermination(): void {
    if (this.closed || this.terminationRequested) {
      return;
    }
    this.terminationRequested = true;
    runDetached('command-host/detached-terminate', async () => {
      try {
        const terminated = await this.hostCommands.interact({
          stateRoot: this.stateRoot,
          threadId: SYSTEM_SESSION_OWNER,
          owner: 'system',
          outputRef: this.outputRef,
          terminate: true,
          yieldTimeMs: 0,
        });
        if (!terminated.ok && !this.closed) {
          this.finish(hostReadFailure(terminated.message));
        }
      } catch (error: unknown) {
        this.finish(
          hostReadFailure(
            `detached command-host termination failed: ${getErrorMessage(error)}`,
          ),
        );
      }
    });
  }

  private finish(exit: HostRoutedDetachedProcessExitInfo): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.bumpOutputRevision();
    this.resolveExit(exit);
  }

  private bumpOutputRevision(): void {
    this.outputRevision += 1;
    const waiters = [...this.outputWaiters];
    this.outputWaiters.clear();
    for (const waiter of waiters) {
      waiter(this.outputRevision);
    }
  }
}

class DetachedOutputBuffer {
  private pending = '';
  private pendingBytes = 0;
  private readonly maxBufferedBytesPerStream: number | undefined;

  constructor(policy: HostRoutedDetachedProcessOutputBufferPolicy | undefined) {
    this.maxBufferedBytesPerStream = policy?.maxBufferedBytesPerStream;
  }

  append(
    output: string,
  ): { ok: true } | { ok: false; maxBufferedBytesPerStream: number } {
    const outputBytes = Buffer.byteLength(output, 'utf8');
    if (
      this.maxBufferedBytesPerStream !== undefined &&
      this.pendingBytes + outputBytes > this.maxBufferedBytesPerStream
    ) {
      return {
        ok: false,
        maxBufferedBytesPerStream: this.maxBufferedBytesPerStream,
      };
    }
    this.pending += output;
    this.pendingBytes += outputBytes;
    return { ok: true };
  }

  drain(): string {
    const output = this.pending;
    this.pending = '';
    this.pendingBytes = 0;
    return output;
  }
}

async function terminateUnclaimedHostSession(args: {
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  outputRef: string;
}): Promise<void> {
  await args.hostCommands
    .interact({
      stateRoot: args.stateRoot,
      threadId: SYSTEM_SESSION_OWNER,
      owner: 'system',
      outputRef: args.outputRef,
      terminate: true,
      yieldTimeMs: 0,
    })
    .catch(() => undefined);
}

function exitFromSnapshot(
  snapshot: HostCommandSnapshot,
): HostRoutedDetachedProcessExitInfo {
  switch (snapshot.status) {
    case 'exit':
      return {
        kind: 'exit',
        exitCode: snapshot.exitCode ?? 1,
        processTerminated: true,
      };
    case 'timeout':
      return {
        kind: 'timeout',
        exitCode: null,
        processTerminated: false,
      };
    case 'output_limit_exceeded':
      return {
        kind: 'output_limit_exceeded',
        exitCode: null,
        processTerminated: false,
        stream: snapshot.outputLimitExceeded?.stream ?? 'stdout',
        maxBufferedBytesPerStream:
          snapshot.outputLimitExceeded?.maxOutputBytesPerStream ?? 0,
      };
    case 'crash':
    case 'output_store_failed':
    case 'command_host_interrupted':
      return hostReadFailure(
        `detached command-host session ended with ${snapshot.status}.`,
      );
    case 'running':
      return hostReadFailure(
        'detached command-host session was still running at terminal settlement.',
      );
    default:
      return signalExit(snapshot.status);
  }
}

function signalExit(
  _status: Exclude<HostCommandStatus, 'running'>,
): HostRoutedDetachedProcessExitInfo {
  return {
    kind: 'signal',
    exitCode: null,
    processTerminated: false,
  };
}

function hostReadFailure(message: string): HostRoutedDetachedProcessExitInfo {
  return {
    kind: 'spawn_failed',
    exitCode: null,
    processTerminated: false,
    message,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
