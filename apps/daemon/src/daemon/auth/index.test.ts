import test from 'node:test';
import assert from 'node:assert/strict';

import { forceRefreshProviderAuth, getProviderAuth } from './access.js';
import { getProviderAuthStatus, getProviderBootstrapStatus } from './status.js';
import { initProviderAuth } from './init.js';
import { createProviderAuthRuntimeStore } from './runtime-state.js';
import { createProviderAuthTestStores } from '../../test-support/provider-auth.js';

const TEST_PROVIDER_AUTH_CLIENT_ID = 'test-provider-auth-client-id';
const TEST_INSTALLED_CONFIG_PATH = '/__geulbat_missing__/provider-auth.json';
const TEST_BUNDLED_CONFIG_PATH =
  '/__geulbat_missing__/provider-auth.config.json';
const previousClientId = process.env['PROVIDER_AUTH_CLIENT_ID'];
const previousInstalledConfigPath =
  process.env['GEULBAT_PROVIDER_AUTH_INSTALLED_CONFIG_PATH'];
const previousBundledConfigPath =
  process.env['GEULBAT_PROVIDER_AUTH_BUNDLED_CONFIG_PATH'];
process.env['PROVIDER_AUTH_CLIENT_ID'] = TEST_PROVIDER_AUTH_CLIENT_ID;
process.env['GEULBAT_PROVIDER_AUTH_INSTALLED_CONFIG_PATH'] =
  TEST_INSTALLED_CONFIG_PATH;
process.env['GEULBAT_PROVIDER_AUTH_BUNDLED_CONFIG_PATH'] =
  TEST_BUNDLED_CONFIG_PATH;
test.after(() => {
  if (previousClientId === undefined) {
    delete process.env['PROVIDER_AUTH_CLIENT_ID'];
  } else {
    process.env['PROVIDER_AUTH_CLIENT_ID'] = previousClientId;
  }
  if (previousInstalledConfigPath === undefined) {
    delete process.env['GEULBAT_PROVIDER_AUTH_INSTALLED_CONFIG_PATH'];
  } else {
    process.env['GEULBAT_PROVIDER_AUTH_INSTALLED_CONFIG_PATH'] =
      previousInstalledConfigPath;
  }
  if (previousBundledConfigPath === undefined) {
    delete process.env['GEULBAT_PROVIDER_AUTH_BUNDLED_CONFIG_PATH'];
  } else {
    process.env['GEULBAT_PROVIDER_AUTH_BUNDLED_CONFIG_PATH'] =
      previousBundledConfigPath;
  }
});

void test('getProviderBootstrapStatus degrades invalid credential files into exchange_failed', async () => {
  const { bootstrapStore, runtimeStore } = createProviderAuthTestStores();
  await initProviderAuth({
    runtimeStore,
    readCredential: async () => {
      throw Object.assign(new Error('invalid provider auth file schema'), {
        code: 'provider_auth_invalid',
      });
    },
  });

  const status = await getProviderBootstrapStatus({
    runtimeStore,
    bootstrapStore,
  });

  assert.equal(status.state, 'exchange_failed');
  assert.equal(status.ready, false);
  assert.equal(status.lastErrorCode, 'provider_auth_invalid');
  assert.match(status.lastErrorMessage ?? '', /Reconnect the provider/);
});

void test('provider auth load preserves credential file access failures', async () => {
  const { bootstrapStore, runtimeStore } = createProviderAuthTestStores();
  await initProviderAuth({
    runtimeStore,
    readCredential: async () => {
      throw Object.assign(
        new Error('provider auth file is not readable: EACCES'),
        {
          code: 'access_denied',
        },
      );
    },
  });

  const status = await getProviderBootstrapStatus({
    runtimeStore,
    bootstrapStore,
  });

  assert.equal(status.state, 'exchange_failed');
  assert.equal(status.ready, false);
  assert.equal(status.lastErrorCode, 'access_denied');
  assert.equal(
    status.lastErrorMessage,
    'provider auth file is not readable: EACCES',
  );
  await assert.rejects(
    () => getProviderAuth({ runtimeStore }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(Reflect.get(error, 'code'), 'access_denied');
      assert.equal(error.message, 'provider auth file is not readable: EACCES');
      return true;
    },
  );
});

