import assert from 'node:assert/strict';
import test from 'node:test';

import { createProviderReplayScopeId } from './provider-replay-scope.js';

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
