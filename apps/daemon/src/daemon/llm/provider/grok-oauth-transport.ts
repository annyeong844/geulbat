import {
  buildPromptCacheProjection,
  type ProviderCacheProfile,
  type ProviderVisiblePrefixMaterial,
  type PromptCacheIntent,
  type PromptCacheProjection,
} from './provider-cache-projection.js';
import type { ProviderReplayScopeId } from '../../runtime-contracts.js';
import { isRecord } from '../../runtime-json.js';
import { buildResponseWireInput } from './transport/responses-wire-input.js';
import {
  streamResponsesOverWebSocket,
  type ResponsesWireDiscoverySink,
} from './transport/responses-websocket.js';
import type {
  AssistantDelta,
  FunctionCallArgsDelta,
} from './transport/responses-parser-shared.js';
import type {
  ResponsesWebSocketReusePolicy,
  ResponsesWebSocketSessionStore,
} from './transport/responses-websocket-cache.js';
import type {
  CallResult,
  HistoryItem,
  WireToolDefinition,
} from './wire/types.js';
import type { ProviderRequestOptions } from './provider-options.js';

type GrokOAuthRouteFamily = 'xai_public_responses';

type GrokOAuthModelId = 'grok-4.5';

type GrokOAuthWireModel = 'grok-4.5';
type GrokOAuthReasoningEffort = 'low' | 'medium' | 'high';

interface GrokOAuthModelDescriptor {
  id: GrokOAuthModelId;
  providerId: 'grok_oauth';
  wireModel: GrokOAuthWireModel;
  baseUrl: string;
  routeFamily: GrokOAuthRouteFamily;
}

interface GrokOAuthResponsesHeaderInput {
  accessToken: string;
  conversationRoutingId?: string;
}

interface GrokOAuthResponsesBodyInput {
  model: GrokOAuthModelDescriptor;
  providerReplayScopeId?: ProviderReplayScopeId;
  providerSessionId: string;
  history: HistoryItem[];
  instructions?: string;
  tools?: WireToolDefinition[];
  reasoningEffort: ProviderRequestOptions['reasoning']['effort'];
  promptCacheIntent?: PromptCacheIntent;
}

interface GrokOAuthResponsesStreamInput extends GrokOAuthResponsesBodyInput {
  accessToken: string;
  providerWebSocketSessions: Pick<
    ResponsesWebSocketSessionStore,
    'acquireWebSocket'
  >;
  signal?: AbortSignal;
  discoverySink?: ResponsesWireDiscoverySink;
  conversationRoutingId?: string;
}

interface GrokOAuthResponsesStreamOptions {
  onAssistantDelta?: (delta: AssistantDelta) => void;
  onFunctionCallArgsDelta?: (delta: FunctionCallArgsDelta) => void;
}

interface GrokOAuthResponsesRequestBody {
  model: GrokOAuthWireModel;
  store: false;
  input: unknown[];
  instructions?: string;
  tools?: WireToolDefinition[];
  tool_choice?: 'auto';
  prompt_cache_key?: string;
  reasoning: { effort: GrokOAuthReasoningEffort };
}

export const GROK_OAUTH_RESPONSES_BASE_URL = 'https://api.x.ai/v1';

// xAI does not publish a guaranteed prompt-cache TTL: entries may be evicted
// at any time. Its Responses WebSocket has a documented 25-minute hard cap, so
// that connection lifetime is the only honest upper bound for local affinity.
export const GROK_OAUTH_RESPONSES_WEBSOCKET_REUSE_POLICY = {
  idleRetentionMs: 25 * 60 * 1000,
  maxConnectionLifetimeMs: 25 * 60 * 1000,
} as const satisfies ResponsesWebSocketReusePolicy;

export const GROK_OAUTH_PROVIDER_CACHE_PROFILE = {
  control: 'prompt_cache_key',
  observedBehavior: 'none',
  telemetry: 'observed_cached_input_tokens',
  verification: 'live_probe_verified',
  defaultScope: 'thread',
} as const satisfies ProviderCacheProfile;

const GROK_OAUTH_MODEL_REGISTRY = {
  'grok-4.5': {
    id: 'grok-4.5',
    providerId: 'grok_oauth',
    wireModel: 'grok-4.5',
    baseUrl: GROK_OAUTH_RESPONSES_BASE_URL,
    routeFamily: 'xai_public_responses',
  },
} as const satisfies Record<GrokOAuthModelId, GrokOAuthModelDescriptor>;

const GROK_OAUTH_MODEL_LOOKUP = {
  grok: 'grok-4.5',
  'grok-4.5': 'grok-4.5',
} as const satisfies Record<string, GrokOAuthModelId>;

export function resolveGrokOAuthModelDescriptor(
  modelId: string,
): GrokOAuthModelDescriptor {
  const normalized = modelId.trim();
  if (!isGrokOAuthModelLookupKey(normalized)) {
    const known = Object.keys(GROK_OAUTH_MODEL_LOOKUP).join(', ');
    throw new Error(`unknown Grok OAuth model '${modelId}'. known: ${known}`);
  }
  return GROK_OAUTH_MODEL_REGISTRY[GROK_OAUTH_MODEL_LOOKUP[normalized]];
}