void test('getProviderBootstrapStatus marks unusable cached credentials as expired', async () => {
  const { bootstrapStore, runtimeStore } = createProviderAuthTestStores();
  await initProviderAuth({
    runtimeStore,
    readCredential: async () => ({
      accessToken: 'access-token',
      refreshToken: '',
      accountId: 'account-1',
      expiresAt: Date.now() - 1_000,
    }),
  });

  const status = await getProviderBootstrapStatus({
    runtimeStore,
    bootstrapStore,
  });

  assert.equal(status.state, 'expired');
  assert.equal(status.ready, false);
  assert.equal(status.lastErrorCode, 'provider_auth_session_expired');
  assert.match(status.lastErrorMessage ?? '', /expired/i);
});

void test('getProviderAuth surfaces reconnect guidance after invalid credential load', async () => {
  const { runtimeStore } = createProviderAuthTestStores();
  await initProviderAuth({
    runtimeStore,
    readCredential: async () => {
      throw Object.assign(new Error('invalid provider auth file schema'), {
        code: 'provider_auth_invalid',
      });
    },
  });

  await assert.rejects(
    () => getProviderAuth({ runtimeStore }),
    /Reconnect the provider/,
  );
});

void test('getProviderAuth uses a canonical protocol code when provider credentials are missing', async () => {
  const { runtimeStore } = createProviderAuthTestStores();
  await initProviderAuth({
    runtimeStore,
    readCredential: async () => null,
  });

  await assert.rejects(
    () => getProviderAuth({ runtimeStore }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        Reflect.get(error, 'code'),
        'provider_auth_session_not_found',
      );
      assert.equal(Reflect.get(error, 'llmCode'), 'llm_auth_failed');
      return true;
    },
  );
});

void test('getProviderAuth returns the refreshed token after auto-refresh', async () => {
  const { runtimeStore } = createProviderAuthTestStores();
  await initProviderAuth({
    runtimeStore,
    readCredential: async () => ({
      accessToken: 'stale-token',
      refreshToken: 'refresh-token',
      accountId: 'account-1',
      expiresAt: Date.now() - 1_000,
    }),
  });

  const auth = await getProviderAuth({
    runtimeStore,
    refreshCredential: async (current) => ({
      ...current,
      accessToken: 'fresh-token',
      expiresAt: Date.now() + 60_000,
    }),
    persistCredential: async (credential) => {
      runtimeStore.setCachedProviderCredential(credential);
    },
  });

  assert.equal(auth.accessToken, 'fresh-token');
  assert.equal(auth.accountId, 'account-1');
});

void test('getProviderAuth refreshes the selected provider credential without changing the default provider', async () => {
  const { runtimeStore } = createProviderAuthTestStores();
  await initProviderAuth({
    runtimeStore,
    readCredential: async () => ({
      accessToken: 'codex-token',
      refreshToken: 'codex-refresh-token',
      accountId: 'codex-account',
      expiresAt: Date.now() + 60_000,
    }),
  });
  await initProviderAuth({
    providerId: 'grok_oauth',
    runtimeStore,
    readCredential: async () => ({
      accessToken: 'stale-grok-token',
      refreshToken: 'grok-refresh-token',
      accountId: 'grok-account',
      expiresAt: Date.now() - 1_000,
    }),
  });

  const auth = await getProviderAuth({
    providerId: 'grok_oauth',
    runtimeStore,
    refreshCredential: async (current) => ({
      ...current,
      accessToken: 'fresh-grok-token',
      expiresAt: Date.now() + 60_000,
    }),
    persistCredential: async (credential) => {
      runtimeStore.setCachedProviderCredential(credential, 'grok_oauth');
    },
  });

  assert.equal(auth.accessToken, 'fresh-grok-token');
  assert.equal(auth.accountId, 'grok-account');
  assert.equal(
    runtimeStore.getCachedProviderCredential()?.accessToken,
    'codex-token',
  );
  assert.equal(
    runtimeStore.getCachedProviderCredential('grok_oauth')?.accessToken,
    'fresh-grok-token',
  );
});

void test('forceRefreshProviderAuth refreshes even when the cached credential is not near expiry', async () => {
  const { runtimeStore } = createProviderAuthTestStores();
  await initProviderAuth({
    runtimeStore,
    readCredential: async () => ({
      accessToken: 'still-valid-token',
      refreshToken: 'refresh-token',
      accountId: 'account-1',
      expiresAt: Date.now() + 60_000,
    }),
  });

  let refreshCalls = 0;
  const auth = await forceRefreshProviderAuth({
    runtimeStore,
    refreshCredential: async (current) => {
      refreshCalls += 1;
      return {
        ...current,
        accessToken: 'forced-fresh-token',
        expiresAt: Date.now() + 120_000,
      };
    },
    persistCredential: async (credential) => {
      runtimeStore.setCachedProviderCredential(credential);
    },
  });

  assert.equal(refreshCalls, 1);
  assert.equal(auth.accessToken, 'forced-fresh-token');
  assert.equal(auth.accountId, 'account-1');
});

