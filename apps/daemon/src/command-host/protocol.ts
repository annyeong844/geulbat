import { z } from 'zod';
import type {
  HostCommandInitialResult,
  HostCommandInteractionResult,
  HostCommandStartResult,
} from './contract.js';

// P7.5 spec v4 §7 — command-host JSON-RPC 2.0 계약. 전송은 워커가 listen
// 하는 Unix 소켓 / Windows named pipe이고, 프레이밍은 4바이트 BE 길이
// 프리픽스 + UTF-8 JSON이다(개행 구분 금지 — Watchman 2차 복잡도 전례).

export const COMMAND_HOST_PROTOCOL_VERSION = '2026-07-24';
export const COMMAND_HOST_SUPPORTED_VERSIONS = [
  COMMAND_HOST_PROTOCOL_VERSION,
] as const;

export const COMMAND_HOST_CAPABILITIES = {
  deferredOutputRelease: true,
  idempotentStartByInvocation: true,
  initialStdinOnStart: true,
  losslessStdio: true,
  prePersistenceOutputRedaction: true,
} as const;

export type CommandHostCapabilities = {
  [Name in keyof typeof COMMAND_HOST_CAPABILITIES]: boolean;
};

// spec §7.5 — inbound frame 하드 상한(기본 4MiB). 프레이밍 계층에서
// 강제하며, 초과 프레임은 파싱하지 않고 연결을 종료한다.
export const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;
const LENGTH_PREFIX_BYTES = 4;

// 데몬이 갓 spawn한 워커에 붙기까지 재시도하는 창. 워커의 기동 유예가
// 이 값에서 파생되므로 두 쪽이 같은 숫자를 봐야 한다 (§6.3·§7).
export const COMMAND_HOST_CONNECT_ATTEMPTS = 40;
export const COMMAND_HOST_CONNECT_BACKOFF_MS = 100;
/**
 * 기동 유예 — 접속 창의 두 배.
 *
 * §6.3의 종료 게이트는 이벤트 구동이지만, **연결이 한 번도 오지 않은**
 * 워커에게는 그 이벤트가 영원히 오지 않는다. spawn 경합이 다른 워커의
 * idle 종료와 겹치면 "태어나자마자 놀고 있는" 워커가 남는다.
 *
 * "아직 안 왔다"와 "영영 안 온다"는 시간 없이는 구별할 수 없다 — §3이
 * 금지하는 것은 *의미 없는* 타이머이고, 이것은 그 구별의 유일한 수단이다.
 * 접속 창보다 넉넉히 길어야 정상 spawn을 잘라먹지 않으므로 2배로 파생한다.
 */
export const COMMAND_HOST_STARTUP_GRACE_MS =
  COMMAND_HOST_CONNECT_ATTEMPTS * COMMAND_HOST_CONNECT_BACKOFF_MS * 2;

export const REQUEST_CANCELLED_CODE = -32800;
export const INVALID_REQUEST_CODE = -32600;
export const METHOD_NOT_FOUND_CODE = -32601;
export const INVALID_PARAMS_CODE = -32602;
export const INTERNAL_ERROR_CODE = -32603;

export function encodeFrame(message: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(message), 'utf8');
  const frame = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES + json.length);
  frame.writeUInt32BE(json.length, 0);
  json.copy(frame, LENGTH_PREFIX_BYTES);
  return frame;
}

export class FrameTooLargeError extends Error {
  readonly declaredLength: number;
  constructor(declaredLength: number, maxFrameBytes: number) {
    super(
      `command-host frame length ${declaredLength} exceeds max ${maxFrameBytes}`,
    );
    this.name = 'FrameTooLargeError';
    this.declaredLength = declaredLength;
  }
}

/**
 * 증분 프레임 디코더. push된 바이트를 누적하다 완결된 프레임마다 파싱한
 * 객체를 반환한다. 선언 길이가 maxFrameBytes를 넘으면 FrameTooLargeError를
 * 던진다 — 호출자는 이때 연결을 종료한다(§7.5). 부분 프레임만 있으면
 * 아무 것도 반환하지 않고 다음 push를 기다린다.
 */
export interface DecodedFrame {
  message: unknown;
  /** 길이 프리픽스를 포함한 wire 바이트 — §7.5 전역 inflight 예산의 단위. */
  byteLength: number;
}

