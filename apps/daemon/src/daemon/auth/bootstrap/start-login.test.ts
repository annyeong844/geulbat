import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import {
  MISSING_PROVIDER_AUTH_CLIENT_ID_MESSAGE,
  PROVIDER_AUTH_NOT_CONFIGURED_CODE,
} from './config.js';
import { getErrorCode } from '../../utils/error.js';
import { createProviderAuthBootstrapStore } from './session-store.js';
import {
  PROVIDER_AUTH_CALLBACK_UNAVAILABLE_MESSAGE,
  startProviderAuthLogin,
} from './start-login.js';

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

void test('startProviderAuthLogin returns the current pending session', async () => {
  const bootstrapStore = createProviderAuthBootstrapStore();
  let ensureCalls = 0;

  const first = await startProviderAuthLogin({
    bootstrapStore,
    ensureCallbackServer: async () => {
      ensureCalls += 1;
    },
  });
  const second = await startProviderAuthLogin({
    bootstrapStore,
    ensureCallbackServer: async () => {
      ensureCalls += 1;
    },
  });

  assert.equal(second.authSessionId, first.authSessionId);

  const url = new URL(first.authorizeUrl);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id')?.length ? true : false, true);
  assert.equal(
    url.searchParams.get('redirect_uri'),
    'http://localhost:1455/auth/callback',
  );
  assert.equal(
    url.searchParams.get('scope'),
    'openid profile email offline_access',
  );
  assert.equal(url.searchParams.get('state')?.length ? true : false, true);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(
    url.searchParams.get('code_challenge')?.length ? true : false,
    true,
  );
  assert.equal(url.searchParams.get('id_token_add_organizations'), 'true');
  assert.equal(url.searchParams.get('codex_cli_simplified_flow'), 'true');
  assert.equal(url.searchParams.get('originator'), 'pi');
  assert.equal(ensureCalls, 2);
});

void test('startProviderAuthLogin can use an injected bootstrap store', async () => {
  const bootstrapStore = createProviderAuthBootstrapStore();
  const untouchedBootstrapStore = createProviderAuthBootstrapStore();

  const response = await startProviderAuthLogin({
    bootstrapStore,
    ensureCallbackServer: async () => {},
  });

  assert.equal(
    bootstrapStore.getPendingProviderAuthSession()?.authSessionId,
    response.authSessionId,
  );
  assert.equal(untouchedBootstrapStore.getPendingProviderAuthSession(), null);
});

void test('startProviderAuthLogin can resolve client id from installed config when env is absent', async () => {
  const bootstrapStore = createProviderAuthBootstrapStore();
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'geulbat-auth-config-'));
  const installedPath = path.join(tempRoot, 'provider-auth.json');
  const currentClientId = process.env['PROVIDER_AUTH_CLIENT_ID'];
  const currentInstalledPath =
    process.env['GEULBAT_PROVIDER_AUTH_INSTALLED_CONFIG_PATH'];
  const currentBundledPath =
    process.env['GEULBAT_PROVIDER_AUTH_BUNDLED_CONFIG_PATH'];

  await writeFile(installedPath, '{"clientId":"installed-client-id"}', 'utf8');
  delete process.env['PROVIDER_AUTH_CLIENT_ID'];
  process.env['GEULBAT_PROVIDER_AUTH_INSTALLED_CONFIG_PATH'] = installedPath;
  process.env['GEULBAT_PROVIDER_AUTH_BUNDLED_CONFIG_PATH'] =
    '/__geulbat_missing__/provider-auth.config.json';

  try {
    const response = await startProviderAuthLogin({
      bootstrapStore,
      ensureCallbackServer: async () => {},
    });
    const url = new URL(response.authorizeUrl);
    assert.equal(url.searchParams.get('client_id'), 'installed-client-id');
  } finally {
    if (currentClientId === undefined) {
      delete process.env['PROVIDER_AUTH_CLIENT_ID'];
    } else {
      process.env['PROVIDER_AUTH_CLIENT_ID'] = currentClientId;
    }
    if (currentInstalledPath === undefined) {
      delete process.env['GEULBAT_PROVIDER_AUTH_INSTALLED_CONFIG_PATH'];
    } else {
      process.env['GEULBAT_PROVIDER_AUTH_INSTALLED_CONFIG_PATH'] =
        currentInstalledPath;
    }
    if (currentBundledPath === undefined) {
      delete process.env['GEULBAT_PROVIDER_AUTH_BUNDLED_CONFIG_PATH'];
    } else {
      process.env['GEULBAT_PROVIDER_AUTH_BUNDLED_CONFIG_PATH'] =
        currentBundledPath;
    }
  }
});

void test('startProviderAuthLogin fails closed when provider auth client id is missing', async () => {
  const bootstrapStore = createProviderAuthBootstrapStore();
  const currentClientId = process.env['PROVIDER_AUTH_CLIENT_ID'];
  delete process.env['PROVIDER_AUTH_CLIENT_ID'];

  try {
    await assert.rejects(
      startProviderAuthLogin({
        bootstrapStore,
        ensureCallbackServer: async () => {
          assert.fail('ensureCallbackServer should not run without client id');
        },
      }),
      (err: unknown) => {
        assert.match(
          err instanceof Error ? err.message : String(err),
          new RegExp(MISSING_PROVIDER_AUTH_CLIENT_ID_MESSAGE),
        );
        assert.equal(getErrorCode(err), PROVIDER_AUTH_NOT_CONFIGURED_CODE);
        return true;
      },
    );
    assert.equal(bootstrapStore.getPendingProviderAuthSession(), null);
  } finally {
    if (currentClientId === undefined) {
      delete process.env['PROVIDER_AUTH_CLIENT_ID'];
    } else {
      process.env['PROVIDER_AUTH_CLIENT_ID'] = currentClientId;
    }
  }
});

void test('startProviderAuthLogin fails with callback unavailable when loopback bind fails', async () => {
  const bootstrapStore = createProviderAuthBootstrapStore();

  await assert.rejects(
    startProviderAuthLogin({
      bootstrapStore,
      ensureCallbackServer: async () => {
        throw new Error('EADDRINUSE');
      },
    }),
    (err: unknown) => {
      assert.equal(
        err instanceof Error ? err.message : String(err),
        PROVIDER_AUTH_CALLBACK_UNAVAILABLE_MESSAGE,
      );
      assert.equal(getErrorCode(err), 'provider_auth_callback_unavailable');
      return true;
    },
  );
});
