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
import type { ProviderReplayScopeId } from '../../runtime-contracts.js';
import { isRecord } from '../../runtime-json.js';
import type { ProviderAuthRuntimeStore } from '../../auth/runtime-state.js';
import { createLogger } from '@geulbat/structured-logger/logger';
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
  buildQwenPromptCacheProjection,
  loadQwenTokenPlanConfig,
  streamQwenChatCompletions,
} from './qwen/index.js';
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
import {
  assertProviderReplayScope,
  createProviderReplayScopeId,
} from './provider-replay-scope.js';
import type { ProviderRequestOptions } from './provider-options.js';
import { ProviderHistoryItemInvalidError } from './transport/responses-wire-input.js';
import {
  streamResponsesOverWebSocket,
  type ResponsesRequestPreparedHandler,
  type ResponsesWireDiscoverySink,
} from './transport/responses-websocket.js';
import { resolveCodexResponsesUrl } from './transport/responses-websocket-url.js';
import type {
  ResponsesWebSocketAdmissionObserver,
  ResponsesWebSocketReusePolicy,
  ResponsesWebSocketSessionStore,
} from './transport/responses-websocket-cache.js';
import type {
  HistoryItem,
  FunctionCall,
  ModelRoundStopReason,
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
      stopReason?: ModelRoundStopReason;
    }
  | { type: 'error'; code: string; message: string };

export type ProviderRuntimeObservation =
  | { state: 'auth_waiting' }
  | { state: 'provider_waiting' }
  | { state: 'rate_limit_waiting' };

export type ProviderRuntimeObserver = (
  observation: ProviderRuntimeObservation,
) => void;

export interface CallModelInput {
  history: HistoryItem[];
  systemPrompt: string;
  promptContext?: string;
  tools?: WireToolDefinition[];
  deferredTools?: WireToolDefinition[];
  providerSessionId: string;
  providerWebSocketSessions: Pick<
    ResponsesWebSocketSessionStore,
    | 'acquireWebSocket'
    | 'streamDurableResponseEvents'
    | 'streamDurableHttpSseEvents'
  >;
  providerAuthRuntime: ProviderAuthRuntimeStore;
  providerRequestOptions: ProviderRequestOptions;
  providerReplayScopeId?: ProviderReplayScopeId;
  oauthWireDiscoverySink?: ResponsesWireDiscoverySink;
  onProviderRequestPrepared?: ResponsesRequestPreparedHandler;
  onProviderRuntimeState?: ProviderRuntimeObserver;
  signal?: AbortSignal;
}

interface CallModelDependencies {
  getProviderAuth: typeof getProviderAuth;
  forceRefreshProviderAuth: typeof forceRefreshProviderAuth;
  streamResponsesOverWebSocket: typeof streamResponsesOverWebSocket;
  streamGrokOAuthResponses?: typeof streamGrokOAuthResponses;
  streamQwenChatCompletions?: typeof streamQwenChatCompletions;
}

const defaultCallModelDependencies: CallModelDependencies = {
  getProviderAuth,
  forceRefreshProviderAuth,
  streamResponsesOverWebSocket,
  streamGrokOAuthResponses,
  streamQwenChatCompletions,
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
    toolCount: (input.tools?.length ?? 0) + (input.deferredTools?.length ?? 0),
    directToolCount: input.tools?.length ?? 0,
    deferredToolCount: input.deferredTools?.length ?? 0,
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
        stopReason,
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
        ...(stopReason !== undefined ? { stopReason } : {}),
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
  requestAttempt?: number;
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
  stopReason?: ModelRoundStopReason;
}> {
  if (
    input.deferredTools !== undefined &&
    input.deferredTools.length > 0 &&
    input.providerRequestOptions.providerId !== 'openai_codex_direct'
  ) {
    throw new Error(
      'deferred provider tools require the OpenAI Codex direct adapter',
    );
  }
  if (input.providerRequestOptions.providerId === 'qwen_token_plan') {
    return callQwenResponsesOnce(input, channel, deps, options);
  }
  if (input.providerRequestOptions.providerId === 'grok_oauth') {
    return callGrokOAuthResponsesOnce(input, channel, deps, options);
  }
  return callCodexDirectResponsesOnce(input, channel, deps, options);
}

