import test from 'node:test';
import assert from 'node:assert/strict';

import { completeProviderAuthCallback } from './callback.js';
import { createProviderAuthRuntimeStore } from '../runtime-state.js';
import { createProviderAuthTestStores } from '../../../test-support/provider-auth.js';

void test('completeProviderAuthCallback rejects missing callback state', async () => {
  const { bootstrapStore, runtimeStore } = createProviderAuthTestStores();

  const result = await completeProviderAuthCallback(
    {
      code: 'code-1',
    },
    {
      bootstrapStore,
      runtimeStore,
    },
  );

  assert.equal(result.statusCode, 400);
  assert.match(result.html, /Missing callback state/i);
});

void test('completeProviderAuthCallback rejects unknown callback state', async () => {
  const { bootstrapStore, runtimeStore } = createProviderAuthTestStores();

  const result = await completeProviderAuthCallback(
    {
      code: 'code-1',
      state: 'missing-state',
    },
    {
      bootstrapStore,
      runtimeStore,
    },
  );

  assert.equal(result.statusCode, 404);
  assert.match(result.html, /not found/i);
});

void test('completeProviderAuthCallback marks provider query.error as session failure', async () => {
  const { bootstrapStore, runtimeStore } = createProviderAuthTestStores();

  bootstrapStore.setPendingProviderAuthSession({
    authSessionId: 'auth-error',
    state: 'error-state',
    codeVerifier: 'verifier-error',
    redirectUri: 'http://localhost:1455/auth/callback',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    status: 'pending',
  });

  const result = await completeProviderAuthCallback(
    {
      state: 'error-state',
      error: 'access_denied',
      errorDescription: 'User denied the login request.',
    },
    {
      bootstrapStore,
      runtimeStore,
    },
  );

  assert.equal(result.statusCode, 502);
  assert.match(result.html, /Provider login failed/i);
  assert.match(result.html, /User denied the login request/i);
  assert.equal(
    bootstrapStore.getProviderAuthSessionSnapshot()?.status,
    'exchange_failed',
  );
  assert.equal(
    bootstrapStore.getProviderAuthSessionSnapshot()?.lastErrorCode,
    'provider_auth_exchange_failed',
  );
  assert.equal(
    bootstrapStore.getProviderAuthSessionSnapshot()?.lastErrorMessage,
    'User denied the login request.',
  );
});

void test('completeProviderAuthCallback expires matching sessions whose ttl already elapsed', async () => {
  const { bootstrapStore, runtimeStore } = createProviderAuthTestStores();

  bootstrapStore.setPendingProviderAuthSession({
    authSessionId: 'auth-expired',
    state: 'expired-state',
    codeVerifier: 'verifier-expired',
    redirectUri: 'http://localhost:1455/auth/callback',
    createdAt: Date.now() - 120_000,
    expiresAt: Date.now() - 60_000,
    status: 'pending',
  });

  const result = await completeProviderAuthCallback(
    {
      code: 'code-1',
      state: 'expired-state',
    },
    {
      bootstrapStore,
      runtimeStore,
    },
  );

  assert.equal(result.statusCode, 410);
  assert.match(result.html, /expired/i);
  assert.equal(
    bootstrapStore.getProviderAuthSessionSnapshot()?.status,
    'expired',
  );
  assert.equal(
    bootstrapStore.getProviderAuthSessionSnapshot()?.lastErrorCode,
    'provider_auth_session_expired',
  );
});

void test('completeProviderAuthCallback rejects replayed callback sessions', async () => {
  const { bootstrapStore, runtimeStore } = createProviderAuthTestStores();

  bootstrapStore.setPendingProviderAuthSession({
    authSessionId: 'auth-consumed',
    state: 'consumed-state',
    codeVerifier: 'verifier-consumed',
    redirectUri: 'http://localhost:1455/auth/callback',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    consumedAt: Date.now(),
    status: 'pending',
  });

  const result = await completeProviderAuthCallback(
    {
      code: 'code-1',
      state: 'consumed-state',
    },
    {
      bootstrapStore,
      runtimeStore,
    },
  );

  assert.equal(result.statusCode, 410);
  assert.match(result.html, /expired/i);
  assert.equal(
    bootstrapStore.getProviderAuthSessionSnapshot()?.status,
    'expired',
  );
  assert.equal(
    bootstrapStore.getProviderAuthSessionSnapshot()?.lastErrorCode,
    'provider_auth_session_expired',
  );
});

void test('completeProviderAuthCallback can use injected auth stores', async () => {
  const { bootstrapStore, runtimeStore } = createProviderAuthTestStores();
  const untouchedRuntimeStore = createProviderAuthRuntimeStore();

  bootstrapStore.setPendingProviderAuthSession({
    authSessionId: 'auth-local',
    state: 'state-local',
    codeVerifier: 'verifier-local',
    redirectUri: 'http://localhost:1455/auth/callback',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    status: 'pending',
  });

  const result = await completeProviderAuthCallback(
    {
      code: 'code-local',
      state: 'state-local',
    },
    {
      bootstrapStore,
      runtimeStore,
      exchangeCode: async () => ({
        access_token: 'local-access-token',
        refresh_token: 'local-refresh-token',
        expires_in: 60,
        accountId: 'local-account-id',
      }),
    },
  );

  assert.equal(result.statusCode, 200);
  assert.equal(
    runtimeStore.getCachedProviderCredential()?.accessToken,
    'local-access-token',
  );
  assert.equal(bootstrapStore.getProviderAuthSessionSnapshot(), null);
  assert.equal(untouchedRuntimeStore.getCachedProviderCredential(), null);
});
