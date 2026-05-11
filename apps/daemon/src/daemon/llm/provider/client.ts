/**
 * llm/client -- ChatGPT Codex direct transport (AsyncGenerator interface)
 *
 * Shell-daemon run channel uses websocket /api/ws.
 * Provider continuity follows the current direct `openai-codex-responses` path:
 * - app session owns transcript/history reconstruction
 * - provider requests carry full structured history per call
 * - `providerSessionId` is sent as `session_id` and `prompt_cache_key`
 *
 * This path is intentionally distinct from the generic
 * `OpenAIWebSocketManager` wrapper for `openai-responses`.
 */

import {
  forceRefreshProviderAuth,
  getProviderAuth,
} from '../../auth/access.js';
import type { ProviderAuthRuntimeStore } from '../../auth/runtime-state.js';
import { getErrorMessage } from '@geulbat/shared-utils/error';
import { createLogger } from '@geulbat/shared-utils/logger';
import { mergeAbortSignals } from '../../utils/abort.js';
import { AsyncQueue } from './async-queue.js';
import {
  normalizeProviderErrorCode,
  sanitizeProviderErrorMessage,
} from './provider-error.js';
import { decideProviderRetryPolicy } from './provider-retry-policy.js';
import type { ProviderRequestOptions } from './provider-options.js';
import { streamResponsesOverWebSocket } from './transport/responses-websocket.js';
import type { ResponsesWebSocketSessionStore } from './transport/responses-websocket-session.js';
import type {
  HistoryItem,
  FunctionCall,
  ProviderArtifactCandidate,
  WireRequestBase,
  WireToolDefinition,
} from './wire/types.js';

const BETA_HEADER = process.env.GEULBAT_BETA_HEADER ?? 'responses=experimental';
const ORIGINATOR_HEADER = process.env.GEULBAT_ORIGINATOR ?? 'pi';

// ── Public types ──

export type LLMChunk =
  | { type: 'text_delta'; text: string; phase?: 'commentary' | 'final_answer' }
  | {
      type: 'tool_call';
      id: string;
      callId: string;
      toolName: string;
      argumentsJson: string;
    }
  | {
      type: 'done';
      assistantText?: string;
      finalText?: string;
      artifactCandidate?: ProviderArtifactCandidate;
    }
  | { type: 'error'; code: string; message: string };

export interface CallModelInput {
  history: HistoryItem[];
  systemPrompt: string;
  promptContext?: string;
  tools?: WireToolDefinition[];
  providerSessionId: string;
  providerWebSocketSessions: Pick<
    ResponsesWebSocketSessionStore,
    'acquireWebSocket'
  >;
  providerAuthRuntime: ProviderAuthRuntimeStore;
  providerRequestOptions: ProviderRequestOptions;
  signal?: AbortSignal;
}

interface CallModelDependencies {
  getProviderAuth: typeof getProviderAuth;
  forceRefreshProviderAuth: typeof forceRefreshProviderAuth;
  streamResponsesOverWebSocket: typeof streamResponsesOverWebSocket;
}

const defaultCallModelDependencies: CallModelDependencies = {
  getProviderAuth,
  forceRefreshProviderAuth,
  streamResponsesOverWebSocket,
};

const logger = createLogger('llm/provider/client');

// ── Main export ──

export async function* callModel(
  input: CallModelInput,
): AsyncGenerator<LLMChunk> {
  yield* callModelWithDependencies(input, defaultCallModelDependencies);
}

export async function* callModelWithDependencies(
  input: CallModelInput,
  deps: CallModelDependencies,
): AsyncGenerator<LLMChunk> {
  const channel = new AsyncQueue<LLMChunk>();
  const consumerAbortController = new AbortController();
  const logMeta = {
    historyCount: input.history.length,
    providerSessionId: input.providerSessionId,
    toolCount: input.tools?.length ?? 0,
  };
  const providerLogger = logger.withContext(logMeta);
  const signal = input.signal
    ? mergeAbortSignals(input.signal, consumerAbortController.signal)
    : consumerAbortController.signal;

  providerLogger.info('provider stream started');

  // Start the provider websocket call + parse loop in the background.
  const resultPromise = callResponsesWithRetryPolicy(
    {
      ...input,
      signal,
    },
    channel,
    deps,
    providerLogger,
  )
    .then(({ functionCalls, assistantText, finalText, artifactCandidate }) => {
      providerLogger.info('provider stream completed', {
        toolCallCount: functionCalls.length,
      });
      // Yield tool_call chunks for each function call
      for (const fc of functionCalls) {
        channel.push({
          type: 'tool_call',
          id: fc.id,
          callId: fc.callId,
          toolName: fc.name,
          argumentsJson: fc.arguments,
        });
      }
      channel.push({
        type: 'done',
        assistantText,
        finalText,
        ...(artifactCandidate !== undefined ? { artifactCandidate } : {}),
      });
      channel.finish();
    })
    .catch((err: unknown) => {
      const code = normalizeProviderErrorCode(err);
      const message = sanitizeProviderErrorMessage(code);
      if (code === 'aborted') {
        providerLogger.info('provider stream aborted');
      } else {
        providerLogger.warn('provider stream failed', {
          code,
          cause: getErrorMessage(err),
        });
      }
      channel.push({ type: 'error', code, message });
      channel.finish();
    });

  let drained = false;
  try {
    for await (const chunk of channel) {
      yield chunk;
    }
    drained = true;
  } finally {
    channel.finish();
    if (!drained) {
      providerLogger.info('provider stream consumer closed');
    }
    consumerAbortController.abort('callModel consumer closed');
    await settleHandledProviderResult(resultPromise);
  }
}

