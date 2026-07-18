import {
  forceRefreshProviderAuth,
  getProviderAuth,
} from '../../auth/access.js';
import { createLogger } from '@geulbat/shared-utils/logger';

import { isJsonValue, type JsonValue } from '../../runtime-json.js';
import type { CallModelInput } from './client.js';
import {
  buildCodexDirectPromptCacheProjection,
  buildProviderInstructions,
  buildResponsesRequestHeaders,
} from './codex-request.js';
import {
  buildGrokOAuthResponsesHeaders,
  resolveGrokOAuthModelDescriptor,
} from './grok-oauth-transport.js';
import { decideProviderRetryPolicy } from './provider-retry-policy.js';
import { buildResponseWireInput } from './transport/responses-wire-input.js';
import type { ProviderNativeCompactionOutputItem } from './wire/types.js';

const DEFAULT_CODEX_RESPONSES_URL =
  'https://chatgpt.com/backend-api/codex/responses';
const CODEX_AUTO_COMPACT_CONTEXT_NUMERATOR = 9;
const CODEX_AUTO_COMPACT_CONTEXT_DENOMINATOR = 10;
const GROK_BUILD_AUTO_COMPACT_CONTEXT_NUMERATOR = 85;
const GROK_BUILD_AUTO_COMPACT_CONTEXT_DENOMINATOR = 100;

const logger = createLogger('llm/provider/client');

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

interface OpenAiNativeCompactionPolicy {
  providerId: 'openai_codex_direct';
  model: string;
  contextWindow: number;
  thresholdTokens: number;
  supportsParallelToolCalls: boolean;
}

interface GrokNativeCompactionPolicy {
  providerId: 'grok_oauth';
  model: string;
  contextWindow: number;
  thresholdTokens: number;
}

export type ProviderNativeCompactionPolicy =
  | OpenAiNativeCompactionPolicy
  | GrokNativeCompactionPolicy;

interface CompactOpenAiHistoryResult {
  output: ProviderNativeCompactionOutputItem[];
}

interface OpenAiNativeCompactionDependencies {
  getProviderAuth: typeof getProviderAuth;
  forceRefreshProviderAuth: typeof forceRefreshProviderAuth;
  fetchImpl: typeof fetch;
  responsesUrl?: string;
  clientVersion?: string;
}

interface GrokNativeCompactionDependencies {
  getProviderAuth: typeof getProviderAuth;
  forceRefreshProviderAuth: typeof forceRefreshProviderAuth;
  fetchImpl: typeof fetch;
}

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
