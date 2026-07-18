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
import { isJsonValue, type JsonValue } from '../../runtime-json.js';
import { AsyncQueue } from './async-queue.js';
import {
  CODEX_DIRECT_PROVIDER_CACHE_PROFILE,
  buildPromptCacheProjection,
  hashProviderTraceIdentity,
  type ProviderVisiblePrefixMaterial,
  type PromptCacheProjection,
} from './provider-cache-projection.js';
import { buildProviderCacheTelemetryLogFields } from './provider-cache-telemetry.js';
import {
  buildGrokOAuthPromptCacheProjection,
  buildGrokOAuthResponsesHeaders,
  resolveGrokOAuthModelDescriptor,
  streamGrokOAuthResponses,
} from './grok-oauth-transport.js';
import {
  normalizeProviderErrorCode,
  sanitizeProviderErrorMessage,
} from './provider-error.js';
import { decideProviderRetryPolicy } from './provider-retry-policy.js';
import type { ProviderRequestOptions } from './provider-options.js';
import { buildResponseWireInput } from './transport/responses-wire-input.js';
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
  ProviderNativeCompactionOutputItem,
  WireRequestBase,
  WireToolDefinition,
} from './wire/types.js';

const BETA_HEADER = process.env.GEULBAT_BETA_HEADER ?? 'responses=experimental';
const ORIGINATOR_HEADER = process.env.GEULBAT_ORIGINATOR ?? 'codex_cli_rs';
const DEFAULT_CODEX_RESPONSES_URL =
  'https://chatgpt.com/backend-api/codex/responses';
const CODEX_AUTO_COMPACT_CONTEXT_NUMERATOR = 9;
const CODEX_AUTO_COMPACT_CONTEXT_DENOMINATOR = 10;
const GROK_BUILD_AUTO_COMPACT_CONTEXT_NUMERATOR = 85;
const GROK_BUILD_AUTO_COMPACT_CONTEXT_DENOMINATOR = 100;

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

export type ProviderNativeCompactionInput = Pick<
  CallModelInput,
  | 'history'
  | 'systemPrompt'
  | 'promptContext'
  | 'tools'
  | 'providerSessionId'
  | 'providerAuthRuntime'
  | 'providerRequestOptions'
  | 'signal'
>;

export type OpenAiNativeCompactionInput = ProviderNativeCompactionInput;

export interface OpenAiNativeCompactionPolicy {
  providerId: 'openai_codex_direct';
  model: string;
  contextWindow: number;
  thresholdTokens: number;
  supportsParallelToolCalls: boolean;
}

export interface GrokNativeCompactionPolicy {
  providerId: 'grok_oauth';
  model: string;
  contextWindow: number;
  thresholdTokens: number;
}

export type ProviderNativeCompactionPolicy =
  | OpenAiNativeCompactionPolicy
  | GrokNativeCompactionPolicy;

export interface CompactOpenAiHistoryResult {
  output: ProviderNativeCompactionOutputItem[];
}

export interface OpenAiNativeCompactionDependencies {
  getProviderAuth: typeof getProviderAuth;
  forceRefreshProviderAuth: typeof forceRefreshProviderAuth;
  fetchImpl: typeof fetch;
  responsesUrl?: string;
  clientVersion?: string;
}

export interface GrokNativeCompactionDependencies {
  getProviderAuth: typeof getProviderAuth;
  forceRefreshProviderAuth: typeof forceRefreshProviderAuth;
  fetchImpl: typeof fetch;
}

type ProviderPromptInput = Pick<
  CallModelInput,
  | 'systemPrompt'
  | 'promptContext'
  | 'tools'
  | 'providerSessionId'
  | 'providerRequestOptions'
>;

interface CallModelDependencies {
  getProviderAuth: typeof getProviderAuth;
  forceRefreshProviderAuth: typeof forceRefreshProviderAuth;
  streamResponsesOverWebSocket: typeof streamResponsesOverWebSocket;
  streamGrokOAuthResponses?: typeof streamGrokOAuthResponses;
}

type CodexDirectPromptCacheProjection = PromptCacheProjection & {
  wire: PromptCacheProjection['wire'] & {
    session_id: string;
    prompt_cache_key: string;
  };
};

