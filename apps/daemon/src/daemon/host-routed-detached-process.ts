import type { HostCommandRuntime } from '../command-host/contract.js';
import {
  type HostCommandSnapshot,
  type HostCommandStatus,
  SYSTEM_SESSION_OWNER,
} from './host-command-output-store.js';
import type {
  DetachedProcessExitInfo as HostRoutedDetachedProcessExitInfo,
  DetachedProcessOutputBufferPolicy as HostRoutedDetachedProcessOutputBufferPolicy,
  DetachedProcessOutputOffsets,
  DetachedProcessPreparedOutputDelivery,
  DetachedProcessOutputSegment as HostRoutedDetachedProcessOutputSegment,
  DetachedProcessOutputStreamName,
  DetachedProcessStartResult,
  HostRoutedDetachedProcessHandle as HostRoutedDetachedProcessHandleContract,
} from './utils/detached-process.js';
import { runDetached } from './utils/run-detached.js';

interface DetachedOutputReadState {
  nextOffset: number;
  unconsumedEnd: number | undefined;
  releaseUpTo: number | undefined;
  mayAdoptRetainedBase: boolean;
}

interface PreparedOutputRelease {
  stdoutBytes: number | undefined;
  stderrBytes: number | undefined;
}

interface HostRoutedDetachedProcessInvocation {
  callId: string;
  executable: string;
  args: readonly string[];
  timeoutMs?: number;
  redactionMarkers?: readonly string[];
  redactionReplacement?: string;
  outputBufferPolicy?: HostRoutedDetachedProcessOutputBufferPolicy;
  stdinMode?: 'closed' | 'open';
  initialStdin?: string;
}

type HostRoutedDetachedProcessStartResult =
  DetachedProcessStartResult<HostRoutedDetachedProcessHandleContract>;

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

