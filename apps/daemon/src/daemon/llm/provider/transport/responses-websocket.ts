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
import type {
  ResponsesWebSocketReusePolicy,
  ResponsesWebSocketSessionStore,
} from './responses-websocket-cache.js';
import {
  resolveCodexResponsesUrl,
  resolveCodexWebSocketUrl,
} from './responses-websocket-url.js';
import { iterateWebSocketEvents } from './responses-websocket-stream.js';
import type { HistoryItem, WireRequestBase } from '../wire/types.js';

const CODEX_WS_BETA_HEADER =
  process.env.GEULBAT_WS_BETA_HEADER ?? 'responses_websockets=2026-02-06';
const RESPONSES_STREAM_IDLE_TIMEOUT_ENV =
  'GEULBAT_LLM_STREAM_IDLE_TIMEOUT_MS' as const;
const DEFAULT_RESPONSES_STREAM_IDLE_TIMEOUT_MS = 60_000;
const logger = createLogger('responses-ws');

export function resolveResponsesStreamIdleTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[RESPONSES_STREAM_IDLE_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_RESPONSES_STREAM_IDLE_TIMEOUT_MS;
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
    'acquireWebSocket'
  >;
  signal?: AbortSignal;
  discoverySink?: ResponsesWireDiscoverySink;
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
  let socketHandle = await input.providerWebSocketSessions.acquireWebSocket(
    webSocketUrl,
    headers,
    input.providerSessionId,
    input.webSocketReusePolicy,
    input.signal,
  );

  let keepSessionSocket = true;
  let socketHandleReleased = false;

  try {
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
      );
      socketHandleReleased = false;
    }
    socketHandle.socket.send(JSON.stringify(payload));

    const result = await parseResponseEvents(
      tapDiscoveryEvents(
        iterateWebSocketEvents(
          socketHandle.socket,
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
        idleTimeoutMs,
        historyProjection: input.historyProjection,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      },
    );

    return result;
  } catch (error: unknown) {
    keepSessionSocket = false;
    throw error;
  } finally {
    if (!socketHandleReleased) {
      socketHandle.release({ keep: keepSessionSocket });
    }
  }
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
