import test from 'node:test';
import assert from 'node:assert/strict';

import {
  exchangeAuthorizationCode,
  extractProviderAuthErrorCode,
} from './callback-exchange.js';

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

void test('exchangeAuthorizationCode fails fast when provider auth client id is not configured', async () => {
  const previousClientId = process.env['PROVIDER_AUTH_CLIENT_ID'];
  const previousInstalledConfigPath =
    process.env['GEULBAT_PROVIDER_AUTH_INSTALLED_CONFIG_PATH'];
  const previousBundledConfigPath =
    process.env['GEULBAT_PROVIDER_AUTH_BUNDLED_CONFIG_PATH'];
  let fetchCalled = false;

  delete process.env['PROVIDER_AUTH_CLIENT_ID'];
  process.env['GEULBAT_PROVIDER_AUTH_INSTALLED_CONFIG_PATH'] =
    '/__geulbat_missing__/exchange-installed-missing.json';
  process.env['GEULBAT_PROVIDER_AUTH_BUNDLED_CONFIG_PATH'] =
    '/__geulbat_missing__/exchange-bundled-missing.json';

  try {
    await assert.rejects(
      () =>
        exchangeAuthorizationCode('code', 'verifier', {
          fetchImpl: async () => {
            fetchCalled = true;
            throw new Error('fetch should not be called');
          },
        }),
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

void test('exchangeAuthorizationCode rejects invalid response bodies from the OAuth provider', async () => {
  await assert.rejects(
    () =>
      exchangeAuthorizationCode('code', 'verifier', {
        fetchImpl: async () =>
          ({
            ok: true,
            status: 200,
            json: async () => [],
            text: async () => '',
          }) as Response,
      }),
    (error: unknown) => {
      assert.equal(
        extractProviderAuthErrorCode(error),
        'provider_auth_exchange_failed',
      );
      assert.ok(error instanceof Error);
      assert.match(error.message, /invalid response body/);
      return true;
    },
  );
});

void test('exchangeAuthorizationCode preserves long provider error bodies', async () => {
  const detail = 'provider-exchange-detail '.repeat(20);

  await assert.rejects(
    () =>
      exchangeAuthorizationCode('code', 'verifier', {
        fetchImpl: async () =>
          ({
            ok: false,
            status: 502,
            text: async () => detail,
          }) as Response,
      }),
    (error: unknown) => {
      assert.equal(
        extractProviderAuthErrorCode(error),
        'provider_auth_exchange_failed',
      );
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        `Provider token exchange failed (502): ${detail}`,
      );
      return true;
    },
  );
});

void test('exchangeAuthorizationCode retries once after a transport failure before succeeding', async () => {
  let attempts = 0;

  const result = await exchangeAuthorizationCode('code', 'verifier', {
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new TypeError('socket reset'), {
          cause: { code: 'ECONNRESET' },
        });
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 90,
        }),
        text: async () => '',
      } as Response;
    },
  });

  assert.equal(attempts, 2);
  assert.equal(result.access_token, 'new-access-token');
  assert.equal(result.refresh_token, 'new-refresh-token');
  assert.equal(result.expires_in, 90);
});

void test('exchangeAuthorizationCode maps abort-driven fetch cancellation to provider_auth_exchange_timeout', async () => {
  await assert.rejects(
    () =>
      exchangeAuthorizationCode('code', 'verifier', {
        timeoutMs: 1,
        fetchImpl: async (_url, init) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new Error('aborted by timeout')),
              { once: true },
            );
          }),
      }),
    (error: unknown) => {
      assert.equal(
        extractProviderAuthErrorCode(error),
        'provider_auth_exchange_timeout',
      );
      assert.ok(error instanceof Error);
      assert.match(error.message, /timed out/i);
      return true;
    },
  );
});
