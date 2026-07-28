import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID, randomUUID as randomSubscriptionId } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

import {
  buildHostCommandOutputRef,
  parseHostCommandOutputRef,
  removeHostCommandDirectory,
  SYSTEM_SESSION_OWNER,
  type HostCommandSnapshot,
  type HostCommandStatus,
} from '../daemon/host-command-output-store.js';
import {
  commitClaimMetadata,
  persistTerminalArtifacts,
  type DurabilityStageObserver,
} from './durability.js';
import type { SpawnJournal } from './journal.js';
import { readProcessBirthToken } from './process-identity.js';
import { spawnGatedChild } from './spawn-gate.js';
import type {
  CommandHostOperation,
  CommandSessionHost,
  CommandSessionOwnerKind,
  CommandSessionStreamMode,
  CommandSessionHostConfig,
  CommandSessionListEntry,
  CommandSessionSubscribeOutcome,
  CommandSessionSubscriptionEvent,
  HostCommandInitialResult,
  HostCommandOutputChunk,
  HostCommandRuntime,
} from './contract.js';
import { createSessionChildIo, detachSourceAbort } from './session-child-io.js';
import { createSessionInteraction } from './session-interaction.js';
import { boundaryPromise, waitForPromiseOrAbort } from './session-wait.js';
import {
  buildSnapshot,
  describeSession,
  metadataFromEntry,
  sessionPaths,
  terminalDescriptorFromEntry,
  terminalMetadataFromEntry,
} from './session-snapshot.js';
import { appendClosedRow, createJournalRegistry } from './session-journal.js';

// P7.5 spec v4 §4 — 메모리-우선 세션 코어. 인라인 모드(W1)에서는 데몬
// 인프로세스로, 워커 모드(W2+)에서는 command-host 프로세스 안에서 같은
// 코어가 돈다. 출력의 유일한 인메모리 저장소는 스트림당 tail 링이며,
// 디스크 접점은 claim 메타 1회 + terminal 산출물 1회뿐이다.

/** §4.4 세션 정원. §4.1 전체 메모리 예산이 이 값으로 링 예산을 곱한다. */
export const COMMAND_HOST_SESSION_CAPACITY = 64;
const SESSION_CAPACITY = COMMAND_HOST_SESSION_CAPACITY;
const PROTECTED_RECENT_SESSIONS = 8;
/** §4.1 스트림당 tail 링 기본 예산. */
export const DEFAULT_TAIL_RING_BYTES = 1024 * 1024;
/**
 * §4.6 대기의 상한 — 명령은 끝나지 않을 수 있어도 **턴은 반드시 끝나야
 * 한다**. 상한을 넘긴 대기는 세션을 claim해 outputRef로 돌려주므로 관측을
 * 잃지 않는다: 기다림을 끊을 뿐 프로세스를 죽이지 않는다.
 *
 * 값은 codex `unified_exec`의 `MAX_YIELD_TIME_MS`와 같다(§2 선례 — 정원 64·
 * 출력 1MiB도 같은 출처다). codex의 **하한**(250ms)은 채택하지 않는다:
 * `yieldTimeMs: 0`은 우리 계약에서 이미 "논블로킹 폴"이라는 뜻이다.
 */
const DEFAULT_MAX_YIELD_TIME_MS = 30_000;

type SessionPhase =
  | 'unclaimed_running'
  | 'claiming_running'
  | 'unclaimed_terminal'
  | 'claiming_terminal'
  | 'claimed_running'
  | 'finalizing'
  | 'finished'
  | 'discarding'
  | 'discarded';

export interface SessionTerminalState {
  status: Exclude<HostCommandStatus, 'running'>;
  exitCode: number | null;
  finishedAtMs: number;
  outputLimitExceeded: HostCommandSnapshot['outputLimitExceeded'];
  terminationReason?: string;
}

/**
 * 프로세스가 사라진 사실. `SessionTerminalState`와 구분해야 한다.
 *
 * Node의 `'exit'`은 프로세스 종료를, `'close'`는 stdio가 모두 닫힘을 뜻한다.
 * 명령이 자손을 백그라운드로 띄우면(`cmd & exit 0`) 자손이 같은 stdout을
 * 물고 있어 `'close'`가 오지 않는다 — 실측: `exit` 16ms, `close` 3017ms이며
 * 자손이 계속 살면 `close`는 오지 않는다. 종료를 `'close'`로만 확정하면 이미
 * 끝난 명령이 계속 `running`으로 보고되고, 모델은 끝난 명령을 계속 관찰한다.
 *
 * 반대로 `'exit'`에서 세션을 정착시키면 파이프에 남은 출력이 잘릴 수 있다.
 * 그래서 두 사실을 각각 남긴다: 여기서 프로세스 생존을, `terminal`에서 출력
 * 완결을 확정한다. 스냅샷의 `outputComplete`가 후자를 나른다.
 */
interface SessionProcessExit {
  status: Exclude<HostCommandStatus, 'running'>;
  exitCode: number | null;
  finishedAtMs: number;
}

/**
 * 출력 보존. 기본은 tail 모드 — 예산을 넘으면 앞을 버리고 `omittedBytes`로
 * 표기한다(§4.1). 사람과 모델이 읽는 출력에는 그것이 옳다.
 *
 * `protocol` 모드는 버리지 않는다 (P7.6 §5.2). 프로토콜 바이트 스트림은 한
 * 바이트만 사라져도 프레임이 깨지므로, 예산을 넘으면 **읽는 쪽이 따라올
 * 때까지 소스를 멈춘다**. 읽힌 만큼만 `releaseUpTo`로 놓아준다 — 그때의
 * `omittedBytes`는 "잃었다"가 아니라 "이미 건네줬다"는 뜻이다.
 */
