import type { RunProviderId } from '../../runtime-contracts.js';
import { DEFAULT_PROVIDER_AUTH_CREDENTIAL_PROVIDER_ID } from '../../auth/credentials/store.js';

export type ProviderId = RunProviderId;

interface ProviderRegistryEntry {
  id: ProviderId;
  defaultModel: string;
  modelEnvKey:
    | 'GEULBAT_CODEX_MODEL'
    | 'GEULBAT_GROK_MODEL'
    | 'GEULBAT_QWEN_MODEL';
}

export const DEFAULT_PROVIDER_ID: ProviderId =
  DEFAULT_PROVIDER_AUTH_CREDENTIAL_PROVIDER_ID;

const PROVIDER_REGISTRY = {
  openai_codex_direct: {
    id: 'openai_codex_direct',
    defaultModel: 'gpt-5.6-sol',
    modelEnvKey: 'GEULBAT_CODEX_MODEL',
  },
  grok_oauth: {
    id: 'grok_oauth',
    defaultModel: 'grok-4.5',
    modelEnvKey: 'GEULBAT_GROK_MODEL',
  },
  qwen_token_plan: {
    id: 'qwen_token_plan',
    defaultModel: 'qwen3.8-max-preview',
    modelEnvKey: 'GEULBAT_QWEN_MODEL',
  },
} as const satisfies Record<ProviderId, ProviderRegistryEntry>;

function isProviderId(value: string): value is ProviderId {
  return Object.hasOwn(PROVIDER_REGISTRY, value);
}

export function resolveProviderRegistryEntry(
  providerId: string,
): ProviderRegistryEntry {
  if (!isProviderId(providerId)) {
    const known = Object.keys(PROVIDER_REGISTRY).join(', ');
    throw new Error(`unknown provider '${providerId}'. known: ${known}`);
  }
  return PROVIDER_REGISTRY[providerId];
}
