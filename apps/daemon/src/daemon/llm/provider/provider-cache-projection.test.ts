import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CODEX_DIRECT_PROVIDER_CACHE_PROFILE,
  PROVIDER_CACHE_PROJECTION_VERSION,
  PROVIDER_VISIBLE_PREFIX_FINGERPRINT_VERSION,
  buildProviderVisiblePrefixFingerprint,
  buildPromptCacheProjection,
  type ProviderCacheProfile,
} from './provider-cache-projection.js';
import type { WireToolDefinition } from './wire/types.js';

const grokOAuthCandidateProfile: ProviderCacheProfile = {
  control: 'prompt_cache_key',
  observedBehavior: 'none',
  telemetry: 'parser_candidate_unverified',
  verification: 'operator_probe_required',
  defaultScope: 'disabled',
};

function buildTestTool(name: string): WireToolDefinition {
  return {
    type: 'function',
    name,
    description: name,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    strict: true,
  };
}

void test('buildPromptCacheProjection preserves current Codex direct thread-scoped wire fields', () => {
  const projection = buildPromptCacheProjection({
    profile: CODEX_DIRECT_PROVIDER_CACHE_PROFILE,
    identities: {
      conversationIdentity: 'provider-session',
      cacheGroupingIdentity: 'provider-session',
    },
    providerId: 'openai_codex_direct',
    routeFamily: 'openai_codex_responses',
    modelId: 'gpt-5.5',
    includeSessionId: true,
    prefixMaterial: {
      instructions: 'system',
      tools: [buildTestTool('read_file')],
    },
  });

  assert.equal(projection.scope, 'thread');
  assert.equal(Object.hasOwn(projection, 'providerSessionId'), false);
  assert.deepEqual(projection.wire, {
    session_id: 'provider-session',
    prompt_cache_key: 'provider-session',
  });
  assert.equal(
    projection.trace.projectionVersion,
    PROVIDER_CACHE_PROJECTION_VERSION,
  );
  assert.equal(
    projection.trace.prefixFingerprintVersion,
    PROVIDER_VISIBLE_PREFIX_FINGERPRINT_VERSION,
  );
  assert.match(projection.trace.conversationIdentityHash, /^[a-f0-9]{64}$/u);
  assert.match(projection.trace.cacheKeyHash ?? '', /^[a-f0-9]{64}$/u);
  assert.match(
    projection.trace.stablePrefixFingerprint ?? '',
    /^[a-f0-9]{64}$/u,
  );
  assert.notEqual(
    projection.trace.conversationIdentityHash,
    'provider-session',
  );
  assert.notEqual(projection.trace.cacheKeyHash, 'provider-session');
});

void test('buildPromptCacheProjection keeps conversation continuity separate from cache grouping', () => {
  const projection = buildPromptCacheProjection({
    profile: CODEX_DIRECT_PROVIDER_CACHE_PROFILE,
    identities: {
      conversationIdentity: 'conversation-a',
      cacheGroupingIdentity: 'cache-group-a',
    },
    providerId: 'openai_codex_direct',
    routeFamily: 'openai_codex_responses',
    modelId: 'gpt-5.5',
    includeSessionId: true,
    prefixMaterial: { instructions: 'same system' },
  });
  const otherIdentityProjection = buildPromptCacheProjection({
    profile: CODEX_DIRECT_PROVIDER_CACHE_PROFILE,
    identities: {
      conversationIdentity: 'conversation-b',
      cacheGroupingIdentity: 'cache-group-b',
    },
    providerId: 'openai_codex_direct',
    routeFamily: 'openai_codex_responses',
    modelId: 'gpt-5.5',
    includeSessionId: true,
    prefixMaterial: { instructions: 'same system' },
  });

  assert.equal(projection.wire.session_id, 'conversation-a');
  assert.equal(projection.wire.prompt_cache_key, 'cache-group-a');
  assert.notEqual(
    projection.trace.conversationIdentityHash,
    otherIdentityProjection.trace.conversationIdentityHash,
  );
  assert.notEqual(
    projection.trace.cacheKeyHash,
    otherIdentityProjection.trace.cacheKeyHash,
  );
  assert.equal(
    projection.trace.stablePrefixFingerprint,
    otherIdentityProjection.trace.stablePrefixFingerprint,
  );
});

void test('buildPromptCacheProjection does not emit cache control fields for disabled candidate providers', () => {
  const projection = buildPromptCacheProjection({
    profile: grokOAuthCandidateProfile,
    identities: {
      conversationIdentity: 'provider-session',
      cacheGroupingIdentity: 'provider-session',
    },
    providerId: 'grok_oauth',
    routeFamily: 'cli_chat_proxy_responses',
    modelId: 'grok-build',
  });

  assert.equal(projection.scope, 'disabled');
  assert.equal(projection.wire.prompt_cache_key, undefined);
  assert.equal(projection.trace.cacheKeyHash, undefined);
});

void test('buildPromptCacheProjection allows thread-scoped candidate projection only when caller opts in', () => {
  const projection = buildPromptCacheProjection({
    profile: grokOAuthCandidateProfile,
    identities: {
      conversationIdentity: 'provider-session',
      cacheGroupingIdentity: 'provider-session',
    },
    providerId: 'grok_oauth',
    routeFamily: 'cli_chat_proxy_responses',
    modelId: 'grok-build',
    intent: {
      scope: 'thread',
    },
  });

  assert.equal(projection.wire.prompt_cache_key, 'provider-session');
  assert.match(projection.trace.cacheKeyHash ?? '', /^[a-f0-9]{64}$/u);
});

void test('buildProviderVisiblePrefixFingerprint is canonical but preserves tool order', () => {
  const readFileTool = buildTestTool('read_file');
  const writeFileTool = buildTestTool('write_file');
  const base = {
    providerId: 'grok_oauth',
    routeFamily: 'xai_public_responses',
    modelId: 'grok-4.5',
    prefixMaterial: {
      instructions: 'system',
      tools: [readFileTool, writeFileTool],
    },
  } as const;

  const fingerprint = buildProviderVisiblePrefixFingerprint(base);
  const equivalentObjectKeyOrder = buildProviderVisiblePrefixFingerprint({
    ...base,
    prefixMaterial: {
      instructions: 'system',
      tools: [
        {
          strict: readFileTool.strict,
          parameters: readFileTool.parameters,
          description: readFileTool.description,
          name: readFileTool.name,
          type: readFileTool.type,
        },
        {
          name: writeFileTool.name,
          type: writeFileTool.type,
          strict: writeFileTool.strict,
          description: writeFileTool.description,
          parameters: writeFileTool.parameters,
        },
      ],
    },
  });
  const changedInstructions = buildProviderVisiblePrefixFingerprint({
    ...base,
    prefixMaterial: {
      ...base.prefixMaterial,
      instructions: 'changed system',
    },
  });
  const changedToolOrder = buildProviderVisiblePrefixFingerprint({
    ...base,
    prefixMaterial: {
      ...base.prefixMaterial,
      tools: [...base.prefixMaterial.tools].reverse(),
    },
  });

  assert.match(fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(equivalentObjectKeyOrder, fingerprint);
  assert.notEqual(changedInstructions, fingerprint);
  assert.notEqual(changedToolOrder, fingerprint);
});
