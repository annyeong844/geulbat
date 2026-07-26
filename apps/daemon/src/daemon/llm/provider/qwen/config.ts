import {
  buildPromptCacheProjection,
  hashProviderTraceIdentity,
  type PromptCacheProjection,
  type ProviderVisiblePrefixMaterial,
} from '../provider-cache-projection.js';
import {
  readQwenTokenPlanCredential,
  type QwenTokenPlanCredential,
} from './credential-store.js';

export const QWEN_TOKEN_PLAN_PROVIDER_ID = 'qwen_token_plan' as const;
export const QWEN_3_8_MAX_PREVIEW_MODEL_ID = 'qwen3.8-max-preview' as const;
export const QWEN_3_8_MAX_PREVIEW_CONTEXT_CAPACITY = {
  contextWindow: 1_000_000,
  thresholdTokens: 850_000,
} as const;
export const QWEN_TOKEN_PLAN_GLOBAL_BASE_URL =
  'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
export const QWEN_TOKEN_PLAN_CHINA_BASE_URL =
  'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';

const QWEN_TOKEN_PLAN_API_KEY_ENV = 'BAILIAN_TOKEN_PLAN_API_KEY';
const QWEN_TOKEN_PLAN_BASE_URL_ENV = 'GEULBAT_QWEN_BASE_URL';
const QWEN_TOKEN_PLAN_ROUTE_FAMILY = 'qwen_token_plan_chat_completions';
const QWEN_CACHE_PROFILE = {
  control: 'none',
  observedBehavior: 'none',
  telemetry: 'telemetry_only',
  verification: 'unit_tested_projection',
  defaultScope: 'disabled',
} as const;

export interface QwenTokenPlanConfig {
  model: string;
  baseUrl: string;
  chatCompletionsUrl: string;
  apiKey: string;
  credentialIdentity: string;
}

export interface QwenContextCapacityPolicy {
  providerId: typeof QWEN_TOKEN_PLAN_PROVIDER_ID;
  model: typeof QWEN_3_8_MAX_PREVIEW_MODEL_ID;
  contextWindow: number;
  thresholdTokens: number;
}

export function resolveQwenContextCapacityPolicy(
  model: string,
): QwenContextCapacityPolicy {
  if (model !== QWEN_3_8_MAX_PREVIEW_MODEL_ID) {
    throw new Error('Qwen context capacity is unavailable for this model');
  }
  return {
    providerId: QWEN_TOKEN_PLAN_PROVIDER_ID,
    model: QWEN_3_8_MAX_PREVIEW_MODEL_ID,
    ...QWEN_3_8_MAX_PREVIEW_CONTEXT_CAPACITY,
  };
}

export function resolveQwenTokenPlanConfig(args: {
  model: string;
  apiKey?: string;
  baseUrl?: string;
  env?: Record<string, string | undefined>;
}): QwenTokenPlanConfig {
  const env = args.env ?? process.env;
  const model = requireQwenNonEmpty(args.model, 'Qwen model');
  const apiKey =
    args.apiKey === undefined
      ? readRequiredEnvironmentValue(env, QWEN_TOKEN_PLAN_API_KEY_ENV)
      : requireQwenNonEmpty(args.apiKey, 'Qwen Token Plan API key');
  const baseUrl = normalizeQwenBaseUrl(
    args.baseUrl ??
      readOptionalEnvironmentValue(env, QWEN_TOKEN_PLAN_BASE_URL_ENV) ??
      QWEN_TOKEN_PLAN_GLOBAL_BASE_URL,
  );

  return {
    model,
    baseUrl,
    chatCompletionsUrl: `${baseUrl}/chat/completions`,
    apiKey,
    credentialIdentity: hashProviderTraceIdentity(apiKey),
  };
}

export type QwenTokenPlanCredentialSource = 'environment' | 'stored';

export type QwenTokenPlanConnectionStatus =
  | {
      state: 'missing';
      region: QwenTokenPlanCredential['region'];
      baseUrl: string;
    }
  | {
      state: 'ready';
      source: QwenTokenPlanCredentialSource;
      region: QwenTokenPlanCredential['region'];
      baseUrl: string;
    };

type ReadQwenTokenPlanCredential =
  () => Promise<QwenTokenPlanCredential | null>;

export async function loadQwenTokenPlanConfig(args: {
  model: string;
  env?: Record<string, string | undefined>;
  readCredentialImpl?: ReadQwenTokenPlanCredential;
}): Promise<QwenTokenPlanConfig> {
  const env = args.env ?? process.env;
  if (env[QWEN_TOKEN_PLAN_API_KEY_ENV] !== undefined) {
    return resolveQwenTokenPlanConfig({ model: args.model, env });
  }
  const credential = await (
    args.readCredentialImpl ?? (() => readQwenTokenPlanCredential())
  )();
  return credential === null
    ? resolveQwenTokenPlanConfig({ model: args.model, env })
    : resolveStoredQwenTokenPlanConfig(args.model, env, credential);
}

