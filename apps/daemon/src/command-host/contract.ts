import type {
  DurabilityFailureObserver,
  DurabilityStageObserver,
} from './durability.js';
import type {
  HostCommandOutputPage,
  HostCommandOutputStream,
  HostCommandSnapshot,
} from '../daemon/host-command-output-store.js';

// P7.5 command-host public contract (spec v4 §7.3·§9.2). W1은 인라인
// 모드에서 이 계약을 세션 코어가 직접 구현하고, W2에서 같은 계약이
// JSON-RPC 파사드 뒤로 이동한다. 도구(exec_command/write_stdin)는 이
// 계약만 본다.

export interface HostCommandOutputChunk {
  stream: HostCommandOutputStream;
  text: string;
}

export type HostCommandStartResult =
  | { ok: true; outputRef: string }
  | {
      ok: false;
      reasonCode:
        | 'runtime_closed'
        | 'spawn_failed'
        | 'output_store_failed'
        | 'session_capacity_exhausted';
      message: string;
    };

export type HostCommandInitialResult =
  | { ok: true; value: HostCommandSnapshot }
  | {
      ok: false;
      reasonCode: 'not_found' | 'output_store_failed' | 'wait_aborted';
      message: string;
    };

export type HostCommandInteractionResult =
  | {
      ok: true;
      value: {
        snapshot: HostCommandSnapshot;
        page: HostCommandOutputPage | null;
      };
    }
  | {
      ok: false;
      reasonCode:
        | 'access_denied'
        | 'invalid_args'
        | 'not_found'
        | 'not_running'
        // §7.5 maxStdinBufferedBytesPerSession — 자식이 읽지 않아 버퍼가
        // 찼다. 세션은 살아 있으므로 호출자는 나중에 다시 보낼 수 있다.
        | 'stdin_backpressure'
        // §4.7 — 이 세션에 더 나중 연산이 이미 적용됐다. 뒤늦게 도착한
        // 재시도는 순서를 되돌릴 수 없으므로 조용히 삼키지 않고 되돌린다.
        | 'operation_superseded'
        | 'output_store_failed'
        | 'wait_aborted';
      message: string;
    };

/**
 * spec v4 §4.7 — 부수효과 있는 interact의 재시도 식별자.
 *
 * 연결이 끊겨 응답만 유실되면 호출자는 "썼는지"를 알 수 없다. 파사드가 같은
 * 식별자로 한 번 재전송하면 세션 소유자가 중복을 판정한다.
 *
 * 적용된 연산 **집합**을 기억하면 보존 상한이라는 새 정책 숫자가 필요해지므로
 * 순서로 판정한다: `clientId`는 파사드 인스턴스, `seq`는 그 파사드가 세션마다
 * 매기는 단조 증가 번호다. 세션은 마지막 한 쌍만 들고 있으면 된다.
 */
export interface CommandHostOperation {
  clientId: string;
  seq: number;
}

/**
 * 세션의 소유자 (P7.6 §5.1·§5.3).
 *
 * `thread`는 모델이 만든 명령 세션이다 — 정원 64를 쓰고, LRU 퇴거 대상이며,
 * 그 스레드만 접근할 수 있다.
 *
 * `system`은 데몬 자신이 세운 세션(MCP 서버 등)이다. **정원 64를 쓰지 않고**
 * (그 64는 exec_command에게 준 보장이므로 잠식하면 계약 위반이다), 퇴거되지
 * 않으며, 어떤 스레드의 열거에도 나타나지 않는다.
 */
export type CommandSessionOwnerKind = 'thread' | 'system';

/**
 * 자식 출력이 command-host의 링·알림·페이지·terminal artifact에 닿기 전에
 * 적용하는 exact-marker redaction. 이 값 자체는 세션 artifact나 journal에
 * 기록하지 않는다. marker가 될 수 있는 마지막 suffix는 다음 출력 또는
 * terminal flush까지 보류된다. 치환 결과의 바이트가 출력 offset과
 * maxOutputBytesPerStream의 좌표계다.
 */
