import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderAuthRuntimeStore } from '../../auth/runtime-state.js';
import { resolveProviderRequestOptions } from './provider-options.js';
import {
  createProviderReplayScopeId,
  resolveProviderReplayScopeForRun,
} from './provider-replay-scope.js';

void test('provider replay scope is stable, private, and changes with account or endpoint', () => {
  const accountId = 'account-private-marker';
  const endpoint = 'https://chatgpt.com/backend-api/codex/responses';
  const baseline = createProviderReplayScopeId({
    providerId: 'openai_codex_direct',
    accountId,
    endpoint,
  });

  assert.match(baseline, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(
    baseline,
    createProviderReplayScopeId({
      providerId: 'openai_codex_direct',
      accountId,
      endpoint: `${endpoint}/`,
    }),
  );
  assert.notEqual(
    baseline,
    createProviderReplayScopeId({
      providerId: 'openai_codex_direct',
      accountId: 'another-account',
      endpoint,
    }),
  );
  assert.notEqual(
    baseline,
    createProviderReplayScopeId({
      providerId: 'openai_codex_direct',
      accountId,
      endpoint: 'https://example.invalid/codex/responses',
    }),
  );
  assert.equal(baseline.includes(accountId), false);
  assert.equal(baseline.includes(endpoint), false);
});

void test('Qwen replay scope uses its HTTP endpoint and credential identity without OAuth', async () => {
  let oauthCalled = false;
  const apiKey = 'x'.repeat(32);
  const credentialIdentity = `sha256:${'c'.repeat(64)}`;
  const chatCompletionsUrl =
    'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
  const scope = await resolveProviderReplayScopeForRun({
    providerRequestOptions: resolveProviderRequestOptions({
      GEULBAT_LLM_PROVIDER: 'qwen_token_plan',
    }),
    providerAuthRuntime: {} as ProviderAuthRuntimeStore,
    getProviderAuthImpl: async () => {
      oauthCalled = true;
      throw new Error('Qwen must not request OAuth credentials');
    },
    loadQwenTokenPlanConfigImpl: async () => ({
      model: 'qwen3.8-max-preview',
      baseUrl:
        'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
      chatCompletionsUrl,
      apiKey,
      credentialIdentity,
    }),
  });

  assert.equal(oauthCalled, false);
  assert.equal(
    scope,
    createProviderReplayScopeId({
      providerId: 'qwen_token_plan',
      accountId: credentialIdentity,
      endpoint: chatCompletionsUrl,
    }),
  );
  assert.equal(scope.includes(apiKey), false);
});