void test('forceRefreshProviderAuth surfaces invalid refresh as terminal auth failure', async () => {
  const { runtimeStore } = createProviderAuthTestStores();
  await initProviderAuth({
    runtimeStore,
    readCredential: async () => ({
      accessToken: 'still-valid-token',
      refreshToken: 'refresh-token',
      accountId: 'account-1',
      expiresAt: Date.now() + 60_000,
    }),
  });

  await assert.rejects(
    () =>
      forceRefreshProviderAuth({
        runtimeStore,
        refreshCredential: async () => {
          throw Object.assign(
            new Error(
              'Saved provider credential is invalid. Reconnect the provider.',
            ),
            { code: 'provider_auth_invalid' },
          );
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(Reflect.get(error, 'llmCode'), 'llm_auth_failed');
      assert.equal(Reflect.get(error, 'code'), 'provider_auth_invalid');
      assert.match(error.message, /Reconnect the provider/);
      return true;
    },
  );
});

void test('getProviderAuthStatus hydrates the runtime cache on first read-through', async () => {
  const { runtimeStore } = createProviderAuthTestStores();

  const status = await getProviderAuthStatus({
    runtimeStore,
    readCredential: async () => ({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      accountId: 'account-1',
      expiresAt: Date.now() + 60_000,
    }),
  });

  assert.equal(status.ready, true);
  assert.equal(
    runtimeStore.getCachedProviderCredential()?.accessToken,
    'access-token',
  );
});

void test('getProviderBootstrapStatus stays ready for a usable cached credential even when client id config is missing', async () => {
  const { bootstrapStore, runtimeStore } = createProviderAuthTestStores();
  const currentClientId = process.env['PROVIDER_AUTH_CLIENT_ID'];
  delete process.env['PROVIDER_AUTH_CLIENT_ID'];

  try {
    await initProviderAuth({
      runtimeStore,
      readCredential: async () => ({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        accountId: 'account-1',
        expiresAt: Date.now() + 60_000,
      }),
    });

    const status = await getProviderBootstrapStatus({
      runtimeStore,
      bootstrapStore,
    });

    assert.equal(status.state, 'ready');
    assert.equal(status.ready, true);
  } finally {
    if (currentClientId === undefined) {
      delete process.env['PROVIDER_AUTH_CLIENT_ID'];
    } else {
      process.env['PROVIDER_AUTH_CLIENT_ID'] = currentClientId;
    }
  }
});

void test('getProviderBootstrapStatus evaluates the selected provider independently', async () => {
  const { bootstrapStore, runtimeStore } = createProviderAuthTestStores();
  await initProviderAuth({
    runtimeStore,
    readCredential: async () => ({
      accessToken: 'codex-token',
      refreshToken: 'codex-refresh-token',
      accountId: 'codex-account',
      expiresAt: Date.now() + 60_000,
    }),
  });
  runtimeStore.setHydratedProviderAuth(true, 'grok_oauth');

  const codexStatus = await getProviderBootstrapStatus({
    runtimeStore,
    bootstrapStore,
  });
  const grokStatus = await getProviderBootstrapStatus({
    providerId: 'grok_oauth',
    runtimeStore,
    bootstrapStore,
  });

  assert.equal(codexStatus.state, 'ready');
  assert.equal(codexStatus.ready, true);
  assert.equal(grokStatus.state, 'missing');
  assert.equal(grokStatus.ready, false);
});

void test('missing provider credentials only trigger one hydration read until runtime state is cleared', async () => {
  const runtimeStore = createProviderAuthRuntimeStore();
  let readCalls = 0;
  const readCredential = async () => {
    readCalls += 1;
    return null;
  };

  const first = await getProviderAuthStatus({
    runtimeStore,
    readCredential,
  });
  const second = await getProviderAuthStatus({
    runtimeStore,
    readCredential,
  });

  assert.equal(first.ready, false);
  assert.equal(second.ready, false);
  assert.equal(readCalls, 1);
});

void test('getProviderBootstrapStatus surfaces refresh failure when the cached token is already expired', async () => {
  const { bootstrapStore, runtimeStore } = createProviderAuthTestStores();
  await initProviderAuth({
    runtimeStore,
    readCredential: async () => ({
      accessToken: 'stale-token',
      refreshToken: 'refresh-token',
      accountId: 'account-1',
      expiresAt: Date.now() - 1_000,
    }),
  });

  const auth = await getProviderAuth({
    runtimeStore,
    refreshCredential: async () => {
      throw new Error('network down');
    },
  });
  const status = await getProviderBootstrapStatus({
    runtimeStore,
    bootstrapStore,
  });

  assert.equal(auth.accessToken, 'stale-token');
  assert.equal(status.state, 'expired');
  assert.equal(status.ready, false);
  assert.equal(status.lastErrorCode, 'provider_auth_refresh_failed');
  assert.match(status.lastErrorMessage ?? '', /Provider token refresh failed/);
  assert.match(status.lastErrorMessage ?? '', /network down/);
});

void test('provider auth refresh invalidates reconnect status even before the local expiry clock', async () => {
  const { bootstrapStore, runtimeStore } = createProviderAuthTestStores();
  await initProviderAuth({
    runtimeStore,
    readCredential: async () => ({
      accessToken: 'stale-token',
      refreshToken: 'refresh-token',
      accountId: 'account-1',
      expiresAt: Date.now() + 1_000,
    }),
  });

  await assert.rejects(
    () =>
      getProviderAuth({
        runtimeStore,
        refreshCredential: async () => {
          throw Object.assign(
            new Error(
              'Saved provider credential is invalid. Reconnect the provider.',
            ),
            { code: 'provider_auth_invalid' },
          );
        },
      }),
    /Reconnect the provider/,
  );
  const status = await getProviderBootstrapStatus({
    runtimeStore,
    bootstrapStore,
  });

  assert.equal(status.state, 'expired');
  assert.equal(status.ready, false);
  assert.equal(status.lastErrorCode, 'provider_auth_invalid');
  assert.match(status.lastErrorMessage ?? '', /Reconnect the provider/);
});

void test('concurrent getProviderAuth callers share one in-flight refresh', async () => {
  const { runtimeStore } = createProviderAuthTestStores();
  await initProviderAuth({
    runtimeStore,
    readCredential: async () => ({
      accessToken: 'stale-token',
      refreshToken: 'refresh-token',
      accountId: 'account-1',
      expiresAt: Date.now() - 1_000,
    }),
  });

  let refreshCalls = 0;
  let persistCalls = 0;
  let releaseRefresh!: (credential: {
    accessToken: string;
    refreshToken: string;
    accountId: string;
    expiresAt: number;
  }) => void;

  const refreshGate = new Promise<{
    accessToken: string;
    refreshToken: string;
    accountId: string;
    expiresAt: number;
  }>((resolve) => {
    releaseRefresh = resolve;
  });

  const first = getProviderAuth({
    runtimeStore,
    refreshCredential: async () => {
      refreshCalls += 1;
      return refreshGate;
    },
    persistCredential: async (credential) => {
      persistCalls += 1;
      runtimeStore.setCachedProviderCredential(credential);
    },
  });
  const second = getProviderAuth({
    runtimeStore,
    refreshCredential: async () => {
      refreshCalls += 1;
      return refreshGate;
    },
    persistCredential: async (credential) => {
      persistCalls += 1;
      runtimeStore.setCachedProviderCredential(credential);
    },
  });

  await Promise.resolve();
  assert.equal(refreshCalls, 1);
  releaseRefresh({
    accessToken: 'fresh-token',
    refreshToken: 'refresh-token',
    accountId: 'account-1',
    expiresAt: Date.now() + 60_000,
  });

  const [firstAuth, secondAuth] = await Promise.all([first, second]);
  assert.equal(firstAuth.accessToken, 'fresh-token');
  assert.equal(secondAuth.accessToken, 'fresh-token');
  assert.equal(firstAuth.accountId, 'account-1');
  assert.equal(secondAuth.accountId, 'account-1');
  assert.equal(refreshCalls, 1);
  assert.equal(persistCalls, 1);
});

void test('getProviderAuth can use an injected runtime store without warming the default cache', async () => {
  const untouchedRuntimeStore = createProviderAuthRuntimeStore();
  const runtimeStore = createProviderAuthRuntimeStore();

  await initProviderAuth({
    runtimeStore,
    readCredential: async () => ({
      accessToken: 'local-token',
      refreshToken: 'local-refresh',
      accountId: 'local-account',
      expiresAt: Date.now() + 120_000,
    }),
  });

  const auth = await getProviderAuth({ runtimeStore });

  assert.equal(auth.accessToken, 'local-token');
  assert.equal(auth.accountId, 'local-account');
  assert.equal(untouchedRuntimeStore.getCachedProviderCredential(), null);
});
