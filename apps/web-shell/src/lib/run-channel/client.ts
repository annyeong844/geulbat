import { isRunChannelServerMessage } from '@geulbat/protocol/run-channel';
import type { ApprovalRequest } from '@geulbat/protocol/run-approval';
import type { CancelRequest } from '@geulbat/protocol/cancel';
import type {
  RunChannelClientMessage,
  RunChannelServerMessage,
} from '@geulbat/protocol/run-channel';
import type { RunRequest } from '@geulbat/protocol/run-contract';
import { tryParseJsonWithGuard } from '@geulbat/protocol/runtime-utils';
import { buildRunChannelAuthMessage } from '../auth/shell-auth.js';
import {
  beginConnectionAttempt,
  canScheduleReconnect,
  clearReconnectSchedule,
  createInitialRunChannelConnectionState,
  markAuthHandshakeStarted,
  markConnectionClosed,
  markConnectionReady,
  markReconnectFailed,
  markReconnectScheduled,
  type RunChannelConnectionState,
} from './client-state.js';

type Listener = (message: RunChannelServerMessage) => void;
type SocketEventMap = {
  open: void;
  message: { data: string };
  close: void;
  error: void;
};
type SocketListener<K extends keyof SocketEventMap> = (
  event: SocketEventMap[K],
) => void;

interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener<K extends keyof SocketEventMap>(
    type: K,
    listener: SocketListener<K>,
    options?: { once?: boolean },
  ): void;
}

interface RunChannelClientOptions {
  getWebSocketUrl?: () => string;
  buildAuthMessage?: (requestId: string) => RunChannelClientMessage;
  createWebSocket?: (url: string) => WebSocketLike;
  scheduleTask?: (callback: () => void, delayMs: number) => unknown;
  clearScheduledTask?: (handle: unknown) => void;
}

const SOCKET_OPEN = 1;
const RECONNECT_DELAY_STEPS_MS = [500, 1_000, 2_000, 5_000] as const;
const MAX_RECONNECT_ATTEMPTS = RECONNECT_DELAY_STEPS_MS.length;

interface PendingSocketConnection {
  socket: WebSocketLike;
  authRequestId: string;
  opened: boolean;
  authenticated: boolean;
  settled: boolean;
  resolve: (socket: WebSocketLike) => void;
  reject: (error: Error) => void;
}

function createRequestId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function buildRunChannelUrl(origin: string): string {
  const base = new URL(origin);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  base.pathname = '/api/ws';
  base.search = '';
  return base.toString();
}

function getWebSocketUrl(): string {
  return buildRunChannelUrl(window.location.origin);
}

export function getReconnectDelay(attempt: number): number {
  const index = Math.min(
    Math.max(attempt, 0),
    RECONNECT_DELAY_STEPS_MS.length - 1,
  );
  return (
    RECONNECT_DELAY_STEPS_MS[index] ?? RECONNECT_DELAY_STEPS_MS.at(-1) ?? 0
  );
}

export class RunChannelClient {
  private socket: WebSocketLike | null = null;
  private connectPromise: Promise<WebSocketLike> | null = null;
  private listeners = new Set<Listener>();
  private connectionState: RunChannelConnectionState =
    createInitialRunChannelConnectionState();

  private readonly resolveWebSocketUrl: () => string;
  private readonly buildAuthMessage: (
    requestId: string,
  ) => RunChannelClientMessage;
  private readonly createSocket: (url: string) => WebSocketLike;
  private readonly scheduleTask: (
    callback: () => void,
    delayMs: number,
  ) => unknown;
  private readonly clearScheduledTask: (handle: unknown) => void;

