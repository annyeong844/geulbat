import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { createCommandSessionHost } from './session-core.js';
import {
  isProcessAlive,
  readCommandHostLock,
  resolveCommandHostPaths,
  type CommandHostPaths,
} from './runtime-paths.js';
import {
  buildNotification,
  buildRequest,
  COMMAND_HOST_CONNECT_ATTEMPTS,
  COMMAND_HOST_CONNECT_BACKOFF_MS,
  COMMAND_HOST_METHODS,
  COMMAND_HOST_NOTIFICATIONS,
  COMMAND_HOST_PROTOCOL_VERSION,
  encodeFrame,
  FrameDecoder,
  initializeResultSchema,
  jsonRpcResponseSchema,
  listResultSchema,
  outputNotificationSchema,
  REQUEST_CANCELLED_CODE,
  type DecodedFrame,
  type JsonRpcId,
} from './protocol.js';
import type {
  CommandSessionHostConfig,
  HostCommandActiveSessions,
  HostCommandInitialResult,
  HostCommandInteractionResult,
  HostCommandOutputChunk,
  HostCommandRuntime,
  HostCommandStartResult,
} from './contract.js';

// P7.5 spec v4 §7 — 데몬 쪽 HostCommandRuntime 파사드. 도구는 이 파사드가
// 인라인 코어인지 워커 RPC인지 모른다. AbortSignal은 프로세스 경계를
// 넘지 않으므로 여기서 $/cancelRequest 알림으로 번역한다.

const CONNECT_ATTEMPTS = COMMAND_HOST_CONNECT_ATTEMPTS;
const CONNECT_BACKOFF_MS = COMMAND_HOST_CONNECT_BACKOFF_MS; // §3 허용 타이머.

/**
 * 응답을 받지 못한 채 연결이 끊긴 요청의 결과값. 결과 모양(reasonCode)만
 * 보고는 "워커가 거절했다"와 구별할 수 없는데, 재시도 가능 여부는 정확히
 * 그 구별에 달려 있다 (§4.7).
 */
const CONNECTION_LOST = Symbol('command-host connection lost');

function connectionLostResult(): {
  ok: false;
  reasonCode: 'output_store_failed';
  message: string;
} {
  return {
    ok: false,
    reasonCode: 'output_store_failed',
    message: 'command-host connection was lost.',
  };
}

interface CommandHostClientOptions {
  config: CommandSessionHostConfig;
  /** 워커 엔트리 실행 스펙. 기본은 빌드 산출물 경로다. */
  workerCommand?: { execPath: string; args: string[] };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  cancelled: boolean;
  detachAbort?: () => void;
}

interface WorkerLink {
  socket: net.Socket;
  pending: Map<JsonRpcId, PendingRequest>;
  outputListeners: Map<string, (chunk: HostCommandOutputChunk) => void>;
  capabilities: {
    losslessStdio: boolean;
    prePersistenceOutputRedaction: boolean;
  };
  nextId: number;
  closedReason: string | null;
}

/**
 * §9.3 — 워커 엔트리는 두 레이아웃에 존재한다: tsc 산출물
 * `dist/command-host/main.js`(이 모듈 옆), dev 번들
 * `dist-dev/command-host.mjs`(번들 엔트리 옆). dev 번들에서는 이 파일의
 * `import.meta.url`이 소스 경로로 치환되므로 옆에 main.js가 없다.
 *
 * 둘 다 없으면 undefined다 — 없는 경로로 spawn해 봐야 접속 백오프를 다
 * 돌고 실패할 뿐이므로, 호출자가 즉시 포기하게 한다.
 */
function resolveWorkerEntry(): string | undefined {
  const sibling = fileURLToPath(new URL('./main.js', import.meta.url));
  if (existsSync(sibling)) {
    return sibling;
  }
  const bundleEntry = process.argv[1];
  if (bundleEntry !== undefined) {
    const bundled = join(dirname(bundleEntry), 'command-host.mjs');
    if (existsSync(bundled)) {
      return bundled;
    }
  }
  return undefined;
}

