import { chmod, unlink } from 'node:fs/promises';
import net from 'node:net';

import type { CommandSessionHost } from './contract.js';
import {
  buildErrorResponse,
  COMMAND_HOST_STARTUP_GRACE_MS,
  buildNotification,
  buildResultResponse,
  cancelParamsSchema,
  COMMAND_HOST_METHODS,
  COMMAND_HOST_NOTIFICATIONS,
  COMMAND_HOST_PROTOCOL_VERSION,
  COMMAND_HOST_SUPPORTED_VERSIONS,
  DEFAULT_MAX_FRAME_BYTES,
  encodeFrame,
  FrameDecoder,
  type DecodedFrame,
  initializeParamsSchema,
  INTERNAL_ERROR_CODE,
  interactParamsSchema,
  INVALID_PARAMS_CODE,
  INVALID_REQUEST_CODE,
  jsonRpcNotificationSchema,
  jsonRpcRequestSchema,
  METHOD_NOT_FOUND_CODE,
  REQUEST_CANCELLED_CODE,
  startParamsSchema,
  subscribeParamsSchema,
  unsubscribeParamsSchema,
  waitInitialParamsSchema,
  type JsonRpcId,
} from './protocol.js';

// P7.5 spec v4 §6.3·§7 — command-host RPC 서버. 워커 프로세스(main.ts)와
// 테스트가 같은 서버를 쓴다(인프로세스 기동 가능). 연결 수명·유계 큐·
// 취소·소유권 정리를 이 층이 소유하고, 세션 의미론은 전부 코어에 있다.

/** spec v4 §7.5 전역 유계표. §4.1 전체 메모리 예산이 이 값들을 합산한다. */
export const COMMAND_HOST_RPC_LIMITS = {
  maxFrameBytes: DEFAULT_MAX_FRAME_BYTES,
  maxAcceptedConnections: 8,
  maxPendingInitializeConnections: 4,
  maxInitializedConnections: 4,
  maxInflightRequestsPerConnection: 256, // = 4 × 세션 정원 (§7.5)
  /** 워커 전역 — 모든 연결의 처리 중 요청 프레임 합계. */
  maxAggregateInflightRequestBytes: 16 * 1024 * 1024,
  responseQueueSoftBytes: 4 * 1024 * 1024,
  responseQueueHardBytes: 16 * 1024 * 1024,
  notificationQueueBytes: 1024 * 1024,
  notificationQueueCount: 256,
} as const;

const LIMITS = COMMAND_HOST_RPC_LIMITS;

interface ServerConnection {
  socket: net.Socket;
  decoder: FrameDecoder;
  initialized: boolean;
  acceptedAtTick: number;
  inflight: Map<JsonRpcId, AbortController>;
  subscriptions: Map<string, () => void>;
  /** 이 연결이 start했고 아직 waitInitial이 해소되지 않은 refs (§7.4). */
  ownedUnclaimedRefs: Set<string>;
  /**
   * P7.6 §7.1 — 이 연결이 고정하고 있는 시스템 세션 refs. 스레드 세션과 달리
   * 시스템 세션은 정원을 쓰지 않고 퇴거되지도 않으므로, 누가 붙들고 있는지를
   * 아는 주체가 워커뿐이다. 이 집합이 비면 그 세션은 회수 후보가 된다.
   */
  pinnedSystemRefs: Set<string>;
  /** wire-encoded 기준 알림 큐 사용량 (§7.5). */
  notificationBytes: number;
  notificationCount: number;
  /** 알림 폐기 후 세션별 resyncRequired 1회 발송 여부. */
  resyncPending: Set<string>;
  responseBytes: number;
  closed: boolean;
}

interface CommandHostServerOptions {
  core: CommandSessionHost;
  socketPath: string;
  stateRoot: string;
  stateRootFingerprint: string;
  /** 모든 연결이 사라지고 코어가 quiescent일 때 호출 (§6.3). */
  onIdle?: () => void;
  /**
   * P7.6 §7.1 — 마지막 연결이 끊긴 뒤 데몬이 돌아오기를 기다리는 창.
   * 기본은 기동 유예와 같은 값이다: 두 경우 모두 "아직 안 왔다"와 "영영 안
   * 온다"를 구별하는 일이고, §3이 금지하는 것은 *의미 없는* 타이머다.
   */
  readoptionGraceMs?: number;
}

