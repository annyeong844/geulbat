import {
  parseResponseEvents,
  type ResponsesParseResult,
} from './responses-parser.js';
import { buildResponseCreatePayload } from './responses-wire-input.js';
import {
  resolveCodexWebSocketUrl,
  type ResponsesWebSocketSessionStore,
} from './responses-websocket-session.js';
import { iterateWebSocketEvents } from './responses-websocket-stream.js';
import type { HistoryItem, WireRequestBase } from '../wire/types.js';

const BACKEND_URL =
  process.env.GEULBAT_BACKEND_URL ??
  'https://chatgpt.com/backend-api/codex/responses';

export { buildResponseCreatePayload } from './responses-wire-input.js';

export async function streamResponsesOverWebSocket(input: {
  body: WireRequestBase;
  headers: Headers;
  history: HistoryItem[];
  providerSessionId: string;
  providerWebSocketSessions: Pick<
    ResponsesWebSocketSessionStore,
    'acquireWebSocket'
  >;
  signal?: AbortSignal;
  onAssistantDelta?: (delta: {
    itemId: string;
    phase: 'commentary' | 'final_answer';
    text: string;
  }) => void;
}): Promise<ResponsesParseResult> {
  const { socket, release } =
    await input.providerWebSocketSessions.acquireWebSocket(
      resolveCodexWebSocketUrl(BACKEND_URL),
      input.headers,
      input.providerSessionId,
      input.signal,
    );
  const payload = buildResponseCreatePayload(input.body, input.history);

  let keepSessionSocket = true;

  try {
    socket.send(JSON.stringify(payload));

    const result = await parseResponseEvents(
      iterateWebSocketEvents(socket, input.signal),
      input.onAssistantDelta,
      {
        idleTimeoutMs: 60_000,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      },
    );

    return result;
  } catch (error: unknown) {
    keepSessionSocket = false;
    throw error;
  } finally {
    release({ keep: keepSessionSocket });
  }
}