export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {}

  push(chunk: Buffer): DecodedFrame[] {
    this.buffer =
      this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const messages: DecodedFrame[] = [];
    for (;;) {
      if (this.buffer.length < LENGTH_PREFIX_BYTES) {
        break;
      }
      const declaredLength = this.buffer.readUInt32BE(0);
      if (declaredLength > this.maxFrameBytes) {
        throw new FrameTooLargeError(declaredLength, this.maxFrameBytes);
      }
      const frameEnd = LENGTH_PREFIX_BYTES + declaredLength;
      if (this.buffer.length < frameEnd) {
        break;
      }
      const body = this.buffer.subarray(LENGTH_PREFIX_BYTES, frameEnd);
      this.buffer = this.buffer.subarray(frameEnd);
      messages.push({
        message: JSON.parse(body.toString('utf8')),
        byteLength: frameEnd,
      });
    }
    return messages;
  }

  get bufferedBytes(): number {
    return this.buffer.length;
  }
}

// ── JSON-RPC envelopes ────────────────────────────────────────────────

const jsonRpcId = z.union([z.string(), z.number().int()]);

export const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: jsonRpcId,
  method: z.string(),
  params: z.unknown().optional(),
});

export const jsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string(),
  params: z.unknown().optional(),
});

const jsonRpcErrorShape = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});

export const jsonRpcResponseSchema = z.union([
  z.object({
    jsonrpc: z.literal('2.0'),
    id: jsonRpcId,
    result: z.unknown(),
  }),
  z.object({
    jsonrpc: z.literal('2.0'),
    id: jsonRpcId,
    error: jsonRpcErrorShape,
  }),
]);

export type JsonRpcId = z.infer<typeof jsonRpcId>;

export function buildRequest(
  id: JsonRpcId,
  method: string,
  params?: unknown,
): unknown {
  return params === undefined
    ? { jsonrpc: '2.0', id, method }
    : { jsonrpc: '2.0', id, method, params };
}

export function buildResultResponse(id: JsonRpcId, result: unknown): unknown {
  return { jsonrpc: '2.0', id, result };
}

export function buildErrorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): unknown {
  const error =
    data === undefined ? { code, message } : { code, message, data };
  return { jsonrpc: '2.0', id, error };
}

export function buildNotification(method: string, params?: unknown): unknown {
  return params === undefined
    ? { jsonrpc: '2.0', method }
    : { jsonrpc: '2.0', method, params };
}

// ── Method params/results ────────────────────────────────────────────

const outputStream = z.enum(['stdout', 'stderr']);
const commandStatus = z.enum([
  'running',
  'exit',
  'crash',
  'timeout',
  'cancelled',
  'signal',
  'output_limit_exceeded',
  'output_store_failed',
  'daemon_shutdown',
  'daemon_restart_interrupted',
  'command_host_interrupted',
]);
const terminalCommandStatus = z.enum([
  'exit',
  'crash',
  'timeout',
  'cancelled',
  'signal',
  'output_limit_exceeded',
  'output_store_failed',
  'daemon_shutdown',
  'daemon_restart_interrupted',
  'command_host_interrupted',
]);

const commandSnapshotSchema = z
  .object({
    outputRef: z.string().nullable(),
    status: commandStatus,
    exitCode: z.number().int().nullable(),
    stdout: z.string().nullable(),
    stderr: z.string().nullable(),
    outputComplete: z.boolean(),
    stdoutBytes: z.number().int().min(0),
    stderrBytes: z.number().int().min(0),
    stdoutChars: z.number().int().min(0).nullable(),
    stderrChars: z.number().int().min(0).nullable(),
    durationMs: z.number().min(0),
    firstOutputAfterMs: z.number().min(0).nullable(),
    revision: z.number().int().min(0),
    stdinOpen: z.boolean(),
    outputLimitExceeded: z
      .object({
        stream: outputStream,
        maxOutputBytesPerStream: z.number().int().positive(),
      })
      .nullable(),
    stdoutOmittedBytes: z.number().int().min(0).optional(),
    stderrOmittedBytes: z.number().int().min(0).optional(),
    terminationReason: z.string().optional(),
    outputPersistFailed: z.boolean().optional(),
    processExit: z
      .object({
        status: terminalCommandStatus,
        exitCode: z.number().int().nullable(),
      })
      .optional(),
  })
  .transform(
    ({
      stdoutOmittedBytes,
      stderrOmittedBytes,
      terminationReason,
      outputPersistFailed,
      processExit,
      ...snapshot
    }) => ({
      ...snapshot,
      ...(stdoutOmittedBytes === undefined ? {} : { stdoutOmittedBytes }),
      ...(stderrOmittedBytes === undefined ? {} : { stderrOmittedBytes }),
      ...(terminationReason === undefined ? {} : { terminationReason }),
      ...(outputPersistFailed === undefined ? {} : { outputPersistFailed }),
      ...(processExit === undefined ? {} : { processExit }),
    }),
  );

