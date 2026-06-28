import test from 'node:test';
import assert from 'node:assert/strict';

import { refreshProviderToken } from './refresh.js';

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

void test('refreshProviderToken rejects when no refresh token is available and does not call fetch', async () => {
  let fetchCalled = false;

  await assert.rejects(
    () =>
      refreshProviderToken(
        {
          accessToken: 'access-token',
          refreshToken: '',
          accountId: 'account-1',
          expiresAt: 0,
        },
        {
          fetchImpl: async () => {
            fetchCalled = true;
            throw new Error('fetch should not be called');
          },
        },
      ),
    /No refresh token available/,
  );

  assert.equal(fetchCalled, false);
});

void test('refreshProviderToken preserves the current refresh token when the provider omits refresh_token', async () => {
  const refreshed = await refreshProviderToken(
    {
      accessToken: 'access-token',
      refreshToken: 'current-refresh-token',
      accountId: 'account-1',
      expiresAt: 0,
    },
    {
      fetchImpl: async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'new-access-token',
            expires_in: 120,
          }),
          text: async () => '',
        }) as Response,
    },
  );

  assert.equal(refreshed.accessToken, 'new-access-token');
  assert.equal(refreshed.refreshToken, 'current-refresh-token');
});

void test('refreshProviderToken fails fast when provider auth client id is not configured', async () => {
  const previousClientId = process.env['PROVIDER_AUTH_CLIENT_ID'];
  const previousInstalledConfigPath =
    process.env['GEULBAT_PROVIDER_AUTH_INSTALLED_CONFIG_PATH'];
  const previousBundledConfigPath =
    process.env['GEULBAT_PROVIDER_AUTH_BUNDLED_CONFIG_PATH'];
  let fetchCalled = false;

  delete process.env['PROVIDER_AUTH_CLIENT_ID'];
  process.env['GEULBAT_PROVIDER_AUTH_INSTALLED_CONFIG_PATH'] =
    '/__geulbat_missing__/refresh-installed-missing.json';
  process.env['GEULBAT_PROVIDER_AUTH_BUNDLED_CONFIG_PATH'] =
    '/__geulbat_missing__/refresh-bundled-missing.json';

  try {
    await assert.rejects(
      () =>
        refreshProviderToken(
          {
            accessToken: 'access-token',
            refreshToken: 'refresh-token',
            accountId: 'account-1',
            expiresAt: 0,
          },
          {
            fetchImpl: async () => {
              fetchCalled = true;
              throw new Error('fetch should not be called');
            },
          },
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          (error as Error & { code?: string }).code,
          'provider_auth_not_configured',
        );
        assert.match(
          error.message,
          /PROVIDER_AUTH_CLIENT_ID is not configured/,
        );
        return true;
      },
    );
    assert.equal(fetchCalled, false);
  } finally {
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
  }
});

void test('refreshProviderToken rejects invalid response bodies from the token endpoint', async () => {
  await assert.rejects(
    () =>
      refreshProviderToken(
        {
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          accountId: 'account-1',
          expiresAt: 0,
        },
        {
          fetchImpl: async () =>
            ({
              ok: true,
              status: 200,
              json: async () => ({ access_token: 123 }),
              text: async () => '',
            }) as Response,
        },
      ),
    /invalid response body/,
  );
});

void test('refreshProviderToken preserves long provider error bodies', async () => {
  const detail = 'provider-refresh-detail '.repeat(20);

  await assert.rejects(
    () =>
      refreshProviderToken(
        {
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          accountId: 'account-1',
          expiresAt: 0,
        },
        {
          fetchImpl: async () =>
            ({
              ok: false,
              status: 502,
              text: async () => detail,
            }) as Response,
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        `Provider token refresh failed (502): ${detail}`,
      );
      return true;
    },
  );
});

for (const status of [401, 403] as const) {
  void test(`refreshProviderToken maps ${status} responses to provider_auth_invalid`, async () => {
    await assert.rejects(
      () =>
        refreshProviderToken(
          {
            accessToken: 'access-token',
            refreshToken: 'refresh-token',
            accountId: 'account-1',
            expiresAt: 0,
          },
          {
            fetchImpl: async () =>
              ({
                ok: false,
                status,
                text: async () => 'invalid credential',
              }) as Response,
          },
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          (error as Error & { code?: string; status?: number }).code,
          'provider_auth_invalid',
        );
        assert.equal(
          (error as Error & { code?: string; status?: number }).status,
          status,
        );
        assert.match(error.message, /Reconnect the provider/i);
        return true;
      },
    );
  });
}
