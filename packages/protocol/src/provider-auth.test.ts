import test from 'node:test';
import assert from 'node:assert/strict';

import { isProviderAuthStatusResponse } from './provider-auth.js';

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
