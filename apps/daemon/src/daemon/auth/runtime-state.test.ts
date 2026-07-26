import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

void test('provider auth runtime credential cache is isolated per provider', () => {
  const runtimeStore = createProviderAuthRuntimeStore();
  runtimeStore.setCachedProviderCredential({
    accessToken: 'codex-token',
    refreshToken: 'codex-refresh-token',
    accountId: 'codex-account',
    expiresAt: 123,
  });
  runtimeStore.setCachedProviderCredential(
    {
      accessToken: 'grok-token',
      refreshToken: 'grok-refresh-token',
      accountId: 'grok-account',
      expiresAt: 456,
    },
    'grok_oauth',
  );

  assert.equal(
    runtimeStore.getCachedProviderCredential()?.accessToken,
    'codex-token',
  );
  assert.equal(
    runtimeStore.getCachedProviderCredential('grok_oauth')?.accessToken,
    'grok-token',
  );
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

void test('provider auth runtime hydration and refresh state are isolated per provider', () => {
  const runtimeStore = createProviderAuthRuntimeStore();
  const refreshPromise = Promise.resolve();

  runtimeStore.setHydratedProviderAuth(true);
  runtimeStore.setHydratedProviderAuth(false, 'grok_oauth');
  runtimeStore.setProviderAuthRefreshPromise(refreshPromise, 'grok_oauth');

  assert.equal(runtimeStore.hasHydratedProviderAuth(), true);
  assert.equal(runtimeStore.hasHydratedProviderAuth('grok_oauth'), false);
  assert.equal(runtimeStore.getProviderAuthRefreshPromise(), null);
  assert.equal(
    runtimeStore.getProviderAuthRefreshPromise('grok_oauth'),
    refreshPromise,
  );

  runtimeStore.clearProviderAuthRuntimeState('grok_oauth');

  assert.equal(runtimeStore.hasHydratedProviderAuth(), true);
  assert.equal(runtimeStore.hasHydratedProviderAuth('grok_oauth'), false);
  assert.equal(runtimeStore.getProviderAuthRefreshPromise('grok_oauth'), null);
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

void test('provider auth runtime uses one injected permission owner for persisted writes and delete rewrites', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-auth-runtime-store-'));
  const authFile = join(root, 'auth', 'provider.json');
  const envKey = 'GEULBAT_PROVIDER_AUTH_FILE_PATH';
  const previousAuthFile = process.env[envKey];
  const hardenedPaths: string[] = [];
  process.env[envKey] = authFile;

  try {
    const runtimeStore = createProviderAuthRuntimeStore({
      async hardenPermissions(targetPath) {
        hardenedPaths.push(targetPath);
      },
    });
    await runtimeStore.persistProviderCredential({
      accessToken: 'codex-token',
      refreshToken: 'codex-refresh-token',
      accountId: 'codex-account',
      expiresAt: 123,
    });
    await runtimeStore.persistProviderCredential(
      {
        accessToken: 'grok-token',
        refreshToken: 'grok-refresh-token',
        accountId: 'grok-account',
        expiresAt: 456,
      },
      'grok_oauth',
    );
    await runtimeStore.deletePersistedProviderCredential('grok_oauth');

    assert.deepEqual(hardenedPaths, [authFile, authFile, authFile]);
    const persisted = await readFile(authFile, 'utf8');
    assert.match(persisted, /codex-token/u);
    assert.doesNotMatch(persisted, /grok-token/u);
  } finally {
    if (previousAuthFile === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = previousAuthFile;
    }
    await rm(root, { recursive: true, force: true });
  }
});
