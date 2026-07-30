import net from 'node:net';

import type { HostCommandOutputChunk } from './contract.js';
import {
  buildNotification,
  buildRequest,
  COMMAND_HOST_METHODS,
  COMMAND_HOST_NOTIFICATIONS,
  COMMAND_HOST_PROTOCOL_VERSION,
  encodeFrame,
  FrameDecoder,
  initializeResultSchema,
  jsonRpcResponseSchema,
  outputNotificationSchema,
  REQUEST_CANCELLED_CODE,
  type CommandHostCapabilities,
  type DecodedFrame,
  type JsonRpcId,
} from './protocol.js';

interface PendingRequest {
  resolve: (value: unknown) => void;
  cancelled: boolean;
  detachAbort?: () => void;
}

export interface CommandHostWorkerLink {
  readonly capabilities: CommandHostCapabilities;
  /**
   * JSON-RPC 결과에는 나타날 수 없는 연결별 식별자다. 요청이 응답 없이
   * 끊겼을 때만 `request()`가 이 값을 돌려준다.
   */
  readonly connectionLost: symbol;
  isClosed(): boolean;
  request(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>;
  subscribeOutput(
    outputRef: string,
    listener: (chunk: HostCommandOutputChunk) => void,
  ): void;
  unsubscribeOutput(outputRef: string): void;
  close(reason: string): void;
}

/**
 * 한 command-host worker 소켓의 연결부터 initialize handshake, JSON-RPC
 * request/cancel, output notification, close 정리까지를 소유한다.
 *
 * worker spawn/backoff와 stateRoot별 재접속 여부는 이 transport 경계 밖의
 * daemon client 정책이다.
 */
export async function connectCommandHostWorkerLink(
  socketPath: string,
  stateRootFingerprint: string,
): Promise<CommandHostWorkerLink | undefined> {
  const socket = await connectSocket(socketPath);
  if (socket === undefined) {
    return undefined;
  }
  return await initializeWorkerLink(socket, stateRootFingerprint);
}

async function connectSocket(
  socketPath: string,
): Promise<net.Socket | undefined> {
  return await new Promise((resolve) => {
    const socket = net.connect(socketPath);
    socket.once('connect', () => {
      socket.removeAllListeners('error');
      resolve(socket);
    });
    socket.once('error', () => {
      resolve(undefined);
    });
  });
}

async function initializeWorkerLink(
  socket: net.Socket,
  stateRootFingerprint: string,
): Promise<CommandHostWorkerLink | undefined> {
  const pending = new Map<JsonRpcId, PendingRequest>();
  const outputListeners = new Map<
    string,
    (chunk: HostCommandOutputChunk) => void
  >();
  const connectionLost = Symbol('command-host connection lost');
  let capabilities: CommandHostCapabilities = {
    deferredOutputRelease: false,
    idempotentStartByInvocation: false,
    initialStdinOnStart: false,
    losslessStdio: false,
    prePersistenceOutputRedaction: false,
    rawInitialStdinOnStart: false,
    rawOutputPages: false,
  };
  let closedReason: string | null = null;
  let nextId = 1;

  const closeConnection = () => {
    if (closedReason === null) {
      closedReason = 'connection closed';
    }
    for (const request of pending.values()) {
      request.detachAbort?.();
      request.resolve(connectionLost);
    }
    pending.clear();
    outputListeners.clear();
  };

  const link: CommandHostWorkerLink = {
    get capabilities() {
      return capabilities;
    },
    connectionLost,
    isClosed() {
      return closedReason !== null;
    },
    request(method, params, signal) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolve) => {
        const request: PendingRequest = { resolve, cancelled: false };
        pending.set(id, request);
        if (signal !== undefined) {
          const onAbort = () => {
            const activeRequest = pending.get(id);
            if (activeRequest !== undefined && !activeRequest.cancelled) {
              activeRequest.cancelled = true;
              socket.write(
                encodeFrame(
                  buildNotification(COMMAND_HOST_NOTIFICATIONS.cancelRequest, {
                    id,
                  }),
                ),
              );
            }
          };
          if (!signal.aborted) {
            signal.addEventListener('abort', onAbort, { once: true });
            request.detachAbort = () => {
              signal.removeEventListener('abort', onAbort);
            };
          }
          socket.write(encodeFrame(buildRequest(id, method, params)));
          if (signal.aborted) {
            onAbort();
          }
        } else {
          socket.write(encodeFrame(buildRequest(id, method, params)));
        }
      });
    },
    subscribeOutput(outputRef, listener) {
      outputListeners.set(outputRef, listener);
    },
    unsubscribeOutput(outputRef) {
      outputListeners.delete(outputRef);
    },
    close(reason) {
      if (closedReason === null) {
        closedReason = reason;
      }
      socket.destroy();
    },
  };

  const decoder = new FrameDecoder();
  socket.on('data', (chunk: Buffer) => {
    let frames: DecodedFrame[];
    try {
      frames = decoder.push(chunk);
    } catch {
      socket.destroy();
      return;
    }
    for (const frame of frames) {
      handleInbound(frame.message);
    }
  });
  socket.on('close', closeConnection);
  socket.on('error', closeConnection);

  const initialized = await link.request(COMMAND_HOST_METHODS.initialize, {
    protocolVersion: COMMAND_HOST_PROTOCOL_VERSION,
    stateRootFingerprint,
  });
  const parsed = initializeResultSchema.safeParse(initialized);
  if (!parsed.success) {
    socket.destroy();
    return undefined;
  }
  capabilities = parsed.data.capabilities;
  return link;

  function handleInbound(message: unknown): void {
    const response = jsonRpcResponseSchema.safeParse(message);
    if (response.success) {
      const request = pending.get(response.data.id);
      if (request !== undefined) {
        pending.delete(response.data.id);
        request.detachAbort?.();
        if ('result' in response.data) {
          request.resolve(response.data.result);
        } else if (response.data.error.code === REQUEST_CANCELLED_CODE) {
          request.resolve({
            ok: false,
            reasonCode: 'wait_aborted',
            message: 'host command wait was aborted.',
          });
        } else {
          request.resolve({
            ok: false,
            reasonCode: 'output_store_failed',
            message: response.data.error.message,
          });
        }
      }
      return;
    }
    const notification = message as { method?: string; params?: unknown };
    if (notification.method === COMMAND_HOST_NOTIFICATIONS.output) {
      const output = outputNotificationSchema.safeParse(notification.params);
      if (output.success) {
        outputListeners.get(output.data.outputRef)?.({
          stream: output.data.stream,
          text: output.data.chunk,
        });
      }
    }
    // resyncRequired는 best-effort 스트리밍에선 무시한다 — 정확 복구는
    // 페이지 조회가 담당한다 (§7.5).
  }
}
