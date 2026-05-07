import test from 'node:test';
import assert from 'node:assert/strict';

import { createProviderAuthBootstrapStore } from './session-store.js';

void test('bootstrap session store reuses the current pending session', () => {
  const bootstrapStore = createProviderAuthBootstrapStore();

  bootstrapStore.setPendingProviderAuthSession({
    authSessionId: 'auth-1',
    state: 'state-1',
    codeVerifier: 'verifier-1',
    redirectUri: 'http://localhost:1455/auth/callback',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    status: 'pending',
  });

  const pending = bootstrapStore.getPendingProviderAuthSession();
  assert.equal(pending?.authSessionId, 'auth-1');
  assert.equal(
    bootstrapStore.resolvePendingProviderAuthSessionByState('state-1')
      ?.codeVerifier,
    'verifier-1',
  );
});

void test('bootstrap session store clears codeVerifier after terminal failure', () => {
  const bootstrapStore = createProviderAuthBootstrapStore();

  bootstrapStore.setPendingProviderAuthSession({
    authSessionId: 'auth-2',
    state: 'state-2',
    codeVerifier: 'verifier-2',
    redirectUri: 'http://localhost:1455/auth/callback',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    status: 'pending',
  });

  bootstrapStore.markProviderAuthSessionConsumed('auth-2');
  bootstrapStore.markProviderAuthSessionFailure(
    'auth-2',
    'provider_auth_exchange_failed',
    'network failed',
  );

  const snapshot = bootstrapStore.getProviderAuthSessionSnapshot();
  assert.equal(snapshot?.status, 'exchange_failed');
  assert.equal(snapshot?.codeVerifier, '');
  assert.equal(snapshot?.lastErrorCode, 'provider_auth_exchange_failed');
});

void test('createProviderAuthBootstrapStore isolates local sessions across instances', () => {
  const first = createProviderAuthBootstrapStore();
  const second = createProviderAuthBootstrapStore();

  first.setPendingProviderAuthSession({
    authSessionId: 'auth-local-1',
    state: 'state-local-1',
    codeVerifier: 'verifier-local-1',
    redirectUri: 'http://localhost:1455/auth/callback',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    status: 'pending',
  });

  assert.equal(
    first.getPendingProviderAuthSession()?.authSessionId,
    'auth-local-1',
  );
  assert.equal(second.getPendingProviderAuthSession(), null);
  assert.equal(
    first.resolvePendingProviderAuthSessionByState('state-local-1')
      ?.codeVerifier,
    'verifier-local-1',
  );
  assert.equal(
    second.resolvePendingProviderAuthSessionByState('state-local-1'),
    null,
  );
});