  constructor(options: RunChannelClientOptions = {}) {
    this.resolveWebSocketUrl = options.getWebSocketUrl ?? getWebSocketUrl;
    this.buildAuthMessage =
      options.buildAuthMessage ?? buildRunChannelAuthMessage;
    this.createSocket =
      options.createWebSocket ?? ((url: string) => new WebSocket(url));
    this.scheduleTask =
      options.scheduleTask ??
      ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearScheduledTask =
      options.clearScheduledTask ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async connect(): Promise<WebSocketLike> {
    if (this.socket && this.socket.readyState === SOCKET_OPEN) {
      return this.socket;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.clearReconnectTask();
    this.connectionState = beginConnectionAttempt(this.connectionState);
    this.connectPromise = new Promise<WebSocketLike>((resolve, reject) => {
      const pending = this.createPendingSocketConnection(resolve, reject);

      pending.socket.addEventListener(
        'open',
        () => this.handleSocketOpen(pending),
        { once: true },
      );

      pending.socket.addEventListener('message', (event) => {
        this.handleSocketMessage(pending, event);
      });

      pending.socket.addEventListener('close', () => {
        this.handleSocketClose(pending);
      });

      pending.socket.addEventListener('error', () => {
        this.handleSocketError(pending);
      });
    });

    try {
      return await this.connectPromise;
    } finally {
      if (this.socket?.readyState !== SOCKET_OPEN) {
        this.connectPromise = null;
      }
    }
  }

  async start(request: RunRequest): Promise<string> {
    const requestId = createRequestId();
    await this.send({
      type: 'run.start',
      requestId,
      request,
    });
    return requestId;
  }

  async cancel(request: CancelRequest): Promise<string> {
    const requestId = createRequestId();
    await this.send({
      type: 'run.cancel',
      requestId,
      request,
    });
    return requestId;
  }

  async approve(request: ApprovalRequest): Promise<string> {
    const requestId = createRequestId();
    await this.send({
      type: 'run.approve',
      requestId,
      request,
    });
    return requestId;
  }

  close(): void {
    this.clearReconnectTask();
    this.connectionState = markConnectionClosed(this.connectionState, true);
    this.socket?.close();
    this.socket = null;
    this.connectPromise = null;
  }

  private async send(message: RunChannelClientMessage): Promise<void> {
    const socket = await this.connect();
    socket.send(JSON.stringify(message));
  }

  private emit(message: RunChannelServerMessage): void {
    for (const listener of this.listeners) {
      listener(message);
    }
  }

  private createPendingSocketConnection(
    resolve: (socket: WebSocketLike) => void,
    reject: (error: Error) => void,
  ): PendingSocketConnection {
    return {
      socket: this.createSocket(this.resolveWebSocketUrl()),
      authRequestId: createRequestId(),
      opened: false,
      authenticated: false,
      settled: false,
      resolve,
      reject,
    };
  }

  private handleSocketOpen(pending: PendingSocketConnection): void {
    pending.opened = true;
    this.connectionState = markAuthHandshakeStarted(this.connectionState);
    const authMessage = this.buildAuthMessage(pending.authRequestId);
    pending.socket.send(JSON.stringify(authMessage));
  }

  private handleSocketMessage(
    pending: PendingSocketConnection,
    event: { data: string },
  ): void {
    const parsed = tryParseJsonWithGuard(
      String(event.data),
      isRunChannelServerMessage,
    );
    if (!parsed.ok) {
      this.emit({
        type: 'run.error',
        code: 'internal',
        message: 'invalid websocket payload',
        status: 500,
      });
      return;
    }

    const message = parsed.value;
    if (this.handleUnauthenticatedMessage(pending, message)) {
      return;
    }
    this.emit(message);
  }

  private handleUnauthenticatedMessage(
    pending: PendingSocketConnection,
    message: RunChannelServerMessage,
  ): boolean {
    if (pending.authenticated) {
      return false;
    }

    if (
      message.type === 'run.auth.ok' &&
      message.requestId === pending.authRequestId
    ) {
      pending.authenticated = true;
      pending.settled = true;
      this.socket = pending.socket;
      this.connectionState = markConnectionReady(this.connectionState);
      pending.resolve(this.socket);
      return true;
    }

    if (
      message.type === 'run.error' &&
      message.requestId === pending.authRequestId
    ) {
      this.rejectBeforeAuth(pending, message.message, false);
      return true;
    }

    return false;
  }

  private handleSocketClose(pending: PendingSocketConnection): void {
    this.socket = null;
    this.connectPromise = null;
    if (!pending.authenticated) {
      this.rejectBeforeAuth(
        pending,
        'run channel websocket connection failed',
        true,
      );
      return;
    }
    this.connectionState = markConnectionClosed(
      this.connectionState,
      this.connectionState.closedExplicitly,
    );
    if (!this.connectionState.closedExplicitly) {
      this.emit({
        type: 'run.error',
        code: 'internal',
        message: 'run channel disconnected',
        status: 500,
      });
      this.scheduleReconnect();
    }
  }

  private handleSocketError(pending: PendingSocketConnection): void {
    if (!pending.opened || !pending.authenticated) {
      this.rejectBeforeAuth(
        pending,
        'run channel websocket connection failed',
        true,
      );
    }
  }

  private rejectBeforeAuth(
    pending: PendingSocketConnection,
    message: string,
    shouldReconnect: boolean,
  ): void {
    if (pending.authenticated || pending.settled) {
      return;
    }

    pending.settled = true;
    this.connectPromise = null;
    const explicitClose = this.connectionState.closedExplicitly;
    this.connectionState = markConnectionClosed(
      this.connectionState,
      explicitClose,
    );
    if (shouldReconnect && !explicitClose) {
      this.scheduleReconnect();
    }
    pending.reject(new Error(message));
  }

  private scheduleReconnect(): void {
    if (!canScheduleReconnect(this.connectionState, MAX_RECONNECT_ATTEMPTS)) {
      if (!this.connectionState.closedExplicitly) {
        this.connectionState = markReconnectFailed(this.connectionState);
        this.emit({
          type: 'run.error',
          code: 'internal',
          message: 'run channel reconnect failed',
          status: 500,
        });
      }
      return;
    }
    const delayMs = getReconnectDelay(this.connectionState.reconnectAttempts);
    const reconnectTask = this.scheduleTask(() => {
      this.connectionState = clearReconnectSchedule(this.connectionState);
      void this.connect().catch(() => {
        // Transport reconnect is best-effort. The next scheduled retry is owned by connect failure handlers.
      });
    }, delayMs);
    this.connectionState = markReconnectScheduled(
      this.connectionState,
      reconnectTask,
    );
  }

  private clearReconnectTask(): void {
    if (this.connectionState.reconnectTask == null) {
      return;
    }
    this.clearScheduledTask(this.connectionState.reconnectTask);
    this.connectionState = clearReconnectSchedule(this.connectionState);
  }
}
