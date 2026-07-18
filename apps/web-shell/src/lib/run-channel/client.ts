import { isRunChannelServerMessage } from '@geulbat/protocol/run-channel';
import type { ApprovalRequest } from '@geulbat/protocol/run-approval';
import type { CancelRequest } from '@geulbat/protocol/cancel';
import type {
  RunChannelClientMessage,
  RunControlMessage,
  RunChannelServerMessage,
  RunInterjectRequest,
  RunToolRequest,
  RunToolResultPayload,
} from '@geulbat/protocol/run-channel';
import type { RunStartRequest } from '@geulbat/protocol/run-contract';
import {
  isRecord,
  isString,
  tryParseJson,
} from '@geulbat/protocol/runtime-utils';
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
  removeEventListener<K extends keyof SocketEventMap>(
    type: K,
    listener: SocketListener<K>,
  ): void;
}

interface RunChannelClientOptions {
  getWebSocketUrl?: () => string;
  buildAuthMessage?: (requestId: string) => RunChannelClientMessage;
  createWebSocket?: (url: string) => WebSocketLike;
  scheduleTask?: (callback: () => void, delayMs: number) => number;
  clearScheduledTask?: (handle: number) => void;
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
  protocolFailureMessage: string | null;
  detachListeners: () => void;
  resolve: (socket: WebSocketLike) => void;
  reject: (error: Error) => void;
}