export function createHostRoutedDetachedProcessAttacher(args: {
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  pageLimitBytes: number;
}): (invocation: {
  outputRef: string;
  outputBufferPolicy?: HostRoutedDetachedProcessOutputBufferPolicy;
  outputReadOffsets?: DetachedProcessOutputOffsets;
}) => Promise<HostRoutedDetachedProcessStartResult> {
  return async (invocation) => {
    const claimed = await args.hostCommands.waitForInitialResult({
      stateRoot: args.stateRoot,
      outputRef: invocation.outputRef,
      yieldTimeMs: 0,
    });
    if (!claimed.ok) {
      return {
        ok: false,
        reasonCode: 'spawn_failed',
        message: `detached command-host re-adoption failed: ${claimed.message}`,
      };
    }

    const handle = new HostRoutedDetachedProcessHandle({
      hostCommands: args.hostCommands,
      stateRoot: args.stateRoot,
      outputRef: invocation.outputRef,
      pageLimitBytes: args.pageLimitBytes,
      outputBufferPolicy: invocation.outputBufferPolicy,
      ...(invocation.outputReadOffsets === undefined
        ? {}
        : { outputReadOffsets: invocation.outputReadOffsets }),
    });
    handle.begin(claimed.value);
    return { ok: true, handle };
  };
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
    requiresDeferredOutputRelease: true,
    requiresIdempotentStart: true,
    runId: args.runId,
    callId: args.invocation.callId,
    stdinMode: args.invocation.stdinMode ?? 'closed',
    ...(args.invocation.initialStdin === undefined
      ? {}
      : { initialStdin: args.invocation.initialStdin }),
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
  readonly outputRef: string;

  private readonly hostCommands: HostCommandRuntime;
  private readonly stateRoot: string;
  private readonly pageLimitBytes: number;
  private readonly hasExplicitOutputReadOffsets: boolean;
  private readonly stdout: DetachedOutputBuffer;
  private readonly stderr: DetachedOutputBuffer;
  private readonly resolveExit: (
    exit: HostRoutedDetachedProcessExitInfo,
  ) => void;
  private readonly outputWaiters = new Set<(nextRevision: number) => void>();
  private readonly readLoopWaiters = new Set<() => void>();
  private readonly readStates: Record<
    DetachedProcessOutputStreamName,
    DetachedOutputReadState
  > = {
    stdout: {
      nextOffset: 0,
      unconsumedEnd: undefined,
      releaseUpTo: undefined,
      mayAdoptRetainedBase: true,
    },
    stderr: {
      nextOffset: 0,
      unconsumedEnd: undefined,
      releaseUpTo: undefined,
      mayAdoptRetainedBase: true,
    },
  };
  private outputRevision = 0;
  private readLoopRevision = 0;
  private preparedOutputDelivery:
    | (DetachedProcessPreparedOutputDelivery & {
        release: PreparedOutputRelease;
      })
    | undefined;
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
    outputReadOffsets?: DetachedProcessOutputOffsets;
  }) {
    this.hostCommands = args.hostCommands;
    this.stateRoot = args.stateRoot;
    this.outputRef = args.outputRef;
    this.pageLimitBytes = args.pageLimitBytes;
    this.hasExplicitOutputReadOffsets = args.outputReadOffsets !== undefined;
    this.readStates.stdout.mayAdoptRetainedBase =
      !this.hasExplicitOutputReadOffsets;
    this.readStates.stderr.mayAdoptRetainedBase =
      !this.hasExplicitOutputReadOffsets;
    this.readStates.stdout.nextOffset =
      args.outputReadOffsets?.stdoutBytes ?? 0;
    this.readStates.stderr.nextOffset =
      args.outputReadOffsets?.stderrBytes ?? 0;
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
    if (!this.hasExplicitOutputReadOffsets) {
      this.readStates.stdout.nextOffset = initial.stdoutOmittedBytes ?? 0;
      this.readStates.stderr.nextOffset = initial.stderrOmittedBytes ?? 0;
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
    const prepared = this.preparedOutputDelivery;
    if (prepared !== undefined) {
      this.preparedOutputDelivery = undefined;
      this.releasePreparedOutput(prepared.release);
    }
    const stdout = this.drainStream('stdout');
    const stderr = this.drainStream('stderr');
    return {
      stdout: (prepared?.output.stdout ?? '') + stdout,
      stderr: (prepared?.output.stderr ?? '') + stderr,
    };
  }

  prepareOutputDelivery(): DetachedProcessPreparedOutputDelivery {
    if (this.preparedOutputDelivery !== undefined) {
      return {
        output: this.preparedOutputDelivery.output,
        offsets: this.preparedOutputDelivery.offsets,
      };
    }
    const stdout = this.prepareStreamDelivery('stdout');
    const stderr = this.prepareStreamDelivery('stderr');
    const prepared = {
      output: {
        stdout: stdout.output,
        stderr: stderr.output,
      },
      offsets: {
        stdoutBytes: stdout.offsetBytes,
        stderrBytes: stderr.offsetBytes,
      },
      release: {
        stdoutBytes: stdout.releaseUpTo,
        stderrBytes: stderr.releaseUpTo,
      },
    };
    if (stdout.output.length > 0 || stderr.output.length > 0) {
      this.preparedOutputDelivery = prepared;
    }
    return {
      output: prepared.output,
      offsets: prepared.offsets,
    };
  }

  commitPreparedOutputDelivery(): void {
    const prepared = this.preparedOutputDelivery;
    if (prepared === undefined) {
      return;
    }
    this.preparedOutputDelivery = undefined;
    this.releasePreparedOutput(prepared.release);
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

  async writeInput(
    chars: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    if (this.closed) {
      return { ok: false, message: 'detached process is no longer running.' };
    }
    const written = await this.hostCommands.interact({
      stateRoot: this.stateRoot,
      threadId: SYSTEM_SESSION_OWNER,
      owner: 'system',
      outputRef: this.outputRef,
      chars,
      yieldTimeMs: 0,
    });
    return written.ok ? { ok: true } : { ok: false, message: written.message };
  }

  stop(): void {
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

  terminate(_args: { graceMs: number }): void {
    this.stop();
  }

  private async readLoop(initial: HostCommandSnapshot): Promise<void> {
    let snapshot = initial;
    for (;;) {
      if (this.closed) {
        return;
      }
      const wakeRevision = this.readLoopRevision;
      const stdout = await this.readAvailableStream('stdout');
      if (!stdout.ok) {
        this.finish(hostReadFailure(stdout.message));
        return;
      }
      snapshot = stdout.snapshot;

      const stderr = await this.readAvailableStream('stderr');
      if (!stderr.ok) {
        this.finish(hostReadFailure(stderr.message));
        return;
      }
      snapshot = stderr.snapshot;

      if (stdout.hasMore || stderr.hasMore || this.hasPendingOutputRelease()) {
        continue;
      }
      if (snapshot.status !== 'running') {
        this.finish(this.terminalOverride ?? exitFromSnapshot(snapshot));
        return;
      }
      const changed = await this.waitForHostOrReadLoopWake(
        snapshot.revision,
        wakeRevision,
      );
      if (!changed.ok) {
        this.finish(hostReadFailure(changed.message));
        return;
      }
      if (changed.snapshot !== null) {
        snapshot = changed.snapshot;
      }
    }
  }

  private async readAvailableStream(
    stream: DetachedProcessOutputStreamName,
  ): Promise<
    | {
        ok: true;
        hasMore: boolean;
        snapshot: HostCommandSnapshot;
      }
    | { ok: false; message: string }
  > {
    const state = this.readStates[stream];
    const requestedOffset = state.nextOffset;
    const releaseUpTo = state.releaseUpTo;
    const observed = await this.hostCommands.interact({
      stateRoot: this.stateRoot,
      threadId: SYSTEM_SESSION_OWNER,
      owner: 'system',
      outputRef: this.outputRef,
      yieldTimeMs: 0,
      page: {
        stream,
        offsetBytes: requestedOffset,
        limitBytes: this.pageLimitBytes,
        deferRelease: true,
        ...(releaseUpTo === undefined ? {} : { releaseUpToBytes: releaseUpTo }),
      },
    });
    if (!observed.ok) {
      return { ok: false, message: observed.message };
    }
    if (state.releaseUpTo === releaseUpTo) {
      state.releaseUpTo = undefined;
    }
    const page = observed.value.page;
    const mayAdoptRetainedBase = state.mayAdoptRetainedBase;
    state.mayAdoptRetainedBase = false;
    if (page === null) {
      return {
        ok: true,
        hasMore: false,
        snapshot: observed.value.snapshot,
      };
    }
    if (page.offsetBytes !== requestedOffset) {
      if (mayAdoptRetainedBase && page.offsetBytes > requestedOffset) {
        state.nextOffset = page.offsetBytes;
      } else {
        return {
          ok: false,
          message: `detached command-host output gap: requested ${requestedOffset}, received ${page.offsetBytes}.`,
        };
      }
    }
    if (page.endOffsetBytes > state.nextOffset) {
      this.appendPage(stream, page.content);
      state.nextOffset = page.endOffsetBytes;
      state.unconsumedEnd = page.endOffsetBytes;
    }
    return {
      ok: true,
      hasMore: page.hasMore,
      snapshot: observed.value.snapshot,
    };
  }

  private drainStream(stream: DetachedProcessOutputStreamName): string {
    const buffer = stream === 'stdout' ? this.stdout : this.stderr;
    const output = buffer.drain();
    const state = this.readStates[stream];
    if (output.length > 0 && state.unconsumedEnd !== undefined) {
      state.releaseUpTo = state.unconsumedEnd;
      state.unconsumedEnd = undefined;
      this.wakeReadLoop();
    }
    return output;
  }

  private prepareStreamDelivery(stream: DetachedProcessOutputStreamName): {
    output: string;
    offsetBytes: number;
    releaseUpTo: number | undefined;
  } {
    const buffer = stream === 'stdout' ? this.stdout : this.stderr;
    const output = buffer.drain();
    const state = this.readStates[stream];
    const releaseUpTo = output.length > 0 ? state.unconsumedEnd : undefined;
    if (releaseUpTo !== undefined) {
      state.unconsumedEnd = undefined;
    }
    return {
      output,
      offsetBytes: releaseUpTo ?? state.nextOffset,
      releaseUpTo,
    };
  }

  private releasePreparedOutput(release: PreparedOutputRelease): void {
    if (release.stdoutBytes !== undefined) {
      this.readStates.stdout.releaseUpTo = release.stdoutBytes;
    }
    if (release.stderrBytes !== undefined) {
      this.readStates.stderr.releaseUpTo = release.stderrBytes;
    }
    if (
      release.stdoutBytes !== undefined ||
      release.stderrBytes !== undefined
    ) {
      this.wakeReadLoop();
    }
  }

  private hasPendingOutputRelease(): boolean {
    return (
      this.readStates.stdout.releaseUpTo !== undefined ||
      this.readStates.stderr.releaseUpTo !== undefined
    );
  }

  private async waitForHostOrReadLoopWake(
    afterRevision: number,
    afterWakeRevision: number,
  ): Promise<
    | { ok: true; snapshot: HostCommandSnapshot | null }
    | { ok: false; message: string }
  > {
    const hostAbort = new AbortController();
    const localAbort = new AbortController();
    const hostWait = this.hostCommands
      .interact({
        stateRoot: this.stateRoot,
        threadId: SYSTEM_SESSION_OWNER,
        owner: 'system',
        outputRef: this.outputRef,
        afterRevision,
        signal: hostAbort.signal,
      })
      .then(
        (result) => ({ kind: 'host' as const, result }),
        (error: unknown) => ({
          kind: 'host_error' as const,
          message: getErrorMessage(error),
        }),
      );
    const localWait = this.waitForReadLoopWake(
      afterWakeRevision,
      localAbort.signal,
    ).then(
      () => ({ kind: 'local' as const }),
      () => ({ kind: 'local_aborted' as const }),
    );
    const winner = await Promise.race([hostWait, localWait]);
    if (winner.kind === 'local') {
      hostAbort.abort();
      await hostWait;
      return { ok: true, snapshot: null };
    }
    localAbort.abort();
    await localWait;
    if (winner.kind === 'host_error') {
      return { ok: false, message: winner.message };
    }
    if (winner.kind === 'local_aborted') {
      return {
        ok: false,
        message: 'detached process read wait aborted unexpectedly.',
      };
    }
    if (!winner.result.ok) {
      return { ok: false, message: winner.result.message };
    }
    return { ok: true, snapshot: winner.result.value.snapshot };
  }

  private waitForReadLoopWake(
    afterRevision: number,
    abortSignal: AbortSignal,
  ): Promise<void> {
    if (this.readLoopRevision !== afterRevision) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        this.readLoopWaiters.delete(onWake);
        abortSignal.removeEventListener('abort', onAbort);
        fn();
      };
      const onAbort = () => {
        finish(() => reject(new Error('detached process read wait aborted')));
      };
      const onWake = () => {
        finish(resolve);
      };
      if (abortSignal.aborted) {
        onAbort();
        return;
      }
      this.readLoopWaiters.add(onWake);
      abortSignal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private wakeReadLoop(): void {
    this.readLoopRevision += 1;
    const waiters = [...this.readLoopWaiters];
    this.readLoopWaiters.clear();
    for (const waiter of waiters) {
      waiter();
    }
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
    this.wakeReadLoop();
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
