/**
 * llm/client -- provider model transport (AsyncGenerator interface)
 *
 * Shell-daemon run channel uses websocket /api/ws.
 * Codex direct continuity follows the current `openai-codex-responses` path:
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
  hashProviderTraceIdentity,
  type PromptCacheProjection,
} from './provider-cache-projection.js';
import { buildProviderCacheTelemetryLogFields } from './provider-cache-telemetry.js';
import {
  buildGrokOAuthPromptCacheProjection,
  resolveGrokOAuthModelDescriptor,
  streamGrokOAuthResponses,
} from './grok-oauth-transport.js';
import {
  buildCodexDirectPromptCacheProjection,
  buildProviderInstructions,
  buildProviderVisiblePrefixMaterial,
  buildResponsesRequestBody,
  buildResponsesRequestHeaders,
} from './codex-request.js';
import {
  normalizeProviderErrorCode,
  sanitizeProviderErrorMessage,
} from './provider-error.js';
import { decideProviderRetryPolicy } from './provider-retry-policy.js';
import type { ProviderRequestOptions } from './provider-options.js';
import { ProviderHistoryItemInvalidError } from './transport/responses-wire-input.js';
import { streamResponsesOverWebSocket } from './transport/responses-websocket.js';
import type { ResponsesWireDiscoverySink } from './transport/responses-websocket.js';
import type {
  ResponsesWebSocketReusePolicy,
  ResponsesWebSocketSessionStore,
} from './transport/responses-websocket-cache.js';
import type {
  HistoryItem,
  FunctionCall,
  ProviderArtifactCandidate,
  ProviderStructuredOutput,
  ProviderUsageTelemetry,
  WireToolDefinition,
} from './wire/types.js';

// GPT-5.6 prompt cache entries stay eligible for at least 30 minutes by
// default. The Responses WebSocket itself has a 60-minute protocol limit, so
// repeated releases may preserve affinity for 30 idle minutes but never extend
// the underlying connection past one hour.
export const CODEX_DIRECT_RESPONSES_WEBSOCKET_REUSE_POLICY = {
  idleRetentionMs: 30 * 60 * 1000,
  maxConnectionLifetimeMs: 60 * 60 * 1000,
} as const satisfies ResponsesWebSocketReusePolicy;

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
  // 스트리밍 도구 인자 — arguments JSON 텍스트 조각 (완성본 tool_call이 정본)
  | {
      type: 'tool_call_delta';
      itemId: string;
      callId: string;
      toolName: string;
      argsDelta: string;
    }
  | {
      type: 'done';
      assistantText?: string;
      finalText?: string;
      itemsToAppend?: HistoryItem[];
      artifactCandidate?: ProviderArtifactCandidate;
      structuredOutputs?: ProviderStructuredOutput[];
      providerUsageTelemetry?: ProviderUsageTelemetry;
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
  oauthWireDiscoverySink?: ResponsesWireDiscoverySink;
  signal?: AbortSignal;
}

interface CallModelDependencies {
  getProviderAuth: typeof getProviderAuth;
  forceRefreshProviderAuth: typeof forceRefreshProviderAuth;
  streamResponsesOverWebSocket: typeof streamResponsesOverWebSocket;
  streamGrokOAuthResponses?: typeof streamGrokOAuthResponses;
}

const defaultCallModelDependencies: CallModelDependencies = {
  getProviderAuth,
  forceRefreshProviderAuth,
  streamResponsesOverWebSocket,
  streamGrokOAuthResponses,
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
    conversationIdentityHash: hashProviderTraceIdentity(
      input.providerSessionId,
    ),
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
    .then((result) => {
      const {
        itemsToAppend,
        functionCalls,
        assistantText,
        finalText,
        artifactCandidate,
        structuredOutputs,
        providerUsageTelemetry,
      } = result;
      providerLogger.info('provider stream completed', {
        toolCallCount: functionCalls.length,
        ...buildProviderCacheTelemetryLogFields(providerUsageTelemetry, {
          ...buildPromptCacheTelemetryContext(input),
        }),
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
        ...(itemsToAppend !== undefined ? { itemsToAppend } : {}),
        ...(artifactCandidate !== undefined ? { artifactCandidate } : {}),
        ...(structuredOutputs !== undefined ? { structuredOutputs } : {}),
        ...(providerUsageTelemetry !== undefined
          ? { providerUsageTelemetry }
          : {}),
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

interface CallResponsesOnceOptions {
  allowRefresh?: boolean;
  onAssistantDeltaCommitted?: () => void;
}

function buildProviderStreamCallbacks(
  channel: AsyncQueue<LLMChunk>,
  options?: CallResponsesOnceOptions,
): Pick<
  Parameters<typeof streamResponsesOverWebSocket>[0],
  'onAssistantDelta' | 'onFunctionCallArgsDelta'
> {
  return {
    onAssistantDelta: (delta) => {
      channel.push({
        type: 'text_delta',
        text: delta.text,
        phase: delta.phase,
      });
      if (delta.text.length > 0) {
        options?.onAssistantDeltaCommitted?.();
      }
    },
    onFunctionCallArgsDelta: (delta) => {
      channel.push({
        type: 'tool_call_delta',
        itemId: delta.itemId,
        callId: delta.callId,
        toolName: delta.name,
        argsDelta: delta.argsDelta,
      });
      // 사용자에게 이미 보인 스트림 — 재시도 정책이 이중 스트림을 막도록
      // committed로 취급한다.
      options?.onAssistantDeltaCommitted?.();
    },
  };
}

async function callResponsesOnce(
  input: CallModelInput,
  channel: AsyncQueue<LLMChunk>,
  deps: CallModelDependencies,
  options?: CallResponsesOnceOptions,
): Promise<{
  itemsToAppend?: HistoryItem[];
  functionCalls: FunctionCall[];
  assistantText: string;
  finalText: string;
  artifactCandidate?: ProviderArtifactCandidate;
  structuredOutputs?: ProviderStructuredOutput[];
  providerUsageTelemetry?: ProviderUsageTelemetry;
}> {
  if (input.providerRequestOptions.providerId === 'grok_oauth') {
    return callGrokOAuthResponsesOnce(input, channel, deps, options);
  }
  return callCodexDirectResponsesOnce(input, channel, deps, options);
}

async function callCodexDirectResponsesOnce(
  input: CallModelInput,
  channel: AsyncQueue<LLMChunk>,
  deps: CallModelDependencies,
  options?: CallResponsesOnceOptions,
): Promise<{
  itemsToAppend?: HistoryItem[];
  functionCalls: FunctionCall[];
  assistantText: string;
  finalText: string;
  artifactCandidate?: ProviderArtifactCandidate;
  structuredOutputs?: ProviderStructuredOutput[];
  providerUsageTelemetry?: ProviderUsageTelemetry;
}> {
  const auth = await deps.getProviderAuth({
    ...(options?.allowRefresh !== undefined
      ? { allowRefresh: options.allowRefresh }
      : {}),
    runtimeStore: input.providerAuthRuntime,
  });
  const promptCacheProjection = buildCodexDirectPromptCacheProjection(input);
  const body = buildResponsesRequestBody(input, promptCacheProjection);
  const headers = buildResponsesRequestHeaders({
    accessToken: auth.accessToken,
    accountId: auth.accountId,
    providerSessionId: promptCacheProjection.wire.session_id,
  });
  const streamCallbacks = buildProviderStreamCallbacks(channel, options);

  const result = await deps.streamResponsesOverWebSocket({
    body,
    headers,
    history: input.history,
    providerSessionId: input.providerSessionId,
    webSocketReusePolicy: CODEX_DIRECT_RESPONSES_WEBSOCKET_REUSE_POLICY,
    providerWebSocketSessions: input.providerWebSocketSessions,
    ...(input.oauthWireDiscoverySink !== undefined
      ? { discoverySink: input.oauthWireDiscoverySink }
      : {}),
    ...streamCallbacks,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  if (
    result.itemsToAppend.some((item) => item.kind !== 'backend_item') ||
    (result.itemsToAppend.length === 0 &&
      (result.functionCalls.length > 0 ||
        result.assistantText.length > 0 ||
        result.finalText.length > 0))
  ) {
    throw new ProviderHistoryItemInvalidError();
  }

  return {
    ...(result.itemsToAppend.length > 0
      ? { itemsToAppend: result.itemsToAppend }
      : {}),
    functionCalls: result.functionCalls,
    assistantText: result.assistantText,
    finalText: result.finalText,
    ...(result.artifactCandidate !== undefined
      ? { artifactCandidate: result.artifactCandidate }
      : {}),
    ...(result.structuredOutputs !== undefined
      ? { structuredOutputs: result.structuredOutputs }
      : {}),
    ...(result.providerUsageTelemetry !== undefined
      ? { providerUsageTelemetry: result.providerUsageTelemetry }
      : {}),
  };
}

async function callGrokOAuthResponsesOnce(
  input: CallModelInput,
  channel: AsyncQueue<LLMChunk>,
  deps: CallModelDependencies,
  options?: CallResponsesOnceOptions,
): Promise<{
  itemsToAppend?: HistoryItem[];
  functionCalls: FunctionCall[];
  assistantText: string;
  finalText: string;
  artifactCandidate?: ProviderArtifactCandidate;
  structuredOutputs?: ProviderStructuredOutput[];
  providerUsageTelemetry?: ProviderUsageTelemetry;
}> {
  const auth = await deps.getProviderAuth({
    providerId: 'grok_oauth',
    ...(options?.allowRefresh !== undefined
      ? { allowRefresh: options.allowRefresh }
      : {}),
    runtimeStore: input.providerAuthRuntime,
  });
  const model = resolveGrokOAuthModelDescriptor(
    input.providerRequestOptions.model,
  );
  const instructions = buildProviderInstructions(input);
  const streamCallbacks = buildProviderStreamCallbacks(channel, options);
  const result = await (
    deps.streamGrokOAuthResponses ?? streamGrokOAuthResponses
  )(
    {
      model,
      accessToken: auth.accessToken,
      providerSessionId: input.providerSessionId,
      history: input.history,
      reasoningEffort: input.providerRequestOptions.reasoning.effort,
      providerWebSocketSessions: input.providerWebSocketSessions,
      ...(input.oauthWireDiscoverySink !== undefined
        ? { discoverySink: input.oauthWireDiscoverySink }
        : {}),
      ...(instructions !== undefined ? { instructions } : {}),
      ...(input.tools !== undefined ? { tools: input.tools } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    },
    streamCallbacks,
  );

  return {
    functionCalls: result.functionCalls,
    assistantText: result.assistantText,
    finalText: result.finalText,
    ...(result.artifactCandidate !== undefined
      ? { artifactCandidate: result.artifactCandidate }
      : {}),
    ...(result.structuredOutputs !== undefined
      ? { structuredOutputs: result.structuredOutputs }
      : {}),
    ...(result.providerUsageTelemetry !== undefined
      ? { providerUsageTelemetry: result.providerUsageTelemetry }
      : {}),
  };
}

async function callResponsesWithRetryPolicy(
  input: CallModelInput,
  channel: AsyncQueue<LLMChunk>,
  deps: CallModelDependencies,
  providerLogger: ReturnType<typeof logger.withContext>,
): Promise<{
  itemsToAppend?: HistoryItem[];
  functionCalls: FunctionCall[];
  assistantText: string;
  finalText: string;
  artifactCandidate?: ProviderArtifactCandidate;
  structuredOutputs?: ProviderStructuredOutput[];
  providerUsageTelemetry?: ProviderUsageTelemetry;
}> {
  let authRefreshAttempts = 0;

  for (;;) {
    let assistantDeltaCommitted = false;
    const attemptOptions: CallResponsesOnceOptions = {
      onAssistantDeltaCommitted: () => {
        assistantDeltaCommitted = true;
      },
    };
    if (authRefreshAttempts > 0) {
      attemptOptions.allowRefresh = false;
    }

    try {
      return await callResponsesOnce(input, channel, deps, attemptOptions);
    } catch (error: unknown) {
      const decision = decideProviderRetryPolicy({
        error,
        authRefreshAttempts,
      });
      if (decision.action === 'fail') {
        throw error;
      }
      if (!isProviderAuthRetryAvailable(input)) {
        providerLogger.info(
          'provider auth retry is unavailable for selected provider',
          {
            code: decision.code,
            providerId: input.providerRequestOptions.providerId,
          },
        );
        throw error;
      }
      if (assistantDeltaCommitted) {
        providerLogger.info(
          'provider auth failed after streamed output; not retrying',
          {
            code: decision.code,
          },
        );
        throw error;
      }

      providerLogger.info(
        'provider auth failed; forcing refresh before one retry',
        {
          code: decision.code,
        },
      );
      await forceRefreshSelectedProviderAuth(input, deps);
      authRefreshAttempts += 1;
      providerLogger.info('provider auth refresh succeeded; retrying once');
    }
  }
}

function buildPromptCacheTelemetryContext(input: CallModelInput): {
  promptCacheKeyHash?: string;
  stablePrefixFingerprint?: string;
  prefixFingerprintVersion?: string;
  cacheProjectionVersion: string;
} {
  let trace: PromptCacheProjection['trace'];
  if (input.providerRequestOptions.providerId === 'grok_oauth') {
    const model = resolveGrokOAuthModelDescriptor(
      input.providerRequestOptions.model,
    );
    trace = buildGrokOAuthPromptCacheProjection({
      model,
      providerSessionId: input.providerSessionId,
      prefixMaterial: buildProviderVisiblePrefixMaterial(input),
    }).trace;
  } else {
    trace = buildCodexDirectPromptCacheProjection(input).trace;
  }

  return {
    ...(trace.cacheKeyHash !== undefined
      ? { promptCacheKeyHash: trace.cacheKeyHash }
      : {}),
    ...(trace.stablePrefixFingerprint !== undefined
      ? { stablePrefixFingerprint: trace.stablePrefixFingerprint }
      : {}),
    ...(trace.prefixFingerprintVersion !== undefined
      ? { prefixFingerprintVersion: trace.prefixFingerprintVersion }
      : {}),
    cacheProjectionVersion: trace.projectionVersion,
  };
}

async function forceRefreshSelectedProviderAuth(
  input: CallModelInput,
  deps: CallModelDependencies,
): Promise<void> {
  if (input.providerRequestOptions.providerId === 'grok_oauth') {
    await deps.forceRefreshProviderAuth({
      providerId: 'grok_oauth',
      runtimeStore: input.providerAuthRuntime,
    });
    return;
  }

  await deps.forceRefreshProviderAuth({
    runtimeStore: input.providerAuthRuntime,
  });
}

function isProviderAuthRetryAvailable(input: CallModelInput): boolean {
  return (
    input.providerRequestOptions.providerId === 'openai_codex_direct' ||
    input.providerRequestOptions.providerId === 'grok_oauth'
  );
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
