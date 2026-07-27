import {
  forceRefreshProviderAuth,
  getProviderAuth,
} from '../../auth/access.js';
import type { ProviderAuthRuntimeStore } from '../../auth/runtime-state.js';
import { isRecord } from '../../runtime-json.js';
import { buildResponsesRequestHeaders } from './codex-request.js';
import { CODEX_DIRECT_RESPONSES_WEBSOCKET_REUSE_POLICY } from './client.js';
import {
  normalizeProviderErrorCode,
  sanitizeProviderErrorMessage,
} from './provider-error.js';
import { decideProviderRetryPolicy } from './provider-retry-policy.js';
import type { ResponsesWebSocketSessionStore } from './transport/responses-websocket-cache.js';
import { streamResponsesOverWebSocket } from './transport/responses-websocket.js';
import type { ResponsesParseResult } from './transport/responses-parser-shared.js';

export type ProviderNativeWebSearchFailureReason =
  | 'provider_not_configured'
  | 'provider_unauthorized'
  | 'provider_rate_limited'
  | 'provider_error'
  | 'invalid_response'
  | 'aborted';

export interface ProviderNativeWebSearchResultCard {
  title: string;
  url: string;
  snippet: string;
}

export type ProviderNativeWebSearchOutcome =
  | {
      ok: true;
      answer?: string;
      results: ProviderNativeWebSearchResultCard[];
    }
  | {
      ok: false;
      reasonCode: ProviderNativeWebSearchFailureReason;
      message: string;
    };

export interface ProviderNativeWebSearchRuntime {
  search(args: {
    query: string;
    model: string;
    providerSessionId: string;
    signal?: AbortSignal;
  }): Promise<ProviderNativeWebSearchOutcome>;
}

interface CodexWebSearchDependencies {
  forceRefreshAuth?: typeof forceRefreshProviderAuth;
  getAuth?: typeof getProviderAuth;
  streamResponses?: typeof streamResponsesOverWebSocket;
}

interface CodexWebSearchRuntimeDependencies {
  authRuntime: ProviderAuthRuntimeStore;
  webSocketSessions: ResponsesWebSocketSessionStore;
  dependencies?: CodexWebSearchDependencies;
}

class CodexWebSearchError extends Error {
  constructor(
    readonly reasonCode: ProviderNativeWebSearchFailureReason,
    message: string,
  ) {
    super(message);
  }
}

export function createCodexWebSearchRuntime(
  runtime: CodexWebSearchRuntimeDependencies,
): ProviderNativeWebSearchRuntime {
  return {
    search: (args) =>
      searchCodexWeb({
        ...args,
        runtime,
      }),
  };
}

export async function searchCodexWeb(args: {
  query: string;
  model: string;
  providerSessionId: string;
  runtime: CodexWebSearchRuntimeDependencies;
  signal?: AbortSignal;
}): Promise<ProviderNativeWebSearchOutcome> {
  if (isAborted(args.signal)) {
    return {
      ok: false,
      reasonCode: 'aborted',
      message: 'web_search was aborted.',
    };
  }

  try {
    const response = await requestCodexWebSearch(args);
    const parsed = readCodexSearchOutput(response);
    if (parsed.answer.length === 0 && parsed.results.length === 0) {
      return {
        ok: false,
        reasonCode: 'invalid_response',
        message:
          'Codex native web search returned no readable answer or source URLs.',
      };
    }
    return {
      ok: true,
      ...(parsed.answer.length === 0 ? {} : { answer: parsed.answer }),
      results: parsed.results,
    };
  } catch (error: unknown) {
    if (isAborted(args.signal)) {
      return {
        ok: false,
        reasonCode: 'aborted',
        message: 'web_search was aborted.',
      };
    }
    if (error instanceof CodexWebSearchError) {
      return {
        ok: false,
        reasonCode: error.reasonCode,
        message: error.message,
      };
    }
    const code = normalizeProviderErrorCode(error);
    return {
      ok: false,
      reasonCode: mapProviderErrorCode(code),
      message: sanitizeProviderErrorMessage(code),
    };
  }
}