interface PendingControlAck {
  action: RunControlMessage['action'];
  resolve: (ack: RunControlMessage) => void;
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
  private pendingControlAcks = new Map<string, PendingControlAck>();
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
  ) => number;
  private readonly clearScheduledTask: (handle: number) => void;

  constructor(options: RunChannelClientOptions = {}) {
    this.resolveWebSocketUrl = options.getWebSocketUrl ?? getWebSocketUrl;
    this.buildAuthMessage =
      options.buildAuthMessage ?? buildRunChannelAuthMessage;
    this.createSocket =
      options.createWebSocket ?? ((url: string) => new WebSocket(url));
    this.scheduleTask =
      options.scheduleTask ??
      ((callback, delayMs) => window.setTimeout(callback, delayMs));
    this.clearScheduledTask =
      options.clearScheduledTask ?? ((handle) => window.clearTimeout(handle));
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
      const handleOpen: SocketListener<'open'> = () =>
        this.handleSocketOpen(pending);
      const handleMessage: SocketListener<'message'> = (event) => {
        this.handleSocketMessage(pending, event);
      };
      const handleClose: SocketListener<'close'> = () => {
        this.handleSocketClose(pending);
      };
      const handleError: SocketListener<'error'> = () => {
        this.handleSocketError(pending);
      };

      pending.detachListeners = () => {
        pending.socket.removeEventListener('open', handleOpen);
        pending.socket.removeEventListener('message', handleMessage);
        pending.socket.removeEventListener('close', handleClose);
        pending.socket.removeEventListener('error', handleError);
      };

      pending.socket.addEventListener('open', handleOpen, { once: true });
      pending.socket.addEventListener('message', handleMessage);
      pending.socket.addEventListener('close', handleClose);
      pending.socket.addEventListener('error', handleError);
    });

    try {
      return await this.connectPromise;
    } finally {
      if (this.socket?.readyState !== SOCKET_OPEN) {
        this.connectPromise = null;
      }
    }
  }

  async start(request: RunStartRequest): Promise<string> {
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

  // 실행 중 스티어링 — 진행 중인 run에 사용자 지시를 주입한다.
  // 대기열에 잡힌 receivedSeq를 돌려주므로 셸이 큐 행을 그릴 수 있다.
  async interject(
    request: RunInterjectRequest,
  ): Promise<{ requestId: string; receivedSeq: number }> {
    const requestId = createRequestId();
    const ack = new Promise<RunControlMessage>((resolve, reject) => {
      this.pendingControlAcks.set(requestId, {
        action: 'run.interject',
        resolve,
        reject,
      });
    });
    try {
      await this.send({
        type: 'run.interject',
        requestId,
        request: { runId: request.runId, text: request.text },
      });
    } catch (error: unknown) {
      this.pendingControlAcks.delete(requestId);
      throw error;
    }
    const control = await ack;
    return {
      requestId,
      receivedSeq: control.action === 'run.interject' ? control.receivedSeq : 0,
    };
  }

  // 대기 중 스티어 취소 — 아직 소비되지 않았으면 큐에서 제거된다.
  async cancelInterject(request: {
    runId: RunInterjectRequest['runId'];
    receivedSeq: number;
  }): Promise<{ cancelled: boolean }> {
    const requestId = createRequestId();
    const ack = new Promise<RunControlMessage>((resolve, reject) => {
      this.pendingControlAcks.set(requestId, {
        action: 'run.interject.cancel',
        resolve,
        reject,
      });
    });
    try {
      await this.send({
        type: 'run.interject.cancel',
        requestId,
        request: {
          runId: request.runId,
          receivedSeq: request.receivedSeq,
        },
      });
    } catch (error: unknown) {
      this.pendingControlAcks.delete(requestId);
      throw error;
    }
    const control = await ack;
    return {
      cancelled:
        control.action === 'run.interject.cancel' ? control.cancelled : false,
    };
  }

  // 대기 중 스티어 즉시 반영 — 데몬이 현재 라운드의 남은 도구 호출을
  // 건너뛰고 다음 소비 지점으로 빨리 가도록 요청한다.
  async flushInterject(request: {
    runId: RunInterjectRequest['runId'];
  }): Promise<{ flushed: boolean }> {
    const requestId = createRequestId();
    const ack = new Promise<RunControlMessage>((resolve, reject) => {
      this.pendingControlAcks.set(requestId, {
        action: 'run.interject.flush',
        resolve,
        reject,
      });
    });
    try {
      await this.send({
        type: 'run.interject.flush',
        requestId,
        request: { runId: request.runId },
      });
    } catch (error: unknown) {
      this.pendingControlAcks.delete(requestId);
      throw error;
    }
    const control = await ack;
    return {
      flushed:
        control.action === 'run.interject.flush' ? control.flushed : false,
    };
  }

  // 아티팩트 프레임 발 도구 호출 — interject와 같은 pending-ack 패턴으로
  // requestId 상관 단일 응답(run.control action=run.tool)을 기다린다.
  async tool(request: RunToolRequest): Promise<RunToolResultPayload> {
    const requestId = createRequestId();
    const ack = new Promise<RunControlMessage>((resolve, reject) => {
      this.pendingControlAcks.set(requestId, {
        action: 'run.tool',
        resolve,
        reject,
      });
    });
    try {
      await this.send({
        type: 'run.tool',
        requestId,
        request: { ...request },
      });
    } catch (error: unknown) {
      this.pendingControlAcks.delete(requestId);
      throw error;
    }
    const control = await ack;
    if (control.action !== 'run.tool') {
      return {
        ok: false,
        errorCode: 'internal',
        error: 'unexpected run.tool control ack shape',
      };
    }
    return control.result;
  }

  close(): void {
    this.clearReconnectTask();
    this.connectionState = markConnectionClosed(this.connectionState, true);
    this.rejectPendingControlAcks('run channel closed');
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
      protocolFailureMessage: null,
      detachListeners: () => undefined,
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
    if (pending.protocolFailureMessage !== null) {
      return;
    }
    if (pending.authenticated && this.socket !== pending.socket) {
      return;
    }

    const parsed = tryParseJson(String(event.data));
    if (!parsed.ok || !isRunChannelServerMessage(parsed.value)) {
      if (parsed.ok && this.settleMalformedPendingControlAck(parsed.value)) {
        return;
      }
      pending.protocolFailureMessage = 'invalid websocket payload';
      pending.socket.close();
      return;
    }

    const message = parsed.value;
    if (this.handleUnauthenticatedMessage(pending, message)) {
      return;
    }
    const consumedByControlError = this.settlePendingControlAck(message);
    // A run.error that answers a pending control request is surfaced to that
    // caller via the rejected ack; re-emitting it here would also flip the
    // whole session into the error phase while the daemon run keeps going
    // (the next prompt would then run.start into conflict_active_run).
    if (!consumedByControlError) {
      this.emit(message);
    }
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
    pending.detachListeners();
    if (this.socket !== pending.socket && pending.authenticated) {
      return;
    }

    if (this.socket === pending.socket) {
      this.socket = null;
    }
    this.connectPromise = null;
    if (!pending.authenticated) {
      this.rejectBeforeAuth(
        pending,
        pending.protocolFailureMessage ??
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
      const failureMessage =
        pending.protocolFailureMessage ?? 'run channel disconnected';
      this.rejectPendingControlAcks(failureMessage);
      this.emit({
        type: 'run.error',
        code: 'internal',
        message: failureMessage,
        status: 500,
      });
      this.scheduleReconnect();
    }
  }

  private handleSocketError(pending: PendingSocketConnection): void {
    if (pending.authenticated && this.socket !== pending.socket) {
      return;
    }

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
    pending.detachListeners();
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

  private settleMalformedPendingControlAck(value: unknown): boolean {
    if (
      !isRecord(value) ||
      (value.type !== 'run.control' && value.type !== 'run.error') ||
      !isString(value.requestId)
    ) {
      return false;
    }
    const pending = this.pendingControlAcks.get(value.requestId);
    if (!pending) {
      return false;
    }
    this.pendingControlAcks.delete(value.requestId);
    pending.reject(new Error('invalid websocket payload'));
    return true;
  }

  // Returns true only when a run.error was consumed by a pending control
  // ack — that error belongs to the awaiting caller, not the session stream.
  private settlePendingControlAck(message: RunChannelServerMessage): boolean {
    if (message.type === 'run.control') {
      const pending = this.pendingControlAcks.get(message.requestId);
      if (!pending || pending.action !== message.action) {
        return false;
      }
      this.pendingControlAcks.delete(message.requestId);
      pending.resolve(message);
      return false;
    }
    if (message.type !== 'run.error' || message.requestId === undefined) {
      return false;
    }
    const pending = this.pendingControlAcks.get(message.requestId);
    if (!pending) {
      return false;
    }
    this.pendingControlAcks.delete(message.requestId);
    pending.reject(new Error(message.message));
    return true;
  }

  private rejectPendingControlAcks(message: string): void {
    if (this.pendingControlAcks.size === 0) {
      return;
    }
    const pending = Array.from(this.pendingControlAcks.values());
    this.pendingControlAcks.clear();
    for (const ack of pending) {
      ack.reject(new Error(message));
    }
  }
}
