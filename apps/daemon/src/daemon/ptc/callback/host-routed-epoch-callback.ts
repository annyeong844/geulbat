import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, unlink } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import type {
  CreatePtcEpochCallbackChannelArgs,
  PtcEpochCallbackChannel,
  PtcEpochCallbackHandler,
} from './epoch-callback.js';
import {
  encodePtcEpochCallbackHostFrame,
  parsePtcEpochCallbackHostFrame,
  type PtcEpochCallbackDaemonFrame,
  type PtcEpochCallbackHostFrame,
} from './epoch-callback-host-protocol.js';
import type {
  PtcEpochCallbackChannelFactory,
  PtcSessionEpochBridgeCallbackPolicy,
} from './session-epoch-bridge.js';
import type {
  DetachedProcessStartResult,
  HostRoutedDetachedProcessHandle as PtcCallbackHostProcessHandle,
} from '../../utils/detached-process.js';
import { runDetached } from '../../utils/run-detached.js';

interface PtcCallbackHostProcessInvocation {
  callId: string;
  executable: string;
  args: readonly string[];
  redactionMarkers: readonly string[];
  redactionReplacement: string;
  stdinMode: 'open';
}

export type PtcCallbackHostProcessStarter = (
  invocation: PtcCallbackHostProcessInvocation,
) => Promise<DetachedProcessStartResult<PtcCallbackHostProcessHandle>>;

export type PtcCallbackHostProcessAttacher = (invocation: {
  outputRef: string;
}) => Promise<DetachedProcessStartResult<PtcCallbackHostProcessHandle>>;

export interface HostRoutedPtcEpochCallbackController {
  readonly processOutputRef: string;
  replaceHandler(handler: PtcEpochCallbackHandler): void;
  close(): Promise<void>;
}

interface PtcCallbackHostReadyIdentity {
  epochId: string;
  token: string;
  socketPath: string;
}

interface PtcCallbackHostWorkerCommand {
  execPath: string;
  args: readonly string[];
}

interface HostRoutedPtcEpochCallbackChannelFactoryOptions {
  startProcess: PtcCallbackHostProcessStarter;
  workerCommand?: PtcCallbackHostWorkerCommand;
}

interface InflightCallback {
  controller: AbortController;
  cancelled: boolean;
  longWaitAdmissions: Map<string, (admitted: boolean) => void>;
}

class PtcCallbackHostControl {
  private readonly socket: Socket;
  private handler: PtcEpochCallbackHandler;
  private readonly inflight = new Map<string, InflightCallback>();
  private readySettled = false;
  private shutdownSettled = false;
  private resolveReady: (identity: PtcCallbackHostReadyIdentity) => void = () =>
    undefined;
  private rejectReady: (error: Error) => void = () => undefined;
  private resolveShutdown: () => void = () => undefined;
  private rejectShutdown: (error: Error) => void = () => undefined;
  private readonly ready: Promise<PtcCallbackHostReadyIdentity>;
  private readonly shutdownAcknowledged: Promise<void>;

  constructor(args: { socket: Socket; handler: PtcEpochCallbackHandler }) {
    this.socket = args.socket;
    this.handler = args.handler;
    this.ready = new Promise<PtcCallbackHostReadyIdentity>(
      (resolve, reject) => {
        this.resolveReady = resolve;
        this.rejectReady = reject;
      },
    );
    this.shutdownAcknowledged = new Promise<void>((resolve, reject) => {
      this.resolveShutdown = resolve;
      this.rejectShutdown = reject;
    });
    runDetached('ptc/callback-host-ready-observer', () =>
      this.ready.catch(() => undefined),
    );
    runDetached('ptc/callback-host-shutdown-observer', () =>
      this.shutdownAcknowledged.catch(() => undefined),
    );

    this.socket.setEncoding('utf8');
    this.socket.on('error', () => undefined);
    const lines = createInterface({ input: this.socket, crlfDelay: Infinity });
    lines.on('line', (line) => {
      const frame = parsePtcEpochCallbackHostFrame(line);
      if (frame !== undefined) {
        this.handleFrame(frame);
      }
    });
    this.socket.on('close', () => {
      lines.close();
      const error = new Error('PTC callback host control connection closed');
      this.settleReadyFailure(error);
      this.settleShutdownFailure(error);
      for (const inflight of this.inflight.values()) {
        inflight.cancelled = true;
        inflight.controller.abort();
        for (const resolve of inflight.longWaitAdmissions.values()) {
          resolve(false);
        }
        inflight.longWaitAdmissions.clear();
      }
      this.inflight.clear();
    });
  }

  async waitUntilReady(): Promise<PtcCallbackHostReadyIdentity> {
    return await this.ready;
  }