const defaultCallModelDependencies: CallModelDependencies = {
  getProviderAuth,
  forceRefreshProviderAuth,
  streamResponsesOverWebSocket,
  streamGrokOAuthResponses,
};

const defaultOpenAiNativeCompactionDependencies: OpenAiNativeCompactionDependencies =
  {
    getProviderAuth,
    forceRefreshProviderAuth,
    fetchImpl: globalThis.fetch,
  };

const defaultGrokNativeCompactionDependencies: GrokNativeCompactionDependencies =
  {
    getProviderAuth,
    forceRefreshProviderAuth,
    fetchImpl: globalThis.fetch,
  };

const logger = createLogger('llm/provider/client');

// ── Main export ──

export async function* callModel(
  input: CallModelInput,
): AsyncGenerator<LLMChunk> {
  yield* callModelWithDependencies(input, defaultCallModelDependencies);
}

export async function resolveOpenAiNativeCompactionPolicy(
  input: OpenAiNativeCompactionInput,
  deps: OpenAiNativeCompactionDependencies = defaultOpenAiNativeCompactionDependencies,
): Promise<OpenAiNativeCompactionPolicy> {
  assertOpenAiNativeCompactionInput(input);
  const responsesUrl = resolveCodexResponsesUrl(deps.responsesUrl);
  const modelsUrl = new URL(responsesUrl);
  modelsUrl.pathname = modelsUrl.pathname.replace(/\/responses$/, '/models');
  modelsUrl.searchParams.set(
    'client_version',
    deps.clientVersion ?? process.env.npm_package_version ?? '0.0.0',
  );

  const payload = await requestOpenAiOAuthJson(input, deps, async (auth) => {
    const headers = buildResponsesRequestHeaders({
      accessToken: auth.accessToken,
      accountId: auth.accountId,
      providerSessionId: input.providerSessionId,
    });
    headers.set('accept', 'application/json');
    const response = await deps.fetchImpl(modelsUrl, {
      method: 'GET',
      headers,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    return parseOpenAiOAuthJsonResponse(response, 'model catalog');
  });
  const model = readOpenAiModelDescriptor(
    payload,
    input.providerRequestOptions.model,
  );
  const compatibilityThreshold = Math.floor(
    (model.contextWindow * CODEX_AUTO_COMPACT_CONTEXT_NUMERATOR) /
      CODEX_AUTO_COMPACT_CONTEXT_DENOMINATOR,
  );
  const thresholdTokens =
    model.autoCompactTokenLimit === undefined
      ? compatibilityThreshold
      : Math.min(model.autoCompactTokenLimit, compatibilityThreshold);
  if (!Number.isSafeInteger(thresholdTokens) || thresholdTokens <= 0) {
    throw new Error(
      'OpenAI model catalog returned an invalid compact threshold',
    );
  }

  return {
    providerId: 'openai_codex_direct',
    model: input.providerRequestOptions.model,
    contextWindow: model.contextWindow,
    thresholdTokens,
    supportsParallelToolCalls: model.supportsParallelToolCalls,
  };
}

export async function compactOpenAiHistory(
  input: OpenAiNativeCompactionInput,
  policy: OpenAiNativeCompactionPolicy,
  deps: OpenAiNativeCompactionDependencies = defaultOpenAiNativeCompactionDependencies,
): Promise<CompactOpenAiHistoryResult> {
  assertOpenAiNativeCompactionInput(input);
  if (
    policy.providerId !== input.providerRequestOptions.providerId ||
    policy.model !== input.providerRequestOptions.model
  ) {
    throw new Error(
      'OpenAI native compaction policy does not match the selected provider and model',
    );
  }

  const promptCacheProjection = buildCodexDirectPromptCacheProjection(input);
  const instructions = buildProviderInstructions(input);
  const body = {
    model: policy.model,
    input: buildResponseWireInput(input.history, {
      providerId: policy.providerId,
      model: policy.model,
    }),
    ...(instructions !== undefined ? { instructions } : {}),
    ...(input.tools !== undefined && input.tools.length > 0
      ? { tools: input.tools }
      : {}),
    parallel_tool_calls: policy.supportsParallelToolCalls,
    reasoning: input.providerRequestOptions.reasoning,
    prompt_cache_key: promptCacheProjection.wire.prompt_cache_key,
    text: input.providerRequestOptions.text,
  };
  const compactUrl = `${resolveCodexResponsesUrl(deps.responsesUrl)}/compact`;
  const payload = await requestOpenAiOAuthJson(input, deps, async (auth) => {
    const headers = buildResponsesRequestHeaders({
      accessToken: auth.accessToken,
      accountId: auth.accountId,
      providerSessionId: input.providerSessionId,
    });
    headers.set('accept', 'application/json');
    const response = await deps.fetchImpl(compactUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    return parseOpenAiOAuthJsonResponse(response, 'native compaction');
  });

  return { output: readProviderNativeCompactionOutput(payload) };
}

export async function resolveGrokNativeCompactionPolicy(
  input: ProviderNativeCompactionInput,
  deps: GrokNativeCompactionDependencies = defaultGrokNativeCompactionDependencies,
): Promise<GrokNativeCompactionPolicy> {
  assertGrokNativeCompactionInput(input);
  const model = resolveGrokOAuthModelDescriptor(
    input.providerRequestOptions.model,
  );
  const modelUrl = `${model.baseUrl.replace(/\/+$/u, '')}/models/${encodeURIComponent(model.wireModel)}`;
  const payload = await requestGrokOAuthJson(input, deps, async (auth) => {
    const headers = buildGrokOAuthResponsesHeaders({
      accessToken: auth.accessToken,
    });
    headers.set('accept', 'application/json');
    const response = await deps.fetchImpl(modelUrl, {
      method: 'GET',
      headers,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    return parseGrokOAuthJsonResponse(response, 'model descriptor');
  });
  const contextWindow = readGrokModelContextWindow(payload, model.wireModel);
  const thresholdTokens = Math.floor(
    (contextWindow * GROK_BUILD_AUTO_COMPACT_CONTEXT_NUMERATOR) /
      GROK_BUILD_AUTO_COMPACT_CONTEXT_DENOMINATOR,
  );
  if (!Number.isSafeInteger(thresholdTokens) || thresholdTokens <= 0) {
    throw new Error(
      'Grok model descriptor produced an invalid Grok Build compatibility compact threshold',
    );
  }

  return {
    providerId: 'grok_oauth',
    model: model.id,
    contextWindow,
    thresholdTokens,
  };
}

export async function compactGrokHistory(
  input: ProviderNativeCompactionInput,
  policy: GrokNativeCompactionPolicy,
  deps: GrokNativeCompactionDependencies = defaultGrokNativeCompactionDependencies,
): Promise<CompactOpenAiHistoryResult> {
  assertGrokNativeCompactionInput(input);
  const model = resolveGrokOAuthModelDescriptor(
    input.providerRequestOptions.model,
  );
  if (policy.providerId !== model.providerId || policy.model !== model.id) {
    throw new Error(
      'Grok native compaction policy does not match the selected provider and model',
    );
  }

  const instructions = buildProviderInstructions(input);
  const body = {
    model: model.wireModel,
    input: [
      ...(instructions === undefined
        ? []
        : [{ role: 'system', content: instructions }]),
      ...buildResponseWireInput(input.history, {
        providerId: model.providerId,
        model: model.id,
      }),
    ],
  };
  const compactUrl = `${model.baseUrl.replace(/\/+$/u, '')}/responses/compact`;
  const payload = await requestGrokOAuthJson(input, deps, async (auth) => {
    const headers = buildGrokOAuthResponsesHeaders({
      accessToken: auth.accessToken,
    });
    headers.set('accept', 'application/json');
    headers.set('content-type', 'application/json');
    const response = await deps.fetchImpl(compactUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    return parseGrokOAuthJsonResponse(response, 'native compaction');
  });

  return { output: readGrokProviderNativeCompactionOutput(payload) };
}

export async function resolveProviderNativeCompactionPolicy(
  input: ProviderNativeCompactionInput,
): Promise<ProviderNativeCompactionPolicy> {
  switch (input.providerRequestOptions.providerId) {
    case 'openai_codex_direct':
      return await resolveOpenAiNativeCompactionPolicy(input);
    case 'grok_oauth':
      return await resolveGrokNativeCompactionPolicy(input);
    default:
      throw new Error(
        'provider-native compaction is not available for the selected provider',
      );
  }
}

export async function compactProviderNativeHistory(
  input: ProviderNativeCompactionInput,
  policy: ProviderNativeCompactionPolicy,
): Promise<CompactOpenAiHistoryResult> {
  switch (policy.providerId) {
    case 'openai_codex_direct':
      return await compactOpenAiHistory(input, policy);
    case 'grok_oauth':
      return await compactGrokHistory(input, policy);
  }
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
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  return {
    ...(result.itemsToAppend.length > 0 &&
    result.itemsToAppend.every((item) => item.kind === 'backend_item')
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
    {
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
        options?.onAssistantDeltaCommitted?.();
      },
    },
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

function buildResponsesRequestBody(
  input: CallModelInput,
  promptCacheProjection: CodexDirectPromptCacheProjection,
): WireRequestBase {
  const requestOptions = input.providerRequestOptions;
  const instructions = buildProviderInstructions(input);
  const body: WireRequestBase = {
    model: requestOptions.model,
    store: false,
    stream: true,
    text: requestOptions.text,
    include: ['reasoning.encrypted_content'],
    ...(promptCacheProjection.wire.prompt_cache_key !== undefined
      ? { prompt_cache_key: promptCacheProjection.wire.prompt_cache_key }
      : {}),
    reasoning: requestOptions.reasoning,
    ...(instructions !== undefined ? { instructions } : {}),
  };

  if (input.tools && input.tools.length > 0) {
    body.tools = input.tools;
    body.tool_choice = 'auto';
  }

  return body;
}

function buildProviderInstructions(
  input: ProviderPromptInput,
): string | undefined {
  const parts: string[] = [];
  for (const part of [input.systemPrompt, input.promptContext]) {
    const trimmed = part?.trim();
    if (trimmed) {
      parts.push(trimmed);
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

function buildProviderVisiblePrefixMaterial(
  input: ProviderPromptInput,
): ProviderVisiblePrefixMaterial {
  const instructions = buildProviderInstructions(input);
  return {
    ...(instructions !== undefined ? { instructions } : {}),
    ...(input.tools !== undefined && input.tools.length > 0
      ? { tools: input.tools }
      : {}),
  };
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

function buildCodexDirectPromptCacheProjection(
  input: ProviderPromptInput,
): CodexDirectPromptCacheProjection {
  const projection = buildPromptCacheProjection({
    profile: CODEX_DIRECT_PROVIDER_CACHE_PROFILE,
    identities: {
      conversationIdentity: input.providerSessionId,
      cacheGroupingIdentity: input.providerSessionId,
    },
    providerId: 'openai_codex_direct',
    routeFamily: 'openai_codex_responses',
    modelId: input.providerRequestOptions.model,
    includeSessionId: true,
    prefixMaterial: buildProviderVisiblePrefixMaterial(input),
  });
  if (projection.wire.prompt_cache_key === undefined) {
    throw new Error('Codex direct prompt cache projection is missing key');
  }
  if (projection.wire.session_id === undefined) {
    throw new Error('Codex direct prompt cache projection is missing session');
  }
  return {
    ...projection,
    wire: {
      ...projection.wire,
      session_id: projection.wire.session_id,
      prompt_cache_key: projection.wire.prompt_cache_key,
    },
  };
}

// media/image 어댑터도 같은 Codex 요청 헤더 조립을 재사용한다(이중화 금지).
export function buildResponsesRequestHeaders(args: {
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

class OpenAiOAuthHttpError extends Error {
  readonly status: number;

  constructor(operation: string, status: number) {
    super(`OpenAI OAuth ${operation} request failed with status ${status}`);
    this.name = 'OpenAiOAuthHttpError';
    this.status = status;
  }
}

class GrokOAuthHttpError extends Error {
  readonly status: number;

  constructor(operation: string, status: number) {
    super(`Grok OAuth ${operation} request failed with status ${status}`);
    this.name = 'GrokOAuthHttpError';
    this.status = status;
  }
}

function assertOpenAiNativeCompactionInput(
  input: OpenAiNativeCompactionInput,
): void {
  if (input.providerRequestOptions.providerId !== 'openai_codex_direct') {
    throw new Error(
      'provider-native compaction is not available for the selected provider',
    );
  }
}

function assertGrokNativeCompactionInput(
  input: ProviderNativeCompactionInput,
): void {
  if (input.providerRequestOptions.providerId !== 'grok_oauth') {
    throw new Error(
      'Grok native compaction is not available for the selected provider',
    );
  }
}

function resolveCodexResponsesUrl(configuredUrl?: string): string {
  const normalized = (
    configuredUrl ??
    process.env.GEULBAT_BACKEND_URL ??
    DEFAULT_CODEX_RESPONSES_URL
  ).replace(/\/+$/, '');
  if (normalized.endsWith('/codex/responses')) {
    return normalized;
  }
  if (normalized.endsWith('/codex')) {
    return `${normalized}/responses`;
  }
  return `${normalized}/codex/responses`;
}

async function requestOpenAiOAuthJson(
  input: OpenAiNativeCompactionInput,
  deps: OpenAiNativeCompactionDependencies,
  request: (auth: {
    accessToken: string;
    accountId: string;
  }) => Promise<unknown>,
): Promise<unknown> {
  let authRefreshAttempts = 0;

  for (;;) {
    const auth = await deps.getProviderAuth({
      ...(authRefreshAttempts > 0 ? { allowRefresh: false } : {}),
      runtimeStore: input.providerAuthRuntime,
    });
    try {
      return await request(auth);
    } catch (error: unknown) {
      const decision = decideProviderRetryPolicy({
        error,
        authRefreshAttempts,
      });
      if (decision.action === 'fail') {
        throw error;
      }
      logger.info(
        'OpenAI native compaction auth failed; forcing refresh before one retry',
        { code: decision.code },
      );
      await deps.forceRefreshProviderAuth({
        runtimeStore: input.providerAuthRuntime,
      });
      authRefreshAttempts += 1;
    }
  }
}

async function requestGrokOAuthJson(
  input: ProviderNativeCompactionInput,
  deps: GrokNativeCompactionDependencies,
  request: (auth: { accessToken: string }) => Promise<unknown>,
): Promise<unknown> {
  let authRefreshAttempts = 0;

  for (;;) {
    const auth = await deps.getProviderAuth({
      providerId: 'grok_oauth',
      ...(authRefreshAttempts > 0 ? { allowRefresh: false } : {}),
      runtimeStore: input.providerAuthRuntime,
    });
    try {
      return await request(auth);
    } catch (error: unknown) {
      const decision = decideProviderRetryPolicy({
        error,
        authRefreshAttempts,
      });
      if (decision.action === 'fail') {
        throw error;
      }
      logger.info(
        'Grok native compaction auth failed; forcing refresh before one retry',
        { code: decision.code },
      );
      await deps.forceRefreshProviderAuth({
        providerId: 'grok_oauth',
        runtimeStore: input.providerAuthRuntime,
      });
      authRefreshAttempts += 1;
    }
  }
}

async function parseOpenAiOAuthJsonResponse(
  response: Response,
  operation: string,
): Promise<unknown> {
  if (!response.ok) {
    throw new OpenAiOAuthHttpError(operation, response.status);
  }
  try {
    return await response.json();
  } catch (error: unknown) {
    throw new Error(`OpenAI OAuth ${operation} returned invalid JSON`, {
      cause: error,
    });
  }
}

async function parseGrokOAuthJsonResponse(
  response: Response,
  operation: string,
): Promise<unknown> {
  if (!response.ok) {
    throw new GrokOAuthHttpError(operation, response.status);
  }
  try {
    return await response.json();
  } catch (error: unknown) {
    throw new Error(`Grok OAuth ${operation} returned invalid JSON`, {
      cause: error,
    });
  }
}

interface OpenAiModelDescriptor {
  contextWindow: number;
  autoCompactTokenLimit?: number;
  supportsParallelToolCalls: boolean;
}

function readOpenAiModelDescriptor(
  payload: unknown,
  selectedModel: string,
): OpenAiModelDescriptor {
  if (!isJsonRecord(payload) || !Array.isArray(payload['models'])) {
    throw new Error('OpenAI model catalog response is invalid');
  }
  const model = payload['models'].find(
    (candidate) =>
      isJsonRecord(candidate) && candidate['slug'] === selectedModel,
  );
  if (!isJsonRecord(model)) {
    throw new Error(
      `selected OpenAI model is missing from the OAuth model catalog: ${selectedModel}`,
    );
  }
  const contextWindowValue =
    model['context_window'] ?? model['max_context_window'];
  const contextWindow = readPositiveSafeInteger(
    contextWindowValue,
    'context window',
  );
  const autoCompactTokenLimitValue = model['auto_compact_token_limit'];
  const autoCompactTokenLimit =
    autoCompactTokenLimitValue === undefined ||
    autoCompactTokenLimitValue === null
      ? undefined
      : readPositiveSafeInteger(
          autoCompactTokenLimitValue,
          'auto compact token limit',
        );
  if (typeof model['supports_parallel_tool_calls'] !== 'boolean') {
    throw new Error(
      'OpenAI model catalog returned an invalid parallel tool-call capability',
    );
  }
  return {
    contextWindow,
    ...(autoCompactTokenLimit !== undefined ? { autoCompactTokenLimit } : {}),
    supportsParallelToolCalls: model['supports_parallel_tool_calls'],
  };
}

function readPositiveSafeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`OpenAI model catalog returned an invalid ${field}`);
  }
  return value;
}

function readGrokModelContextWindow(
  payload: unknown,
  expectedModel: string,
): number {
  if (!isJsonRecord(payload) || payload['id'] !== expectedModel) {
    throw new Error(
      `selected Grok model is missing from the OAuth model descriptor: ${expectedModel}`,
    );
  }
  const contextWindow = payload['context_length'];
  if (
    typeof contextWindow !== 'number' ||
    !Number.isSafeInteger(contextWindow) ||
    contextWindow <= 0
  ) {
    throw new Error('Grok model descriptor returned an invalid context length');
  }
  return contextWindow;
}

function readProviderNativeCompactionOutput(
  payload: unknown,
): ProviderNativeCompactionOutputItem[] {
  if (!isJsonRecord(payload) || !Array.isArray(payload['output'])) {
    throw new Error('OpenAI native compaction response is invalid');
  }
  const output = payload['output'].map((item) => {
    if (!isJsonRecord(item)) {
      throw new Error(
        'OpenAI native compaction returned an invalid output item',
      );
    }
    const normalized = { ...item };
    delete normalized['id'];
    return normalized;
  });
  const hasEncryptedCompaction = output.some(
    (item) =>
      (item['type'] === 'compaction' ||
        item['type'] === 'compaction_summary') &&
      typeof item['encrypted_content'] === 'string' &&
      item['encrypted_content'].length > 0,
  );
  if (!hasEncryptedCompaction) {
    throw new Error(
      'OpenAI native compaction response is missing encrypted compaction output',
    );
  }
  return output;
}

function readGrokProviderNativeCompactionOutput(
  payload: unknown,
): ProviderNativeCompactionOutputItem[] {
  if (!isJsonRecord(payload) || !Array.isArray(payload['output'])) {
    throw new Error('Grok native compaction response is invalid');
  }
  const output = payload['output'].map((item) => {
    if (!isJsonRecord(item)) {
      throw new Error('Grok native compaction returned an invalid output item');
    }
    return item;
  });
  const hasEncryptedCompaction = output.some(
    (item) =>
      item['type'] === 'compaction' &&
      typeof item['encrypted_content'] === 'string' &&
      item['encrypted_content'].length > 0,
  );
  if (!hasEncryptedCompaction) {
    throw new Error(
      'Grok native compaction response is missing encrypted compaction output',
    );
  }
  return output;
}

function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    isJsonValue(value)
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