interface CommandHostServer {
  close(): Promise<void>;
  connectionCount(): number;
  /** §6.3 종료 게이트가 세는 연결 수 — pre-init은 포함하지 않는다. */
  initializedConnectionCount(): number;
  /**
   * initialize를 마친 연결을 한 번이라도 받았는가. 한 번도 없었다면 종료
   * 게이트를 울릴 이벤트가 영영 오지 않으므로 기동 유예가 그 자리를 맡는다.
   */
  hasEverServedConnection(): boolean;
}

export async function startCommandHostServer(
  options: CommandHostServerOptions,
): Promise<CommandHostServer> {
  const { core } = options;
  const connections = new Set<ServerConnection>();
  let acceptTick = 0;
  let draining = false;
  // §7.5 — 워커 전역 inflight 요청 바이트. 연결당 상한만으로는
  // maxAcceptedConnections 배만큼 부풀 수 있어 전역 항이 따로 필요하다.
  let aggregateInflightRequestBytes = 0;
  let everServedConnection = false;

  const detachSettled = core.onSettled(() => {
    evaluateIdle();
  });

  function initializedConnectionCount(): number {
    let count = 0;
    for (const connection of connections) {
      if (connection.initialized) {
        count += 1;
      }
    }
    return count;
  }

  const readoptionGraceMs =
    options.readoptionGraceMs ?? COMMAND_HOST_STARTUP_GRACE_MS;

  /** 살아 있는 연결들이 지금 고정하고 있는 시스템 세션 전부. */
  function pinnedSystemRefs(): Set<string> {
    const pinned = new Set<string>();
    for (const connection of connections) {
      for (const ref of connection.pinnedSystemRefs) {
        pinned.add(ref);
      }
    }
    return pinned;
  }

  /**
   * P7.6 §7.1 — 고정을 들고 있던 연결이 사라졌다. 창 안에 누군가 그 세션을
   * 다시 고정하면 고정이 이어지고, 아무도 안 하면 회수한다. 데몬 크래시와 앱
   * 종료는 끊긴 순간에 구별되지 않으므로 시간이 유일한 구별 수단이다.
   *
   * 창을 연결 수가 아니라 **세션 단위**로 센다: 데몬이 돌아오되 옛 세션은
   * 다시 고정하지 않는 경우가 있고(재입양 경로가 없는 지금은 언제나 그렇다),
   * 연결 수로 세면 돌아온 연결이 창을 취소해버려 그 세션이 영영 회수되지
   * 않는다. 파도마다 자기 refs를 들고 가므로 뒤늦게 풀린 세션이 앞 파도의
   * 만료에 휩쓸려 일찍 회수되지도 않는다.
   */
  function scheduleReclaimWindow(refs: readonly string[]): void {
    if (refs.length === 0) {
      return;
    }
    const timer = setTimeout(() => {
      if (draining) {
        return;
      }
      const pinned = pinnedSystemRefs();
      const unpinned = new Set(refs.filter((ref) => !pinned.has(ref)));
      if (unpinned.size === 0) {
        return;
      }
      core.reclaimSystemSessions(unpinned);
      evaluateIdle();
    }, readoptionGraceMs);
    timer.unref?.();
  }

  function evaluateIdle(): void {
    if (draining) {
      return;
    }
    // §6.3 — pre-initialize 연결은 세션도 작업도 갖지 않으므로 계상에서
    // 제외한다. 종료 절차가 그 연결들을 즉시 파기한다.
    if (initializedConnectionCount() === 0 && core.isQuiescent()) {
      options.onIdle?.();
    }
  }

  const server = net.createServer((socket) => {
    if (draining || connections.size >= LIMITS.maxAcceptedConnections) {
      socket.destroy();
      return;
    }
    const pendingInit = [...connections].filter((c) => !c.initialized);
    if (pendingInit.length >= LIMITS.maxPendingInitializeConnections) {
      // §7.5 — deadline 타이머 대신 oldest pre-init 퇴거 (이벤트 구동).
      const oldest = pendingInit.sort(
        (a, b) => a.acceptedAtTick - b.acceptedAtTick,
      )[0];
      if (oldest !== undefined) {
        teardownConnection(oldest);
      }
    }
    acceptTick += 1;
    const connection: ServerConnection = {
      socket,
      decoder: new FrameDecoder(LIMITS.maxFrameBytes),
      initialized: false,
      acceptedAtTick: acceptTick,
      inflight: new Map(),
      subscriptions: new Map(),
      ownedUnclaimedRefs: new Set(),
      pinnedSystemRefs: new Set(),
      notificationBytes: 0,
      notificationCount: 0,
      resyncPending: new Set(),
      responseBytes: 0,
      closed: false,
    };
    connections.add(connection);
    socket.on('data', (chunk: Buffer) => {
      let frames: DecodedFrame[];
      try {
        frames = connection.decoder.push(chunk);
      } catch {
        // 프레이밍 위반(초과 길이·손상 JSON)은 협상 불가 — 연결 종료.
        teardownConnection(connection);
        return;
      }
      for (const frame of frames) {
        handleMessage(connection, frame.message, frame.byteLength);
      }
    });
    socket.on('error', () => {
      teardownConnection(connection);
    });
    socket.on('close', () => {
      teardownConnection(connection);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  if (!options.socketPath.startsWith('\\\\')) {
    try {
      await chmod(options.socketPath, 0o600);
    } catch (error: unknown) {
      draining = true;
      detachSettled();
      for (const connection of [...connections]) {
        teardownConnection(connection);
      }
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      await unlink(options.socketPath).catch(() => undefined);
      throw error;
    }
  }

  function teardownConnection(connection: ServerConnection): void {
    if (connection.closed) {
      return;
    }
    connection.closed = true;
    connections.delete(connection);
    for (const controller of connection.inflight.values()) {
      controller.abort();
    }
    connection.inflight.clear();
    for (const unsubscribe of connection.subscriptions.values()) {
      unsubscribe();
    }
    connection.subscriptions.clear();
    const owned = [...connection.ownedUnclaimedRefs];
    connection.ownedUnclaimedRefs.clear();
    // 고정을 놓은 시점이 창의 시작이다 — 연결이 사라진 지금이 그 시점이다.
    const unpinned = [...connection.pinnedSystemRefs];
    connection.pinnedSystemRefs.clear();
    connection.socket.destroy();
    scheduleReclaimWindow(unpinned);
    void Promise.all(owned.map((ref) => core.releaseUnclaimed(ref))).finally(
      () => {
        evaluateIdle();
      },
    );
  }

  function sendResponse(connection: ServerConnection, message: unknown): void {
    if (connection.closed) {
      return;
    }
    const frame = encodeFrame(message);
    connection.responseBytes += frame.length;
    if (connection.responseBytes > LIMITS.responseQueueHardBytes) {
      teardownConnection(connection);
      return;
    }
    if (connection.responseBytes > LIMITS.responseQueueSoftBytes) {
      connection.socket.pause();
    }
    connection.socket.write(frame, () => {
      connection.responseBytes -= frame.length;
      if (
        connection.responseBytes <= LIMITS.responseQueueSoftBytes &&
        !connection.closed
      ) {
        connection.socket.resume();
      }
    });
  }

  function sendNotification(
    connection: ServerConnection,
    subscriptionId: string,
    outputRef: string,
    message: unknown,
  ): void {
    if (connection.closed) {
      return;
    }
    const frame = encodeFrame(message);
    if (
      connection.notificationBytes + frame.length >
        LIMITS.notificationQueueBytes ||
      connection.notificationCount >= LIMITS.notificationQueueCount
    ) {
      // §7.5 — 알림은 best-effort. 폐기 후 세션당 resyncRequired 1회.
      queueResync(connection, subscriptionId, outputRef);
      return;
    }
    connection.notificationBytes += frame.length;
    connection.notificationCount += 1;
    connection.socket.write(frame, () => {
      connection.notificationBytes -= frame.length;
      connection.notificationCount -= 1;
    });
  }

  function queueResync(
    connection: ServerConnection,
    subscriptionId: string,
    outputRef: string,
  ): void {
    if (connection.resyncPending.has(subscriptionId)) {
      return;
    }
    connection.resyncPending.add(subscriptionId);
    const running = core
      .listSessions()
      .find((session) => session.outputRef === outputRef);
    const frame = encodeFrame(
      buildNotification(COMMAND_HOST_NOTIFICATIONS.resyncRequired, {
        outputRef,
        subscriptionId,
        latestRevision: running?.revision ?? 0,
      }),
    );
    connection.socket.write(frame, () => {
      connection.resyncPending.delete(subscriptionId);
    });
  }

  function handleMessage(
    connection: ServerConnection,
    message: unknown,
    frameBytes: number,
  ): void {
    const asNotification = jsonRpcNotificationSchema.safeParse(message);
    if (
      asNotification.success &&
      (message as { id?: unknown }).id === undefined
    ) {
      handleNotification(connection, asNotification.data);
      return;
    }
    const asRequest = jsonRpcRequestSchema.safeParse(message);
    if (!asRequest.success) {
      teardownConnection(connection);
      return;
    }
    void handleRequest(connection, asRequest.data, frameBytes);
  }

  function handleNotification(
    connection: ServerConnection,
    notification: { method: string; params?: unknown },
  ): void {
    if (notification.method === COMMAND_HOST_NOTIFICATIONS.cancelRequest) {
      const parsed = cancelParamsSchema.safeParse(notification.params);
      if (parsed.success) {
        connection.inflight.get(parsed.data.id)?.abort();
      }
    }
  }

  async function handleRequest(
    connection: ServerConnection,
    request: { id: JsonRpcId; method: string; params?: unknown },
    frameBytes: number,
  ): Promise<void> {
    const { id, method } = request;
    if (!connection.initialized && method !== COMMAND_HOST_METHODS.initialize) {
      sendResponse(
        connection,
        buildErrorResponse(id, INVALID_REQUEST_CODE, 'initialize first'),
      );
      return;
    }
    if (connection.inflight.has(id)) {
      sendResponse(
        connection,
        buildErrorResponse(
          id,
          INVALID_REQUEST_CODE,
          'duplicate in-flight request id',
        ),
      );
      return;
    }
    if (connection.inflight.size >= LIMITS.maxInflightRequestsPerConnection) {
      sendResponse(
        connection,
        buildErrorResponse(
          id,
          INVALID_REQUEST_CODE,
          'too many in-flight requests on this connection',
        ),
      );
      return;
    }
    if (
      aggregateInflightRequestBytes + frameBytes >
      LIMITS.maxAggregateInflightRequestBytes
    ) {
      sendResponse(
        connection,
        buildErrorResponse(
          id,
          INVALID_REQUEST_CODE,
          'worker in-flight request budget is exhausted',
        ),
      );
      return;
    }
    aggregateInflightRequestBytes += frameBytes;
    const controller = new AbortController();
    connection.inflight.set(id, controller);
    try {
      const result = await dispatch(connection, method, request.params, {
        signal: controller.signal,
      });
      if (result.kind === 'result') {
        sendResponse(connection, buildResultResponse(id, result.value));
      } else if (result.kind === 'cancelled') {
        sendResponse(
          connection,
          buildErrorResponse(id, REQUEST_CANCELLED_CODE, 'request cancelled'),
        );
      } else {
        sendResponse(
          connection,
          buildErrorResponse(id, result.code, result.message),
        );
        if (result.closeAfterResponse === true) {
          connection.socket.end();
        }
      }
    } catch (error: unknown) {
      sendResponse(
        connection,
        buildErrorResponse(
          id,
          INTERNAL_ERROR_CODE,
          error instanceof Error ? error.message : 'internal error',
        ),
      );
    } finally {
      aggregateInflightRequestBytes -= frameBytes;
      if (connection.inflight.get(id) === controller) {
        connection.inflight.delete(id);
      }
    }
  }

  type DispatchOutcome =
    | { kind: 'result'; value: unknown }
    | { kind: 'cancelled' }
    | {
        kind: 'error';
        code: number;
        message: string;
        closeAfterResponse?: boolean;
      };

  async function dispatch(
    connection: ServerConnection,
    method: string,
    params: unknown,
    context: { signal: AbortSignal },
  ): Promise<DispatchOutcome> {
    switch (method) {
      case COMMAND_HOST_METHODS.initialize: {
        const parsed = initializeParamsSchema.safeParse(params);
        if (!parsed.success) {
          return invalidParams(parsed.error.message);
        }
        if (parsed.data.stateRootFingerprint !== options.stateRootFingerprint) {
          // §6.4 — fingerprint 불일치는 오류 응답 후 즉시 disconnect.
          return {
            kind: 'error',
            code: INVALID_REQUEST_CODE,
            message: 'stateRoot fingerprint mismatch',
            closeAfterResponse: true,
          };
        }
        const initializedCount = [...connections].filter(
          (candidate) => candidate.initialized,
        ).length;
        if (initializedCount >= LIMITS.maxInitializedConnections) {
          return {
            kind: 'error',
            code: INVALID_REQUEST_CODE,
            message: 'too many initialized connections',
          };
        }
        connection.initialized = true;
        // 데몬이 돌아온 것만으로는 고정이 이어지지 않는다 (P7.6 §7.1) —
        // 옛 세션을 다시 고정하는 것은 그 세션에 붙는 쪽의 일이다.
        everServedConnection = true;
        return {
          kind: 'result',
          value: {
            selectedVersion: COMMAND_HOST_PROTOCOL_VERSION,
            supportedVersions: [...COMMAND_HOST_SUPPORTED_VERSIONS],
            capabilities: {
              losslessStdio: true,
              prePersistenceOutputRedaction: true,
            },
            effectiveConfig: core.effectiveConfig,
          },
        };
      }
      case COMMAND_HOST_METHODS.start: {
        const parsed = startParamsSchema.safeParse(params);
        if (!parsed.success) {
          return invalidParams(parsed.error.message);
        }
        const p = parsed.data;
        if (p.stateRoot !== options.stateRoot) {
          return invalidParams('stateRoot does not match initialized worker');
        }
        const started = await core.start({
          executable: p.executable,
          args: p.args,
          cwd: p.cwd,
          env: p.env,
          stateRoot: options.stateRoot,
          threadId: p.threadId,
          runId: p.runId,
          callId: p.callId,
          stdinMode: p.stdinMode,
          ...(p.owner === undefined ? {} : { owner: p.owner }),
          ...(p.streamMode === undefined ? {} : { streamMode: p.streamMode }),
          ...(p.timeoutMs === undefined ? {} : { timeoutMs: p.timeoutMs }),
          ...(p.maxOutputBytesPerStream === undefined
            ? {}
            : { maxOutputBytesPerStream: p.maxOutputBytesPerStream }),
          ...(p.outputRedaction === undefined
            ? {}
            : { outputRedaction: p.outputRedaction }),
        });
        if (started.ok) {
          if (p.owner === 'system') {
            connection.pinnedSystemRefs.add(started.outputRef);
          } else {
            connection.ownedUnclaimedRefs.add(started.outputRef);
          }
        }
        return { kind: 'result', value: started };
      }
      case COMMAND_HOST_METHODS.waitInitial: {
        const parsed = waitInitialParamsSchema.safeParse(params);
        if (!parsed.success) {
          return invalidParams(parsed.error.message);
        }
        const result = await core.waitForInitialResult({
          // 워커는 stateRoot 하나만 서빙한다 — RPC가 나르지 않는 이유다.
          stateRoot: options.stateRoot,
          outputRef: parsed.data.outputRef,
          ...(parsed.data.yieldTimeMs === undefined
            ? {}
            : { yieldTimeMs: parsed.data.yieldTimeMs }),
          signal: context.signal,
        });
        connection.ownedUnclaimedRefs.delete(parsed.data.outputRef);
        if (
          !result.ok &&
          result.reasonCode === 'wait_aborted' &&
          context.signal.aborted
        ) {
          return { kind: 'cancelled' };
        }
        return { kind: 'result', value: result };
      }
      case COMMAND_HOST_METHODS.interact: {
        const parsed = interactParamsSchema.safeParse(params);
        if (!parsed.success) {
          return invalidParams(parsed.error.message);
        }
        const p = parsed.data;
        if (p.stateRoot !== options.stateRoot) {
          return invalidParams('stateRoot does not match initialized worker');
        }
        const result = await core.interact({
          stateRoot: options.stateRoot,
          threadId: p.threadId,
          outputRef: p.outputRef,
          ...(p.chars === undefined ? {} : { chars: p.chars }),
          ...(p.closeStdin === undefined ? {} : { closeStdin: p.closeStdin }),
          ...(p.terminate === undefined ? {} : { terminate: p.terminate }),
          ...(p.operation === undefined ? {} : { operation: p.operation }),
          ...(p.owner === undefined ? {} : { owner: p.owner }),
          ...(p.afterRevision === undefined
            ? {}
            : { afterRevision: p.afterRevision }),
          ...(p.yieldTimeMs === undefined
            ? {}
            : { yieldTimeMs: p.yieldTimeMs }),
          ...(p.page === undefined ? {} : { page: p.page }),
          signal: context.signal,
        });
        if (
          !result.ok &&
          result.reasonCode === 'wait_aborted' &&
          context.signal.aborted
        ) {
          return { kind: 'cancelled' };
        }
        return { kind: 'result', value: result };
      }
      case COMMAND_HOST_METHODS.subscribe: {
        const parsed = subscribeParamsSchema.safeParse(params);
        if (!parsed.success) {
          return invalidParams(parsed.error.message);
        }
        // 이 구독의 id는 core.subscribe가 돌려주기 전에는 없지만, §7.3
        // barrier가 "등록 이후의 output만 전달"을 보장하므로 반환 뒤에
        // 채워도 늦지 않다. outputRef로 공유 맵을 두면 같은 세션을 구독한
        // 다른 연결이 서로의 id를 덮어쓴다.
        let subscriptionId = '';
        const subscription = core.subscribe({
          stateRoot: options.stateRoot,
          threadId: threadIdOfRef(parsed.data.outputRef),
          outputRef: parsed.data.outputRef,
          ...(parsed.data.afterRevision === undefined
            ? {}
            : { afterRevision: parsed.data.afterRevision }),
          ...(parsed.data.stdoutAfterOffset === undefined
            ? {}
            : { stdoutAfterOffset: parsed.data.stdoutAfterOffset }),
          ...(parsed.data.stderrAfterOffset === undefined
            ? {}
            : { stderrAfterOffset: parsed.data.stderrAfterOffset }),
          onEvent: (event) => {
            if (event.kind === 'output') {
              sendNotification(
                connection,
                subscriptionId,
                event.outputRef,
                buildNotification(COMMAND_HOST_NOTIFICATIONS.output, {
                  outputRef: event.outputRef,
                  subscriptionId,
                  revision: event.revision,
                  stream: event.stream,
                  startOffset: event.startOffset,
                  endOffset: event.endOffset,
                  chunk: event.chunk,
                }),
              );
            }
          },
        });
        if (!subscription.ok) {
          return { kind: 'result', value: subscription };
        }
        subscriptionId = subscription.subscriptionId;
        connection.subscriptions.set(
          subscription.subscriptionId,
          subscription.unsubscribe,
        );
        return {
          kind: 'result',
          value: {
            ok: true,
            subscriptionId: subscription.subscriptionId,
            barrierRevision: subscription.barrierRevision,
            stdout: subscription.stdout,
            stderr: subscription.stderr,
            resyncRequired: subscription.resyncRequired,
          },
        };
      }
      case COMMAND_HOST_METHODS.unsubscribe: {
        const parsed = unsubscribeParamsSchema.safeParse(params);
        if (!parsed.success) {
          return invalidParams(parsed.error.message);
        }
        connection.subscriptions.get(parsed.data.subscriptionId)?.();
        connection.subscriptions.delete(parsed.data.subscriptionId);
        return { kind: 'result', value: { ok: true } };
      }
      case COMMAND_HOST_METHODS.list: {
        return { kind: 'result', value: core.listSessions() };
      }
      case COMMAND_HOST_METHODS.terminateAll: {
        // 세션들을 요청-종료할 뿐 워커는 종료하지 않는다 (spec §7.3).
        const running = core
          .listSessions()
          .filter((session) => session.running);
        await Promise.all(
          running.map((session) =>
            core.interact({
              stateRoot: options.stateRoot,
              threadId: session.threadId,
              outputRef: session.outputRef,
              terminate: true,
              yieldTimeMs: 0,
            }),
          ),
        );
        return { kind: 'result', value: { ok: true } };
      }
      case COMMAND_HOST_METHODS.shutdown: {
        if (!core.isQuiescent()) {
          return {
            kind: 'error',
            code: INVALID_REQUEST_CODE,
            message: 'Busy: active work exists',
          };
        }
        queueMicrotask(() => {
          options.onIdle?.();
        });
        return { kind: 'result', value: { ok: true } };
      }
      default:
        return {
          kind: 'error',
          code: METHOD_NOT_FOUND_CODE,
          message: `unknown method: ${method}`,
        };
    }
  }

  function threadIdOfRef(outputRef: string): string {
    const withoutPrefix = outputRef.slice('command-output:'.length);
    const separator = withoutPrefix.indexOf('/');
    return decodeURIComponent(
      separator < 0 ? withoutPrefix : withoutPrefix.slice(0, separator),
    );
  }

  function invalidParams(message: string): DispatchOutcome {
    return { kind: 'error', code: INVALID_PARAMS_CODE, message };
  }

  return {
    async close() {
      draining = true;
      detachSettled();
      for (const connection of [...connections]) {
        teardownConnection(connection);
      }
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      if (!options.socketPath.startsWith('\\\\')) {
        await unlink(options.socketPath).catch(() => undefined);
      }
    },
    connectionCount() {
      return connections.size;
    },
    initializedConnectionCount,
    hasEverServedConnection() {
      return everServedConnection;
    },
  };
}