async function callQwenResponsesOnce(
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
  stopReason?: ModelRoundStopReason;
}> {
  const config = await loadQwenTokenPlanConfig({
    model: input.providerRequestOptions.model,
  });
  const providerReplayScopeId = createProviderReplayScopeId({
    providerId: 'qwen_token_plan',
    accountId: config.credentialIdentity,
    endpoint: config.chatCompletionsUrl,
  });
  assertProviderReplayScope(providerReplayScopeId, input.providerReplayScopeId);
  const instructions = buildProviderInstructions(input);
  const result = await (
    deps.streamQwenChatCompletions ?? streamQwenChatCompletions
  )({
    config,
    history: input.history,
    providerReplayScopeId,
    providerSessionId: input.providerSessionId,
    requestAttempt: options?.requestAttempt ?? 0,
    providerRequestSessions: input.providerWebSocketSessions,
    ...(instructions === undefined ? {} : { instructions }),
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    ...(input.onProviderRequestPrepared === undefined
      ? {}
      : { onRequestPrepared: input.onProviderRequestPrepared }),
    ...(input.onProviderRuntimeState === undefined
      ? {}
      : {
          onProviderWaiting: () =>
            input.onProviderRuntimeState?.({ state: 'provider_waiting' }),
        }),
    ...buildProviderStreamCallbacks(channel, options),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const itemsToAppend = scopeProviderOutputBatch({
    ...result,
    providerReplayScopeId,
  });

  return {
    ...(itemsToAppend === undefined ? {} : { itemsToAppend }),
    functionCalls: result.functionCalls,
    assistantText: result.assistantText,
    finalText: result.finalText,
    ...(result.artifactCandidate === undefined
      ? {}
      : { artifactCandidate: result.artifactCandidate }),
    ...(result.structuredOutputs === undefined
      ? {}
      : { structuredOutputs: result.structuredOutputs }),
    ...(result.providerUsageTelemetry === undefined
      ? {}
      : { providerUsageTelemetry: result.providerUsageTelemetry }),
    ...(result.stopReason === undefined
      ? {}
      : { stopReason: result.stopReason }),
  };
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
  stopReason?: ModelRoundStopReason;
}> {
  const auth = await getSelectedProviderAuth(input, deps, options);
  const promptCacheProjection = buildCodexDirectPromptCacheProjection(input);
  const providerReplayScopeId = createProviderReplayScopeId({
    providerId: 'openai_codex_direct',
    accountId: auth.accountId,
    endpoint: resolveCodexResponsesUrl(),
  });
  assertProviderReplayScope(providerReplayScopeId, input.providerReplayScopeId);
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
    historyProjection: 'provider_output',
    history: input.history,
    providerReplayScopeId,
    providerSessionId: input.providerSessionId,
    requestAttempt: options?.requestAttempt ?? 0,
    webSocketReusePolicy: CODEX_DIRECT_RESPONSES_WEBSOCKET_REUSE_POLICY,
    providerWebSocketSessions: input.providerWebSocketSessions,
    ...(input.oauthWireDiscoverySink !== undefined
      ? { discoverySink: input.oauthWireDiscoverySink }
      : {}),
    ...(input.onProviderRequestPrepared !== undefined
      ? { onRequestPrepared: input.onProviderRequestPrepared }
      : {}),
    ...(input.onProviderRuntimeState !== undefined
      ? { onAdmissionState: createProviderAdmissionObserver(input) }
      : {}),
    ...streamCallbacks,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  const itemsToAppend = scopeProviderOutputBatch({
    ...result,
    providerReplayScopeId,
  });

  return {
    ...(itemsToAppend === undefined ? {} : { itemsToAppend }),
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
    ...(result.stopReason !== undefined
      ? { stopReason: result.stopReason }
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
  stopReason?: ModelRoundStopReason;
}> {
  const auth = await getSelectedProviderAuth(input, deps, options);
  const model = resolveGrokOAuthModelDescriptor(
    input.providerRequestOptions.model,
  );
  const providerReplayScopeId = createProviderReplayScopeId({
    providerId: 'grok_oauth',
    accountId: auth.accountId,
    endpoint: model.baseUrl,
  });
  assertProviderReplayScope(providerReplayScopeId, input.providerReplayScopeId);
  const instructions = buildProviderInstructions(input);
  const streamCallbacks = buildProviderStreamCallbacks(channel, options);
  const result = await (
    deps.streamGrokOAuthResponses ?? streamGrokOAuthResponses
  )(
    {
      model,
      accessToken: auth.accessToken,
      providerReplayScopeId,
      providerSessionId: input.providerSessionId,
      requestAttempt: options?.requestAttempt ?? 0,
      history: input.history,
      reasoningEffort: input.providerRequestOptions.reasoning.effort,
      providerWebSocketSessions: input.providerWebSocketSessions,
      ...(input.oauthWireDiscoverySink !== undefined
        ? { discoverySink: input.oauthWireDiscoverySink }
        : {}),
      ...(input.onProviderRequestPrepared !== undefined
        ? { onRequestPrepared: input.onProviderRequestPrepared }
        : {}),
      ...(input.onProviderRuntimeState !== undefined
        ? { onAdmissionState: createProviderAdmissionObserver(input) }
        : {}),
      ...(instructions !== undefined ? { instructions } : {}),
      ...(input.tools !== undefined ? { tools: input.tools } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    },
    streamCallbacks,
  );
  const itemsToAppend = scopeProviderOutputBatch({
    ...result,
    providerReplayScopeId,
  });

  return {
    ...(itemsToAppend === undefined ? {} : { itemsToAppend }),
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
    ...(result.stopReason !== undefined
      ? { stopReason: result.stopReason }
      : {}),
  };
}

function scopeProviderOutputBatch(args: {
  itemsToAppend: HistoryItem[];
  functionCalls: readonly FunctionCall[];
  assistantText: string;
  finalText: string;
  providerReplayScopeId: ProviderReplayScopeId;
}): HistoryItem[] | undefined {
  if (
    args.itemsToAppend.length === 0 &&
    (args.functionCalls.length > 0 ||
      args.assistantText.length > 0 ||
      args.finalText.length > 0)
  ) {
    throw new ProviderHistoryItemInvalidError();
  }

  const scopedItems: HistoryItem[] = [];
  const rawCalls = new Map<
    string,
    { id: string; name: string; arguments: string }
  >();
  let hasMessageItem = false;
  for (const item of args.itemsToAppend) {
    if (item.kind !== 'backend_item' || !isRecord(item.data)) {
      throw new ProviderHistoryItemInvalidError();
    }
    scopedItems.push({
      ...item,
      providerReplayScopeId: args.providerReplayScopeId,
    });

    if (item.data['type'] === 'reasoning') {
      continue;
    }
    if (item.data['type'] === 'message') {
      hasMessageItem = true;
      continue;
    }
    if (item.data['type'] !== 'function_call') {
      continue;
    }

    const id = item.data['id'];
    const callId = item.data['call_id'];
    const name = item.data['name'];
    const callArguments = item.data['arguments'];
    if (
      typeof id !== 'string' ||
      id.trim() === '' ||
      typeof callId !== 'string' ||
      callId.trim() === '' ||
      typeof name !== 'string' ||
      name.trim() === '' ||
      typeof callArguments !== 'string' ||
      rawCalls.has(callId)
    ) {
      throw new ProviderHistoryItemInvalidError();
    }
    rawCalls.set(callId, { id, name, arguments: callArguments });
  }

  if (
    rawCalls.size !== args.functionCalls.length ||
    !args.functionCalls.every((call) => {
      const raw = rawCalls.get(call.callId);
      return (
        raw !== undefined &&
        raw.id === call.id &&
        raw.name === call.name &&
        raw.arguments === call.arguments
      );
    }) ||
    ((args.assistantText.length > 0 || args.finalText.length > 0) &&
      !hasMessageItem)
  ) {
    throw new ProviderHistoryItemInvalidError();
  }
  return scopedItems.length === 0 ? undefined : scopedItems;
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
  stopReason?: ModelRoundStopReason;
}> {
  let authRefreshAttempts = 0;

  for (;;) {
    let assistantDeltaCommitted = false;
    const attemptOptions: CallResponsesOnceOptions = {
      requestAttempt: authRefreshAttempts,
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
  if (input.providerRequestOptions.providerId === 'qwen_token_plan') {
    trace = buildQwenPromptCacheProjection({
      model: input.providerRequestOptions.model,
      providerSessionId: input.providerSessionId,
      prefixMaterial: buildProviderVisiblePrefixMaterial(input),
    }).trace;
  } else if (input.providerRequestOptions.providerId === 'grok_oauth') {
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

function resolveSelectedOAuthProviderId(input: CallModelInput) {
  const providerId = input.providerRequestOptions.providerId;
  if (providerId === 'qwen_token_plan') {
    throw new Error('Qwen Token Plan does not use provider OAuth.');
  }
  return providerId;
}

async function forceRefreshSelectedProviderAuth(
  input: CallModelInput,
  deps: CallModelDependencies,
): Promise<void> {
  await observeProviderAuthWait(input, (onWait) =>
    deps.forceRefreshProviderAuth({
      providerId: resolveSelectedOAuthProviderId(input),
      onWait,
      runtimeStore: input.providerAuthRuntime,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    }),
  );
}

async function getSelectedProviderAuth(
  input: CallModelInput,
  deps: CallModelDependencies,
  options?: CallResponsesOnceOptions,
): Promise<{ accessToken: string; accountId: string }> {
  return observeProviderAuthWait(input, (onWait) =>
    deps.getProviderAuth({
      providerId: resolveSelectedOAuthProviderId(input),
      ...(options?.allowRefresh !== undefined
        ? { allowRefresh: options.allowRefresh }
        : {}),
      onWait,
      runtimeStore: input.providerAuthRuntime,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    }),
  );
}

async function observeProviderAuthWait<T>(
  input: CallModelInput,
  operation: (onWait: () => void) => Promise<T>,
): Promise<T> {
  let waitObserved = false;
  const result = await operation(() => {
    waitObserved = true;
    input.onProviderRuntimeState?.({ state: 'auth_waiting' });
  });
  if (waitObserved) {
    input.onProviderRuntimeState?.({ state: 'provider_waiting' });
  }
  return result;
}

function createProviderAdmissionObserver(
  input: CallModelInput,
): ResponsesWebSocketAdmissionObserver {
  return (observation) => {
    input.onProviderRuntimeState?.({
      state:
        observation.state === 'admitted'
          ? 'provider_waiting'
          : 'rate_limit_waiting',
    });
  };
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
