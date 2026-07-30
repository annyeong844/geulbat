import WebSocket from 'ws';

import type { ProviderReplayScopeId } from '../../../runtime-contracts.js';
import { createLogger } from '@geulbat/structured-logger/logger';
import {
  parseResponseEvents,
  type ResponsesParseResult,
} from './responses-parser.js';
import { buildResponseCreatePayload } from './responses-wire-input.js';
import {
  sanitizeOAuthWireDiscoveryEvent,
  sanitizeOAuthWireDiscoveryRequest,
} from './responses-wire-discovery.js';
import {
  readRetryAfterMs,
  type ProviderAdmissionFallbackDelayResolver,
  type ResponsesWebSocketAdmissionObserver,
  type ResponsesWebSocketReusePolicy,
  type ResponsesWebSocketSessionStore,
} from './responses-websocket-cache.js';
import {
  resolveCodexResponsesUrl,
  resolveCodexWebSocketUrl,
} from './responses-websocket-url.js';
import { iterateWebSocketEventsAfterDispatch } from './responses-websocket-stream.js';
import type { DurableProviderRequestPreparedHandler } from './responses-durable-request.js';
import type { HistoryItem, WireRequestBase } from '../wire/types.js';

const CODEX_WS_BETA_HEADER =
  process.env.GEULBAT_WS_BETA_HEADER ?? 'responses_websockets=2026-02-06';
const RESPONSES_STREAM_IDLE_TIMEOUT_ENV =
  'GEULBAT_LLM_STREAM_IDLE_TIMEOUT_MS' as const;
const logger = createLogger('responses-ws');

export function resolveResponsesStreamIdleTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const raw = env[RESPONSES_STREAM_IDLE_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `${RESPONSES_STREAM_IDLE_TIMEOUT_ENV} must be a positive safe integer`,
    );
  }
  return parsed;
}

export interface ResponsesWireDiscoverySink {
  recordRequest(snapshot: unknown): void;
  recordEvent(snapshot: unknown): void;
}

export interface ResponsesRequestMeasurement {
  serializedBytes: number;
  dominantPressureSource:
    | 'history'
    | 'instructions'
    | 'tool_definitions'
    | 'envelope';
  serializedBytesBySource: {
    history: number;
    instructions: number;
    toolDefinitions: number;
    envelope: number;
  };
}

type ResponsesRequestAdmissionDecision =
  | { kind: 'send' }
  | { kind: 'prepare'; reason: 'near_policy' | 'over_window' };

export type ResponsesRequestPreparedHandler = (
  measurement: ResponsesRequestMeasurement,
) =>
  | ResponsesRequestAdmissionDecision
  | void
  | Promise<ResponsesRequestAdmissionDecision | void>;

type ResponsesWebSocketPayloadSource =
  | {
      body: WireRequestBase;
      history: HistoryItem[];
      payload?: never;
    }
  | {
      payload: Record<string, unknown>;
      body?: never;
      history?: never;
    };

type ResponsesWebSocketEventNormalizer = (
  event: Record<string, unknown>,
) => Record<string, unknown>;

interface ResponsesWebSocketStreamBase {
  headers: Headers;
  historyProjection: 'normalized' | 'provider_output';
  providerReplayScopeId?: ProviderReplayScopeId;
  webSocketUrl?: string;
  providerSessionId: string;
  webSocketReusePolicy: ResponsesWebSocketReusePolicy;
  providerWebSocketSessions: Pick<
    ResponsesWebSocketSessionStore,
    'acquireWebSocket' | 'deferProviderRequests' | 'streamDurableResponseEvents'
  >;
  requestAttempt?: number;
  resumeRequestIdentity?: string;
  signal?: AbortSignal;
  discoverySink?: ResponsesWireDiscoverySink;
  onRequestPrepared?: ResponsesRequestPreparedHandler;
  onDurableRequestPrepared?: DurableProviderRequestPreparedHandler;
  onAdmissionState?: ResponsesWebSocketAdmissionObserver;
  resolveProviderAdmissionFallbackDelayMs?: ProviderAdmissionFallbackDelayResolver;
  normalizeEvent?: ResponsesWebSocketEventNormalizer;
  completionEventTypes?: readonly string[];
  // 이벤트 사이 유휴 상한. 기본 60s는 챗 스트림 기준 — 이미지 생성처럼
  // 이벤트 간격이 긴 호출은 명시적으로 늘려야 한다(안 그러면 유휴 타임아웃).
  idleTimeoutMs?: number;
  onAssistantDelta?: (delta: {
    itemId: string;
    phase: 'commentary' | 'final_answer';
    text: string;
  }) => void;
  onFunctionCallArgsDelta?: (delta: {
    itemId: string;
    callId: string;
    name: string;
    argsDelta: string;
  }) => void;
}

