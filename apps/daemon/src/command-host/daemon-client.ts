import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  connectCommandHostWorkerLink,
  type CommandHostWorkerLink,
} from './daemon-worker-link.js';
import { createCommandSessionHost } from './session-core.js';
import {
  isProcessAlive,
  readCommandHostLock,
  resolveCommandHostPaths,
} from './runtime-paths.js';
import {
  COMMAND_HOST_CONNECT_ATTEMPTS,
  COMMAND_HOST_CONNECT_BACKOFF_MS,
  COMMAND_HOST_METHODS,
  listResultSchema,
} from './protocol.js';
import type {
  CommandSessionHostConfig,
  HostCommandActiveSessions,
  HostCommandInitialResult,
  HostCommandInteractionResult,
  HostCommandRuntime,
  HostCommandStartResult,
} from './contract.js';

// P7.5 spec v4 §7 — 데몬 쪽 HostCommandRuntime 파사드. 도구는 이 파사드가
// 인라인 코어인지 워커 RPC인지 모른다. 이 파일은 spawn/reconnect와 명령
// 재시도 정책을 소유하고, 소켓·handshake·AbortSignal 번역은 worker link가
// 소유한다.

const CONNECT_ATTEMPTS = COMMAND_HOST_CONNECT_ATTEMPTS;
const CONNECT_BACKOFF_MS = COMMAND_HOST_CONNECT_BACKOFF_MS; // §3 허용 타이머.

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
  const links = new Map<string, Promise<CommandHostWorkerLink>>();
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

  async function ensureLink(stateRoot: string): Promise<CommandHostWorkerLink> {
    const existing = links.get(stateRoot);
    if (existing !== undefined) {
      const link = await existing.catch(() => undefined);
      if (link !== undefined && !link.isClosed()) {
        return link;
      }
      links.delete(stateRoot);
    }
    const created = establishLink(stateRoot);
    links.set(stateRoot, created);
    return await created;
  }

  async function establishLink(
    stateRoot: string,
  ): Promise<CommandHostWorkerLink> {
    const paths = await resolveCommandHostPaths(stateRoot);
    let spawned = false;
    for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt += 1) {
      const link = await connectCommandHostWorkerLink(
        paths.socketPath,
        paths.stateRootFingerprint,
      );
      if (link !== undefined) {
        return link;
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

  return {
    async start(args) {
      let link: CommandHostWorkerLink;
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
      if (
        args.requiresDeferredOutputRelease === true &&
        !link.capabilities.deferredOutputRelease
      ) {
        return {
          ok: false,
          reasonCode: 'spawn_failed',
          message:
            'command-host worker does not support deferred lossless output release.',
        };
      }
      if (
        args.requiresIdempotentStart === true &&
        !link.capabilities.idempotentStartByInvocation
      ) {
        return {
          ok: false,
          reasonCode: 'spawn_failed',
          message:
            'command-host worker does not support idempotent start reconciliation.',
        };
      }
      if (
        args.initialStdin !== undefined &&
        !link.capabilities.initialStdinOnStart
      ) {
        return {
          ok: false,
          reasonCode: 'spawn_failed',
          message:
            'command-host worker does not support non-persisted initial stdin on start.',
        };
      }
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(args.env)) {
        if (value !== undefined) {
          env[key] = value;
        }
      }
      const answered = await link.request(COMMAND_HOST_METHODS.start, {
        executable: args.executable,
        args: args.args,
        cwd: args.cwd,
        env,
        stateRoot: args.stateRoot,
        threadId: args.threadId,
        runId: args.runId,
        callId: args.callId,
        ...(args.requiresIdempotentStart === undefined
          ? {}
          : { requiresIdempotentStart: args.requiresIdempotentStart }),
        stdinMode: args.stdinMode,
        ...(args.initialStdin === undefined
          ? {}
          : { initialStdin: args.initialStdin }),
        ...(args.owner === undefined ? {} : { owner: args.owner }),
        ...(args.streamMode === undefined
          ? {}
          : { streamMode: args.streamMode }),
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
        ...(args.maxOutputBytesPerStream === undefined
          ? {}
          : { maxOutputBytesPerStream: args.maxOutputBytesPerStream }),
        ...(args.requiresDeferredOutputRelease === undefined
          ? {}
          : {
              requiresDeferredOutputRelease: args.requiresDeferredOutputRelease,
            }),
        ...(args.outputRedaction === undefined
          ? {}
          : {
              outputRedaction: {
                exactMarkers: [...args.outputRedaction.exactMarkers],
                replacement: args.outputRedaction.replacement,
              },
            }),
      });
      if (answered === link.connectionLost) {
        // spawn 요청이 나갔는지조차 알 수 없다. 자동 재시도는 명령을 두 번
        // 실행할 수 있으므로 하지 않는다 — 여기서 멈추는 것이 §4.7이다.
        return connectionLostResult();
      }
      const started = answered as HostCommandStartResult;
      if (started.ok && args.onOutput !== undefined) {
        link.subscribeOutput(started.outputRef, args.onOutput);
        void link.request(COMMAND_HOST_METHODS.subscribe, {
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
        const answered = await link.request(
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
        return answered === link.connectionLost
          ? connectionLostResult()
          : (answered as HostCommandInitialResult);
      } finally {
        // 스트리밍 창은 초기 대기까지다 — 리스너를 세션마다 남기면 링크
        // 수명 동안 누적된다.
        link.unsubscribeOutput(args.outputRef);
      }
    },

    async interact(args) {
      let link: CommandHostWorkerLink | undefined;
      try {
        link = await ensureLinkIfOwnerAlive(args.stateRoot);
      } catch {
        link = undefined;
      }
      if (link === undefined) {
        // 워커 부재 — 종료 세션의 디스크 직접 읽기 (§8.2).
        return await persistedReader.interact(args);
      }
      if (
        (args.page?.deferRelease === true ||
          args.page?.releaseUpToBytes !== undefined) &&
        !link.capabilities.deferredOutputRelease
      ) {
        return {
          ok: false,
          reasonCode: 'invalid_args',
          message:
            'command-host worker does not support deferred lossless output release.',
        };
      }
      // durable 호출자가 체크포인트의 operation을 주면 그대로 보존하고,
      // 일반 호출자가 생략한 부수효과에만 이 facade의 pair를 할당한다.
      // 관찰 요청은 두 번 처리돼도 같은 결과이므로 번호를 소모하지 않는다
      // (§4.7).
      const hasSideEffect =
        args.chars !== undefined ||
        args.closeStdin === true ||
        args.terminate === true;
      let operation = args.operation;
      if (hasSideEffect && operation === undefined) {
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
      const answered = await link.request(
        COMMAND_HOST_METHODS.interact,
        params,
        args.signal,
      );
      if (answered !== link.connectionLost) {
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
      let retryLink: CommandHostWorkerLink | undefined;
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
      const retried = await retryLink.request(
        COMMAND_HOST_METHODS.interact,
        { ...params, yieldTimeMs: 0 },
        args.signal,
      );
      return retried === retryLink.connectionLost
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
      const listed = await link.request(COMMAND_HOST_METHODS.list, {});
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
      let link: CommandHostWorkerLink | undefined;
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
      const listed = await link.request(COMMAND_HOST_METHODS.list, {});
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
          link.close('daemon disconnect');
        }
      }
      links.clear();
      return { ok: true };
    },
  };

  async function linkFor(
    stateRoot: string,
  ): Promise<CommandHostWorkerLink | undefined> {
    const pendingLink = links.get(stateRoot);
    if (pendingLink === undefined) {
      return undefined;
    }
    const link = await pendingLink.catch(() => undefined);
    return link !== undefined && !link.isClosed() ? link : undefined;
  }

  async function ensureLinkIfOwnerAlive(
    stateRoot: string,
  ): Promise<CommandHostWorkerLink | undefined> {
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
