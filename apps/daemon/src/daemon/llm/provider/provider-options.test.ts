import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveProviderRequestOptions,
  resolveProviderRequestOptionsForRun,
} from './provider-options.js';
import { resolveChildModelPin } from '../../subagent-runtime-contracts.js';

const defaultModelRoundRetry = {
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

void test('resolveProviderRequestOptions returns daemon-local provider defaults', () => {
  assert.deepEqual(resolveProviderRequestOptions({}), {
    providerId: 'openai_codex_direct',
    model: 'gpt-5.6-sol',
    text: { verbosity: 'medium' },
    reasoning: { effort: 'medium', summary: 'auto' },
    modelRoundRetry: defaultModelRoundRetry,
  });
});

void test('resolveProviderRequestOptions trims configured provider options', () => {
  assert.deepEqual(
    resolveProviderRequestOptions({
      GEULBAT_CODEX_MODEL: ' gpt-5.4 ',
      GEULBAT_CODEX_REASONING_EFFORT: ' xhigh ',
      GEULBAT_CODEX_TEXT_VERBOSITY: ' high ',
      GEULBAT_CODEX_MODEL_ROUND_RETRY_CONNECTION_LOST_MAX_RETRIES: ' 4 ',
      GEULBAT_CODEX_MODEL_ROUND_RETRY_OVERLOADED_MAX_RETRIES: ' 5 ',
      GEULBAT_CODEX_MODEL_ROUND_RETRY_RATE_LIMITED_MAX_RETRIES: ' 6 ',
      GEULBAT_CODEX_MODEL_ROUND_RETRY_BASE_DELAY_MS: ' 250 ',
      GEULBAT_CODEX_MODEL_ROUND_RETRY_MULTIPLIER: ' 3 ',
      GEULBAT_CODEX_MODEL_ROUND_RETRY_MAX_DELAY_MS: ' 5000 ',
      GEULBAT_CODEX_MODEL_ROUND_RETRY_JITTER_RATIO: ' 0.1 ',
    }),
    {
      providerId: 'openai_codex_direct',
      model: 'gpt-5.4',
      text: { verbosity: 'high' },
      reasoning: { effort: 'xhigh', summary: 'auto' },
      modelRoundRetry: {
        llmConnectionLost: { maxRetries: 4 },
        llmOverloaded: { maxRetries: 5 },
        llmRateLimited: { maxRetries: 6 },
        delay: {
          baseDelayMs: 250,
          multiplier: 3,
          maxDelayMs: 5000,
          jitterRatio: 0.1,
        },
      },
    },
  );
});

void test('resolveProviderRequestOptions accepts GPT-5.6 max reasoning effort', () => {
  assert.equal(
    resolveProviderRequestOptions({
      GEULBAT_CODEX_REASONING_EFFORT: 'max',
    }).reasoning.effort,
    'max',
  );
});

void test('resolveProviderRequestOptions selects Grok OAuth provider and model from registry-backed env', () => {
  assert.deepEqual(
    resolveProviderRequestOptions({
      GEULBAT_LLM_PROVIDER: ' grok_oauth ',
      GEULBAT_GROK_MODEL: ' grok-custom ',
    }),
    {
      providerId: 'grok_oauth',
      model: 'grok-custom',
      text: { verbosity: 'medium' },
      reasoning: { effort: 'medium', summary: 'auto' },
      modelRoundRetry: defaultModelRoundRetry,
    },
  );
});

void test('resolveProviderRequestOptions uses the Grok registry default when provider is selected without a model override', () => {
  assert.equal(
    resolveProviderRequestOptions({ GEULBAT_LLM_PROVIDER: 'grok_oauth' }).model,
    'grok-4.5',
  );
});

void test('resolveProviderRequestOptionsForRun projects the selected model owner and reasoning override', () => {
  assert.deepEqual(
    resolveProviderRequestOptionsForRun(
      resolveProviderRequestOptions({
        GEULBAT_CODEX_MODEL: 'gpt-custom',
        GEULBAT_CODEX_REASONING_EFFORT: 'low',
      }),
      {
        providerModel: {
          providerId: 'grok_oauth',
          model: 'grok-4.5',
        },
        reasoningEffort: 'high',
      },
    ),
    {
      providerId: 'grok_oauth',
      model: 'grok-4.5',
      text: { verbosity: 'medium' },
      reasoning: { effort: 'high', summary: 'auto' },
      modelRoundRetry: defaultModelRoundRetry,
    },
  );
});

void test('resolveProviderRequestOptionsForRun preserves configured model when provider does not change', () => {
  assert.deepEqual(
    resolveProviderRequestOptionsForRun(
      resolveProviderRequestOptions({
        GEULBAT_LLM_PROVIDER: 'grok_oauth',
        GEULBAT_GROK_MODEL: 'grok-custom',
      }),
      { reasoningEffort: 'xhigh' },
    ),
    {
      providerId: 'grok_oauth',
      model: 'grok-custom',
      text: { verbosity: 'medium' },
      reasoning: { effort: 'xhigh', summary: 'auto' },
      modelRoundRetry: defaultModelRoundRetry,
    },
  );
});

void test('automatic child routing selects a requested heterogeneous model with its own default effort', () => {
  assert.deepEqual(
    resolveChildModelPin({
      routing: { mode: 'auto' },
      requestedChoice: { modelId: 'grok-4.5' },
      inheritedSelection: {
        providerModel: {
          providerId: 'openai_codex_direct',
          model: 'gpt-5.6-sol',
        },
        reasoningEffort: 'xhigh',
      },
    }),
    {
      ok: true,
      pin: {
        modelId: 'grok-4.5',
        providerRunSelection: {
          providerModel: { providerId: 'grok_oauth', model: 'grok-4.5' },
          reasoningEffort: 'high',
        },
        selectionSource: 'model_selected',
      },
    },
  );
});

void test('automatic child routing inherits the exact parent selection when no model is requested', () => {
  assert.deepEqual(
    resolveChildModelPin({
      routing: { mode: 'auto' },
      inheritedSelection: {
        providerModel: { providerId: 'grok_oauth', model: 'grok-custom' },
        reasoningEffort: 'medium',
      },
    }),
    {
      ok: true,
      pin: {
        modelId: 'grok-custom',
        providerRunSelection: {
          providerModel: { providerId: 'grok_oauth', model: 'grok-custom' },
          reasoningEffort: 'medium',
        },
        selectionSource: 'inherited',
      },
    },
  );
});

void test('fixed child routing rejects a conflicting model instead of silently overriding it', () => {
  assert.deepEqual(
    resolveChildModelPin({
      routing: {
        mode: 'fixed',
        choice: { modelId: 'gpt-5.6-luna', reasoningEffort: 'xhigh' },
      },
      requestedChoice: { modelId: 'grok-4.5', reasoningEffort: 'high' },
    }),
    {
      ok: false,
      errorCode: 'invalid_args',
      error:
        "agent_spawn requested model 'grok-4.5', but this run fixes all descendants to 'gpt-5.6-luna'",
    },
  );
});

void test('fixed child routing lets the model choose effort only when the user left effort open', () => {
  assert.deepEqual(
    resolveChildModelPin({
      routing: {
        mode: 'fixed',
        choice: { modelId: 'gpt-5.6-terra' },
      },
      requestedChoice: {
        modelId: 'gpt-5.6-terra',
        reasoningEffort: 'high',
      },
    }),
    {
      ok: true,
      pin: {
        modelId: 'gpt-5.6-terra',
        providerRunSelection: {
          providerModel: {
            providerId: 'openai_codex_direct',
            model: 'gpt-5.6-terra',
          },
          reasoningEffort: 'high',
        },
        selectionSource: 'user_fixed',
      },
    },
  );
});

void test('child routing rejects unsupported model-specific effort and missing inheritance', () => {
  const unsupportedEffort = resolveChildModelPin({
    routing: { mode: 'auto' },
    requestedChoice: { modelId: 'grok-4.5', reasoningEffort: 'xhigh' },
  });
  assert.equal(unsupportedEffort.ok, false);
  if (!unsupportedEffort.ok) {
    assert.equal(unsupportedEffort.errorCode, 'invalid_args');
  }

  const missingInheritance = resolveChildModelPin({
    routing: { mode: 'auto' },
  });
  assert.equal(missingInheritance.ok, false);
  if (!missingInheritance.ok) {
    assert.equal(missingInheritance.errorCode, 'execution_failed');
  }
});

for (const { name, env, error } of [
  {
    name: 'unknown provider',
    env: { GEULBAT_LLM_PROVIDER: 'not-a-provider' },
    error: /unknown provider 'not-a-provider'/,
  },
  {
    name: 'empty provider',
    env: { GEULBAT_LLM_PROVIDER: ' ' },
    error: /invalid GEULBAT_LLM_PROVIDER: empty/,
  },
  {
    name: 'empty model',
    env: { GEULBAT_CODEX_MODEL: ' ' },
    error: /invalid GEULBAT_CODEX_MODEL: empty/,
  },
  {
    name: 'empty reasoning effort',
    env: { GEULBAT_CODEX_REASONING_EFFORT: ' ' },
    error: /invalid GEULBAT_CODEX_REASONING_EFFORT: empty/,
  },
  {
    name: 'empty text verbosity',
    env: { GEULBAT_CODEX_TEXT_VERBOSITY: ' ' },
    error: /invalid GEULBAT_CODEX_TEXT_VERBOSITY: empty/,
  },
  {
    name: 'empty Grok model',
    env: { GEULBAT_LLM_PROVIDER: 'grok_oauth', GEULBAT_GROK_MODEL: ' ' },
    error: /invalid GEULBAT_GROK_MODEL: empty/,
  },
  {
    name: 'empty retry base delay',
    env: { GEULBAT_CODEX_MODEL_ROUND_RETRY_BASE_DELAY_MS: ' ' },
    error: /invalid GEULBAT_CODEX_MODEL_ROUND_RETRY_BASE_DELAY_MS: empty/,
  },
  {
    name: 'unsupported reasoning effort',
    env: { GEULBAT_CODEX_REASONING_EFFORT: 'mid' },
    error: /invalid GEULBAT_CODEX_REASONING_EFFORT: mid/,
  },
  {
    name: 'unsupported text verbosity',
    env: { GEULBAT_CODEX_TEXT_VERBOSITY: 'verbose' },
    error: /invalid GEULBAT_CODEX_TEXT_VERBOSITY: verbose/,
  },
  {
    name: 'fractional retry count',
    env: {
      GEULBAT_CODEX_MODEL_ROUND_RETRY_CONNECTION_LOST_MAX_RETRIES: '1.5',
    },
    error:
      /invalid GEULBAT_CODEX_MODEL_ROUND_RETRY_CONNECTION_LOST_MAX_RETRIES: expected non-negative integer/,
  },
  {
    name: 'negative retry max delay',
    env: { GEULBAT_CODEX_MODEL_ROUND_RETRY_MAX_DELAY_MS: '-1' },
    error:
      /invalid GEULBAT_CODEX_MODEL_ROUND_RETRY_MAX_DELAY_MS: expected non-negative number/,
  },
  {
    name: 'zero retry multiplier',
    env: { GEULBAT_CODEX_MODEL_ROUND_RETRY_MULTIPLIER: '0' },
    error:
      /invalid GEULBAT_CODEX_MODEL_ROUND_RETRY_MULTIPLIER: expected positive number/,
  },
] as const) {
  void test(`resolveProviderRequestOptions rejects ${name}`, () => {
    assert.throws(() => resolveProviderRequestOptions(env), error);
  });
}
