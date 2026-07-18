import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GROK_OAUTH_TOKEN_ENDPOINT,
  buildGrokOAuthRefreshTokenRequest,
  parseGrokOAuthRefreshTokenResponse,
  refreshGrokOAuthProviderCredential,
  refreshProviderCredential,
  refreshProviderToken,
} from './refresh.js';

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

void test('buildGrokOAuthRefreshTokenRequest projects explicit client credentials into OAuth form body', () => {
  const request = buildGrokOAuthRefreshTokenRequest({
    tokenEndpoint: 'https://auth.example.test/oauth2/token',
    clientId: 'client-id',
    refreshToken: 'refresh-token',
  });

  assert.equal(request.url, 'https://auth.example.test/oauth2/token');
  assert.equal(request.init.method, 'POST');
  assert.equal(
    request.init.headers.get('content-type'),
    'application/x-www-form-urlencoded',
  );
  assert.equal(request.init.body.get('grant_type'), 'refresh_token');
  assert.equal(request.init.body.get('client_id'), 'client-id');
  assert.equal(request.init.body.get('refresh_token'), 'refresh-token');
});

void test('buildGrokOAuthRefreshTokenRequest uses the Grok OAuth token endpoint by default', () => {
  const request = buildGrokOAuthRefreshTokenRequest({
    clientId: 'client-id',
    refreshToken: 'refresh-token',
  });

  assert.equal(request.url, GROK_OAUTH_TOKEN_ENDPOINT);
});

void test('buildGrokOAuthRefreshTokenRequest rejects missing boundary credentials', () => {
  assert.throws(
    () =>
      buildGrokOAuthRefreshTokenRequest({
        clientId: '  ',
        refreshToken: 'refresh-token',
      }),
    /clientId is required/u,
  );
  assert.throws(
    () =>
      buildGrokOAuthRefreshTokenRequest({
        clientId: 'client-id',
        refreshToken: '  ',
      }),
    /refreshToken is required/u,
  );
});

void test('parseGrokOAuthRefreshTokenResponse maps OAuth snake-case fields to internal token response shape', () => {
  assert.deepEqual(
    parseGrokOAuthRefreshTokenResponse({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 90,
    }),
    {
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresIn: 90,
    },
  );
});

void test('parseGrokOAuthRefreshTokenResponse rejects invalid response shapes', () => {
  assert.throws(
    () => parseGrokOAuthRefreshTokenResponse(null),
    /invalid response body/u,
  );
  assert.throws(
    () => parseGrokOAuthRefreshTokenResponse({ access_token: 123 }),
    /invalid response body/u,
  );
  assert.throws(
    () => parseGrokOAuthRefreshTokenResponse({ expires_in: -1 }),
    /invalid response body/u,
  );
});

void test('refreshGrokOAuthProviderCredential rotates access and refresh tokens with provider expiry when present', async () => {
  const observed: { url?: string; body?: URLSearchParams } = {};
  const fetchImpl: typeof fetch = async (input, init) => {
    observed.url = String(input);
    assert.ok(init?.body instanceof URLSearchParams);
    observed.body = init.body;

    return new Response(
      JSON.stringify({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 90,
      }),
      { status: 200 },
    );
  };

  const refreshed = await refreshGrokOAuthProviderCredential(
    {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      accountId: 'grok-account',
      expiresAt: 1,
    },
    { fetchImpl, nowMs: () => 1_000_000 },
  );

  assert.equal(observed.url, GROK_OAUTH_TOKEN_ENDPOINT);
  assert.equal(observed.body?.get('refresh_token'), 'old-refresh');
  assert.deepEqual(refreshed, {
    accessToken: 'new-access',
    refreshToken: 'new-refresh',
    accountId: 'grok-account',
    expiresAt: 1_090_000,
  });
});

void test('refreshGrokOAuthProviderCredential keeps the existing refresh token and records unknown expiry as zero', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ access_token: 'new-access' }), {
      status: 200,
    });

  const refreshed = await refreshGrokOAuthProviderCredential(
    {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      accountId: 'grok-account',
      expiresAt: 1,
    },
    { fetchImpl },
  );

  assert.deepEqual(refreshed, {
    accessToken: 'new-access',
    refreshToken: 'old-refresh',
    accountId: 'grok-account',
    expiresAt: 0,
  });
});

void test('refreshGrokOAuthProviderCredential classifies invalid OAuth credentials without hiding the provider status', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response('invalid refresh token', { status: 401 });

  await assert.rejects(
    () =>
      refreshGrokOAuthProviderCredential(
        {
          accessToken: 'old-access',
          refreshToken: 'old-refresh',
          accountId: 'grok-account',
          expiresAt: 0,
        },
        { fetchImpl },
      ),
    (error: unknown) => {
      assert.equal(errorProperty(error, 'code'), 'provider_auth_invalid');
      assert.equal(errorProperty(error, 'status'), 401);
      return true;
    },
  );
});

void test('refreshGrokOAuthProviderCredential rejects missing access_token in successful responses', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ refresh_token: 'new-refresh' }), {
      status: 200,
    });

  await assert.rejects(
    () =>
      refreshGrokOAuthProviderCredential(
        {
          accessToken: 'old-access',
          refreshToken: 'old-refresh',
          accountId: 'grok-account',
          expiresAt: 0,
        },
        { fetchImpl },
      ),
    /missing access_token/u,
  );
});

void test('refreshProviderCredential routes Grok OAuth credentials through the Grok refresh owner', async () => {
  const observed: { url?: string } = {};
  const refreshed = await refreshProviderCredential(
    'grok_oauth',
    {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      accountId: 'grok-account',
      expiresAt: 0,
    },
    {
      fetchImpl: async (input) => {
        observed.url = String(input);
        return new Response(JSON.stringify({ access_token: 'new-access' }), {
          status: 200,
        });
      },
    },
  );

  assert.equal(observed.url, GROK_OAUTH_TOKEN_ENDPOINT);
  assert.equal(refreshed.accessToken, 'new-access');
  assert.equal(refreshed.accountId, 'grok-account');
});

function errorProperty(error: unknown, key: string): unknown {
  if (
    error === null ||
    (typeof error !== 'object' && typeof error !== 'function')
  ) {
    return undefined;
  }
  return Reflect.get(error, key);
}