interface CommandSessionOutputRedaction {
  exactMarkers: readonly string[];
  replacement: string;
}

/**
 * 출력 보존 규범 (P7.6 §5.2).
 *
 * `tail`(기본)은 예산을 넘으면 앞을 버린다 — 사람과 모델이 읽는 출력의 규범.
 * `protocol`은 버리지 않고, 읽는 쪽이 따라올 때까지 **소스를 멈춘다**.
 * JSON-RPC 같은 바이트 스트림은 한 바이트만 사라져도 프레임이 깨지기 때문이다.
 * `lossless`는 같은 규범을 stdout과 stderr 모두에 적용한다. 두 스트림이 모두
 * 제품 결과인 PTC retained cell처럼 어느 한쪽도 진단 tail로 강등할 수 없는
 * 시스템 세션이 쓴다. 소비자는 두 스트림을 모두 페이지로 비워야 한다. 읽지
 * 않은 어느 한쪽이 예산을 채우면 그 source와 자식 진행이 멈추며, 읽은 바이트를
 * release한 뒤에만 다시 흐른다.
 */
export type CommandSessionStreamMode = 'tail' | 'protocol' | 'lossless';

export interface HostCommandRuntime {
  start(args: {
    executable: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    stateRoot: string;
    threadId: string;
    /** 미지정은 `thread`. 시스템 세션은 threadId를 소유자로 쓰지 않는다. */
    owner?: CommandSessionOwnerKind;
    /** 미지정은 `tail`. */
    streamMode?: CommandSessionStreamMode;
    runId: string;
    callId: string;
    /**
     * 같은 owner/runId/callId의 세션이 이미 있으면 새 자식을 만들지 않고
     * 그 outputRef를 돌려준다. 지원하지 않는 worker에는 요청을 보내지 않는다.
     */
    requiresIdempotentStart?: true;
    stdinMode: 'closed' | 'open';
    /**
     * 자식의 첫 stdin 바이트를 start RPC 안에서 넘긴다. command-host는 이를
     * argv·env·journal·metadata에 기록하지 않고, 새 자식을 만들 때 한 번만
     * 쓴다. 멱등 start가 기존 세션에 합류하면 다시 쓰지 않는다.
     */
    initialStdin?: string | Uint8Array;
    timeoutMs?: number;
    /** outputRedaction이 적용된 뒤의 스트림 바이트 기준 상한. */
    maxOutputBytesPerStream?: number;
    outputRedaction?: CommandSessionOutputRedaction;
    /**
     * lossless 페이지를 응답과 동시에 놓지 않고 다음 명시적 확인까지
     * 보존할 수 있는 worker만 허용한다.
     */
    requiresDeferredOutputRelease?: true;
    signal?: AbortSignal;
    onOutput?: (chunk: HostCommandOutputChunk) => void;
  }): Promise<HostCommandStartResult>;
  waitForInitialResult(args: {
    outputRef: string;
    /**
     * 이 세션을 소유한 stateRoot. 데몬 하나가 여러 워크스페이스를 서빙하고
     * 워크스페이스마다 호스트가 따로 서므로 세션 식별은 interact와 같은
     * (stateRoot, outputRef)다 — 라우팅 정보를 곁테이블에 두면 세션 수만큼
     * 자라고 멱등 재시도에서 어긋난다.
     */
    stateRoot: string;
    yieldTimeMs?: number;
    /**
     * 터미널 출력이 inline 한도보다 작아도 text projection으로 해제하지 않고
     * outputRef를 유지한다. raw page 소비자가 원본 바이트를 잃지 않기 위한
     * opt-in이며, 지원하지 않는 worker에는 요청을 보내지 않는다.
     */
    requiresOutputRef?: true;
    signal?: AbortSignal;
  }): Promise<HostCommandInitialResult>;
  interact(args: {
    stateRoot: string;
    threadId: string;
    /**
     * 미지정은 `thread` — threadId가 ref의 소유자와 일치해야 한다. `system`은
     * 데몬 자신이 부르는 경우이며, 그때 threadId는 접근 판정에 쓰이지 않는다.
     */
    owner?: CommandSessionOwnerKind;
    outputRef: string;
    chars?: string;
    closeStdin?: boolean;
    terminate?: boolean;
    /**
     * 부수효과(chars·closeStdin·terminate)의 재시도 식별자(§4.7). durable
     * invocation은 체크포인트에 기록한 pair를 넘길 수 있고, 일반 호출자가
     * 생략하면 daemon facade가 자기 pair를 할당한다. 인라인 배치처럼 응답이
     * 유실될 수 없는 경로는 없이 호출해 중복 판정을 생략할 수 있다.
     */
    operation?: CommandHostOperation;
    afterRevision?: number;
    yieldTimeMs?: number;
    page?: {
      stream: HostCommandOutputStream;
      offsetBytes: number;
      limitBytes: number;
      /** Omitted preserves the existing UTF-8 page projection. */
      encoding?: 'base64';
      /**
       * 읽은 페이지를 이번 응답에서는 놓지 않는다. lossless 스트림에서만
       * 유효하며, 소비자는 다음 요청의 releaseUpToBytes로 확인한다.
       */
      deferRelease?: boolean;
      /**
       * 이전 deferred 응답 가운데 소비가 끝난 바이트의 끝 offset.
       * 현재 요청 offset보다 클 수 없다.
       */
      releaseUpToBytes?: number;
    };
    signal?: AbortSignal;
  }): Promise<HostCommandInteractionResult>;
  /**
   * 이 스레드가 아직 붙들고 있는 세션들. 모델은 자기가 받은 outputRef로만
   * 세션에 닿는데, 압축(compaction)이 그 ref를 지우면 살아 있는 명령에
   * 다시 닿을 길이 없어진다 — 그 복구 경로다. 스레드 밖 세션은 보이지
   * 않는다(§13 비목표: 세션의 스레드 간 공유).
   */
  listThreadSessions(args: {
    stateRoot: string;
    threadId: string;
  }): Promise<CommandSessionListEntry[]>;
  closeAll(args?: {
    signal?: AbortSignal;
  }): Promise<
    { ok: true } | { ok: false; reasonCode: string; message: string }
  >;
}