async function requestCodexWebSearch(args: {
  query: string;
  model: string;
  providerSessionId: string;
  runtime: CodexWebSearchRuntimeDependencies;
  signal?: AbortSignal;
}): Promise<ResponsesParseResult> {
  const readAuth = args.runtime.dependencies?.getAuth ?? getProviderAuth;
  const refreshAuth =
    args.runtime.dependencies?.forceRefreshAuth ?? forceRefreshProviderAuth;
  const stream =
    args.runtime.dependencies?.streamResponses ?? streamResponsesOverWebSocket;
  let authRefreshAttempts = 0;

  while (true) {
    try {
      const auth = await readAuth({
        providerId: 'openai_codex_direct',
        runtimeStore: args.runtime.authRuntime,
        ...(args.signal === undefined ? {} : { signal: args.signal }),
      });
      const headers = buildResponsesRequestHeaders({
        accessToken: auth.accessToken,
        accountId: auth.accountId,
        providerSessionId: args.providerSessionId,
      });
      return await stream({
        headers,
        historyProjection: 'provider_output',
        payload: {
          type: 'response.create',
          model: args.model,
          store: false,
          stream: true,
          input: [
            {
              role: 'user',
              content: [{ type: 'input_text', text: args.query }],
            },
          ],
          tools: [{ type: 'web_search', search_context_size: 'high' }],
          tool_choice: { type: 'web_search' },
        },
        providerSessionId: args.providerSessionId,
        requestAttempt: authRefreshAttempts,
        webSocketReusePolicy: CODEX_DIRECT_RESPONSES_WEBSOCKET_REUSE_POLICY,
        providerWebSocketSessions: args.runtime.webSocketSessions,
        normalizeEvent: normalizeCodexSearchEvent,
        ...(args.signal === undefined ? {} : { signal: args.signal }),
      });
    } catch (error: unknown) {
      if (isAborted(args.signal)) {
        throw new CodexWebSearchError('aborted', 'web_search was aborted.');
      }
      const decision = decideProviderRetryPolicy({
        error,
        authRefreshAttempts,
      });
      if (decision.action !== 'force_refresh_auth_retry') {
        throw new CodexWebSearchError(
          mapProviderErrorCode(decision.code),
          decision.message,
        );
      }
      authRefreshAttempts += 1;
      try {
        await refreshAuth({
          providerId: 'openai_codex_direct',
          runtimeStore: args.runtime.authRuntime,
          ...(args.signal === undefined ? {} : { signal: args.signal }),
        });
      } catch (refreshError: unknown) {
        const code = normalizeProviderErrorCode(refreshError);
        throw new CodexWebSearchError(
          mapProviderErrorCode(code),
          sanitizeProviderErrorMessage(code),
        );
      }
    }
  }
}

function normalizeCodexSearchEvent(
  event: Record<string, unknown>,
): Record<string, unknown> {
  if (
    event.type !== 'response.output_item.added' &&
    event.type !== 'response.output_item.done'
  ) {
    return event;
  }
  const item = isRecord(event.item) ? event.item : undefined;
  if (item?.type !== 'message' || item.phase !== undefined) {
    return event;
  }
  return {
    ...event,
    item: {
      ...item,
      phase: 'final_answer',
    },
  };
}

function readCodexSearchOutput(response: ResponsesParseResult): {
  answer: string;
  results: ProviderNativeWebSearchResultCard[];
} {
  const answer = response.finalText.trim() || response.assistantText.trim();
  const resultsByUrl = new Map<string, ProviderNativeWebSearchResultCard>();

  for (const historyItem of response.itemsToAppend) {
    if (historyItem.kind !== 'backend_item' || !isRecord(historyItem.data)) {
      continue;
    }
    const content = historyItem.data.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (!isRecord(part) || !Array.isArray(part.annotations)) {
        continue;
      }
      const text = typeof part.text === 'string' ? part.text : answer;
      for (const annotation of part.annotations) {
        if (
          !isRecord(annotation) ||
          annotation.type !== 'url_citation' ||
          typeof annotation.url !== 'string' ||
          resultsByUrl.has(annotation.url)
        ) {
          continue;
        }
        const title =
          typeof annotation.title === 'string'
            ? normalizeSearchText(annotation.title)
            : '';
        resultsByUrl.set(annotation.url, {
          title,
          url: annotation.url,
          snippet: readCitationSnippet(text, annotation),
        });
      }
    }
  }

  for (const result of readAnswerUrlCards(answer)) {
    if (!resultsByUrl.has(result.url)) {
      resultsByUrl.set(result.url, result);
    }
  }

  return {
    answer,
    results: [...resultsByUrl.values()],
  };
}

function readCitationSnippet(
  text: string,
  annotation: Record<string, unknown>,
): string {
  const start = annotation.start_index;
  const end = annotation.end_index;
  if (
    typeof start !== 'number' ||
    !Number.isSafeInteger(start) ||
    typeof end !== 'number' ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > text.length
  ) {
    return '';
  }
  return normalizeSearchText(text.slice(start, end));
}

function readAnswerUrlCards(
  answer: string,
): ProviderNativeWebSearchResultCard[] {
  const cards: ProviderNativeWebSearchResultCard[] = [];
  const seen = new Set<string>();
  for (const match of answer.matchAll(/https?:\/\/[^\s<>"'\])}]+/giu)) {
    const url = match[0].replace(/[.,;:!?]+$/u, '');
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    cards.push({
      title: '',
      url,
      snippet: '',
    });
  }
  return cards;
}

function normalizeSearchText(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim();
}

function mapProviderErrorCode(
  code: string,
): ProviderNativeWebSearchFailureReason {
  switch (code) {
    case 'aborted':
      return 'aborted';
    case 'llm_auth_failed':
      return 'provider_unauthorized';
    case 'llm_rate_limited':
      return 'provider_rate_limited';
    default:
      return 'provider_error';
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
