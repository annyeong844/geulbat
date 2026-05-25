import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveProviderRequestOptions } from './provider-options.js';

void test('resolveProviderRequestOptions returns daemon-local provider defaults', () => {
  assert.deepEqual(resolveProviderRequestOptions({}), {
    model: 'gpt-5.5',
    text: { verbosity: 'medium' },
    reasoning: { effort: 'medium', summary: 'auto' },
  });
});

void test('resolveProviderRequestOptions trims configured provider options', () => {
  assert.deepEqual(
    resolveProviderRequestOptions({
      GEULBAT_CODEX_MODEL: ' gpt-5.4 ',
      GEULBAT_CODEX_REASONING_EFFORT: ' xhigh ',
      GEULBAT_CODEX_TEXT_VERBOSITY: ' high ',
    }),
    {
      model: 'gpt-5.4',
      text: { verbosity: 'high' },
      reasoning: { effort: 'xhigh', summary: 'auto' },
    },
  );
});

for (const { name, env, error } of [
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
    name: 'unsupported reasoning effort',
    env: { GEULBAT_CODEX_REASONING_EFFORT: 'mid' },
    error: /invalid GEULBAT_CODEX_REASONING_EFFORT: mid/,
  },
  {
    name: 'unsupported text verbosity',
    env: { GEULBAT_CODEX_TEXT_VERBOSITY: 'verbose' },
    error: /invalid GEULBAT_CODEX_TEXT_VERBOSITY: verbose/,
  },
] as const) {
  void test(`resolveProviderRequestOptions rejects ${name}`, () => {
    assert.throws(() => resolveProviderRequestOptions(env), error);
  });
}
