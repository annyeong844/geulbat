import {
  chmod,
  mkdir,
  open,
  readFile,
  type FileHandle,
} from 'node:fs/promises';

import type { HostCommandRuntime } from '../command-host/contract.js';
import {
  buildHostCommandPaths,
  commitHostCommandFullOutputArchive,
  readPersistedHostCommand,
  removeHostCommandDirectory,
  type HostCommandOutputStream,
  type HostCommandPaths,
  type HostCommandSnapshot,
} from './host-command-output-store.js';
import { writeTextFileAtomically } from './utils/atomic-file.js';
import { runDetached } from './utils/run-detached.js';

type FullOutputArchiveStatus = 'active' | 'complete' | 'failed';

interface FullOutputArchiveState {
  schemaVersion: 1;
  status: FullOutputArchiveStatus;
  message?: string;
}

export type HostCommandFullOutputArchiveResult =
  | { ok: true }
  | { ok: false; message: string };

export interface HostCommandFullOutputArchiveHandle {
  readonly completed: Promise<HostCommandFullOutputArchiveResult>;
  readonly status: FullOutputArchiveStatus;
  readonly failureMessage: string | null;
  activateRelease(): void;
  cancelAndRemove(): Promise<void>;
}

interface EnsureHostCommandFullOutputArchiveArgs {
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  threadId: string;
  outputRef: string;
  pageLimitBytes: number;
  createIfMissing: boolean;
  activateRelease?: boolean;
}

const activeArchivesByRuntime = new WeakMap<
  HostCommandRuntime,
  Map<string, Promise<HostCommandFullOutputArchiveHandle | null>>
>();

export async function ensureHostCommandFullOutputArchive(
  args: EnsureHostCommandFullOutputArchiveArgs,
): Promise<HostCommandFullOutputArchiveHandle | null> {
  const key = archiveKey(args);
  const activeArchives = getRuntimeArchives(args.hostCommands);
  const existing = activeArchives.get(key);
  if (existing !== undefined) {
    const handle = await existing;
    if (args.activateRelease === true) {
      handle?.activateRelease();
    }
    return handle;
  }

  const creating = prepareArchive(args);
  activeArchives.set(key, creating);
  const handle = await creating;
  if (handle === null) {
    activeArchives.delete(key);
    return null;
  }
  if (args.activateRelease === true) {
    handle.activateRelease();
  }
  runDetached(
    'host-command-full-output-archive/active-owner-cleanup',
    async () => {
      await handle.completed;
      if (activeArchives.get(key) === creating) {
        activeArchives.delete(key);
      }
    },
  );
  return handle;
}

async function prepareArchive(
  args: EnsureHostCommandFullOutputArchiveArgs,
): Promise<HostCommandFullOutputArchiveHandle | null> {
  if (!Number.isSafeInteger(args.pageLimitBytes) || args.pageLimitBytes <= 0) {
    throw new Error(
      'host command full-output archive page limit must be a positive integer',
    );
  }
  let paths: HostCommandPaths;
  try {
    paths = buildHostCommandPaths(args);
  } catch (error: unknown) {
    if (!args.createIfMissing) {
      return null;
    }
    throw error;
  }
  const persisted = await readPersistedHostCommand(args);
  if (persisted.ok && persisted.value.metadata.fullOutputAvailable === true) {
    return settledHandle({ ok: true }, 'complete');
  }

  const state = await readArchiveState(paths);
  if (state?.status === 'complete') {
    return settledHandle({ ok: true }, 'complete');
  }
  if (state?.status === 'failed') {
    return settledHandle(
      {
        ok: false,
        message:
          state.message ??
          'host command full-output archive previously failed.',
      },
      'failed',
    );
  }
  if (state === null && !args.createIfMissing) {
    return null;
  }

  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  const [stdoutHandle, stderrHandle] = await Promise.all([
    openArchiveFile(paths.stdoutFull),
    openArchiveFile(paths.stderrFull),
  ]);
  try {
    await writeArchiveState(paths, { schemaVersion: 1, status: 'active' });
  } catch (error: unknown) {
    await Promise.all([
      closeFileHandle(stdoutHandle),
      closeFileHandle(stderrHandle),
    ]);
    throw error;
  }
  return new FullOutputArchive({
    ...args,
    paths,
    stdoutHandle,
    stderrHandle,
  });
}

