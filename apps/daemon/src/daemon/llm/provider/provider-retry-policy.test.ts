import test from 'node:test';
import assert from 'node:assert/strict';

import { decideProviderRetryPolicy } from './provider-retry-policy.js';

void test('decideProviderRetryPolicy allows one forced auth refresh retry', () => {
  assert.deepEqual(
    decideProviderRetryPolicy({
      error: Object.assign(new Error('unauthorized'), {
        status: 401,
      }),
      authRefreshAttempts: 0,
    }),
    {
      action: 'force_refresh_auth_retry',
      code: 'llm_auth_failed',
      message: 'provider authentication failed',
    },
  );
});

void test('decideProviderRetryPolicy does not retry a second auth failure', () => {
  assert.deepEqual(
    decideProviderRetryPolicy({
      error: Object.assign(new Error('unauthorized'), {
        status: 401,
      }),
      authRefreshAttempts: 1,
    }),
    {
      action: 'fail',
      code: 'llm_auth_failed',
      message: 'provider authentication failed',
    },
  );
});

void test('decideProviderRetryPolicy keeps rate limit terminal', () => {
  assert.deepEqual(
    decideProviderRetryPolicy({
      error: Object.assign(new Error('too many requests'), {
        status: 429,
      }),
      authRefreshAttempts: 0,
    }),
    {
      action: 'fail',
      code: 'llm_rate_limited',
      message: 'provider rate limited',
    },
  );
});

void test('decideProviderRetryPolicy keeps timeout terminal', () => {
  assert.deepEqual(
    decideProviderRetryPolicy({
      error: new Error('Provider request timed out'),
      authRefreshAttempts: 0,
    }),
    {
      action: 'fail',
      code: 'llm_connect_timeout',
      message: 'provider request timed out',
    },
  );
});
