import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { isPtcRecord } from '../shared/record-shape.js';
import { runDetached } from '../../utils/run-detached.js';

type PtcEpochCallbackHandlerResult =
  | { ok: true; result?: unknown }
  | {
      ok: false;
      errorCode: string;
      message: string;
      remediation?: string;
      details?: Record<string, unknown>;
    };

export interface PtcEpochCallbackHandlerInvocation {
  requestId: string;
  kind: string;
  args: unknown;
  cellId?: string;
  signal: AbortSignal;
  enterLongWait(this: void): boolean | Promise<boolean>;
}

export type PtcEpochCallbackHandler = (
  invocation: PtcEpochCallbackHandlerInvocation,
) => Promise<PtcEpochCallbackHandlerResult>;

export interface PtcEpochCallbackChannel {
  epochId: string;
  token: string;
  epochDir: string;
  socketPath: string;
  processOutputRef?: string;
  replaceHandler?(handler: PtcEpochCallbackHandler): void;
  close(): Promise<void>;
}

interface PtcEpochCallbackChannelIdentity {
  epochId: string;
  token: string;
}

export interface CreatePtcEpochCallbackChannelArgs {
  rootDir: string;
  handler: PtcEpochCallbackHandler;
  identity?: PtcEpochCallbackChannelIdentity;
  processInvocationId?: string;
  maxFrameBytes?: number;
  maxCallbacks?: number;
  maxOpenConnections?: number;
  callbackTimeoutMs?: number;
  maxResponseBytes?: number;
}

type PtcWireResponse =
  | { requestId?: string; ok: true; result?: unknown }
  | {
      requestId?: string;
      ok: false;
      errorCode: string;
      message: string;
      remediation?: string;
      details?: Record<string, unknown>;
    };

export async function createPtcEpochCallbackChannel(
  args: CreatePtcEpochCallbackChannelArgs,
): Promise<PtcEpochCallbackChannel> {
  if (process.platform === 'win32') {
    throw new Error(
      'ptc_epoch_callback_unavailable: Unix sockets require Linux or WSL',
    );
  }

  const identity = args.identity ?? {
    epochId: randomBytes(8).toString('hex'),
    token: randomBytes(32).toString('hex'),
  };
  requirePtcEpochCallbackChannelIdentity(identity);
  const { epochId, token } = identity;
  const maxFrameBytes = args.maxFrameBytes;
  const maxCallbacks = args.maxCallbacks;
  const maxOpenConnections = args.maxOpenConnections;
  const callbackTimeoutMs = args.callbackTimeoutMs;
  const maxResponseBytes = args.maxResponseBytes;
  const epochDir =
    args.identity === undefined
      ? await mkdtemp(join(args.rootDir, 'ptc-epoch-'))
      : join(args.rootDir, `ptc-epoch-${epochId}`);
  if (args.identity !== undefined) {
    await mkdir(epochDir, { mode: 0o700 });
  }

  try {
    await chmod(epochDir, 0o700);
    const socketPath = join(epochDir, 'callback.sock');
    let callbackCount = 0;
    let closed = false;
    let closePromise: Promise<void> | null = null;
    const openConnections = new Set<Socket>();
    const pendingControllers = new Set<AbortController>();
    const server = createServer((socket) => {
      const connectionOverCap =
        maxOpenConnections !== undefined &&
        openConnections.size >= maxOpenConnections;
      if (connectionOverCap) {
        socket.on('error', () => {});
        endWithResponse(
          socket,
          {
            ok: false,
            errorCode: 'too_many_connections',
            message: 'PTC callback open connection limit exceeded',
          },
          maxResponseBytes,
        );
        return;
      }

      openConnections.add(socket);
      socket.on('error', () => {
        openConnections.delete(socket);
      });
      socket.on('close', () => {
        openConnections.delete(socket);
      });

      socket.setEncoding('utf8');
      let buffer = '';
      let handled = false;
      let frameTimeout: ReturnType<typeof setTimeout> | undefined;
      const clearFrameTimeout = () => {
        if (frameTimeout !== undefined) {
          clearTimeout(frameTimeout);
          frameTimeout = undefined;
        }
      };
      if (callbackTimeoutMs !== undefined) {
        frameTimeout = setTimeout(() => {
          if (handled) {
            return;
          }
          handled = true;
          clearFrameTimeout();
          endWithResponse(
            socket,
            {
              ok: false,
              errorCode: 'callback_timeout',
              message: 'PTC callback frame timed out',
            },
            maxResponseBytes,
          );
        }, callbackTimeoutMs);
      }
      socket.on('close', clearFrameTimeout);
      socket.on('error', clearFrameTimeout);

      socket.on('data', (chunk) => {
        if (handled) {
          return;
        }
        buffer += String(chunk);
        if (
          maxFrameBytes !== undefined &&
          Buffer.byteLength(buffer, 'utf8') > maxFrameBytes
        ) {
          handled = true;
          clearFrameTimeout();
          endWithResponse(
            socket,
            {
              ok: false,
              errorCode: 'frame_too_large',
              message: 'PTC callback frame exceeds maxFrameBytes',
            },
            maxResponseBytes,
          );
          return;
        }

        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex >= 0) {
          handled = true;
          clearFrameTimeout();
          const line = buffer.slice(0, newlineIndex);
          buffer = '';
          runDetached('ptc/callback-frame', () =>
            handleCallbackFrame({
              line,
              socket,
              token,
              handler: args.handler,
              callbackTimeoutMs,
              maxResponseBytes,
              pendingControllers,
              get closed() {
                return closed;
              },
              tryReserveCallbackSlot: () => {
                if (
                  maxCallbacks !== undefined &&
                  callbackCount >= maxCallbacks
                ) {
                  return false;
                }
                callbackCount += 1;
                return true;
              },
            }).finally(() => socket.end()),
          );
        }
      });
    });

    await listen(server, socketPath);

    return {
      epochId,
      token,
      epochDir,
      socketPath,
      close: async () => {
        closePromise ??= (async () => {
          closed = true;
          for (const controller of pendingControllers) {
            controller.abort();
          }
          for (const socket of openConnections) {
            socket.destroy();
          }
          await closeServer(server);
          await rm(epochDir, { recursive: true, force: true });
        })();
        await closePromise;
      },
    };
  } catch (error) {
    await rm(epochDir, { recursive: true, force: true });
    throw error;
  }
}