class FullOutputArchive implements HostCommandFullOutputArchiveHandle {
  readonly completed: Promise<HostCommandFullOutputArchiveResult>;
  private currentStatus: FullOutputArchiveStatus = 'active';
  private currentFailureMessage: string | null = null;
  private releaseEnabled = false;
  private cancelled = false;
  private readonly abortController = new AbortController();
  private readonly releaseWaiters = new Set<() => void>();
  private readonly hostCommands: HostCommandRuntime;
  private readonly stateRoot: string;
  private readonly threadId: string;
  private readonly outputRef: string;
  private readonly pageLimitBytes: number;
  private readonly paths: HostCommandPaths;
  private readonly stdoutHandle: FileHandle;
  private readonly stderrHandle: FileHandle;

  constructor(args: {
    hostCommands: HostCommandRuntime;
    stateRoot: string;
    threadId: string;
    outputRef: string;
    pageLimitBytes: number;
    paths: HostCommandPaths;
    stdoutHandle: FileHandle;
    stderrHandle: FileHandle;
  }) {
    this.hostCommands = args.hostCommands;
    this.stateRoot = args.stateRoot;
    this.threadId = args.threadId;
    this.outputRef = args.outputRef;
    this.pageLimitBytes = args.pageLimitBytes;
    this.paths = args.paths;
    this.stdoutHandle = args.stdoutHandle;
    this.stderrHandle = args.stderrHandle;
    this.completed = this.run();
  }

  get status(): FullOutputArchiveStatus {
    return this.currentStatus;
  }

  get failureMessage(): string | null {
    return this.currentFailureMessage;
  }

  activateRelease(): void {
    if (this.releaseEnabled) {
      return;
    }
    this.releaseEnabled = true;
    for (const wake of this.releaseWaiters) {
      wake();
    }
    this.releaseWaiters.clear();
  }

  async cancelAndRemove(): Promise<void> {
    this.cancelled = true;
    this.abortController.abort();
    this.activateRelease();
    await this.completed;
    await removeHostCommandDirectory(this.paths.directory);
  }

  private async run(): Promise<HostCommandFullOutputArchiveResult> {
    try {
      await Promise.all([
        this.drainStream('stdout', this.stdoutHandle),
        this.drainStream('stderr', this.stderrHandle),
      ]);
      await Promise.all([this.stdoutHandle.sync(), this.stderrHandle.sync()]);
      await Promise.all([
        closeFileHandle(this.stdoutHandle),
        closeFileHandle(this.stderrHandle),
      ]);
      if (this.cancelled) {
        return { ok: false, message: 'full-output archive was cancelled.' };
      }
      const committed = await commitHostCommandFullOutputArchive({
        stateRoot: this.stateRoot,
        threadId: this.threadId,
        outputRef: this.outputRef,
      });
      if (!committed.ok) {
        throw new Error(committed.message);
      }
      await writeArchiveState(this.paths, {
        schemaVersion: 1,
        status: 'complete',
      });
      this.currentStatus = 'complete';
      return { ok: true };
    } catch (error: unknown) {
      await Promise.all([
        closeFileHandle(this.stdoutHandle),
        closeFileHandle(this.stderrHandle),
      ]);
      const message = getErrorMessage(error);
      if (this.cancelled || isAbortError(error)) {
        return { ok: false, message: 'full-output archive was cancelled.' };
      }
      if (error instanceof FullOutputArchiveInterruptedError) {
        return { ok: false, message };
      }
      this.currentStatus = 'failed';
      this.currentFailureMessage = message;
      await writeArchiveState(this.paths, {
        schemaVersion: 1,
        status: 'failed',
        message,
      }).catch(() => undefined);
      await this.hostCommands
        .interact({
          stateRoot: this.stateRoot,
          threadId: this.threadId,
          outputRef: this.outputRef,
          terminate: true,
          yieldTimeMs: 0,
        })
        .catch(() => undefined);
      return { ok: false, message };
    }
  }

