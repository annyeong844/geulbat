import test from 'node:test';
import assert from 'node:assert/strict';

import { createProviderAuthRuntimeStore } from './runtime-state.js';

void test('provider auth runtime credential cache returns snapshots', () => {
  const runtimeStore = createProviderAuthRuntimeStore();
  runtimeStore.setCachedProviderCredential({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    accountId: 'account-1',
    expiresAt: 123,
  });

  const first = runtimeStore.getCachedProviderCredential();
  assert.ok(first);
  first.accessToken = 'mutated-token';

  const second = runtimeStore.getCachedProviderCredential();
  assert.equal(second?.accessToken, 'access-token');
});

void test('provider auth runtime load error cache returns snapshots', () => {
  const runtimeStore = createProviderAuthRuntimeStore();
  runtimeStore.setCachedProviderAuthLoadError({
    code: 'provider_auth_invalid',
    message: 'Reconnect the provider.',
  });

  const first = runtimeStore.getCachedProviderAuthLoadError();
  assert.ok(first);
  first.message = 'mutated';

  const second = runtimeStore.getCachedProviderAuthLoadError();
  assert.equal(second?.message, 'Reconnect the provider.');
});

void test('provider auth runtime hydration flag is tracked independently from cache content', () => {
  const runtimeStore = createProviderAuthRuntimeStore();
  assert.equal(runtimeStore.hasHydratedProviderAuth(), false);

  runtimeStore.setHydratedProviderAuth(true);
  assert.equal(runtimeStore.hasHydratedProviderAuth(), true);

  runtimeStore.clearProviderAuthRuntimeState();
  assert.equal(runtimeStore.hasHydratedProviderAuth(), false);
});

void test('createProviderAuthRuntimeStore isolates local caches across instances', () => {
  const first = createProviderAuthRuntimeStore();
  const second = createProviderAuthRuntimeStore();

  first.setCachedProviderCredential({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    accountId: 'account-1',
    expiresAt: 123,
  });
  first.setCachedProviderAuthLoadError({
    code: 'provider_auth_invalid',
    message: 'Reconnect the provider.',
  });

  assert.equal(
    first.getCachedProviderCredential()?.accessToken,
    'access-token',
  );
  assert.equal(second.getCachedProviderCredential(), null);
  assert.equal(
    first.getCachedProviderAuthLoadError()?.message,
    'Reconnect the provider.',
  );
  assert.equal(second.getCachedProviderAuthLoadError(), null);
  assert.equal(first.hasHydratedProviderAuth(), false);
  first.setHydratedProviderAuth(true);
  assert.equal(first.hasHydratedProviderAuth(), true);
  assert.equal(second.hasHydratedProviderAuth(), false);
});
