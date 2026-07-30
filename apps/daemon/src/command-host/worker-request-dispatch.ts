import {
  buildNotification,
  COMMAND_HOST_CAPABILITIES,
  COMMAND_HOST_METHODS,
  COMMAND_HOST_NOTIFICATIONS,
  COMMAND_HOST_PROTOCOL_VERSION,
  COMMAND_HOST_SUPPORTED_VERSIONS,
  initializeParamsSchema,
  interactParamsSchema,
  INVALID_PARAMS_CODE,
  INVALID_REQUEST_CODE,
  METHOD_NOT_FOUND_CODE,
  startParamsSchema,
  subscribeParamsSchema,
  unsubscribeParamsSchema,
  waitInitialParamsSchema,
} from './protocol.js';
import type {
  CommandHostServerOptions,
  ServerConnection,
} from './worker-server.js';

/**
 * P7.5 spec v4 §6.3·§7 — RPC 메서드 표. 한 요청의 파라미터 검증, 코어 호출,
 * 연결 소유권 갱신, 취소 판정, 결과·오류 형태가 여기 있다.
 *
 * 연결 수명(accept·teardown·유계 큐·drain)과 워커 종료 게이트는 서버가
 * 소유한다. 이 표는 그 서버 상태를 직접 만지지 않고, 서버가 넘긴 판정
 * (`canAdmitInitializedConnection`)과 기록(`markServedConnection`)만 쓴다.
 */

type DispatchOutcome =
  | { kind: 'result'; value: unknown }
  | { kind: 'cancelled' }
  | {
      kind: 'error';
      code: number;
      message: string;
      closeAfterResponse?: boolean;
    };

interface CommandHostRequestDispatchDeps {
  options: CommandHostServerOptions;
  /** §7.5 유계 알림 전송 — 폐기 시 resyncRequired는 서버가 처리한다. */
  sendNotification: (
    connection: ServerConnection,
    subscriptionId: string,
    outputRef: string,
    message: unknown,
  ) => void;
  /** §7.5 initialize 연결 정원 — 서버가 세고 판정한다. */
  canAdmitInitializedConnection: () => boolean;
  /**
   * initialize를 마친 연결을 받았다고 서버에 기록한다. 종료 게이트는 이
   * 사실로 "아직 안 왔다"와 "영영 안 온다"를 구별한다 (P7.6 §7.1).
   */
  markServedConnection: () => void;
}

interface CommandHostRequestDispatch {
  dispatch: (
    connection: ServerConnection,
    method: string,
    params: unknown,
    context: { signal: AbortSignal },
  ) => Promise<DispatchOutcome>;
}

export function createCommandHostRequestDispatch(
  deps: CommandHostRequestDispatchDeps,
): CommandHostRequestDispatch {
  const {
    canAdmitInitializedConnection,
    markServedConnection,
    options,
    sendNotification,
  } = deps;
  const { core } = options;

  return { dispatch };

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
        if (!canAdmitInitializedConnection()) {
          return {
            kind: 'error',
            code: INVALID_REQUEST_CODE,
            message: 'too many initialized connections',
          };
        }
        connection.initialized = true;
        // 데몬이 돌아온 것만으로는 고정이 이어지지 않는다 (P7.6 §7.1) —
        // 옛 세션을 다시 고정하는 것은 그 세션에 붙는 쪽의 일이다.
        markServedConnection();
        return {
          kind: 'result',
          value: {
            selectedVersion: COMMAND_HOST_PROTOCOL_VERSION,
            supportedVersions: [...COMMAND_HOST_SUPPORTED_VERSIONS],
            capabilities: COMMAND_HOST_CAPABILITIES,
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
          ...(p.requiresIdempotentStart === undefined
            ? {}
            : { requiresIdempotentStart: p.requiresIdempotentStart }),
          stdinMode: p.stdinMode,
          ...(p.initialStdin === undefined
            ? p.initialStdinBase64 === undefined
              ? {}
              : {
                  initialStdin: Buffer.from(p.initialStdinBase64, 'base64'),
                }
            : { initialStdin: p.initialStdin }),
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
          ...(parsed.data.requiresOutputRef === undefined
            ? {}
            : { requiresOutputRef: parsed.data.requiresOutputRef }),
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
        // P7.6 §7.1 — 단순 재접속은 옛 시스템 세션을 고정하지 않지만,
        // 그 세션에 실제로 접근한 연결은 새 소유자다. 코어의 동기식 목록으로
        // 유효한 live ref임을 확인한 뒤 await 전에 고정해야, 이전 연결의
        // 회수 타이머와 재입양이 한 이벤트 루프 틱에서 선형화된다.
        if (
          p.owner === 'system' &&
          core
            .listSessions()
            .some(
              (session) =>
                session.running &&
                session.stateRoot === options.stateRoot &&
                session.outputRef === p.outputRef,
            )
        ) {
          connection.pinnedSystemRefs.add(p.outputRef);
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
          ...(p.page === undefined
            ? {}
            : {
                page: {
                  stream: p.page.stream,
                  offsetBytes: p.page.offsetBytes,
                  limitBytes: p.page.limitBytes,
                  ...(p.page.encoding === undefined
                    ? {}
                    : { encoding: p.page.encoding }),
                  ...(p.page.deferRelease === undefined
                    ? {}
                    : { deferRelease: p.page.deferRelease }),
                  ...(p.page.releaseUpToBytes === undefined
                    ? {}
                    : { releaseUpToBytes: p.page.releaseUpToBytes }),
                },
              }),
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
