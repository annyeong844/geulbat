import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PROVIDER_AUTH_PROVIDER_ID,
  isProviderAuthProviderId,
  isProviderAuthStartResponse,
  isProviderAuthStatusResponse,
} from './provider-auth.js';

void test('isProviderAuthProviderId accepts known provider auth ids only', () => {
  assert.equal(DEFAULT_PROVIDER_AUTH_PROVIDER_ID, 'openai_codex_direct');
  assert.equal(isProviderAuthProviderId('openai_codex_direct'), true);
  assert.equal(isProviderAuthProviderId('grok_oauth'), true);
  assert.equal(isProviderAuthProviderId('grok'), false);
  assert.equal(isProviderAuthProviderId(undefined), false);
});

void test('isProviderAuthStartResponse requires a concrete provider id', () => {
  assert.equal(
    isProviderAuthStartResponse({
      authSessionId: 'auth-1',
      authorizeUrl: 'https://auth.example/authorize',
      expiresAt: 123,
      providerId: 'grok_oauth',
    }),
    true,
  );
  assert.equal(
    isProviderAuthStartResponse({
      authSessionId: 'auth-1',
      authorizeUrl: 'https://auth.example/authorize',
      expiresAt: 123,
    }),
    false,
  );
});

void test('isProviderAuthStatusResponse accepts state-correlated provider auth shapes', () => {
  const validCases: unknown[] = [
    { state: 'missing', ready: false },
    {
      state: 'pending',
      ready: false,
      authSessionId: 'auth-1',
      expiresAt: 123,
      pollAfterMs: 1000,
    },
    { state: 'ready', ready: true, expiresAt: 456 },
    {
      state: 'ready',
      ready: true,
      lastErrorCode: 'provider_auth_refresh_failed',
      lastErrorMessage: 'Provider token refresh failed.',
    },
    {
      state: 'ready',
      ready: false,
      authSessionId: 'auth-1',
      expiresAt: 789,
    },
    {
      state: 'exchange_failed',
      ready: false,
      lastErrorCode: 'provider_auth_not_configured',
      lastErrorMessage: 'PROVIDER_AUTH_CLIENT_ID is not configured.',
    },
    {
      state: 'exchange_failed',
      ready: false,
      authSessionId: 'auth-1',
      expiresAt: 111,
      lastErrorCode: 'provider_auth_exchange_failed',
      lastErrorMessage: 'Provider login failed.',
    },
    {
      state: 'expired',
      ready: false,
      expiresAt: 222,
      lastErrorCode: 'provider_auth_session_expired',
      lastErrorMessage: 'The provider login session has expired.',
    },
    {
      state: 'expired',
      ready: false,
      authSessionId: 'auth-1',
      expiresAt: 333,
      lastErrorCode: 'provider_auth_session_expired',
      lastErrorMessage: 'The provider login session has expired.',
    },
  ];

  for (const value of validCases) {
    assert.equal(isProviderAuthStatusResponse(value), true);
  }
});

void test('isProviderAuthStatusResponse rejects uncorrelated provider auth shapes', () => {
  const invalidCases: unknown[] = [
    { state: 'missing', ready: false, expiresAt: 123 },
    { state: 'pending', ready: false, authSessionId: 'auth-1' },
    {
      state: 'pending',
      ready: false,
      authSessionId: 'auth-1',
      expiresAt: 123,
    },
    {
      state: 'pending',
      ready: false,
      authSessionId: 'auth-1',
      expiresAt: 123,
      pollAfterMs: 0,
    },
    {
      state: 'pending',
      ready: false,
      authSessionId: 'auth-1',
      expiresAt: 123,
      pollAfterMs: -5000,
    },
    {
      state: 'pending',
      ready: false,
      authSessionId: 'auth-1',
      expiresAt: 123,
      pollAfterMs: 0.5,
    },
    {
      state: 'pending',
      ready: false,
      authSessionId: 'auth-1',
      expiresAt: 123,
      pollAfterMs: 0.001,
    },
    {
      state: 'ready',
      ready: true,
      authSessionId: 'auth-1',
      expiresAt: 123,
    },
    {
      state: 'ready',
      ready: true,
      lastErrorCode: 'provider_auth_refresh_failed',
    },
    {
      state: 'exchange_failed',
      ready: false,
      lastErrorCode: 'provider_auth_not_configured',
    },
    {
      state: 'exchange_failed',
      ready: false,
      expiresAt: 123,
      lastErrorCode: 'provider_auth_not_configured',
      lastErrorMessage: 'PROVIDER_AUTH_CLIENT_ID is not configured.',
    },
    {
      state: 'expired',
      ready: false,
      authSessionId: 'auth-1',
      lastErrorCode: 'provider_auth_session_expired',
      lastErrorMessage: 'The provider login session has expired.',
    },
  ];

  for (const value of invalidCases) {
    assert.equal(isProviderAuthStatusResponse(value), false);
  }
});