export interface CommandSessionHostConfig {
  inlineMaxBytes: number;
  /** 스트림당 tail 링 예산(raw bytes). 기본 1MiB — spec v4 §4.1. */
  tailRingBytes?: number;
  /**
   * 대기의 상한(ms). 호출자가 무엇을 요구하든(미지정 포함) 이 이상은
   * 기다리지 않는다 — 기본 30초, spec v4 §4.6.
   */
  maxYieldTimeMs?: number;
  /**
   * 내구화 시퀀스의 단계 사이에서 제어를 넘겨받는 관찰자 (spec §14
   * T3·T9·T19 검증용). production 배선에서는 지정하지 않으며, 지정해도
   * 저장소가 대역으로 바뀌지 않는다 — 실제 fsync·rename은 그대로 일어나고
   * 이 훅은 그 사이의 틈만 연다. 시퀀스 안쪽의 시각은 밖에서 만들 수 없어
   * 이 seam 없이는 해당 수용기준을 검증할 방법이 없다.
   */
  onDurabilityStage?: DurabilityStageObserver;
  /** terminal 산출물 실패의 원인과 세션 좌표를 운영 진단 출구로 전달한다. */
  onDurabilityFailure?: DurabilityFailureObserver;
}

// spec v4 §7.3 — 워커-facing 구독 계약. 도구는 HostCommandRuntime만 보고,
// 워커의 RPC 서버(및 인라인 배선)는 이 확장 표면으로 스트리밍을 서빙한다.

interface CommandSessionOutputEvent {
  kind: 'output';
  outputRef: string;
  revision: number;
  stream: HostCommandOutputStream;
  startOffset: number;
  endOffset: number;
  chunk: string;
}