// ── Internal: single attempt ──

async function callResponsesOnce(
  input: CallModelInput,
  channel: AsyncQueue<LLMChunk>,
  deps: CallModelDependencies,
  options?: {
    allowRefresh?: boolean;
  },
): Promise<{
  functionCalls: FunctionCall[];
  assistantText: string;
  finalText: string;
  artifactCandidate?: ProviderArtifactCandidate;
}> {
  const auth = await deps.getProviderAuth({
    ...(options?.allowRefresh !== undefined
      ? { allowRefresh: options.allowRefresh }
      : {}),
    runtimeStore: input.providerAuthRuntime,
  });
  const body = buildResponsesRequestBody(input);
  const headers = buildResponsesRequestHeaders({
    accessToken: auth.accessToken,
    accountId: auth.accountId,
    providerSessionId: input.providerSessionId,
  });

  const result = await deps.streamResponsesOverWebSocket({
    body,
    headers,
    history: input.history,
    providerSessionId: input.providerSessionId,
    providerWebSocketSessions: input.providerWebSocketSessions,
    onAssistantDelta: (delta) => {
      channel.push({
        type: 'text_delta',
        text: delta.text,
        phase: delta.phase,
      });
    },
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  return {
    functionCalls: result.functionCalls,
    assistantText: result.assistantText,
    finalText: result.finalText,
    ...(result.artifactCandidate !== undefined
      ? { artifactCandidate: result.artifactCandidate }
      : {}),
  };
}

async function callResponsesWithRetryPolicy(
  input: CallModelInput,
  channel: AsyncQueue<LLMChunk>,
  deps: CallModelDependencies,
  providerLogger: ReturnType<typeof logger.withContext>,
): Promise<{
  functionCalls: FunctionCall[];
  assistantText: string;
  finalText: string;
  artifactCandidate?: ProviderArtifactCandidate;
}> {
  let authRefreshAttempts = 0;

  for (;;) {
    try {
      return await callResponsesOnce(
        input,
        channel,
        deps,
        authRefreshAttempts > 0 ? { allowRefresh: false } : undefined,
      );
    } catch (error: unknown) {
      const decision = decideProviderRetryPolicy({
        error,
        authRefreshAttempts,
      });
      if (decision.action === 'fail') {
        throw error;
      }

      providerLogger.info(
        'provider auth failed; forcing refresh before one retry',
        {
          code: decision.code,
        },
      );
      await deps.forceRefreshProviderAuth({
        runtimeStore: input.providerAuthRuntime,
      });
      authRefreshAttempts += 1;
      providerLogger.info('provider auth refresh succeeded; retrying once');
    }
  }
}

function buildResponsesRequestBody(input: CallModelInput): WireRequestBase {
  const requestOptions = input.providerRequestOptions;
  const body: WireRequestBase = {
    model: requestOptions.model,
    store: false,
    stream: true,
    text: requestOptions.text,
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: input.providerSessionId,
    reasoning: requestOptions.reasoning,
    ...(input.systemPrompt ? { instructions: input.systemPrompt } : {}),
  };

  if (input.promptContext) {
    // Append prompt context as a system-level instruction addendum
    body.instructions =
      (body.instructions ?? '') + '\n\n' + input.promptContext;
  }

  if (input.tools && input.tools.length > 0) {
    body.tools = input.tools;
    body.tool_choice = 'auto';
  }

  return body;
}

function buildResponsesRequestHeaders(args: {
  accessToken: string;
  accountId: string;
  providerSessionId: string;
}): Headers {
  const headers = new Headers();
  headers.set('Authorization', `Bearer ${args.accessToken}`);
  headers.set('chatgpt-account-id', args.accountId);
  headers.set('OpenAI-Beta', BETA_HEADER);
  headers.set('originator', ORIGINATOR_HEADER);
  headers.set('Content-Type', 'application/json');
  headers.set('accept', 'text/event-stream');
  headers.set('session_id', args.providerSessionId);
  return headers;
}

async function settleHandledProviderResult(
  resultPromise: Promise<unknown>,
): Promise<void> {
  try {
    await resultPromise;
  } catch (handledError: unknown) {
    // `callModel` already translated the failure into an `error` chunk.
    void handledError;
  }
}