export function createCommandHostClient(
  options: CommandHostClientOptions,
): HostCommandRuntime & HostCommandActiveSessions {
  const links = new Map<string, Promise<WorkerLink>>();
  /** 마지막 워커 spawn 실패 사유 — 접속 실패 진단에 실어 보낸다. */
  let lastSpawnFailure: string | undefined;
  /**
   * §4.7 — 이 파사드 인스턴스의 신원과 전역 단조 연산 번호. 세션마다 번호를
   * 따로 매기면 세션이 끝날 때 그 카운터를 언제 지울지가 새 문제로 남는다.
   * 전역 단조면 세션은 "마지막으로 적용된 번호" 하나만 비교하면 되고, 파사드
   * 쪽에는 정수 하나 말고 아무 상태도 남지 않는다.
   */
  const clientId = randomUUID();
  let lastOperationSeq = 0;
  // 워커 부재 시 종료 세션의 디스크 직접 읽기(§8.2)에 쓰는 로컬 코어 —
  // 세션을 만들지 않으므로 소유권과 충돌하지 않는다.
  const persistedReader = createCommandSessionHost(options.config);

  async function ensureLink(stateRoot: string): Promise<WorkerLink> {
    const existing = links.get(stateRoot);
    if (existing !== undefined) {
      const link = await existing.catch(() => undefined);
      if (link !== undefined && link.closedReason === null) {
        return link;
      }
      links.delete(stateRoot);
    }
    const created = establishLink(stateRoot);
    links.set(stateRoot, created);
    return await created;
  }

  async function establishLink(stateRoot: string): Promise<WorkerLink> {
    const paths = await resolveCommandHostPaths(stateRoot);
    let spawned = false;
    for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt += 1) {
      const socket = await connectOnce(paths.socketPath);
      if (socket !== undefined) {
        const link = await initializeLink(socket, paths);
        if (link !== undefined) {
          return link;
        }
      }
      if (!spawned) {
        const launched = spawnWorker(stateRoot);
        if (!launched.ok) {
          // 띄울 수 없는 워커를 기다리는 백오프는 실패를 늦출 뿐이다.
          throw new Error(launched.message);
        }
        spawned = true;
      }
      await delay(CONNECT_BACKOFF_MS);
    }
    throw new Error(
      lastSpawnFailure === undefined
        ? 'command-host worker did not become reachable.'
        : `command-host worker did not become reachable: ${lastSpawnFailure}`,
    );
  }

  function spawnWorker(
    stateRoot: string,
  ): { ok: true } | { ok: false; message: string } {
    let command = options.workerCommand;
    if (command === undefined) {
      const entry = resolveWorkerEntry();
      if (entry === undefined) {
        return {
          ok: false,
          message:
            'command-host worker entry was not found — expected dist/command-host/main.js next to this build or command-host.mjs next to the dev bundle.',
        };
      }
      command = { execPath: process.execPath, args: [entry] };
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        command.execPath,
        [
          ...command.args,
          stateRoot,
          String(options.config.inlineMaxBytes),
          String(options.config.tailRingBytes ?? 0),
          String(options.config.maxYieldTimeMs ?? 0),
        ],
        {
          detached: true,
          stdio: 'ignore',
          env: process.env,
        },
      );
    } catch (error: unknown) {
      return { ok: false, message: getErrorMessage(error) };
    }
    // spawn 실패는 비동기 'error' 이벤트로 온다 — 핸들러가 없으면 데몬이
    // 죽는다. 접속이 끝내 안 되면 아래 진단에 그 이유를 실어 보낸다.
    child.once('error', (error: Error) => {
      lastSpawnFailure = error.message;
    });
    child.unref();
    return { ok: true };
  }

  async function connectOnce(
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

  async function initializeLink(
    socket: net.Socket,
    paths: CommandHostPaths,
  ): Promise<WorkerLink | undefined> {
    const link: WorkerLink = {
      socket,
      pending: new Map(),
      outputListeners: new Map(),
      capabilities: {
        losslessStdio: false,
        prePersistenceOutputRedaction: false,
      },
      nextId: 1,
      closedReason: null,
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
        handleInbound(link, frame.message);
      }
    });
    const closeLink = () => {
      if (link.closedReason === null) {
        link.closedReason = 'connection closed';
      }
      for (const pending of link.pending.values()) {
        pending.detachAbort?.();
        pending.resolve(CONNECTION_LOST);
      }
      link.pending.clear();
      link.outputListeners.clear();
    };
    socket.on('close', closeLink);
    socket.on('error', closeLink);

    const initialized = await request(link, COMMAND_HOST_METHODS.initialize, {
      protocolVersion: COMMAND_HOST_PROTOCOL_VERSION,
      stateRootFingerprint: paths.stateRootFingerprint,
    });
    const parsed = initializeResultSchema.safeParse(initialized);
    if (!parsed.success) {
      socket.destroy();
      return undefined;
    }
    link.capabilities = {
      losslessStdio: parsed.data.capabilities['losslessStdio'] === true,
      prePersistenceOutputRedaction:
        parsed.data.capabilities['prePersistenceOutputRedaction'] === true,
    };
    return link;
  }

  function handleInbound(link: WorkerLink, message: unknown): void {
    const response = jsonRpcResponseSchema.safeParse(message);
    if (response.success) {
      const pending = link.pending.get(response.data.id);
      if (pending !== undefined) {
        link.pending.delete(response.data.id);
        pending.detachAbort?.();
        if ('result' in response.data) {
          pending.resolve(response.data.result);
        } else if (response.data.error.code === REQUEST_CANCELLED_CODE) {
          pending.resolve({
            ok: false,
            reasonCode: 'wait_aborted',
            message: 'host command wait was aborted.',
          });
        } else {
          pending.resolve({
            ok: false,
            reasonCode: 'output_store_failed',
            message: response.data.error.message,
          });
        }
      }
      return;
    }
    const asObject = message as { method?: string; params?: unknown };
    if (asObject.method === COMMAND_HOST_NOTIFICATIONS.output) {
      const output = outputNotificationSchema.safeParse(asObject.params);
      if (output.success) {
        link.outputListeners.get(output.data.outputRef)?.({
          stream: output.data.stream,
          text: output.data.chunk,
        });
      }
    }
    // resyncRequired는 best-effort 스트리밍에선 무시한다 — 정확 복구는
    // 페이지 조회가 담당한다 (§7.5).
  }

  function request(
    link: WorkerLink,
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const id = link.nextId;
    link.nextId += 1;
    return new Promise((resolve) => {
      const pending: PendingRequest = { resolve, cancelled: false };
      link.pending.set(id, pending);
      if (signal !== undefined) {
        const onAbort = () => {
          const pending = link.pending.get(id);
          if (pending !== undefined && !pending.cancelled) {
            pending.cancelled = true;
            link.socket.write(
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
          pending.detachAbort = () => {
            signal.removeEventListener('abort', onAbort);
          };
        }
        link.socket.write(encodeFrame(buildRequest(id, method, params)));
        if (signal.aborted) {
          onAbort();
        }
      } else {
        link.socket.write(encodeFrame(buildRequest(id, method, params)));
      }
    });
  }

  return {
    async start(args) {
      let link: WorkerLink;
      try {
        link = await ensureLink(args.stateRoot);
      } catch (error: unknown) {
        return {
          ok: false,
          reasonCode: 'spawn_failed',
          message:
            error instanceof Error
              ? error.message
              : 'command-host worker unreachable',
        };
      }
      if (
        args.outputRedaction !== undefined &&
        !link.capabilities.prePersistenceOutputRedaction
      ) {
        return {
          ok: false,
          reasonCode: 'spawn_failed',
          message:
            'command-host worker does not support pre-persistence output redaction.',
        };
      }
      if (args.streamMode === 'lossless' && !link.capabilities.losslessStdio) {
        return {
          ok: false,
          reasonCode: 'spawn_failed',
          message:
            'command-host worker does not support lossless stdout/stderr sessions.',
        };
      }
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(args.env)) {
        if (value !== undefined) {
          env[key] = value;
        }
      }
      const answered = await request(link, COMMAND_HOST_METHODS.start, {
        executable: args.executable,
        args: args.args,
        cwd: args.cwd,
        env,
        stateRoot: args.stateRoot,
        threadId: args.threadId,
        runId: args.runId,
        callId: args.callId,
        stdinMode: args.stdinMode,
        ...(args.owner === undefined ? {} : { owner: args.owner }),
        ...(args.streamMode === undefined
          ? {}
          : { streamMode: args.streamMode }),
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
        ...(args.maxOutputBytesPerStream === undefined
          ? {}
          : { maxOutputBytesPerStream: args.maxOutputBytesPerStream }),
        ...(args.outputRedaction === undefined
          ? {}
          : {
              outputRedaction: {
                exactMarkers: [...args.outputRedaction.exactMarkers],
                replacement: args.outputRedaction.replacement,
              },
            }),
      });
      if (answered === CONNECTION_LOST) {
        // spawn 요청이 나갔는지조차 알 수 없다. 자동 재시도는 명령을 두 번
        // 실행할 수 있으므로 하지 않는다 — 여기서 멈추는 것이 §4.7이다.
        return connectionLostResult();
      }
      const started = answered as HostCommandStartResult;
      if (started.ok && args.onOutput !== undefined) {
        link.outputListeners.set(started.outputRef, args.onOutput);
        void request(link, COMMAND_HOST_METHODS.subscribe, {
          outputRef: started.outputRef,
        });
      }
      if (started.ok && args.signal !== undefined) {
        // start의 소유 abort는 초기 대기 취소로 번역된다 — waitInitial의
        // signal이 같은 ctx.signal이므로 여기서 별도 처리하지 않는다.
      }
      return started;
    },

    async waitForInitialResult(args) {
      // 세션을 소유한 워크스페이스의 워커로만 보낸다. 링크가 없거나 이미
      // 끊겼으면 다시 세운다 — T2(claim 응답 유실 → 재접속 멱등 복구)가
      // 바로 이 경로다. 커밋된 claim은 재접속한 뒤 같은 답으로 합류할 수
      // 있어야 하고, 그 판정은 lock owner 생존 확인이 한다(§8.2).
      const link =
        (await linkFor(args.stateRoot)) ??
        (await ensureLinkIfOwnerAlive(args.stateRoot).catch(() => undefined));
      if (link === undefined) {
        return {
          ok: false,
          reasonCode: 'not_found',
          message: 'command-host worker is not connected.',
        };
      }
      try {
        const answered = await request(
          link,
          COMMAND_HOST_METHODS.waitInitial,
          {
            outputRef: args.outputRef,
            ...(args.yieldTimeMs === undefined
              ? {}
              : { yieldTimeMs: args.yieldTimeMs }),
          },
          args.signal,
        );
        // claim은 그 자체로 멱등하므로 재시도는 호출자 몫이다 — 커밋된
        // claim은 재접속 뒤 같은 답으로 합류한다(§8.2).
        return answered === CONNECTION_LOST
          ? connectionLostResult()
          : (answered as HostCommandInitialResult);
      } finally {
        // 스트리밍 창은 초기 대기까지다 — 리스너를 세션마다 남기면 링크
        // 수명 동안 누적된다.
        link.outputListeners.delete(args.outputRef);
      }
    },

    async interact(args) {
      let link: WorkerLink | undefined;
      try {
        link = await ensureLinkIfOwnerAlive(args.stateRoot);
      } catch {
        link = undefined;
      }
      if (link === undefined) {
        // 워커 부재 — 종료 세션의 디스크 직접 읽기 (§8.2).
        return await persistedReader.interact(args);
      }
      // 부수효과가 있는 요청만 재시도 식별자를 단다. 관찰만 하는 요청은
      // 두 번 처리돼도 같은 결과이므로 번호를 소모할 이유가 없다 (§4.7).
      const hasSideEffect =
        args.chars !== undefined ||
        args.closeStdin === true ||
        args.terminate === true;
      let operation: { clientId: string; seq: number } | undefined;
      if (hasSideEffect) {
        lastOperationSeq += 1;
        operation = { clientId, seq: lastOperationSeq };
      }
      const params = {
        stateRoot: args.stateRoot,
        threadId: args.threadId,
        outputRef: args.outputRef,
        ...(args.owner === undefined ? {} : { owner: args.owner }),
        ...(args.chars === undefined ? {} : { chars: args.chars }),
        ...(args.closeStdin === undefined
          ? {}
          : { closeStdin: args.closeStdin }),
        ...(args.terminate === undefined ? {} : { terminate: args.terminate }),
        ...(args.afterRevision === undefined
          ? {}
          : { afterRevision: args.afterRevision }),
        ...(args.yieldTimeMs === undefined
          ? {}
          : { yieldTimeMs: args.yieldTimeMs }),
        ...(args.page === undefined ? {} : { page: args.page }),
        ...(operation === undefined ? {} : { operation }),
      };
      const answered = await request(
        link,
        COMMAND_HOST_METHODS.interact,
        params,
        args.signal,
      );
      if (answered !== CONNECTION_LOST) {
        return answered as HostCommandInteractionResult;
      }
      if (operation === undefined || args.signal?.aborted === true) {
        // 관찰 요청은 호출자가 다시 물어보면 그만이고, 취소된 요청은
        // 되살릴 대상이 아니다.
        return connectionLostResult();
      }
      // 응답만 유실된 경우다: 썼는지 아닌지 여기서는 알 수 없다. 같은
      // operation으로 정확히 한 번 다시 보내면, 이미 적용됐다면 워커가
      // 중복으로 걸러 관찰만 돌려주고 아니면 그때 적용된다.
      let retryLink: WorkerLink | undefined;
      try {
        retryLink = await ensureLinkIfOwnerAlive(args.stateRoot);
      } catch {
        retryLink = undefined;
      }
      if (retryLink === undefined) {
        // 워커가 사라졌다 — 세션도 함께 갔으므로 남은 진실은 디스크다.
        return await persistedReader.interact(args);
      }
      // 대기는 이미 한 번 썼다. 재전송은 부수효과를 확정하러 가는 것이지
      // 관찰 창을 새로 사는 것이 아니므로 폴로 보낸다 — 그러지 않으면 한
      // 턴의 최악 대기가 §4.6 상한의 두 배가 된다.
      const retried = await request(
        retryLink,
        COMMAND_HOST_METHODS.interact,
        { ...params, yieldTimeMs: 0 },
        args.signal,
      );
      return retried === CONNECTION_LOST
        ? connectionLostResult()
        : (retried as HostCommandInteractionResult);
    },

    async listThreadSessions(args) {
      // 워커가 없으면 살아 있는 세션도 없다 — 끝난 것은 transcript가 답한다.
      const link = await ensureLinkIfOwnerAlive(args.stateRoot).catch(
        () => undefined,
      );
      if (link === undefined) {
        return [];
      }
      const listed = await request(link, COMMAND_HOST_METHODS.list, {});
      const parsed = listResultSchema.safeParse(listed);
      return parsed.success
        ? parsed.data.filter(
            (session) =>
              session.stateRoot === args.stateRoot &&
              session.threadId === args.threadId,
          )
        : [];
    },

    async activeOutputRefs(stateRoot) {
      // §5.6 fail-closed — 워커가 살아 있는데 응답을 얻지 못하면 삭제를
      // 건너뛰어야 하므로 실패를 값으로 돌려준다.
      let link: WorkerLink | undefined;
      try {
        link = await ensureLinkIfOwnerAlive(stateRoot);
      } catch (error: unknown) {
        return {
          ok: false,
          reason:
            error instanceof Error
              ? error.message
              : 'command-host worker is unreachable',
        };
      }
      if (link === undefined) {
        // lock owner 사망 확인 = 워커 부재 확정. 살아 있는 세션은 없다.
        return { ok: true, refs: new Set<string>() };
      }
      const listed = await request(link, COMMAND_HOST_METHODS.list, {});
      const parsed = listResultSchema.safeParse(listed);
      if (!parsed.success) {
        return { ok: false, reason: 'session/list response was not readable' };
      }
      return {
        ok: true,
        refs: new Set(
          parsed.data
            .filter((session) => session.stateRoot === stateRoot)
            .map((session) => session.outputRef),
        ),
      };
    },

    async closeAll() {
      // 데몬 셧다운은 disconnect다 — 세션은 워커에서 계속 산다 (§8.2).
      for (const pendingLink of links.values()) {
        const link = await pendingLink.catch(() => undefined);
        if (link !== undefined) {
          link.closedReason = 'daemon disconnect';
          link.socket.destroy();
        }
      }
      links.clear();
      return { ok: true };
    },
  };

  async function linkFor(stateRoot: string): Promise<WorkerLink | undefined> {
    const pendingLink = links.get(stateRoot);
    if (pendingLink === undefined) {
      return undefined;
    }
    const link = await pendingLink.catch(() => undefined);
    return link !== undefined && link.closedReason === null ? link : undefined;
  }

  async function ensureLinkIfOwnerAlive(
    stateRoot: string,
  ): Promise<WorkerLink | undefined> {
    const paths = await resolveCommandHostPaths(stateRoot);
    const lock = await readCommandHostLock(paths.lockPath);
    if (lock === 'missing') {
      return undefined; // 워커 부재 확정 — 디스크 폴백.
    }
    if (lock === 'unparsable') {
      // 신선-미파싱 lock은 stale이 아니다 — 접속 재시도 (§6.2).
      return await ensureLink(stateRoot);
    }
    if (!isProcessAlive(lock.pid)) {
      return undefined; // owner 사망 확정 — 디스크 폴백.
    }
    return await ensureLink(stateRoot);
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'command-host worker could not be launched';
}