class TailRing {
  private chunks: Buffer[] = [];
  private retained = 0;
  private dropped = 0;

  constructor(
    private readonly capacity: number,
    private readonly evictWhenFull = true,
  ) {}

  get retainedBytes(): number {
    return this.retained;
  }

  /** 소비자가 읽어간 지점까지 보관을 놓는다 (protocol 모드). */
  releaseUpTo(offset: number): void {
    while (this.chunks.length > 0 && this.dropped < offset) {
      const head = this.chunks[0];
      if (head === undefined) {
        return;
      }
      const releasable = Math.min(head.length, offset - this.dropped);
      if (releasable <= 0) {
        return;
      }
      if (releasable === head.length) {
        this.chunks.shift();
      } else {
        this.chunks[0] = head.subarray(releasable);
      }
      this.retained -= releasable;
      this.dropped += releasable;
    }
  }

  append(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.retained += chunk.length;
    if (!this.evictWhenFull) {
      return;
    }
    while (this.retained > this.capacity) {
      const head = this.chunks[0];
      if (head === undefined) {
        break;
      }
      const excess = this.retained - this.capacity;
      if (head.length <= excess) {
        this.chunks.shift();
        this.retained -= head.length;
        this.dropped += head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.retained -= excess;
        this.dropped += excess;
      }
    }
  }

  get omittedBytes(): number {
    return this.dropped;
  }

  get totalBytes(): number {
    return this.dropped + this.retained;
  }