  private async drainStream(
    stream: HostCommandOutputStream,
    handle: FileHandle,
  ): Promise<void> {
    let nextOffset = 0;
    let pendingRelease: number | undefined;
    let aligned = false;
    let hasMore = true;
    for (;;) {
      const releaseUpTo = this.releaseEnabled ? pendingRelease : undefined;
      const observed = await this.hostCommands.interact({
        stateRoot: this.stateRoot,
        threadId: this.threadId,
        outputRef: this.outputRef,
        page: {
          stream,
          offsetBytes: aligned ? nextOffset : 0,
          limitBytes: this.pageLimitBytes,
          deferRelease: true,
          ...(releaseUpTo === undefined
            ? {}
            : { releaseUpToBytes: releaseUpTo }),
        },
        ...(!aligned || hasMore || releaseUpTo !== undefined
          ? { yieldTimeMs: 0 }
          : {}),
        signal: this.abortController.signal,
      });
      if (!observed.ok) {
        if (
          observed.reasonCode === 'output_store_failed' &&
          observed.message === 'command-host connection was lost.'
        ) {
          throw new FullOutputArchiveInterruptedError(observed.message);
        }
        throw new Error(observed.message);
      }
      if (pendingRelease === releaseUpTo) {
        pendingRelease = undefined;
      }
      this.activateWhenInlineIsImpossible(observed.value.snapshot);
      const page = observed.value.page;
      if (page === null) {
        throw new Error(
          `host command ${stream} full-output archive received no requested page.`,
        );
      }
      if (!aligned) {
        const remoteBase = page.earliestAvailableOffset ?? page.offsetBytes;
        const stats = await handle.stat();
        if (stats.size < remoteBase) {
          throw new Error(
            `host command ${stream} full-output archive is missing ${remoteBase - stats.size} durably released bytes.`,
          );
        }
        if (stats.size > remoteBase) {
          await handle.truncate(remoteBase);
          await handle.sync();
        }
        nextOffset = remoteBase;
        aligned = true;
      }
      if (page.offsetBytes !== nextOffset) {
        throw new Error(
          `host command ${stream} full-output archive gap: expected ${nextOffset}, received ${page.offsetBytes}.`,
        );
      }
      const contentStartOffset = page.contentStartOffset ?? page.offsetBytes;
      if (contentStartOffset !== nextOffset) {
        throw new Error(
          `host command ${stream} full-output archive page did not begin at a UTF-8 boundary.`,
        );
      }
      if (page.endOffsetBytes > nextOffset) {
        const content = Buffer.from(page.content, 'utf8');
        if (content.length !== page.endOffsetBytes - nextOffset) {
          throw new Error(
            `host command ${stream} full-output archive cannot losslessly encode a non-UTF-8 page.`,
          );
        }
        const written = await handle.write(
          content,
          0,
          content.length,
          nextOffset,
        );
        if (written.bytesWritten !== content.length) {
          throw new Error(
            `host command ${stream} full-output archive short write.`,
          );
        }
        await handle.sync();
        nextOffset = page.endOffsetBytes;
        pendingRelease = nextOffset;
      }
      hasMore = page.hasMore;

      const expectedBytes =
        stream === 'stdout'
          ? observed.value.snapshot.stdoutBytes
          : observed.value.snapshot.stderrBytes;
      if (
        observed.value.snapshot.status !== 'running' &&
        !hasMore &&
        nextOffset >= expectedBytes
      ) {
        if (pendingRelease !== undefined && !this.releaseEnabled) {
          await this.waitForReleaseActivation();
          hasMore = true;
          continue;
        }
        if (pendingRelease !== undefined) {
          hasMore = true;
          continue;
        }
        if (nextOffset !== expectedBytes) {
          throw new Error(
            `host command ${stream} full-output archive byte count does not match the terminal snapshot.`,
          );
        }
        return;
      }
    }
  }