type ResponsesWebSocketStreamInput = ResponsesWebSocketStreamBase &
  ResponsesWebSocketPayloadSource;

export async function streamResponsesOverWebSocket(
  input: ResponsesWebSocketStreamInput,
): Promise<ResponsesParseResult> {
  const webSocketUrl =
    input.webSocketUrl ?? resolveCodexWebSocketUrl(resolveCodexResponsesUrl());
  const headers =
    input.webSocketUrl === undefined
      ? buildCodexResponsesWebSocketHeaders(input.headers)
      : input.headers;
  const payload =
    input.payload ??
    buildResponseCreatePayload(
      input.body,
      input.history,
      input.providerReplayScopeId,
    );
  const idleTimeoutMs =
    input.idleTimeoutMs ?? resolveResponsesStreamIdleTimeoutMs();
  const serializedPayload = JSON.stringify(payload);
  let fallbackDelayResolved = false;
  const resolveProviderAdmissionFallbackDelayMs = (
    error: unknown,
  ): number | undefined => {
    if (
      fallbackDelayResolved ||
      input.resolveProviderAdmissionFallbackDelayMs === undefined
    ) {
      return undefined;
    }
    fallbackDelayResolved = true;
    return input.resolveProviderAdmissionFallbackDelayMs(error);
  };
  const deferProviderFailure = (error: unknown): void => {
    const delayMs =
      readRetryAfterMs(error) ?? resolveProviderAdmissionFallbackDelayMs(error);
    if (delayMs !== undefined) {
      input.providerWebSocketSessions.deferProviderRequests?.(
        webSocketUrl,
        delayMs,
      );
    }
  };
  const admission = await input.onRequestPrepared?.(
    measureResponsesRequest(payload, serializedPayload),
  );
  if (admission?.kind === 'prepare') {
    throw Object.assign(new Error('context preparation required'), {
      llmCode: 'llm_context_preparation_required' as const,
      preparationReason: admission.reason,
    });
  }
  const streamDurableResponseEvents =
    input.providerWebSocketSessions.streamDurableResponseEvents;
  if (streamDurableResponseEvents !== undefined) {
    try {
      const events = streamDurableResponseEvents({
        webSocketUrl,
        headers,
        serializedPayload,
        providerSessionId: input.providerSessionId,
        requestAttempt: input.requestAttempt ?? 0,
        ...(input.resumeRequestIdentity === undefined
          ? {}
          : { resumeRequestIdentity: input.resumeRequestIdentity }),
        ...(input.onDurableRequestPrepared === undefined
          ? {}
          : { onPrepared: input.onDurableRequestPrepared }),
        ...(input.completionEventTypes === undefined
          ? {}
          : { completionEventTypes: input.completionEventTypes }),
        onDispatched: () =>
          input.discoverySink?.recordRequest(
            sanitizeOAuthWireDiscoveryRequest({ headers, payload }),
          ),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.onAdmissionState === undefined
          ? {}
          : { onAdmissionState: input.onAdmissionState }),
        ...(input.resolveProviderAdmissionFallbackDelayMs === undefined
          ? {}
          : { resolveProviderAdmissionFallbackDelayMs }),
      });
      // The durable generator owns caller-signal settlement. Racing the same
      // signal in the parser would mask host-stop or coordinate-cleanup errors.
      return await parseResponseEvents(
        tapDiscoveryEvents(events, input.discoverySink, input.normalizeEvent),
        input.onAssistantDelta,
        {
          ...(input.onFunctionCallArgsDelta !== undefined
            ? { onFunctionCallArgsDelta: input.onFunctionCallArgsDelta }
            : {}),
          ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
          historyProjection: input.historyProjection,
          onErrorBeforeIteratorClose: deferProviderFailure,
        },
      );
    } catch (error: unknown) {
      deferProviderFailure(error);
      throw error;
    }
  }
  let socketHandle:
    | Awaited<ReturnType<ResponsesWebSocketSessionStore['acquireWebSocket']>>
    | undefined;
  let keepSessionSocket = true;
  let socketHandleReleased = false;

  try {
    socketHandle = await input.providerWebSocketSessions.acquireWebSocket(
      webSocketUrl,
      headers,
      input.providerSessionId,
      input.webSocketReusePolicy,
      input.signal,
      input.onAdmissionState,
    );
    input.discoverySink?.recordRequest(
      sanitizeOAuthWireDiscoveryRequest({
        headers,
        payload,
      }),
    );
    if (
      socketHandle.reused === true &&
      socketHandle.socket.readyState !== WebSocket.OPEN
    ) {
      socketHandleReleased = true;
      socketHandle.release({ keep: false });
      logger.info(
        'reconnecting responses websocket closed before request dispatch',
      );
      socketHandle = await input.providerWebSocketSessions.acquireWebSocket(
        webSocketUrl,
        headers,
        input.providerSessionId,
        input.webSocketReusePolicy,
        input.signal,
        input.onAdmissionState,
      );
      socketHandleReleased = false;
    }
    const activeSocket = socketHandle.socket;
    const result = await parseResponseEvents(
      tapDiscoveryEvents(
        iterateWebSocketEventsAfterDispatch(
          activeSocket,
          () => activeSocket.send(serializedPayload),
          input.signal,
          input.completionEventTypes,
        ),
        input.discoverySink,
        input.normalizeEvent,
      ),
      input.onAssistantDelta,
      {
        ...(input.onFunctionCallArgsDelta !== undefined
          ? { onFunctionCallArgsDelta: input.onFunctionCallArgsDelta }
          : {}),
        ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
        historyProjection: input.historyProjection,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        onErrorBeforeIteratorClose: deferProviderFailure,
      },
    );

    return result;
  } catch (error: unknown) {
    keepSessionSocket = false;
    deferProviderFailure(error);
    throw error;
  } finally {
    if (socketHandle !== undefined && !socketHandleReleased) {
      socketHandle.release({ keep: keepSessionSocket });
    }
  }
}