  replaceHandler(handler: PtcEpochCallbackHandler): void {
    this.handler = handler;
  }

  async shutdown(): Promise<void> {
    if (!this.send({ kind: 'shutdown' })) {
      throw new Error('PTC callback host shutdown could not be requested');
    }
    await this.shutdownAcknowledged;
  }

  destroy(): void {
    this.socket.destroy();
  }

  private handleFrame(frame: PtcEpochCallbackHostFrame): void {
    if (frame.kind === 'ready') {
      this.settleReadySuccess({
        epochId: frame.epochId,
        token: frame.token,
        socketPath: frame.socketPath,
      });
      return;
    }
    if (frame.kind === 'startup_failed' || frame.kind === 'busy') {
      this.settleReadyFailure(
        new Error(
          frame.kind === 'busy'
            ? 'PTC callback host already has an active daemon controller'
            : 'PTC callback host failed to open its epoch channel',
        ),
      );
      return;
    }
    if (frame.kind === 'closed') {
      this.settleShutdownSuccess();
      return;
    }
    if (frame.kind === 'cancel') {
      const inflight = this.inflight.get(frame.invocationId);
      if (inflight !== undefined) {
        inflight.cancelled = true;
        inflight.controller.abort();
        for (const resolve of inflight.longWaitAdmissions.values()) {
          resolve(false);
        }
        inflight.longWaitAdmissions.clear();
      }
      return;
    }
    if (frame.kind === 'long_wait_result') {
      const inflight = this.inflight.get(frame.invocationId);
      if (inflight === undefined) {
        return;
      }
      const resolve = inflight.longWaitAdmissions.get(frame.admissionId);
      if (resolve !== undefined) {
        inflight.longWaitAdmissions.delete(frame.admissionId);
        resolve(frame.admitted);
      }
      return;
    }
    this.dispatchInvocation(frame);
  }

  private dispatchInvocation(
    frame: Extract<PtcEpochCallbackHostFrame, { kind: 'invoke' }>,
  ): void {
    if (this.inflight.has(frame.invocationId)) {
      this.send({
        kind: 'handler_failed',
        invocationId: frame.invocationId,
      });
      return;
    }
    const inflight: InflightCallback = {
      controller: new AbortController(),
      cancelled: false,
      longWaitAdmissions: new Map(),
    };
    this.inflight.set(frame.invocationId, inflight);
    runDetached('ptc/callback-host-dispatch', async () => {
      try {
        const handlerResult = await this.handler({
          requestId: frame.requestId,
          kind: frame.callbackKind,
          args: frame.args,
          signal: inflight.controller.signal,
          enterLongWait: () =>
            this.requestLongWait(frame.invocationId, inflight),
        });
        if (
          !inflight.cancelled &&
          this.inflight.get(frame.invocationId) === inflight &&
          !this.send({
            kind: 'settle',
            invocationId: frame.invocationId,
            handlerResult,
          })
        ) {
          this.send({
            kind: 'handler_failed',
            invocationId: frame.invocationId,
          });
        }
      } catch {
        if (!inflight.cancelled) {
          this.send({
            kind: 'handler_failed',
            invocationId: frame.invocationId,
          });
        }
      } finally {
        if (this.inflight.get(frame.invocationId) === inflight) {
          this.inflight.delete(frame.invocationId);
        }
        for (const resolve of inflight.longWaitAdmissions.values()) {
          resolve(false);
        }
        inflight.longWaitAdmissions.clear();
      }
    });
  }

  private requestLongWait(
    invocationId: string,
    inflight: InflightCallback,
  ): Promise<boolean> {
    if (inflight.cancelled || this.inflight.get(invocationId) !== inflight) {
      return Promise.resolve(false);
    }
    const admissionId = randomUUID();
    return new Promise<boolean>((resolve) => {
      inflight.longWaitAdmissions.set(admissionId, resolve);
      if (
        !this.send({
          kind: 'enter_long_wait',
          invocationId,
          admissionId,
        })
      ) {
        inflight.longWaitAdmissions.delete(admissionId);
        resolve(false);
      }
    });
  }

  private send(frame: PtcEpochCallbackDaemonFrame): boolean {
    if (this.socket.destroyed) {
      return false;
    }
    try {
      this.socket.write(encodePtcEpochCallbackHostFrame(frame));
      return true;
    } catch {
      return false;
    }
  }

  private settleReadySuccess(identity: PtcCallbackHostReadyIdentity): void {
    if (this.readySettled) {
      return;
    }
    this.readySettled = true;
    this.resolveReady(identity);
  }

  private settleReadyFailure(error: Error): void {
    if (this.readySettled) {
      return;
    }
    this.readySettled = true;
    this.rejectReady(error);
  }

