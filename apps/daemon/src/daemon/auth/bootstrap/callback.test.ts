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
    providerId: 'openai_codex_direct',
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
    providerId: 'openai_codex_direct',
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
    providerId: 'openai_codex_direct',
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
    providerId: 'openai_codex_direct',
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

void test('completeProviderAuthCallback persists Grok OAuth callback credentials to the Grok provider slot', async () => {
  const { bootstrapStore, runtimeStore } = createProviderAuthTestStores();

  bootstrapStore.setPendingProviderAuthSession({
    authSessionId: 'auth-grok',
    providerId: 'grok_oauth',
    state: 'state-grok',
    codeVerifier: 'verifier-grok',
    redirectUri: 'http://localhost:1455/auth/callback',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    status: 'pending',
  });

  const result = await completeProviderAuthCallback(
    {
      code: 'code-grok',
      state: 'state-grok',
    },
    {
      bootstrapStore,
      runtimeStore,
      exchangeCode: async (_code, _codeVerifier, options) => {
        assert.equal(options.providerId, 'grok_oauth');
        return {
          access_token: 'grok-access-token',
          refresh_token: 'grok-refresh-token',
          expires_in: 60,
          id_token: makeJwt({ sub: 'xai-account-1' }),
        };
      },
    },
  );

  assert.equal(result.statusCode, 200);
  assert.equal(runtimeStore.getCachedProviderCredential(), null);
  const grokCredential = runtimeStore.getCachedProviderCredential('grok_oauth');
  assert.equal(grokCredential?.accessToken, 'grok-access-token');
  assert.equal(grokCredential?.refreshToken, 'grok-refresh-token');
  assert.equal(grokCredential?.accountId, 'xai-account-1');
  assert.ok((grokCredential?.expiresAt ?? 0) > Date.now());
  assert.equal(bootstrapStore.getProviderAuthSessionSnapshot(), null);
});

function makeJwt(payload: object): string {
  const header = base64Url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const body = base64Url(JSON.stringify(payload));
  return `${header}.${body}.sig`;
}

function base64Url(text: string): string {
  return Buffer.from(text, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}
