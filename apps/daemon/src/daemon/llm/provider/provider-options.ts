import type { ProviderRunSelection } from '../../subagent-runtime-contracts.js';
import {
  DEFAULT_PROVIDER_ID,
  resolveProviderRegistryEntry,
  type ProviderId,
} from './provider-registry.js';

export type ProviderReasoningEffort =
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';
type ProviderTextVerbosity = 'low' | 'medium' | 'high';

export interface ProviderModelRoundRetryPolicy {
  llmConnectionLost: { maxRetries: number };
  llmOverloaded: { maxRetries: number };
  llmRateLimited: { maxRetries: number };
  delay: {
    baseDelayMs: number;
    multiplier: number;
    maxDelayMs: number;
    jitterRatio: number;
  };
}

export interface ProviderRequestOptions {
  providerId: ProviderId;
  model: string;
  text: { verbosity: ProviderTextVerbosity };
  reasoning: { effort: ProviderReasoningEffort; summary: 'auto' };
  modelRoundRetry: ProviderModelRoundRetryPolicy;
}

const DEFAULT_REASONING_EFFORT: ProviderReasoningEffort = 'medium';
const DEFAULT_TEXT_VERBOSITY: ProviderTextVerbosity = 'medium';
const DEFAULT_MODEL_ROUND_RETRY_POLICY: ProviderModelRoundRetryPolicy = {
  llmConnectionLost: { maxRetries: 2 },
  llmOverloaded: { maxRetries: 3 },
  llmRateLimited: { maxRetries: 3 },
  delay: {
    baseDelayMs: 1_000,
    multiplier: 2,
    maxDelayMs: 4_000,
    jitterRatio: 0.2,
  },
};

const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const TEXT_VERBOSITIES = ['low', 'medium', 'high'] as const;

type ProviderEnv = Partial<
  Record<
    | 'GEULBAT_LLM_PROVIDER'
    | 'GEULBAT_CODEX_MODEL'
    | 'GEULBAT_GROK_MODEL'
    | 'GEULBAT_CODEX_REASONING_EFFORT'
    | 'GEULBAT_CODEX_TEXT_VERBOSITY'
    | 'GEULBAT_CODEX_MODEL_ROUND_RETRY_CONNECTION_LOST_MAX_RETRIES'
    | 'GEULBAT_CODEX_MODEL_ROUND_RETRY_OVERLOADED_MAX_RETRIES'
    | 'GEULBAT_CODEX_MODEL_ROUND_RETRY_RATE_LIMITED_MAX_RETRIES'
    | 'GEULBAT_CODEX_MODEL_ROUND_RETRY_BASE_DELAY_MS'
    | 'GEULBAT_CODEX_MODEL_ROUND_RETRY_MULTIPLIER'
    | 'GEULBAT_CODEX_MODEL_ROUND_RETRY_MAX_DELAY_MS'
    | 'GEULBAT_CODEX_MODEL_ROUND_RETRY_JITTER_RATIO',
    string
  >
>;

function readEnvValue(
  env: ProviderEnv,
  name: keyof ProviderEnv,
): string | undefined {
  const raw = env[name];
  if (raw === undefined) {
    return undefined;
  }
  const value = raw.trim();
  if (!value) {
    throw new Error(`invalid ${name}: empty`);
  }
  return value;
}

function readEnumValue<TValue extends string>(
  env: ProviderEnv,
  name: keyof ProviderEnv,
  values: readonly TValue[],
  fallback: TValue,
): TValue {
  const value = readEnvValue(env, name);
  if (value === undefined) {
    return fallback;
  }
  for (const candidate of values) {
    if (value === candidate) {
      return candidate;
    }
  }
  throw new Error(`invalid ${name}: ${value}`);
}

function readNonNegativeInteger(
  env: ProviderEnv,
  name: keyof ProviderEnv,
  fallback: number,
): number {
  const value = readEnvValue(env, name);
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`invalid ${name}: expected non-negative integer`);
  }
  return parsed;
}

function readNonNegativeNumber(
  env: ProviderEnv,
  name: keyof ProviderEnv,
  fallback: number,
): number {
  const value = readEnvValue(env, name);
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`invalid ${name}: expected non-negative number`);
  }
  return parsed;
}