  private settleShutdownSuccess(): void {
    if (this.shutdownSettled) {
      return;
    }
    this.shutdownSettled = true;
    this.resolveShutdown();
  }

  private settleShutdownFailure(error: Error): void {
    if (this.shutdownSettled) {
      return;
    }
    this.shutdownSettled = true;
    this.rejectShutdown(error);
  }
}

export function createHostRoutedPtcEpochCallbackChannelFactory(
  options: HostRoutedPtcEpochCallbackChannelFactoryOptions,
): PtcEpochCallbackChannelFactory {
  return (args) =>
    createHostRoutedPtcEpochCallbackChannel({
      ...args,
      ...options,
    });
}

export function createHostRoutedPtcEpochCallbackControllerAttacher(options: {
  attachProcess: PtcCallbackHostProcessAttacher;
}): (args: {
  outputRef: string;
  handler: PtcEpochCallbackHandler;
}) => Promise<HostRoutedPtcEpochCallbackController> {
  return async (args) => {
    if (process.platform === 'win32') {
      throw new Error(
        'ptc_epoch_callback_host_unavailable: Unix sockets require Linux or WSL',
      );
    }
    const controlEndpoint = await createControlEndpoint();
    let handle: PtcCallbackHostProcessHandle | undefined;
    let control: PtcCallbackHostControl | undefined;
    try {
      const attached = await options.attachProcess({
        outputRef: args.outputRef,
      });
      if (!attached.ok) {
        throw new Error('PTC epoch callback host process re-adoption failed');
      }
      handle = attached.handle;
      const written = await handle.writeInput(
        encodePtcEpochCallbackHostFrame({
          kind: 'attach',
          controlSocketPath: controlEndpoint.socketPath,
        }),
      );
      if (!written.ok) {
        throw new Error('PTC epoch callback host attach was not delivered');
      }
      const socket = await Promise.race([
        controlEndpoint.accepted,
        handle.exit.then(() => {
          throw new Error(
            'PTC epoch callback host exited before re-attachment',
          );
        }),
      ]);
      control = new PtcCallbackHostControl({
        socket,
        handler: args.handler,
      });
      await Promise.race([
        control.waitUntilReady(),
        handle.exit.then(() => {
          throw new Error(
            'PTC epoch callback host exited before re-attachment readiness',
          );
        }),
      ]);
      await controlEndpoint.retire();
    } catch (error) {
      control?.destroy();
      handle?.stop();
      await handle?.exit.catch(() => undefined);
      await controlEndpoint.dispose();
      throw error;
    }

    let closePromise: Promise<void> | undefined;
    return {
      processOutputRef: handle.outputRef,
      replaceHandler: (handler) => control.replaceHandler(handler),
      close: async () => {
        closePromise ??= (async () => {
          let cleanupProven = false;
          try {
            await control.shutdown();
            cleanupProven = true;
          } finally {
            if (!cleanupProven) {
              handle.stop();
            }
            const exit = await handle.exit;
            control.destroy();
            if (!cleanupProven || exit.kind !== 'exit' || exit.exitCode !== 0) {
              throw new Error('PTC epoch callback host cleanup was not proven');
            }
          }
        })();
        await closePromise;
      },
    };
  };
}

async function createHostRoutedPtcEpochCallbackChannel(
  args: CreatePtcEpochCallbackChannelArgs &
    HostRoutedPtcEpochCallbackChannelFactoryOptions,
): Promise<PtcEpochCallbackChannel> {
  if (process.platform === 'win32') {
    throw new Error(
      'ptc_epoch_callback_host_unavailable: Unix sockets require Linux or WSL',
    );
  }
  const policy = requireCallbackPolicy(args);
  const workerCommand = args.workerCommand ?? resolveWorkerCommand();
  if (workerCommand === undefined) {
    throw new Error('PTC epoch callback host entry was not found');
  }

  const epochId = randomBytes(8).toString('hex');
  const token = randomBytes(32).toString('hex');
  const epochDir = join(args.rootDir, `ptc-epoch-${epochId}`);
  const socketPath = join(epochDir, 'callback.sock');
  const controlEndpoint = await createControlEndpoint();
  let handle: PtcCallbackHostProcessHandle | undefined;
  let control: PtcCallbackHostControl | undefined;
  try {
    const started = await args.startProcess({
      callId: `ptc-callback-${args.processInvocationId ?? epochId}`,
      executable: workerCommand.execPath,
      args: workerCommand.args,
      redactionMarkers: [token, socketPath, controlEndpoint.socketPath],
      redactionReplacement: '[redacted:ptc-callback]',
      stdinMode: 'open',
    });
    if (!started.ok) {
      throw new Error('PTC epoch callback host process failed to start');
    }
    handle = started.handle;
    const written = await handle.writeInput(
      encodePtcEpochCallbackHostFrame({
        kind: 'initialize_or_attach',
        rootDir: args.rootDir,
        epochId,
        token,
        controlSocketPath: controlEndpoint.socketPath,
        policy,
      }),
    );
    if (!written.ok) {
      throw new Error('PTC epoch callback host bootstrap was not delivered');
    }

    const socket = await Promise.race([
      controlEndpoint.accepted,
      handle.exit.then(() => {
        throw new Error('PTC epoch callback host exited before attachment');
      }),
    ]);
    control = new PtcCallbackHostControl({ socket, handler: args.handler });
    const readyIdentity = await Promise.race([
      control.waitUntilReady(),
      handle.exit.then(() => {
        throw new Error('PTC epoch callback host exited before readiness');
      }),
    ]);
    await controlEndpoint.retire();
    const readyEpochDir = dirname(readyIdentity.socketPath);
    return createControlledCallbackChannel({
      control,
      handle,
      identity: {
        ...readyIdentity,
        epochDir: readyEpochDir,
      },
    });
  } catch (error) {
    control?.destroy();
    handle?.stop();
    await handle?.exit.catch(() => undefined);
    await controlEndpoint.dispose();
    throw error;
  }
}