interface CommandSessionResyncEvent {
  kind: 'resync';
  outputRef: string;
  latestRevision: number;
}

export type CommandSessionSubscriptionEvent =
  | CommandSessionOutputEvent
  | CommandSessionResyncEvent;

interface CommandSessionStreamBarrier {
  earliestAvailableOffset: number;
  barrierOffset: number;
}

interface CommandSessionSubscribeResult {
  ok: true;
  subscriptionId: string;
  barrierRevision: number;
  stdout: CommandSessionStreamBarrier;
  stderr: CommandSessionStreamBarrier;
  resyncRequired: boolean;
  // 구독 해제도 자립 클로저다 — 연결 테이블에 보관했다가 나중에 부르므로
  // (this 없는) 함수 프로퍼티로 선언한다.
  unsubscribe: () => void;
}

export type CommandSessionSubscribeOutcome =
  | CommandSessionSubscribeResult
  | { ok: false; reasonCode: 'not_found' | 'access_denied'; message: string };

export interface CommandSessionListEntry {
  outputRef: string;
  threadId: string;
  stateRoot: string;
  /**
   * 재시작한 데몬이 같은 도구 호출의 세션만 재입양하는 내부 상관관계.
   * 구 워커와의 재접속은 허용하되 재실행은 금지해야 하므로 optional이다.
   */
  runId?: string | undefined;
  callId?: string | undefined;
  running: boolean;
  revision: number;
  /** 무엇을 돌리고 있는지 — 열거를 사람이 읽을 수 있게 하는 최소 정보. */
  command: string;
  status: string;
  startedAtMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  stdinOpen: boolean;
}

/**
 * spec v4 §5.6 — 도달 불가능 산출물 GC의 보존 집합 조회. 조회에 실패하면
 * (워커 hang·프로토콜 불일치·타임아웃) 삭제를 건너뛰는 것이 규범이므로
 * 실패를 값으로 돌려준다.
 */
export interface HostCommandActiveSessions {
  activeOutputRefs(
    stateRoot: string,
  ): Promise<
    { ok: true; refs: ReadonlySet<string> } | { ok: false; reason: string }
  >;
}

// 세션 코어가 구현하는 전체 표면(HostCommandRuntime + 워커-facing).
export interface CommandSessionHost extends HostCommandRuntime {
  subscribe(args: {
    stateRoot: string;
    threadId: string;
    outputRef: string;
    afterRevision?: number;
    stdoutAfterOffset?: number;
    stderrAfterOffset?: number;
    onEvent: (event: CommandSessionSubscriptionEvent) => void;
  }): CommandSessionSubscribeOutcome;
  listSessions(): CommandSessionListEntry[];
  readonly effectiveConfig: { inlineMaxBytes: number; tailRingBytes: number };
  /**
   * spec §6.3 — 이벤트 구동 종료 평가. running·transitional·critical-I/O·
   * reserved slot·admission 대기가 모두 0일 때만 true.
   */
  isQuiescent(): boolean;
  /** 활동이 잦아들 때마다 호출 — 워커가 종료 조건을 재평가하는 신호. */
  onSettled(listener: () => void): () => void;
  /**
   * spec §7.4 — 소유 연결 단절 시 unclaimed 세션 정리. unclaimed_* 가
   * 아닌 세션에는 아무 것도 하지 않는다.
   */
  releaseUnclaimed(outputRef: string): Promise<void>;
  /**
   * P7.6 §7.1 — 고정이 풀린 채 창을 넘긴 시스템 세션의 회수. 어느 세션이
   * 그런지는 고정을 아는 워커가 판정하고, 코어는 받은 refs만 끝낸다. 스레드
   * 세션은 refs에 들어 있어도 건드리지 않는다(claim된 명령은 데몬 재시작을
   * 생존하는 것이 규범이다).
   */
  reclaimSystemSessions(outputRefs: ReadonlySet<string>): void;
}