export async function getQwenTokenPlanConnectionStatus(
  args: {
    env?: Record<string, string | undefined>;
    readCredentialImpl?: ReadQwenTokenPlanCredential;
  } = {},
): Promise<QwenTokenPlanConnectionStatus> {
  const env = args.env ?? process.env;
  if (env[QWEN_TOKEN_PLAN_API_KEY_ENV] !== undefined) {
    const config = resolveQwenTokenPlanConfig({
      model: QWEN_3_8_MAX_PREVIEW_MODEL_ID,
      env,
    });
    return {
      state: 'ready',
      source: 'environment',
      region:
        config.baseUrl === QWEN_TOKEN_PLAN_CHINA_BASE_URL ? 'china' : 'global',
      baseUrl: config.baseUrl,
    };
  }
  const credential = await (
    args.readCredentialImpl ?? (() => readQwenTokenPlanCredential())
  )();
  if (credential === null) {
    const baseUrl = normalizeQwenBaseUrl(
      readOptionalEnvironmentValue(env, QWEN_TOKEN_PLAN_BASE_URL_ENV) ??
        QWEN_TOKEN_PLAN_GLOBAL_BASE_URL,
    );
    return {
      state: 'missing',
      region: baseUrl === QWEN_TOKEN_PLAN_CHINA_BASE_URL ? 'china' : 'global',
      baseUrl,
    };
  }
  const config = resolveStoredQwenTokenPlanConfig(
    QWEN_3_8_MAX_PREVIEW_MODEL_ID,
    env,
    credential,
  );
  return {
    state: 'ready',
    source: 'stored',
    region: credential.region,
    baseUrl: config.baseUrl,
  };
}

function resolveStoredQwenTokenPlanConfig(
  model: string,
  env: Record<string, string | undefined>,
  credential: QwenTokenPlanCredential,
): QwenTokenPlanConfig {
  const configuredBaseUrl = env[QWEN_TOKEN_PLAN_BASE_URL_ENV];
  return resolveQwenTokenPlanConfig({
    model,
    apiKey: credential.apiKey,
    baseUrl:
      configuredBaseUrl ??
      (credential.region === 'china'
        ? QWEN_TOKEN_PLAN_CHINA_BASE_URL
        : QWEN_TOKEN_PLAN_GLOBAL_BASE_URL),
    env,
  });
}

export function buildQwenPromptCacheProjection(input: {
  model: string;
  providerSessionId: string;
  prefixMaterial: ProviderVisiblePrefixMaterial;
}): PromptCacheProjection {
  return buildPromptCacheProjection({
    profile: QWEN_CACHE_PROFILE,
    identities: {
      conversationIdentity: input.providerSessionId,
      cacheGroupingIdentity: input.providerSessionId,
    },
    providerId: QWEN_TOKEN_PLAN_PROVIDER_ID,
    routeFamily: QWEN_TOKEN_PLAN_ROUTE_FAMILY,
    modelId: input.model,
    prefixMaterial: input.prefixMaterial,
  });
}

export function requireQwenNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized === '') {
    throw new QwenConfigurationError(`${label} must not be empty`);
  }
  return normalized;
}

function normalizeQwenBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(requireQwenNonEmpty(value, QWEN_TOKEN_PLAN_BASE_URL_ENV));
  } catch {
    throw new QwenConfigurationError(
      `${QWEN_TOKEN_PLAN_BASE_URL_ENV} must be an absolute HTTPS URL`,
    );
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new QwenConfigurationError(
      `${QWEN_TOKEN_PLAN_BASE_URL_ENV} must be an absolute HTTPS URL without credentials, query, or fragment`,
    );
  }
  url.pathname = url.pathname.replace(/\/+$/u, '');
  return url.toString().replace(/\/+$/u, '');
}

function readRequiredEnvironmentValue(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = readOptionalEnvironmentValue(env, name);
  if (value === undefined) {
    throw new QwenConfigurationError(`${name} is not configured`);
  }
  return value;
}

function readOptionalEnvironmentValue(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const raw = env[name];
  if (raw === undefined) {
    return undefined;
  }
  const value = raw.trim();
  if (value === '') {
    throw new QwenConfigurationError(`${name} must not be empty`);
  }
  return value;
}

class QwenConfigurationError extends Error {
  readonly llmCode = 'llm_auth_failed';

  constructor(message: string) {
    super(message);
    this.name = 'QwenConfigurationError';
  }
}