  private activateWhenInlineIsImpossible(snapshot: HostCommandSnapshot): void {
    const combinedBytes = snapshot.stdoutBytes + snapshot.stderrBytes;
    if (
      combinedBytes > this.pageLimitBytes ||
      (snapshot.status === 'running' && combinedBytes >= this.pageLimitBytes)
    ) {
      this.activateRelease();
    }
  }

  private async waitForReleaseActivation(): Promise<void> {
    if (this.releaseEnabled) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.releaseWaiters.add(resolve);
      if (this.releaseEnabled) {
        this.releaseWaiters.delete(resolve);
        resolve();
      }
    });
  }
}

class FullOutputArchiveInterruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FullOutputArchiveInterruptedError';
  }
}

function getRuntimeArchives(
  runtime: HostCommandRuntime,
): Map<string, Promise<HostCommandFullOutputArchiveHandle | null>> {
  const existing = activeArchivesByRuntime.get(runtime);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Map<
    string,
    Promise<HostCommandFullOutputArchiveHandle | null>
  >();
  activeArchivesByRuntime.set(runtime, created);
  return created;
}

function settledHandle(
  result: HostCommandFullOutputArchiveResult,
  status: 'complete' | 'failed',
): HostCommandFullOutputArchiveHandle {
  return {
    completed: Promise.resolve(result),
    status,
    failureMessage: result.ok ? null : result.message,
    activateRelease() {},
    async cancelAndRemove() {},
  };
}

async function openArchiveFile(path: string): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await open(path, 'r+');
  } catch (error: unknown) {
    if (getErrorCode(error) !== 'ENOENT') {
      throw error;
    }
    handle = await open(path, 'wx+', 0o600);
  }
  await chmod(path, 0o600);
  return handle;
}

async function readArchiveState(
  paths: HostCommandPaths,
): Promise<FullOutputArchiveState | null> {
  let raw: string;
  try {
    raw = await readFile(paths.fullOutputState, 'utf8');
  } catch (error: unknown) {
    if (getErrorCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('host command full-output archive state is not valid JSON');
  }
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !['schemaVersion', 'status', 'message'].includes(key),
    ) ||
    value['schemaVersion'] !== 1 ||
    (value['status'] !== 'active' &&
      value['status'] !== 'complete' &&
      value['status'] !== 'failed') ||
    (value['message'] !== undefined && typeof value['message'] !== 'string') ||
    (value['status'] === 'failed' && typeof value['message'] !== 'string')
  ) {
    throw new Error('host command full-output archive state is invalid');
  }
  return {
    schemaVersion: 1,
    status: value['status'],
    ...(value['message'] === undefined ? {} : { message: value['message'] }),
  };
}

async function writeArchiveState(
  paths: HostCommandPaths,
  state: FullOutputArchiveState,
): Promise<void> {
  await writeTextFileAtomically(
    paths.fullOutputState,
    `${JSON.stringify(state, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function closeFileHandle(handle: FileHandle): Promise<void> {
  await handle.close().catch(() => undefined);
}

function archiveKey(args: {
  stateRoot: string;
  threadId: string;
  outputRef: string;
}): string {
  return `${args.stateRoot}\u0000${args.threadId}\u0000${args.outputRef}`;
}

function isAbortError(error: unknown): boolean {
  return getErrorCode(error) === 'ABORT_ERR';
}

function getErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  const code = error['code'];
  return typeof code === 'string' ? code : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'host command full-output archive failed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