function measureResponsesRequest(
  payload: Record<string, unknown>,
  serializedPayload: string,
): ResponsesRequestMeasurement {
  const serializedBytes = Buffer.byteLength(serializedPayload, 'utf8');
  const history = measureSerializedValue(payload['input']);
  const instructions = measureSerializedValue(payload['instructions']);
  const toolDefinitions = measureSerializedValue(payload['tools']);
  const envelope = Math.max(
    0,
    serializedBytes - history - instructions - toolDefinitions,
  );
  const dominantPressureSource = (
    [
      ['history', history],
      ['instructions', instructions],
      ['tool_definitions', toolDefinitions],
      ['envelope', envelope],
    ] as const
  ).reduce((dominant, candidate) =>
    candidate[1] > dominant[1] ? candidate : dominant,
  )[0];

  return {
    serializedBytes,
    dominantPressureSource,
    serializedBytesBySource: {
      history,
      instructions,
      toolDefinitions,
      envelope,
    },
  };
}

function measureSerializedValue(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function buildCodexResponsesWebSocketHeaders(headers: Headers): Headers {
  const out = new Headers(headers);
  out.set('OpenAI-Beta', CODEX_WS_BETA_HEADER);
  return out;
}

async function* tapDiscoveryEvents(
  events: AsyncIterable<Record<string, unknown>>,
  discoverySink: ResponsesWireDiscoverySink | undefined,
  normalizeEvent: ResponsesWebSocketEventNormalizer | undefined,
): AsyncIterable<Record<string, unknown>> {
  for await (const event of events) {
    const normalized = normalizeEvent ? normalizeEvent(event) : event;
    discoverySink?.recordEvent(sanitizeOAuthWireDiscoveryEvent(normalized));
    yield normalized;
  }
}