const commandOutputPageSchema = z
  .object({
    stream: outputStream,
    offsetBytes: z.number().int().min(0),
    endOffsetBytes: z.number().int().min(0),
    totalBytes: z.number().int().min(0),
    limitBytes: z.number().int().positive(),
    hasMore: z.boolean(),
    nextOffsetBytes: z.number().int().min(0).nullable(),
    content: z.string(),
    contentStartOffset: z.number().int().min(0).optional(),
    earliestAvailableOffset: z.number().int().min(0).optional(),
  })
  .transform(({ contentStartOffset, earliestAvailableOffset, ...page }) => ({
    ...page,
    ...(contentStartOffset === undefined ? {} : { contentStartOffset }),
    ...(earliestAvailableOffset === undefined
      ? {}
      : { earliestAvailableOffset }),
  }));

export const initializeParamsSchema = z.object({
  protocolVersion: z.string(),
  stateRootFingerprint: z.string(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
});

const commandHostCapabilitiesSchema: z.ZodType<CommandHostCapabilities> =
  z.object({
    deferredOutputRelease: z.boolean().default(false),
    idempotentStartByInvocation: z.boolean().default(false),
    initialStdinOnStart: z.boolean().default(false),
    losslessStdio: z.boolean().default(false),
    prePersistenceOutputRedaction: z.boolean().default(false),
  });

export const initializeResultSchema = z.object({
  selectedVersion: z.string(),
  supportedVersions: z.array(z.string()),
  capabilities: commandHostCapabilitiesSchema,
  effectiveConfig: z.object({
    inlineMaxBytes: z.number().int().positive(),
    tailRingBytes: z.number().int().positive(),
  }),
});

export const startParamsSchema = z.object({
  executable: z.string(),
  // P7.6 §5.1 — 미지정은 thread. system은 데몬 자신이 세우는 세션이다.
  owner: z.enum(['thread', 'system']).optional(),
  // P7.6 §5.2 — protocol은 stdout, lossless는 양 스트림 무손실 보존 + 역압.
  streamMode: z.enum(['tail', 'protocol', 'lossless']).optional(),
  args: z.array(z.string()),
  cwd: z.string(),
  env: z.record(z.string(), z.string()),
  stateRoot: z.string(),
  threadId: z.string(),
  runId: z.string(),
  callId: z.string(),
  requiresIdempotentStart: z.literal(true).optional(),
  stdinMode: z.enum(['closed', 'open']),
  initialStdin: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxOutputBytesPerStream: z.number().int().positive().optional(),
  requiresDeferredOutputRelease: z.literal(true).optional(),
  outputRedaction: z
    .object({
      exactMarkers: z.array(z.string().min(1)).min(1),
      replacement: z.string(),
    })
    .optional(),
});

export const waitInitialParamsSchema = z.object({
  outputRef: z.string(),
  yieldTimeMs: z.number().int().min(0).optional(),
});

export const interactParamsSchema = z.object({
  stateRoot: z.string(),
  threadId: z.string(),
  owner: z.enum(['thread', 'system']).optional(),
  outputRef: z.string(),
  chars: z.string().optional(),
  closeStdin: z.boolean().optional(),
  terminate: z.boolean().optional(),
  // §4.7 — 부수효과 재시도 식별자. seq는 파사드가 세션마다 1부터 매긴다.
  operation: z
    .object({ clientId: z.string().min(1), seq: z.number().int().positive() })
    .optional(),
  afterRevision: z.number().int().min(0).optional(),
  yieldTimeMs: z.number().int().min(0).optional(),
  page: z
    .object({
      stream: outputStream,
      offsetBytes: z.number().int().min(0),
      limitBytes: z.number().int().min(1),
      deferRelease: z.boolean().optional(),
      releaseUpToBytes: z.number().int().min(0).optional(),
    })
    .optional(),
});

export const startResultSchema: z.ZodType<HostCommandStartResult> =
  z.discriminatedUnion('ok', [
    z.object({
      ok: z.literal(true),
      outputRef: z.string().min(1),
    }),
    z.object({
      ok: z.literal(false),
      reasonCode: z.enum([
        'runtime_closed',
        'spawn_failed',
        'output_store_failed',
        'session_capacity_exhausted',
      ]),
      message: z.string(),
    }),
  ]);

export const waitInitialResultSchema: z.ZodType<HostCommandInitialResult> =
  z.discriminatedUnion('ok', [
    z.object({
      ok: z.literal(true),
      value: commandSnapshotSchema,
    }),
    z.object({
      ok: z.literal(false),
      reasonCode: z.enum(['not_found', 'output_store_failed', 'wait_aborted']),
      message: z.string(),
    }),
  ]);

export const interactResultSchema: z.ZodType<HostCommandInteractionResult> =
  z.discriminatedUnion('ok', [
    z.object({
      ok: z.literal(true),
      value: z.object({
        snapshot: commandSnapshotSchema,
        page: commandOutputPageSchema.nullable(),
      }),
    }),
    z.object({
      ok: z.literal(false),
      reasonCode: z.enum([
        'access_denied',
        'invalid_args',
        'not_found',
        'not_running',
        'stdin_backpressure',
        'operation_superseded',
        'output_store_failed',
        'wait_aborted',
      ]),
      message: z.string(),
    }),
  ]);

export const subscribeParamsSchema = z.object({
  outputRef: z.string(),
  afterRevision: z.number().int().min(0).optional(),
  stdoutAfterOffset: z.number().int().min(0).optional(),
  stderrAfterOffset: z.number().int().min(0).optional(),
});

const streamBarrierSchema = z.object({
  earliestAvailableOffset: z.number().int().min(0),
  barrierOffset: z.number().int().min(0),
});

export const subscribeResultSchema = z.object({
  barrierRevision: z.number().int().min(0),
  stdout: streamBarrierSchema,
  stderr: streamBarrierSchema,
  resyncRequired: z.boolean(),
});

export const unsubscribeParamsSchema = z.object({
  subscriptionId: z.string(),
});

export const cancelParamsSchema = z.object({
  id: jsonRpcId,
});

// Server → client notifications
export const outputNotificationSchema = z.object({
  outputRef: z.string(),
  subscriptionId: z.string(),
  revision: z.number().int().min(0),
  stream: outputStream,
  startOffset: z.number().int().min(0),
  endOffset: z.number().int().min(0),
  chunk: z.string(),
});

/** §5.6 GC 보존 집합 조회에 쓰는 `session/list` 응답. */
export const listResultSchema = z.array(
  z.object({
    outputRef: z.string(),
    threadId: z.string(),
    stateRoot: z.string(),
    // 구 워커가 살아 있는 업그레이드 재접속에서는 빠질 수 있다. 새 데몬은
    // 이 둘이 모두 있는 정확한 호출만 재입양하고, 없으면 fail-closed한다.
    runId: z.string().optional(),
    callId: z.string().optional(),
    running: z.boolean(),
    revision: z.number(),
    command: z.string(),
    status: z.string(),
    startedAtMs: z.number(),
    stdoutBytes: z.number(),
    stderrBytes: z.number(),
    stdinOpen: z.boolean(),
  }),
);

export const COMMAND_HOST_METHODS = {
  initialize: 'initialize',
  shutdown: 'shutdown',
  terminateAll: 'host/terminateAll',
  start: 'session/start',
  waitInitial: 'session/waitInitial',
  interact: 'session/interact',
  list: 'session/list',
  subscribe: 'session/subscribe',
  unsubscribe: 'session/unsubscribe',
} as const;

export const COMMAND_HOST_NOTIFICATIONS = {
  output: 'session/output',
  resyncRequired: 'session/resyncRequired',
  cancelRequest: '$/cancelRequest',
} as const;