function requirePtcEpochCallbackChannelIdentity(
  identity: PtcEpochCallbackChannelIdentity,
): void {
  if (!/^[a-f0-9]{16}$/u.test(identity.epochId)) {
    throw new Error('PTC epoch callback identity is invalid');
  }
  if (!/^[a-f0-9]{64}$/u.test(identity.token)) {
    throw new Error('PTC epoch callback token is invalid');
  }
}

interface HandleCallbackFrameArgs {
  line: string;
  socket: Socket;
  token: string;
  handler: PtcEpochCallbackHandler;
  callbackTimeoutMs: number | undefined;
  maxResponseBytes: number | undefined;
  pendingControllers: Set<AbortController>;
  closed: boolean;
  tryReserveCallbackSlot(): boolean;
}

function isPtcEpochCallbackHandlerResult(
  value: unknown,
): value is PtcEpochCallbackHandlerResult {
  if (!isPtcRecord(value)) {
    return false;
  }
  if (value.ok === true) {
    // JSON omits an explicit `undefined` result while relaying a handler
    // success through the host process. The SDK wire already defines an
    // omitted success result as `undefined`, so preserve that meaning here.
    return true;
  }
  if (value.ok !== false) {
    return false;
  }
  return (
    typeof value.errorCode === 'string' &&
    typeof value.message === 'string' &&
    (value.remediation === undefined ||
      typeof value.remediation === 'string') &&
    (value.details === undefined || isPtcRecord(value.details))
  );
}

async function handleCallbackFrame(
  args: HandleCallbackFrameArgs,
): Promise<void> {
  if (args.closed) {
    writeResponse(
      args.socket,
      {
        ok: false,
        errorCode: 'channel_closed',
        message: 'PTC callback channel is closed',
      },
      args.maxResponseBytes,
    );
    return;
  }

  const parsed = parseCallbackRequest(args.line);
  if (!parsed.ok) {
    writeResponse(args.socket, parsed.response, args.maxResponseBytes);
    return;
  }

  const request = parsed.request;
  if (request.token !== args.token) {
    writeResponse(
      args.socket,
      {
        requestId: request.requestId,
        ok: false,
        errorCode: 'bad_capability',
        message: 'PTC callback token is invalid',
      },
      args.maxResponseBytes,
    );
    return;
  }

  if (!args.tryReserveCallbackSlot()) {
    writeResponse(
      args.socket,
      {
        requestId: request.requestId,
        ok: false,
        errorCode: 'callback_cap_exceeded',
        message: 'PTC callback count exceeded for epoch',
      },
      args.maxResponseBytes,
    );
    return;
  }

  const callbackController = new AbortController();
  args.pendingControllers.add(callbackController);

  let result:
    | { kind: 'value'; value: PtcEpochCallbackHandlerResult }
    | { kind: 'timeout' };
  try {
    result = await withAdmissionWatchdog(
      (enterLongWait) =>
        args.handler({
          requestId: request.requestId,
          kind: request.kind,
          args: request.args,
          signal: callbackController.signal,
          enterLongWait,
        }),
      args.callbackTimeoutMs,
      () => callbackController.abort(),
    );
  } catch {
    args.pendingControllers.delete(callbackController);
    writeResponse(
      args.socket,
      {
        requestId: request.requestId,
        ok: false,
        errorCode: 'callback_handler_failed',
        message: 'PTC callback handler failed',
      },
      args.maxResponseBytes,
    );
    return;
  }
  args.pendingControllers.delete(callbackController);

  if (result.kind === 'timeout') {
    writeResponse(
      args.socket,
      {
        requestId: request.requestId,
        ok: false,
        errorCode: 'callback_timeout',
        message: 'PTC callback handler timed out',
      },
      args.maxResponseBytes,
    );
    return;
  }

  const handlerResult: unknown = result.value;
  if (!isPtcEpochCallbackHandlerResult(handlerResult)) {
    writeResponse(
      args.socket,
      {
        requestId: request.requestId,
        ok: false,
        errorCode: 'callback_result_invalid',
        message: 'PTC callback handler returned an invalid result',
      },
      args.maxResponseBytes,
    );
    return;
  }

  if (!handlerResult.ok) {
    writeResponse(
      args.socket,
      {
        requestId: request.requestId,
        ok: false,
        errorCode: handlerResult.errorCode,
        message: handlerResult.message,
        ...(handlerResult.remediation === undefined
          ? {}
          : { remediation: handlerResult.remediation }),
        ...(handlerResult.details === undefined
          ? {}
          : { details: handlerResult.details }),
      },
      args.maxResponseBytes,
    );
    return;
  }

  writeResponse(
    args.socket,
    {
      requestId: request.requestId,
      ok: true,
      result: handlerResult.result,
    },
    args.maxResponseBytes,
  );
}