function createControlledCallbackChannel(args: {
  control: PtcCallbackHostControl;
  handle: PtcCallbackHostProcessHandle;
  identity: PtcCallbackHostReadyIdentity & { epochDir: string };
}): PtcEpochCallbackChannel {
  let closePromise: Promise<void> | undefined;
  return {
    epochId: args.identity.epochId,
    token: args.identity.token,
    epochDir: args.identity.epochDir,
    socketPath: args.identity.socketPath,
    processOutputRef: args.handle.outputRef,
    replaceHandler: (handler) => args.control.replaceHandler(handler),
    close: async () => {
      closePromise ??= (async () => {
        let cleanupProven = false;
        try {
          await args.control.shutdown();
          cleanupProven = true;
        } finally {
          if (!cleanupProven) {
            args.handle.stop();
          }
          const exit = await args.handle.exit;
          args.control.destroy();
          if (!cleanupProven || exit.kind !== 'exit' || exit.exitCode !== 0) {
            throw new Error('PTC epoch callback host cleanup was not proven');
          }
        }
      })();
      await closePromise;
    },
  };
}

function requireCallbackPolicy(
  args: CreatePtcEpochCallbackChannelArgs,
): PtcSessionEpochBridgeCallbackPolicy {
  const policy = {
    maxFrameBytes: args.maxFrameBytes,
    maxOpenConnections: args.maxOpenConnections,
    maxCallbacks: args.maxCallbacks,
    callbackTimeoutMs: args.callbackTimeoutMs,
    maxResponseBytes: args.maxResponseBytes,
  };
  for (const value of Object.values(policy)) {
    if (!Number.isSafeInteger(value) || Number(value) < 1) {
      throw new Error('PTC epoch callback host requires complete policy');
    }
  }
  return policy as PtcSessionEpochBridgeCallbackPolicy;
}

function resolveWorkerCommand(): PtcCallbackHostWorkerCommand | undefined {
  const sibling = fileURLToPath(
    new URL('./epoch-callback-host-main.js', import.meta.url),
  );
  if (existsSync(sibling)) {
    return { execPath: process.execPath, args: [sibling] };
  }
  const bundleEntry = process.argv[1];
  if (bundleEntry === undefined) {
    return undefined;
  }
  const bundled = join(dirname(bundleEntry), 'ptc-callback-host.mjs');
  return existsSync(bundled)
    ? { execPath: process.execPath, args: [bundled] }
    : undefined;
}

async function createControlEndpoint(): Promise<{
  socketPath: string;
  accepted: Promise<Socket>;
  retire(): Promise<void>;
  dispose(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-ptc-control-'));
  await chmod(root, 0o700);
  const socketPath = join(root, 'control.sock');
  const server = createServer();
  let acceptedSocket: Socket | undefined;
  let disposed = false;
  const accepted = new Promise<Socket>((resolve, reject) => {
    server.once('error', reject);
    server.once('connection', (socket) => {
      acceptedSocket = socket;
      server.removeListener('error', reject);
      resolve(socket);
    });
  });
  await listen(server, socketPath);
  await chmod(socketPath, 0o600);

  async function removeEndpoint(): Promise<void> {
    await unlink(socketPath).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }

  return {
    socketPath,
    accepted,
    async retire() {
      if (disposed) {
        return;
      }
      disposed = true;
      server.close();
      await removeEndpoint();
    },
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      acceptedSocket?.destroy();
      await closeServer(server);
      await removeEndpoint();
    },
  };
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