  snapshot(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

interface SessionStream {
  ring: TailRing;
  decoder: StringDecoder;
  redactor: StreamingMarkerRedactor | undefined;
  chars: number;
}

/**
 * exact marker가 임의의 stdout/stderr chunk 경계에 걸쳐도 원문 조각을 한
 * 바이트도 내보내지 않는다. StringDecoder가 UTF-8 코드포인트 경계를
 * 복원하고, marker가 될 수 있는 suffix만 짧게 보류한다.
 */
class StreamingMarkerRedactor {
  private readonly decoder = new StringDecoder('utf8');
  private readonly markers: readonly string[];
  private readonly replacement: string;
  private readonly holdbackChars: number;
  private pending = '';

  constructor(args: { exactMarkers: readonly string[]; replacement: string }) {
    this.markers = [...new Set(args.exactMarkers)].filter(
      (marker) => marker.length > 0,
    );
    this.replacement = args.replacement;
    this.holdbackChars = Math.max(
      0,
      ...this.markers.map((marker) => marker.length - 1),
    );
  }

  write(chunk: Buffer): Buffer {
    this.pending += this.decoder.write(chunk);
    return this.drain(false);
  }

  end(): Buffer {
    this.pending += this.decoder.end();
    return this.drain(true);
  }

  private drain(terminal: boolean): Buffer {
    if (this.pending.length === 0) {
      return Buffer.alloc(0);
    }
    let drainLength = terminal
      ? this.pending.length
      : Math.max(0, this.pending.length - this.holdbackChars);
    if (!terminal) {
      let previousDrainLength: number;
      do {
        previousDrainLength = drainLength;
        for (const marker of this.markers) {
          const markerStart = this.pending.lastIndexOf(marker, drainLength - 1);
          if (markerStart >= 0 && markerStart + marker.length > drainLength) {
            drainLength = markerStart;
          }
        }
      } while (drainLength < previousDrainLength);
    }
    if (drainLength === 0) {
      return Buffer.alloc(0);
    }
    const raw = this.pending.slice(0, drainLength);
    this.pending = this.pending.slice(drainLength);
    return Buffer.from(
      redactExactMarkers(raw, this.markers, this.replacement),
      'utf8',
    );
  }
}

/** 열거에 실을 명령 라벨의 상한 — 목록은 요약이지 기록이 아니다. */
const COMMAND_LABEL_MAX_CHARS = 200;

export interface SessionEntry {
  phase: SessionPhase;
  /** P7.6 §5.1 — 스레드의 것인가, 데몬 자신의 것인가. */
  owner: CommandSessionOwnerKind;
  /** P7.6 §5.2 — 사람이 읽는 출력인가, 잃으면 안 되는 프로토콜 바이트인가. */
  streamMode: CommandSessionStreamMode;
  outputRef: string;
  sessionId: string;
  command: string;
  stateRoot: string;
  threadId: string;
  runId: string;
  callId: string;
  child: ChildProcessWithoutNullStreams;
  stdinOpen: boolean;
  stdout: SessionStream;
  stderr: SessionStream;
  startedAtMs: number;
  firstOutputAfterMs: number | null;
  revision: number;
  terminal: SessionTerminalState | null;
  /** 프로세스는 사라졌지만 출력 스트림은 아직 열려 있을 수 있다. */
  processExit: SessionProcessExit | null;
  terminalOverride: SessionTerminalState | null;
  outputWaiters: Set<() => void>;
  exit: Promise<void>;
  resolveExit: () => void;
  timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  graceTimer: ReturnType<typeof setTimeout> | undefined;
  sourceSignal: AbortSignal | undefined;
  sourceAbortListener: (() => void) | undefined;
  maxOutputBytesPerStream: number | undefined;
  onOutput: ((chunk: HostCommandOutputChunk) => void) | undefined;
  subscribers: Map<string, (event: CommandSessionSubscriptionEvent) => void>;
  lastTouched: number;
  /** §4.7 — 이 세션에 마지막으로 적용된 부수효과 연산. */
  lastOperation: CommandHostOperation | null;
  claimPromise: Promise<HostCommandInitialResult> | undefined;
  finalizePromise: Promise<void> | undefined;
  outputPersistFailed: boolean;
  terminalMetaDirty: boolean;
  journal: SpawnJournal;
  journalClosed: boolean;
}

export function createCommandSessionHost(
  config: CommandSessionHostConfig,
): CommandSessionHost {
  if (
    !Number.isSafeInteger(config.inlineMaxBytes) ||
    config.inlineMaxBytes <= 0
  ) {
    throw new Error('command host inlineMaxBytes must be a positive integer');
  }
  const tailRingBytes = config.tailRingBytes ?? DEFAULT_TAIL_RING_BYTES;
  if (!Number.isSafeInteger(tailRingBytes) || tailRingBytes <= 0) {
    throw new Error('command host tailRingBytes must be a positive integer');
  }
  const maxYieldTimeMs = config.maxYieldTimeMs ?? DEFAULT_MAX_YIELD_TIME_MS;
  if (!Number.isSafeInteger(maxYieldTimeMs) || maxYieldTimeMs <= 0) {
    throw new Error('command host maxYieldTimeMs must be a positive integer');
  }

  /** 미지정은 "무한"이 아니라 "상한만큼"이다 (§4.6). */
  function resolveYieldTimeMs(requested: number | undefined): number {
    return Math.min(requested ?? maxYieldTimeMs, maxYieldTimeMs);
  }

  const resident = new Map<string, SessionEntry>();
  let reservedSlots = 0;
  let admissionChain: Promise<unknown> = Promise.resolve();
  let pendingAdmissions = 0;
  let touchTick = 0;
  let closed = false;
  const settledListeners = new Set<() => void>();

  const journalRegistry = createJournalRegistry();

  /**
   * 세션 하나의 자식 프로세스 입출력은 별도 소유자에게 있다. 그 소유자는
   * 여기 있는 레지스트리(`resident`)와 정착 상태(`closed`)를 보지 않고
   * `SessionEntry` 안에서만 움직이므로, 레지스트리를 건드리는 유일한 지점인
   * `finalizeTerminal`만 넘긴다.
   */
  const {
    applyStreamBackpressure,
    attachChildProcess,
    forceTermination,
    requestGracefulTermination,
  } = createSessionChildIo({
    finalizeTerminal,
    tailRingBytes,
  });

  /**
   * `interact` 요청 본문도 별도 소유자에게 있다. 넘기는 것은 이 호스트의
   * 정책(인라인 예산 · yield 상한 · 인라인 적격 판정)과 자식 입출력 경로뿐이며,
   * 레지스트리는 넘기지 않는다.
   */
  const { interactWithPersisted, interactWithResident } =
    createSessionInteraction({
      applyStreamBackpressure,
      inlineEligible,
      inlineMaxBytes: config.inlineMaxBytes,
      requestGracefulTermination,
      resolveYieldTimeMs,
    });

  function emitSettled(): void {
    for (const listener of [...settledListeners]) {
      listener();
    }
  }

  const TRANSITIONAL_PHASES: ReadonlySet<SessionPhase> = new Set([
    'claiming_running',
    'claiming_terminal',
    'finalizing',
    'discarding',
  ]);

  function touch(entry: SessionEntry): void {
    touchTick += 1;
    entry.lastTouched = touchTick;
  }

  function inlineEligible(entry: SessionEntry): boolean {
    return (
      entry.streamMode !== 'protocol' &&
      entry.stdout.ring.totalBytes + entry.stderr.ring.totalBytes <=
        config.inlineMaxBytes &&
      entry.stdout.ring.omittedBytes === 0 &&
      entry.stderr.ring.omittedBytes === 0
    );
  }

  /** 시스템 세션은 슬롯을 잡지 않았으므로 돌려줄 것도 없다 (P7.6 §5.3). */
  function releaseReservedSlot(owner: CommandSessionOwnerKind): void {
    if (owner !== 'system') {
      reservedSlots -= 1;
    }
  }

  /** 정원과 퇴거의 대상은 스레드 세션뿐이다 (P7.6 §5.3). */
  function threadSessions(): SessionEntry[] {
    return [...resident.values()].filter((entry) => entry.owner === 'thread');
  }

  // §4.4 하드 admission: resident + reserved ≤ 64. FIFO는 체인 직렬화로,
  // 대기 해제는 victim의 완전 종료 이벤트(아래 await)로 성립한다.
  function acquireSlot(): Promise<
    { ok: true } | { ok: false; reasonCode: 'session_capacity_exhausted' }
  > {
    pendingAdmissions += 1;
    const attempt = admissionChain.then(async () => {
      for (;;) {
        const ordered = threadSessions().sort(
          (a, b) => a.lastTouched - b.lastTouched,
        );
        if (ordered.length + reservedSlots < SESSION_CAPACITY) {
          reservedSlots += 1;
          return { ok: true } as const;
        }
        const protectedSet = new Set(ordered.slice(-PROTECTED_RECENT_SESSIONS));
        const cacheVictim = ordered.find(
          (candidate) =>
            !protectedSet.has(candidate) && candidate.phase === 'finished',
        );
        if (cacheVictim !== undefined) {
          resident.delete(cacheVictim.outputRef);
          continue;
        }
        const liveVictim = ordered.find(
          (candidate) =>
            !protectedSet.has(candidate) &&
            candidate.phase === 'claimed_running',
        );
        if (liveVictim !== undefined) {
          requestGracefulTermination(liveVictim, {
            status: 'signal',
            exitCode: null,
            finishedAtMs: Date.now(),
            outputLimitExceeded: null,
            terminationReason: 'lru_evicted',
          });
          await liveVictim.exit;
          await liveVictim.finalizePromise;
          resident.delete(liveVictim.outputRef);
          continue;
        }
        return {
          ok: false,
          reasonCode: 'session_capacity_exhausted',
        } as const;
      }
    });
    admissionChain = attempt
      .catch(() => undefined)
      .finally(() => {
        pendingAdmissions -= 1;
      });
    return attempt;
  }

  let idempotentStartChain = Promise.resolve();

  const runtime: CommandSessionHost = {
    async start(args) {
      if (args.requiresIdempotentStart === true) {
        const attempt = idempotentStartChain.then(async () => {
          const owner: CommandSessionOwnerKind = args.owner ?? 'thread';
          const ownerId =
            owner === 'system' ? SYSTEM_SESSION_OWNER : args.threadId;
          const existing = [...resident.values()].find(
            (entry) =>
              entry.stateRoot === args.stateRoot &&
              entry.owner === owner &&
              entry.threadId === ownerId &&
              entry.runId === args.runId &&
              entry.callId === args.callId,
          );
          if (existing !== undefined) {
            if (
              existing.command !==
              describeCommand(args.executable, args.args, args.outputRedaction)
            ) {
              return {
                ok: false,
                reasonCode: 'spawn_failed',
                message:
                  'idempotent command-host start identity conflicts with the existing command',
              } as const;
            }
            return { ok: true, outputRef: existing.outputRef } as const;
          }
          const freshArgs = { ...args };
          delete freshArgs.requiresIdempotentStart;
          return await runtime.start(freshArgs);
        });
        idempotentStartChain = attempt.then(
          () => undefined,
          () => undefined,
        );
        return await attempt;
      }
      if (closed) {
        return {
          ok: false,
          reasonCode: 'runtime_closed',
          message: 'host command runtime is closed.',
        };
      }
      let journal: SpawnJournal;
      try {
        journal = await journalRegistry.journalFor(args.stateRoot);
      } catch (error: unknown) {
        // 저널 없이 자식을 만들 수 없다 (§5.1) — 게이트 fail-closed.
        return {
          ok: false,
          reasonCode: 'output_store_failed',
          message: getErrorMessage(error),
        };
      }
      // P7.6 §5.1·§5.3 — 시스템 세션은 데몬 자신의 것이다. 정원 64는
      // exec_command에게 준 보장이므로 시스템 세션이 그것을 소비하지 않는다.
      const owner: CommandSessionOwnerKind = args.owner ?? 'thread';
      const streamMode: CommandSessionStreamMode = args.streamMode ?? 'tail';
      const ownerId = owner === 'system' ? SYSTEM_SESSION_OWNER : args.threadId;
      const slot =
        owner === 'system' ? ({ ok: true } as const) : await acquireSlot();
      if (!slot.ok) {
        return {
          ok: false,
          reasonCode: slot.reasonCode,
          message:
            'host command session capacity is exhausted by unclaimed live sessions.',
        };
      }
      if (closed) {
        // closeAll과의 경합 — 슬롯 대기 중 런타임이 닫혔다면 새 세션을
        // 만들지 않는다.
        releaseReservedSlot(owner);
        return {
          ok: false,
          reasonCode: 'runtime_closed',
          message: 'host command runtime is closed.',
        };
      }

      // §5.1 — 자식은 fd3 GO 전까지 exec하지 않는다. 게이트가 열려 있는
      // 동안에는 출력도 종료도 발생할 수 없다.
      let gated: ReturnType<typeof spawnGatedChild>;
      try {
        gated = spawnGatedChild({
          executable: args.executable,
          args: args.args,
          cwd: args.cwd,
          env: args.env,
        });
      } catch (error: unknown) {
        releaseReservedSlot(owner);
        return {
          ok: false,
          reasonCode: 'spawn_failed',
          message: getErrorMessage(error),
        };
      }
      const child = gated.child;

      const sessionId = randomUUID();
      const outputRef = buildHostCommandOutputRef({
        threadId: ownerId,
        sessionId,
      });
      let resolveExit: () => void = () => undefined;
      const exit = new Promise<void>((resolve) => {
        resolveExit = resolve;
      });
      const entry: SessionEntry = {
        phase: 'unclaimed_running',
        outputRef,
        sessionId,
        command: describeCommand(
          args.executable,
          args.args,
          args.outputRedaction,
        ),
        stateRoot: args.stateRoot,
        owner,
        streamMode,
        threadId: ownerId,
        runId: args.runId,
        callId: args.callId,
        child,
        stdinOpen: args.stdinMode === 'open',
        stdout: {
          ring: new TailRing(tailRingBytes, streamMode === 'tail'),
          decoder: new StringDecoder('utf8'),
          redactor: createStreamingMarkerRedactor(args.outputRedaction),
          chars: 0,
        },
        stderr: {
          // protocol의 stderr는 진단 tail이지만, lossless는 양 스트림 모두
          // 제품 결과이므로 stdout과 같은 보존/역압 규범을 쓴다.
          ring: new TailRing(tailRingBytes, streamMode !== 'lossless'),
          decoder: new StringDecoder('utf8'),
          redactor: createStreamingMarkerRedactor(args.outputRedaction),
          chars: 0,
        },
        startedAtMs: Date.now(),
        firstOutputAfterMs: null,
        revision: 0,
        terminal: null,
        processExit: null,
        terminalOverride: null,
        outputWaiters: new Set(),
        exit,
        resolveExit,
        timeoutTimer: undefined,
        graceTimer: undefined,
        sourceSignal: args.signal,
        sourceAbortListener: undefined,
        maxOutputBytesPerStream: args.maxOutputBytesPerStream,
        onOutput: args.onOutput,
        subscribers: new Map(),
        lastTouched: 0,
        lastOperation: null,
        claimPromise: undefined,
        finalizePromise: undefined,
        outputPersistFailed: false,
        terminalMetaDirty: false,
        journal,
        journalClosed: false,
      };
      resident.set(outputRef, entry);
      releaseReservedSlot(owner);
      touch(entry);
      attachChildProcess(entry);

      // 게이트가 닫혀 있는 동안 open 행을 내구화한다. fdatasync가 성공한
      // 뒤에만 GO를 쓰므로 "journal에 없는 자식"은 존재할 수 없다 (§5.1).
      try {
        const pid = child.pid ?? 0;
        await journal.appendOpen({
          sessionId,
          outputRef,
          threadId: ownerId,
          pid,
          pgid: pid,
          birthToken: await readProcessBirthToken(pid),
          gated: gated.gated,
        });
      } catch (error: unknown) {
        gated.abort();
        entry.journalClosed = true; // open 행이 없으므로 closed 행도 없다.
        await discard(entry);
        return {
          ok: false,
          reasonCode: 'output_store_failed',
          message: getErrorMessage(error),
        };
      }
      const initialStdin = args.initialStdin;
      const initialStdinWrite =
        initialStdin === undefined
          ? undefined
          : new Promise<void>((resolve, reject) => {
              entry.child.stdin.write(initialStdin, (error) => {
                if (error) {
                  reject(error);
                } else {
                  resolve();
                }
              });
            });
      gated.release();
      if (initialStdinWrite !== undefined) {
        try {
          await initialStdinWrite;
        } catch (error: unknown) {
          entry.stdinOpen = false;
          await discard(entry);
          return {
            ok: false,
            reasonCode: 'spawn_failed',
            message: getErrorMessage(error),
          };
        }
      }

      if (args.timeoutMs !== undefined) {
        entry.timeoutTimer = setTimeout(() => {
          forceTermination(entry, {
            status: 'timeout',
            exitCode: null,
            finishedAtMs: Date.now(),
            outputLimitExceeded: null,
            terminationReason: 'caller_timeout',
          });
        }, args.timeoutMs);
        entry.timeoutTimer.unref?.();
      }

      if (args.signal !== undefined) {
        const onAbort = () => {
          forceTermination(entry, {
            status: 'cancelled',
            exitCode: null,
            finishedAtMs: Date.now(),
            outputLimitExceeded: null,
            terminationReason: 'owner_abort',
          });
        };
        entry.sourceAbortListener = onAbort;
        args.signal.addEventListener('abort', onAbort, { once: true });
        if (args.signal.aborted) {
          onAbort();
        }
      }

      if (args.stdinMode === 'closed') {
        entry.child.stdin.end();
      }
      if (closed) {
        // closeAll의 스냅샷 이후에 등록된 세션은 스스로 종료 절차를
        // 밟는다 — 관리 밖 세션을 남기지 않는다.
        requestGracefulTermination(entry, {
          status: 'daemon_shutdown',
          exitCode: null,
          finishedAtMs: Date.now(),
          outputLimitExceeded: null,
          terminationReason: 'command_host_shutdown',
        });
      }

      return { ok: true, outputRef };
    },

    async waitForInitialResult(args) {
      const entry = resident.get(args.outputRef);
      if (entry === undefined) {
        return {
          ok: false,
          reasonCode: 'not_found',
          message: 'host command process was not found.',
        };
      }
      touch(entry);
      if (entry.claimPromise !== undefined) {
        // 멱등 재시도/동시 waiter — 단일 transition promise 합류.
        // 비소유 waiter의 취소는 해당 RPC만 끝내고 세션에 영향을 주지
        // 않는다 (§4.2.1).
        return await joinClaim(entry.claimPromise, args.signal);
      }

      const waitResult = await waitForPromiseOrAbort(
        boundaryPromise(entry, resolveYieldTimeMs(args.yieldTimeMs)),
        args.signal,
      );
      if (!waitResult.ok) {
        if (
          entry.phase === 'unclaimed_running' ||
          entry.phase === 'unclaimed_terminal'
        ) {
          // authoritative cancel — exec_command의 초기 대기 취소는 명령
          // 폐기다 (§4.2.1).
          await discard(entry);
        }
        return waitResult;
      }
      if (entry.claimPromise !== undefined) {
        return await joinClaim(entry.claimPromise, args.signal);
      }
      if (args.signal?.aborted === true) {
        // boundary 해소 직후·claim 개시 전 도착한 authoritative 취소 —
        // 커밋 전이므로 결정론적으로 discard한다 (§4.2.1).
        await discard(entry);
        return {
          ok: false,
          reasonCode: 'wait_aborted',
          message: 'host command wait was aborted.',
        };
      }

      if (entry.terminal === null) {
        entry.claimPromise = claimRunning(entry, args.signal);
        return await entry.claimPromise;
      }
      if (entry.phase === 'unclaimed_terminal' && inlineEligible(entry)) {
        // inline_released — 디스크 0회, 즉시 resident 제거 (§4.2).
        const snapshot = buildSnapshot(entry, inlineEligible, {
          includeInline: true,
          outputRef: null,
        });
        resident.delete(entry.outputRef);
        // 디스크에 남는 산출물이 없으므로 저널상으로도 discarded다 — reap이
        // 이 세션의 open 엔트리를 붙들지 않게 한다.
        await appendClosedRow(entry, 'discarded');
        emitSettled();
        return { ok: true, value: snapshot };
      }
      entry.claimPromise = claimTerminal(entry, args.signal);
      return await entry.claimPromise;
    },

    async interact(args) {
      const parsedRef = parseHostCommandOutputRef(args.outputRef);
      if (!parsedRef.ok) {
        return parsedRef;
      }
      // P7.6 §5.1 — 시스템 세션의 소유자는 스레드가 아니라 데몬 자신이다.
      // 그러므로 스레드가 시스템 ref를 들고 와도, 데몬이 스레드 ref를 시스템
      // 자격으로 열어도 둘 다 거절이다.
      const callerOwnerId =
        (args.owner ?? 'thread') === 'system'
          ? SYSTEM_SESSION_OWNER
          : args.threadId;
      if (parsedRef.threadId !== callerOwnerId) {
        return {
          ok: false,
          reasonCode: 'access_denied',
          message: 'host command output does not belong to this thread.',
        };
      }

      const entry = resident.get(args.outputRef);
      if (entry !== undefined) {
        if (
          entry.stateRoot !== args.stateRoot ||
          entry.threadId !== callerOwnerId
        ) {
          return {
            ok: false,
            reasonCode: 'access_denied',
            message: 'host command output does not belong to this run context.',
          };
        }
        touch(entry);
        return await interactWithResident(entry, args);
      }

      if (
        args.chars !== undefined ||
        args.closeStdin === true ||
        args.terminate === true
      ) {
        return {
          ok: false,
          reasonCode: 'not_running',
          message: 'host command process is no longer running.',
        };
      }
      return await interactWithPersisted(args);
    },

    async closeAll(args) {
      closed = true;
      const entries = [...resident.values()];
      for (const entry of entries) {
        detachSourceAbort(entry);
        if (entry.terminal === null && entry.phase !== 'discarding') {
          requestGracefulTermination(entry, {
            status: 'daemon_shutdown',
            exitCode: null,
            finishedAtMs: Date.now(),
            outputLimitExceeded: null,
            terminationReason: 'command_host_shutdown',
          });
        }
      }
      const waited = await waitForPromiseOrAbort(
        Promise.all(
          entries.map(async (entry) => {
            await entry.exit;
            await entry.finalizePromise;
          }),
        ).then(() => undefined),
        args?.signal,
      );
      if (!waited.ok) {
        return {
          ok: false,
          reasonCode: 'cleanup_aborted',
          message: waited.message,
        };
      }
      await journalRegistry.closeAll();
      const failed = entries.find(
        (entry) => entry.outputPersistFailed || entry.terminalMetaDirty,
      );
      if (failed !== undefined) {
        return {
          ok: false,
          reasonCode: 'output_store_failed',
          message: 'host command terminal output could not be fully persisted.',
        };
      }
      return { ok: true };
    },

    subscribe(args): CommandSessionSubscribeOutcome {
      const parsedRef = parseHostCommandOutputRef(args.outputRef);
      if (!parsedRef.ok || parsedRef.threadId !== args.threadId) {
        return {
          ok: false,
          reasonCode: 'access_denied',
          message: 'host command output does not belong to this thread.',
        };
      }
      const entry = resident.get(args.outputRef);
      if (entry === undefined) {
        return {
          ok: false,
          reasonCode: 'not_found',
          message: 'host command session is not resident.',
        };
      }
      if (entry.stateRoot !== args.stateRoot) {
        return {
          ok: false,
          reasonCode: 'access_denied',
          message: 'host command output does not belong to this run context.',
        };
      }
      // §7.3 barrier: 등록과 스냅샷은 같은 동기 tick에서 일어난다 —
      // 여기서 await하지 않으므로 이후 output만 subscriber에 전달되고,
      // barrier 이전 데이터는 아래 offset에 정확히 반영된다.
      const subscriptionId = randomSubscriptionId();
      const stdoutOffset =
        args.stdoutAfterOffset ?? entry.stdout.ring.omittedBytes;
      const stderrOffset =
        args.stderrAfterOffset ?? entry.stderr.ring.omittedBytes;
      const resyncRequired =
        stdoutOffset < entry.stdout.ring.omittedBytes ||
        stderrOffset < entry.stderr.ring.omittedBytes;
      entry.subscribers.set(subscriptionId, (event) => {
        args.onEvent(event);
      });
      touch(entry);
      return {
        ok: true,
        subscriptionId,
        barrierRevision: entry.revision,
        stdout: {
          earliestAvailableOffset: entry.stdout.ring.omittedBytes,
          barrierOffset: entry.stdout.ring.totalBytes,
        },
        stderr: {
          earliestAvailableOffset: entry.stderr.ring.omittedBytes,
          barrierOffset: entry.stderr.ring.totalBytes,
        },
        resyncRequired,
        unsubscribe() {
          entry.subscribers.delete(subscriptionId);
        },
      };
    },

    listSessions(): CommandSessionListEntry[] {
      return [...resident.values()].map(describeSession);
    },

    /**
     * P7.6 §7.1 — 시스템 세션의 고정은 **데몬 연결이 들고 있는 것**이다.
     * 연결이 끊기고 재입양 창이 지나도록 아무도 돌아오지 않으면, 그 세션을
     * 붙들 이유가 사라진다. 회수하지 않으면 §6.3 종료 게이트가 영원히
     * quiescent가 되지 않아 워커도 서버도 무기한 남는다.
     */
    reclaimSystemSessions(outputRefs) {
      for (const entry of resident.values()) {
        if (
          entry.owner !== 'system' ||
          entry.terminal !== null ||
          !outputRefs.has(entry.outputRef)
        ) {
          continue;
        }
        requestGracefulTermination(entry, {
          status: 'signal',
          exitCode: null,
          finishedAtMs: Date.now(),
          outputLimitExceeded: null,
          terminationReason: 'system_session_unclaimed',
        });
      }
    },

    async listThreadSessions(args) {
      return threadSessions()
        .filter(
          (entry) =>
            entry.stateRoot === args.stateRoot &&
            entry.threadId === args.threadId,
        )
        .map(describeSession);
    },

    effectiveConfig: {
      inlineMaxBytes: config.inlineMaxBytes,
      tailRingBytes,
    },

    isQuiescent(): boolean {
      if (reservedSlots > 0 || pendingAdmissions > 0) {
        return false;
      }
      if (journalRegistry.hasPendingCriticalIo()) {
        return false;
      }
      for (const entry of resident.values()) {
        if (entry.terminal === null || TRANSITIONAL_PHASES.has(entry.phase)) {
          return false;
        }
      }
      return true;
    },

    onSettled(listener: () => void): () => void {
      settledListeners.add(listener);
      return () => {
        settledListeners.delete(listener);
      };
    },

    async releaseUnclaimed(outputRef: string): Promise<void> {
      const entry = resident.get(outputRef);
      if (entry === undefined) {
        return;
      }
      if (
        entry.phase !== 'unclaimed_running' &&
        entry.phase !== 'unclaimed_terminal'
      ) {
        return;
      }
      await discard(entry);
    },
  };

  return runtime;

  /**
   * §4.2.1 커밋 cutoff — 커밋점(부모 dir fsync) **전에** 도착한 소유
   * waiter의 취소는 결정론적 discard이고, 그 뒤에 도착한 취소는 커밋된
   * 결과를 그대로 돌려준다. 어느 쪽인지는 "어느 사건이 먼저 일어났나"로만
   * 판정할 수 있으므로, 취소 시각과 커밋 시각을 각각 붙잡아 비교한다.
   */
  function watchClaimCutoff(signal: AbortSignal | undefined): {
    observe: DurabilityStageObserver;
    cancelledBeforeCommit(): boolean;
    detach(): void;
  } {
    let passedCommit = false;
    let cancelledEarly = signal?.aborted === true;
    const onAbort = () => {
      if (!passedCommit) {
        cancelledEarly = true;
      }
    };
    signal?.addEventListener('abort', onAbort);
    return {
      // 커밋점은 부모 디렉터리 fsync가 끝난 순간이다 — `claim.committed`
      // 단계가 곧 그 시각이므로, 관찰자에게 제어를 넘기기 **전에** 표시한다.
      // commitClaimMetadata가 반환한 뒤에 찍으면 그 사이에 도착한 취소를
      // 커밋 전으로 잘못 판정한다.
      async observe(stage) {
        if (stage === 'claim.committed') {
          passedCommit = true;
        }
        await config.onDurabilityStage?.(stage);
      },
      cancelledBeforeCommit() {
        return cancelledEarly;
      },
      detach() {
        signal?.removeEventListener('abort', onAbort);
      },
    };
  }

  async function claimRunning(
    entry: SessionEntry,
    signal?: AbortSignal,
  ): Promise<HostCommandInitialResult> {
    entry.phase = 'claiming_running';
    const cutoff = watchClaimCutoff(signal);
    try {
      await commitClaimMetadata({
        paths: sessionPaths(entry),
        metadata: metadataFromEntry(entry),
        observe: cutoff.observe,
      });
    } catch (error: unknown) {
      cutoff.detach();
      await discard(entry);
      return {
        ok: false,
        reasonCode: 'output_store_failed',
        message: getErrorMessage(error),
      };
    }
    cutoff.detach();
    if (cutoff.cancelledBeforeCommit()) {
      await discard(entry);
      return {
        ok: false,
        reasonCode: 'wait_aborted',
        message: 'host command wait was aborted.',
      };
    }
    detachSourceAbort(entry);
    if (entry.terminal !== null) {
      // claim 중 terminal 승격분 — 커밋 후 finalizing으로 직행.
      entry.phase = 'finalizing';
      entry.finalizePromise = finalizeTerminal(entry);
      await entry.finalizePromise;
      return {
        ok: true,
        value: buildSnapshot(entry, inlineEligible, {
          includeInline: false,
          outputRef: entry.outputRef,
        }),
      };
    }
    entry.phase = 'claimed_running';
    return {
      ok: true,
      value: buildSnapshot(entry, inlineEligible, {
        includeInline: true,
        outputRef: entry.outputRef,
      }),
    };
  }

  async function claimTerminal(
    entry: SessionEntry,
    signal?: AbortSignal,
  ): Promise<HostCommandInitialResult> {
    entry.phase = 'claiming_terminal';
    const cutoff = watchClaimCutoff(signal);
    try {
      await commitClaimMetadata({
        paths: sessionPaths(entry),
        metadata: metadataFromEntry(entry),
        observe: cutoff.observe,
      });
    } catch (error: unknown) {
      cutoff.detach();
      entry.phase = 'discarded';
      resident.delete(entry.outputRef);
      await removeHostCommandDirectory(sessionPaths(entry).directory);
      await appendClosedRow(entry, 'discarded');
      return {
        ok: false,
        reasonCode: 'output_store_failed',
        message: getErrorMessage(error),
      };
    }
    cutoff.detach();
    if (cutoff.cancelledBeforeCommit()) {
      entry.phase = 'discarded';
      resident.delete(entry.outputRef);
      await removeHostCommandDirectory(sessionPaths(entry).directory);
      await appendClosedRow(entry, 'discarded');
      emitSettled();
      return {
        ok: false,
        reasonCode: 'wait_aborted',
        message: 'host command wait was aborted.',
      };
    }
    entry.phase = 'finalizing';
    entry.finalizePromise = finalizeTerminal(entry);
    await entry.finalizePromise;
    return {
      ok: true,
      value: buildSnapshot(entry, inlineEligible, {
        includeInline: false,
        outputRef: entry.outputRef,
      }),
    };
  }

  async function finalizeTerminal(entry: SessionEntry): Promise<void> {
    const outcome = await persistTerminalArtifacts({
      paths: sessionPaths(entry),
      stdoutTail: entry.stdout.ring.snapshot(),
      stderrTail: entry.stderr.ring.snapshot(),
      metadata: terminalMetadataFromEntry(entry),
      ...(config.onDurabilityStage === undefined
        ? {}
        : { observe: config.onDurabilityStage }),
    });
    entry.outputPersistFailed = !outcome.artifactOk;
    entry.terminalMetaDirty = !outcome.metadataOk;
    // §5.1 — closed 행이 terminal 진실의 원천이다. metadata 기록이 실패한
    // 경우 재시작 승격(§5.3 3행)의 유일한 근거이므로 내구화 뒤에 쓴다.
    await appendClosedRow(
      entry,
      'finished',
      terminalDescriptorFromEntry(entry),
    );
    entry.phase = 'finished';
    if (
      entry.owner === 'system' &&
      !entry.outputPersistFailed &&
      !entry.terminalMetaDirty
    ) {
      // system 세션은 후속 stdin/재접속 대상이 아니다. terminal truth가
      // 내구화됐으면 resident ring을 계속 붙들지 않고, 이후 페이지 조회는
      // 동일 outputRef의 persisted 경로가 담당한다.
      resident.delete(entry.outputRef);
    }
    emitSettled();
  }

  async function discard(entry: SessionEntry): Promise<void> {
    if (entry.terminal === null) {
      entry.phase = 'discarding';
      forceTermination(entry, {
        status: 'cancelled',
        exitCode: null,
        finishedAtMs: Date.now(),
        outputLimitExceeded: null,
        terminationReason: 'owner_abort',
      });
      await entry.exit;
    }
    entry.phase = 'discarded';
    resident.delete(entry.outputRef);
    await removeHostCommandDirectory(sessionPaths(entry).directory);
    await appendClosedRow(entry, 'discarded');
    emitSettled();
  }
}

async function joinClaim(
  claim: Promise<HostCommandInitialResult>,
  signal: AbortSignal | undefined,
): Promise<HostCommandInitialResult> {
  if (signal === undefined) {
    return await claim;
  }
  if (signal.aborted) {
    return {
      ok: false,
      reasonCode: 'wait_aborted',
      message: 'host command wait was aborted.',
    };
  }
  return await new Promise((resolve) => {
    const onAbort = () => {
      resolve({
        ok: false,
        reasonCode: 'wait_aborted',
        message: 'host command wait was aborted.',
      });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void claim.then((result) => {
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    });
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'host command failed';
}

/** 실행 파일 + 인자를 목록용 한 줄로 줄인다. */
function createStreamingMarkerRedactor(
  redaction:
    | Parameters<HostCommandRuntime['start']>[0]['outputRedaction']
    | undefined,
): StreamingMarkerRedactor | undefined {
  if (
    redaction === undefined ||
    redaction.exactMarkers.every((marker) => marker.length === 0)
  ) {
    return undefined;
  }
  return new StreamingMarkerRedactor(redaction);
}

function redactExactMarkers(
  value: string,
  markers: readonly string[],
  replacement: string,
): string {
  let redacted = value;
  for (const marker of markers) {
    if (marker.length > 0) {
      redacted = redacted.replaceAll(marker, replacement);
    }
  }
  return redacted;
}

function describeCommand(
  executable: string,
  args: readonly string[],
  outputRedaction:
    | Parameters<HostCommandRuntime['start']>[0]['outputRedaction']
    | undefined,
): string {
  const joined = redactExactMarkers(
    [executable, ...args].join(' '),
    outputRedaction?.exactMarkers ?? [],
    outputRedaction?.replacement ?? '',
  );
  return joined.length <= COMMAND_LABEL_MAX_CHARS
    ? joined
    : `${joined.slice(0, COMMAND_LABEL_MAX_CHARS - 1)}…`;
}