function parseCallbackRequest(line: string):
  | {
      ok: true;
      request: {
        requestId: string;
        token: string;
        kind: string;
        args: unknown;
      };
    }
  | { ok: false; response: PtcWireResponse } {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return {
      ok: false,
      response: {
        ok: false,
        errorCode: 'bad_json',
        message: 'PTC callback frame is not valid JSON',
      },
    };
  }

  if (!isPtcRecord(value)) {
    return invalidRequestResponse();
  }

  const requestId = value.requestId;
  const token = value.token;
  const kind = value.kind;
  if (
    typeof requestId !== 'string' ||
    requestId.length === 0 ||
    typeof token !== 'string' ||
    token.length === 0 ||
    typeof kind !== 'string' ||
    kind.length === 0
  ) {
    return invalidRequestResponse();
  }

  return {
    ok: true,
    request: {
      requestId,
      token,
      kind,
      args: value.args,
    },
  };
}

function invalidRequestResponse(): { ok: false; response: PtcWireResponse } {
  return {
    ok: false,
    response: {
      ok: false,
      errorCode: 'invalid_request',
      message: 'PTC callback request must include requestId, token, and kind',
    },
  };
}

function writeResponse(
  socket: Socket,
  response: PtcWireResponse,
  maxResponseBytes: number | undefined,
): void {
  socket.write(`${serializeWireResponse(response, maxResponseBytes)}\n`);
}

function endWithResponse(
  socket: Socket,
  response: PtcWireResponse,
  maxResponseBytes: number | undefined,
): void {
  socket.end(`${serializeWireResponse(response, maxResponseBytes)}\n`, () => {
    socket.destroy();
  });
}

function serializeWireResponse(
  response: PtcWireResponse,
  maxResponseBytes: number | undefined,
): string {
  let text: string;
  try {
    text = JSON.stringify(response);
  } catch {
    return JSON.stringify({
      requestId: response.requestId,
      ok: false,
      errorCode: 'callback_result_not_serializable',
      message: 'PTC callback response is not JSON serializable',
    });
  }

  if (
    maxResponseBytes !== undefined &&
    Buffer.byteLength(text, 'utf8') > maxResponseBytes
  ) {
    return JSON.stringify({
      requestId: response.requestId,
      ok: false,
      errorCode: 'callback_response_too_large',
      message: 'PTC callback response exceeds maxResponseBytes',
    });
  }

  return text;
}

async function withAdmissionWatchdog<T>(
  createPromise: (enterLongWait: () => boolean) => Promise<T>,
  timeoutMs: number | undefined,
  onTimeout: () => void,
): Promise<{ kind: 'value'; value: T } | { kind: 'timeout' }> {
  if (timeoutMs === undefined) {
    const value = await createPromise(() => true);
    return { kind: 'value', value };
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const enterLongWait = (): boolean => {
    if (timedOut) {
      return false;
    }
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    return true;
  };

  try {
    const timeoutPromise = new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        timer = null;
        onTimeout();
        resolve({ kind: 'timeout' });
      }, timeoutMs);
    });
    const valuePromise = createPromise(enterLongWait).then((value) => ({
      kind: 'value' as const,
      value,
    }));
    return await Promise.race([valuePromise, timeoutPromise]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

async function listen(server: ReturnType<typeof createServer>, path: string) {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(path);
  });
}

async function closeServer(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