function readPositiveNumber(
  env: ProviderEnv,
  name: keyof ProviderEnv,
  fallback: number,
): number {
  const value = readEnvValue(env, name);
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid ${name}: expected positive number`);
  }
  return parsed;
}

function resolveModelRoundRetryPolicy(
  env: ProviderEnv,
): ProviderModelRoundRetryPolicy {
  return {
    llmConnectionLost: {
      maxRetries: readNonNegativeInteger(
        env,
        'GEULBAT_CODEX_MODEL_ROUND_RETRY_CONNECTION_LOST_MAX_RETRIES',
        DEFAULT_MODEL_ROUND_RETRY_POLICY.llmConnectionLost.maxRetries,
      ),
    },
    llmOverloaded: {
      maxRetries: readNonNegativeInteger(
        env,
        'GEULBAT_CODEX_MODEL_ROUND_RETRY_OVERLOADED_MAX_RETRIES',
        DEFAULT_MODEL_ROUND_RETRY_POLICY.llmOverloaded.maxRetries,
      ),
    },
    llmRateLimited: {
      maxRetries: readNonNegativeInteger(
        env,
        'GEULBAT_CODEX_MODEL_ROUND_RETRY_RATE_LIMITED_MAX_RETRIES',
        DEFAULT_MODEL_ROUND_RETRY_POLICY.llmRateLimited.maxRetries,
      ),
    },
    delay: {
      baseDelayMs: readNonNegativeNumber(
        env,
        'GEULBAT_CODEX_MODEL_ROUND_RETRY_BASE_DELAY_MS',
        DEFAULT_MODEL_ROUND_RETRY_POLICY.delay.baseDelayMs,
      ),
      multiplier: readPositiveNumber(
        env,
        'GEULBAT_CODEX_MODEL_ROUND_RETRY_MULTIPLIER',
        DEFAULT_MODEL_ROUND_RETRY_POLICY.delay.multiplier,
      ),
      maxDelayMs: readNonNegativeNumber(
        env,
        'GEULBAT_CODEX_MODEL_ROUND_RETRY_MAX_DELAY_MS',
        DEFAULT_MODEL_ROUND_RETRY_POLICY.delay.maxDelayMs,
      ),
      jitterRatio: readNonNegativeNumber(
        env,
        'GEULBAT_CODEX_MODEL_ROUND_RETRY_JITTER_RATIO',
        DEFAULT_MODEL_ROUND_RETRY_POLICY.delay.jitterRatio,
      ),
    },
  };
}

function readProviderId(env: ProviderEnv): ProviderId {
  const value = readEnvValue(env, 'GEULBAT_LLM_PROVIDER');
  if (value === undefined) {
    return DEFAULT_PROVIDER_ID;
  }
  return resolveProviderRegistryEntry(value).id;
}

function readProviderModel(env: ProviderEnv, providerId: ProviderId): string {
  const provider = resolveProviderRegistryEntry(providerId);
  return readEnvValue(env, provider.modelEnvKey) ?? provider.defaultModel;
}

export function resolveProviderRequestOptions(
  env: ProviderEnv = process.env,
): ProviderRequestOptions {
  const providerId = readProviderId(env);
  return {
    providerId,
    model: readProviderModel(env, providerId),
    text: {
      verbosity: readEnumValue(
        env,
        'GEULBAT_CODEX_TEXT_VERBOSITY',
        TEXT_VERBOSITIES,
        DEFAULT_TEXT_VERBOSITY,
      ),
    },
    reasoning: {
      effort: readEnumValue(
        env,
        'GEULBAT_CODEX_REASONING_EFFORT',
        REASONING_EFFORTS,
        DEFAULT_REASONING_EFFORT,
      ),
      summary: 'auto',
    },
    modelRoundRetry: resolveModelRoundRetryPolicy(env),
  };
}

export function projectProviderRunSelection(
  options: ProviderRequestOptions,
): ProviderRunSelection {
  return {
    providerModel: { providerId: options.providerId, model: options.model },
    reasoningEffort: options.reasoning.effort,
  };
}

export function resolveProviderRequestOptionsForRun(
  base: ProviderRequestOptions,
  overrides: {
    providerModel?: Pick<ProviderRequestOptions, 'providerId' | 'model'>;
    reasoningEffort?: ProviderReasoningEffort;
  },
): ProviderRequestOptions {
  return {
    ...base,
    ...(overrides.providerModel ?? {}),
    reasoning: {
      ...base.reasoning,
      ...(overrides.reasoningEffort !== undefined
        ? { effort: overrides.reasoningEffort }
        : {}),
    },
  };
}
