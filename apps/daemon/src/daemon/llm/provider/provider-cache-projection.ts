import { sha256Hex } from '@geulbat/content-identity/sha256';
import { sha256StableJson } from '@geulbat/content-identity/stable-json';
import type { WireToolDefinition } from './wire/types.js';

type ProviderCacheControl = 'none' | 'prompt_cache_key' | 'explicit_breakpoint';

type ProviderCacheObservedBehavior = 'none' | 'implicit_content_cache';

type ProviderCacheTelemetrySupport =
  | 'none'
  | 'observed_cached_input_tokens'
  | 'parser_candidate_unverified'
  | 'telemetry_only';

type ProviderCacheVerification =
  | 'landed_legacy'
  | 'unit_tested_projection'
  | 'operator_probe_required'
  | 'live_probe_verified';

type CacheScope = 'disabled' | 'thread';

export type ProviderCacheProfile = {
  control: ProviderCacheControl;
  observedBehavior: ProviderCacheObservedBehavior;
  telemetry: ProviderCacheTelemetrySupport;
  verification: ProviderCacheVerification;
  defaultScope: CacheScope;
};

export type PromptCacheIntent = {
  scope: CacheScope;
};

type PromptCacheIdentities = {
  conversationIdentity: string;
  cacheGroupingIdentity: string;
};

export type ProviderVisiblePrefixMaterial = {
  instructions?: string;
  tools?: readonly WireToolDefinition[];
};

export type PromptCacheProjection = {
  scope: CacheScope;
  wire: {
    session_id?: string;
    prompt_cache_key?: string;
  };
  trace: {
    providerId: string;
    routeFamily: string;
    modelId: string;
    conversationIdentityHash: string;
    cacheKeyHash?: string;
    stablePrefixFingerprint?: string;
    prefixFingerprintVersion?: string;
    projectionVersion: string;
  };
};

export const PROVIDER_CACHE_PROJECTION_VERSION =
  'provider_cache_projection_v2' as const;

export const PROVIDER_VISIBLE_PREFIX_FINGERPRINT_VERSION =
  'provider_visible_prefix_fingerprint_v1' as const;

export const CODEX_DIRECT_PROVIDER_CACHE_PROFILE = {
  control: 'prompt_cache_key',
  observedBehavior: 'none',
  telemetry: 'observed_cached_input_tokens',
  verification: 'landed_legacy',
  defaultScope: 'thread',
} as const satisfies ProviderCacheProfile;

export function buildPromptCacheProjection(input: {
  profile: ProviderCacheProfile;
  identities: PromptCacheIdentities;
  providerId: string;
  routeFamily: string;
  modelId: string;
  intent?: PromptCacheIntent;
  includeSessionId?: boolean;
  prefixMaterial?: ProviderVisiblePrefixMaterial;
}): PromptCacheProjection {
  const scope = input.intent?.scope ?? input.profile.defaultScope;

  const wire: PromptCacheProjection['wire'] = {
    ...(input.includeSessionId === true
      ? { session_id: input.identities.conversationIdentity }
      : {}),
  };

  if (scope === 'thread' && input.profile.control === 'prompt_cache_key') {
    wire.prompt_cache_key = input.identities.cacheGroupingIdentity;
  }

  const cacheKeyHash = hashCacheTraceValue(wire.prompt_cache_key);
  const stablePrefixFingerprint =
    input.prefixMaterial === undefined
      ? undefined
      : buildProviderVisiblePrefixFingerprint({
          providerId: input.providerId,
          routeFamily: input.routeFamily,
          modelId: input.modelId,
          prefixMaterial: input.prefixMaterial,
        });

  return {
    scope,
    wire,
    trace: {
      providerId: input.providerId,
      routeFamily: input.routeFamily,
      modelId: input.modelId,
      conversationIdentityHash: hashProviderTraceIdentity(
        input.identities.conversationIdentity,
      ),
      ...(cacheKeyHash !== undefined ? { cacheKeyHash } : {}),
      ...(stablePrefixFingerprint !== undefined
        ? {
            stablePrefixFingerprint,
            prefixFingerprintVersion:
              PROVIDER_VISIBLE_PREFIX_FINGERPRINT_VERSION,
          }
        : {}),
      projectionVersion: PROVIDER_CACHE_PROJECTION_VERSION,
    },
  };
}

export function buildProviderVisiblePrefixFingerprint(input: {
  providerId: string;
  routeFamily: string;
  modelId: string;
  prefixMaterial: ProviderVisiblePrefixMaterial;
}): string {
  const tools =
    input.prefixMaterial.tools !== undefined &&
    input.prefixMaterial.tools.length > 0
      ? input.prefixMaterial.tools
      : [];

  return sha256StableJson(
    {
      version: PROVIDER_VISIBLE_PREFIX_FINGERPRINT_VERSION,
      providerId: input.providerId,
      routeFamily: input.routeFamily,
      modelId: input.modelId,
      instructions: input.prefixMaterial.instructions,
      tools,
      toolChoice: tools.length > 0 ? 'auto' : undefined,
    },
    { omitUndefinedObjectKeys: true },
  );
}

export function hashProviderTraceIdentity(value: string): string {
  return sha256Hex(value);
}

function hashCacheTraceValue(value: string | undefined): string | undefined {
  return value === undefined ? undefined : hashProviderTraceIdentity(value);
}