export function buildGrokOAuthResponsesWebSocketUrl(
  model: GrokOAuthModelDescriptor,
): string {
  const url = new URL(model.baseUrl);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/responses`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function buildGrokOAuthResponsesHeaders(
  input: GrokOAuthResponsesHeaderInput,
): Headers {
  const accessToken = requireNonEmpty(input.accessToken, 'accessToken');

  const headers = new Headers();
  headers.set('authorization', `Bearer ${accessToken}`);
  if (input.conversationRoutingId !== undefined) {
    headers.set(
      'x-grok-conv-id',
      requireNonEmpty(input.conversationRoutingId, 'conversationRoutingId'),
    );
  }
  return headers;
}

export function buildGrokOAuthResponsesRequestBody(
  input: GrokOAuthResponsesBodyInput,
): GrokOAuthResponsesRequestBody {
  const promptCacheProjection = buildGrokOAuthPromptCacheProjection({
    model: input.model,
    providerSessionId: input.providerSessionId,
    prefixMaterial: {
      ...(input.instructions !== undefined
        ? { instructions: input.instructions }
        : {}),
      ...(input.tools !== undefined && input.tools.length > 0
        ? { tools: input.tools }
        : {}),
    },
    ...(input.promptCacheIntent !== undefined
      ? { intent: input.promptCacheIntent }
      : {}),
  });

  const body: GrokOAuthResponsesRequestBody = {
    model: input.model.wireModel,
    store: false,
    input: buildResponseWireInput(input.history, {
      providerId: input.model.providerId,
      model: input.model.id,
      ...(input.providerReplayScopeId === undefined
        ? {}
        : { providerReplayScopeId: input.providerReplayScopeId }),
    }),
    reasoning: {
      effort: resolveGrokOAuthReasoningEffort(input.reasoningEffort),
    },
    ...(input.instructions !== undefined
      ? { instructions: input.instructions }
      : {}),
    ...(promptCacheProjection.wire.prompt_cache_key !== undefined
      ? { prompt_cache_key: promptCacheProjection.wire.prompt_cache_key }
      : {}),
  };

  if (input.tools !== undefined && input.tools.length > 0) {
    body.tools = input.tools;
    body.tool_choice = 'auto';
  }

  return body;
}

export function buildGrokOAuthPromptCacheProjection(input: {
  model: GrokOAuthModelDescriptor;
  providerSessionId: string;
  prefixMaterial?: ProviderVisiblePrefixMaterial;
  intent?: PromptCacheIntent;
}): PromptCacheProjection {
  return buildPromptCacheProjection({
    profile: GROK_OAUTH_PROVIDER_CACHE_PROFILE,
    identities: {
      conversationIdentity: input.providerSessionId,
      cacheGroupingIdentity: input.providerSessionId,
    },
    providerId: input.model.providerId,
    routeFamily: input.model.routeFamily,
    modelId: input.model.wireModel,
    ...(input.prefixMaterial !== undefined
      ? { prefixMaterial: input.prefixMaterial }
      : {}),
    ...(input.intent !== undefined ? { intent: input.intent } : {}),
  });
}

export async function streamGrokOAuthResponses(
  input: GrokOAuthResponsesStreamInput,
  options: GrokOAuthResponsesStreamOptions,
): Promise<CallResult> {
  const result = await streamResponsesOverWebSocket({
    webSocketUrl: buildGrokOAuthResponsesWebSocketUrl(input.model),
    payload: {
      type: 'response.create',
      ...buildGrokOAuthResponsesRequestBody(input),
    },
    headers: buildGrokOAuthResponsesHeaders({
      accessToken: input.accessToken,
      ...(input.conversationRoutingId !== undefined
        ? { conversationRoutingId: input.conversationRoutingId }
        : {}),
    }),
    historyProjection: 'provider_output',
    providerSessionId: input.providerSessionId,
    webSocketReusePolicy: GROK_OAUTH_RESPONSES_WEBSOCKET_REUSE_POLICY,
    providerWebSocketSessions: input.providerWebSocketSessions,
    normalizeEvent: normalizeGrokOAuthResponseEventForParser,
    completionEventTypes: ['response.completed'],
    ...(input.discoverySink !== undefined
      ? { discoverySink: input.discoverySink }
      : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(options.onAssistantDelta !== undefined
      ? { onAssistantDelta: options.onAssistantDelta }
      : {}),
    ...(options.onFunctionCallArgsDelta !== undefined
      ? { onFunctionCallArgsDelta: options.onFunctionCallArgsDelta }
      : {}),
  });
  return {
    ...result,
    itemsToAppend: result.itemsToAppend.map(stripGrokSyntheticAssistantPhase),
  };
}

function stripGrokSyntheticAssistantPhase(item: HistoryItem): HistoryItem {
  if (
    item.kind !== 'backend_item' ||
    !isRecord(item.data) ||
    item.data.type !== 'message' ||
    item.data.phase !== 'final_answer'
  ) {
    return item;
  }
  const { phase: _syntheticPhase, ...data } = item.data;
  return { ...item, data };
}

function isGrokOAuthModelLookupKey(
  value: string,
): value is keyof typeof GROK_OAUTH_MODEL_LOOKUP {
  return Object.hasOwn(GROK_OAUTH_MODEL_LOOKUP, value);
}

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new Error(`Grok OAuth ${label} is required`);
  }
  return trimmed;
}

function resolveGrokOAuthReasoningEffort(
  effort: ProviderRequestOptions['reasoning']['effort'],
): GrokOAuthReasoningEffort {
  if (effort === 'low' || effort === 'medium' || effort === 'high') {
    return effort;
  }
  throw new Error(`Grok OAuth does not support '${effort}' reasoning effort`);
}

function normalizeGrokOAuthResponseEventForParser(
  event: Record<string, unknown>,
): Record<string, unknown> {
  const type = typeof event.type === 'string' ? event.type : '';
  if (
    type !== 'response.output_item.added' &&
    type !== 'response.output_item.done'
  ) {
    return event;
  }

  const item = isRecord(event.item) ? event.item : null;
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
