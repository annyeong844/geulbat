import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GROK_OAUTH_REDIRECT_URI,
  MISSING_PROVIDER_AUTH_CLIENT_ID_MESSAGE,
  type ProviderAuthCallbackListenerConfig,
} from './daemon/auth/bootstrap/config.js';
import {
  authHeaders,
  createRouteTestDaemonContext,
  withAuthenticatedDaemonServer,
  withDaemonServer,
} from './test-support/http-routes.js';

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

void test('provider-auth callback route stays public and returns html failure for missing state', async () => {
  const daemonContext = createRouteTestDaemonContext();
  daemonContext.providerAuthRuntime.clearProviderAuthRuntimeState();
  daemonContext.providerAuthBootstrap.clearProviderAuthBootstrapState();

  try {
    await withDaemonServer(
      async ({ port }) => {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/provider-auth/callback`,
        );

        assert.equal(res.status, 400);
        assert.match(res.headers.get('content-type') ?? '', /text\/html/);
        assert.match(await res.text(), /Missing callback state/i);
      },
      { daemonContext },
    );
  } finally {
    daemonContext.providerAuthRuntime.clearProviderAuthRuntimeState();
    daemonContext.providerAuthBootstrap.clearProviderAuthBootstrapState();
  }
});

void test('provider-auth start route validates launcher over authenticated HTTP', async () => {
  const daemonContext = createRouteTestDaemonContext();
  daemonContext.providerAuthRuntime.clearProviderAuthRuntimeState();
  daemonContext.providerAuthBootstrap.clearProviderAuthBootstrapState();

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/provider-auth/start`,
          {
            method: 'POST',
            headers: authHeaders({
              'Content-Type': 'application/json',
            }),
            body: JSON.stringify({ launcher: 'desktop' }),
          },
        );

        assert.equal(res.status, 400);
        const body = (await res.json()) as { code: string; message: string };
        assert.equal(body.code, 'bad_request');
        assert.match(body.message, /launcher must be "web-shell"/);
      },
      { daemonContext },
    );
  } finally {
    daemonContext.providerAuthRuntime.clearProviderAuthRuntimeState();
    daemonContext.providerAuthBootstrap.clearProviderAuthBootstrapState();
  }
});

void test('provider-auth start route rejects unsupported provider ids', async () => {
  const daemonContext = createRouteTestDaemonContext();
  daemonContext.providerAuthRuntime.clearProviderAuthRuntimeState();
  daemonContext.providerAuthBootstrap.clearProviderAuthBootstrapState();

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/provider-auth/start`,
          {
            method: 'POST',
            headers: authHeaders({
              'Content-Type': 'application/json',
            }),
            body: JSON.stringify({
              launcher: 'web-shell',
              providerId: 'grok',
            }),
          },
        );

        assert.equal(res.status, 400);
        const body = (await res.json()) as { code: string; message: string };
        assert.equal(body.code, 'bad_request');
        assert.match(body.message, /providerId is not supported/);
      },
      { daemonContext },
    );
  } finally {
    daemonContext.providerAuthRuntime.clearProviderAuthRuntimeState();
    daemonContext.providerAuthBootstrap.clearProviderAuthBootstrapState();
  }
});

void test('provider-auth start route returns conflict only when provider status is ready', async () => {
  const daemonContext = createRouteTestDaemonContext();
  daemonContext.providerAuthRuntime.clearProviderAuthRuntimeState();
  daemonContext.providerAuthBootstrap.clearProviderAuthBootstrapState();
  daemonContext.providerAuthRuntime.setCachedProviderCredential({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    accountId: 'account-1',
    expiresAt: Date.now() + 60_000,
  });
  daemonContext.providerAuthRuntime.setHydratedProviderAuth(true);

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/provider-auth/start`,
          {
            method: 'POST',
            headers: authHeaders({
              'Content-Type': 'application/json',
            }),
            body: JSON.stringify({ launcher: 'web-shell' }),
          },
        );

        assert.equal(res.status, 409);
        const body = (await res.json()) as { code: string; message: string };
        assert.equal(body.code, 'provider_auth_already_connected');
      },
      { daemonContext },
    );
  } finally {
    daemonContext.providerAuthRuntime.clearProviderAuthRuntimeState();
    daemonContext.providerAuthBootstrap.clearProviderAuthBootstrapState();
  }
});

void test('provider-auth start route can start Grok OAuth while Codex direct is already connected', async () => {
  const daemonContext = createRouteTestDaemonContext();
  daemonContext.providerAuthRuntime.clearProviderAuthRuntimeState();
  daemonContext.providerAuthBootstrap.clearProviderAuthBootstrapState();
  daemonContext.providerAuthRuntime.setCachedProviderCredential({
    accessToken: 'codex-access-token',
    refreshToken: 'codex-refresh-token',
    accountId: 'codex-account-1',
    expiresAt: Date.now() + 60_000,
  });
  daemonContext.providerAuthRuntime.setHydratedProviderAuth(true);
  daemonContext.providerAuthRuntime.setHydratedProviderAuth(true, 'grok_oauth');
  const previousEnsureListening =
    daemonContext.providerAuthCallbackServer.ensureListening;
  let callbackListener: ProviderAuthCallbackListenerConfig | null = null;
  daemonContext.providerAuthCallbackServer.ensureListening = async (
    listener,
  ) => {
    callbackListener = listener ?? null;
  };

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/provider-auth/start`,
          {
            method: 'POST',
            headers: authHeaders({
              'Content-Type': 'application/json',
            }),
            body: JSON.stringify({
              launcher: 'web-shell',
              providerId: 'grok_oauth',
            }),
          },
        );

        assert.equal(res.status, 200);
        const body = (await res.json()) as {
          authSessionId: string;
          authorizeUrl: string;
          expiresAt: number;
          providerId: string;
        };
        assert.equal(body.providerId, 'grok_oauth');
        assert.ok(body.authSessionId.length > 0);
        assert.match(body.authorizeUrl, /^https:\/\/auth\.x\.ai\//);
        assert.equal(typeof body.expiresAt, 'number');
        assert.equal(callbackListener?.redirectUri, GROK_OAUTH_REDIRECT_URI);
      },
      { daemonContext },
    );
  } finally {
    daemonContext.providerAuthCallbackServer.ensureListening =
      previousEnsureListening;
    daemonContext.providerAuthRuntime.clearProviderAuthRuntimeState();
    daemonContext.providerAuthBootstrap.clearProviderAuthBootstrapState();
  }
});

void test('provider-auth start route allows reconnect when status is expired', async () => {
  const daemonContext = createRouteTestDaemonContext();
  daemonContext.providerAuthRuntime.clearProviderAuthRuntimeState();
  daemonContext.providerAuthBootstrap.clearProviderAuthBootstrapState();
  daemonContext.providerAuthRuntime.setCachedProviderCredential({
    accessToken: 'expired-access-token',
    refreshToken: 'refresh-token',
    accountId: 'account-1',
    expiresAt: Date.now() - 60_000,
  });
  daemonContext.providerAuthRuntime.setCachedProviderAuthRefreshError({
    code: 'provider_auth_refresh_failed',
    message: 'Provider token refresh failed. network down',
  });
  daemonContext.providerAuthRuntime.setHydratedProviderAuth(true);
  const previousEnsureListening =
    daemonContext.providerAuthCallbackServer.ensureListening;
  daemonContext.providerAuthCallbackServer.ensureListening = async () => {};

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/provider-auth/start`,
          {
            method: 'POST',
            headers: authHeaders({
              'Content-Type': 'application/json',
            }),
            body: JSON.stringify({ launcher: 'web-shell' }),
          },
        );

        assert.equal(res.status, 200);
        const body = (await res.json()) as {
          authSessionId: string;
          authorizeUrl: string;
          expiresAt: number;
        };
        assert.ok(body.authSessionId.length > 0);
        assert.match(body.authorizeUrl, /^https:\/\/auth\.openai\.com\//);
        assert.equal(typeof body.expiresAt, 'number');
      },
      { daemonContext },
    );
  } finally {
    daemonContext.providerAuthCallbackServer.ensureListening =
      previousEnsureListening;
    daemonContext.providerAuthRuntime.clearProviderAuthRuntimeState();
    daemonContext.providerAuthBootstrap.clearProviderAuthBootstrapState();
  }
});

void test('provider-auth status route returns protocol error shape for unexpected failures', async () => {
  const daemonContext = createRouteTestDaemonContext();
  daemonContext.providerAuthRuntime.clearProviderAuthRuntimeState();
  daemonContext.providerAuthBootstrap.clearProviderAuthBootstrapState();
  const previousHasHydratedProviderAuth =
    daemonContext.providerAuthRuntime.hasHydratedProviderAuth;
  daemonContext.providerAuthRuntime.hasHydratedProviderAuth = () => {
    throw new Error('provider runtime boom');
  };

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/provider-auth/status`,
          {
            headers: authHeaders(),
          },
        );

        assert.equal(res.status, 500);
        const body = (await res.json()) as { code: string; message: string };
        assert.deepEqual(body, {
          code: 'internal',
          message: 'internal server error',
        });
      },
      { daemonContext },
    );
  } finally {
    daemonContext.providerAuthRuntime.hasHydratedProviderAuth =
      previousHasHydratedProviderAuth;
    daemonContext.providerAuthRuntime.clearProviderAuthRuntimeState();
    daemonContext.providerAuthBootstrap.clearProviderAuthBootstrapState();
  }
});

void test('provider-auth status route reports missing client id as a protocol error state', async () => {
  const daemonContext = createRouteTestDaemonContext();
  daemonContext.providerAuthRuntime.clearProviderAuthRuntimeState();
  daemonContext.providerAuthBootstrap.clearProviderAuthBootstrapState();
  daemonContext.providerAuthRuntime.setHydratedProviderAuth(true);
  const currentClientId = process.env['PROVIDER_AUTH_CLIENT_ID'];
  delete process.env['PROVIDER_AUTH_CLIENT_ID'];

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/provider-auth/status`,
          {
            headers: authHeaders(),
          },
        );

        assert.equal(res.status, 200);
        const body = (await res.json()) as {
          state: string;
          lastErrorCode?: string;
          lastErrorMessage?: string;
          ready: boolean;
        };
        assert.deepEqual(body, {
          state: 'exchange_failed',
          lastErrorCode: 'provider_auth_not_configured',
          lastErrorMessage: MISSING_PROVIDER_AUTH_CLIENT_ID_MESSAGE,
          ready: false,
        });
      },
      { daemonContext },
    );
  } finally {
    if (currentClientId === undefined) {
      delete process.env['PROVIDER_AUTH_CLIENT_ID'];
    } else {
      process.env['PROVIDER_AUTH_CLIENT_ID'] = currentClientId;
    }
    daemonContext.providerAuthRuntime.clearProviderAuthRuntimeState();
    daemonContext.providerAuthBootstrap.clearProviderAuthBootstrapState();
  }
});

void test('provider-auth status route stays ready when a usable cached credential exists even if client id config is missing', async () => {
  const daemonContext = createRouteTestDaemonContext();
  daemonContext.providerAuthRuntime.clearProviderAuthRuntimeState();
  daemonContext.providerAuthBootstrap.clearProviderAuthBootstrapState();
  daemonContext.providerAuthRuntime.setCachedProviderCredential({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    accountId: 'account-1',
    expiresAt: Date.now() + 60_000,
  });
  daemonContext.providerAuthRuntime.setHydratedProviderAuth(true);
  const currentClientId = process.env['PROVIDER_AUTH_CLIENT_ID'];
  delete process.env['PROVIDER_AUTH_CLIENT_ID'];

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/provider-auth/status`,
          {
            headers: authHeaders(),
          },
        );

        assert.equal(res.status, 200);
        const body = (await res.json()) as {
          state: string;
          ready: boolean;
        };
        assert.equal(body.state, 'ready');
        assert.equal(body.ready, true);
      },
      { daemonContext },
    );
  } finally {
    if (currentClientId === undefined) {
      delete process.env['PROVIDER_AUTH_CLIENT_ID'];
    } else {
      process.env['PROVIDER_AUTH_CLIENT_ID'] = currentClientId;
    }
    daemonContext.providerAuthRuntime.clearProviderAuthRuntimeState();
    daemonContext.providerAuthBootstrap.clearProviderAuthBootstrapState();
  }
});

void test('provider-auth start route reports missing client id as exact config error', async () => {
  const daemonContext = createRouteTestDaemonContext();
  daemonContext.providerAuthRuntime.clearProviderAuthRuntimeState();
  daemonContext.providerAuthBootstrap.clearProviderAuthBootstrapState();
  daemonContext.providerAuthRuntime.setHydratedProviderAuth(true);
  const currentClientId = process.env['PROVIDER_AUTH_CLIENT_ID'];
  delete process.env['PROVIDER_AUTH_CLIENT_ID'];

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/provider-auth/start`,
          {
            method: 'POST',
            headers: authHeaders({
              'Content-Type': 'application/json',
            }),
            body: JSON.stringify({ launcher: 'web-shell' }),
          },
        );

        assert.equal(res.status, 503);
        const body = (await res.json()) as { code: string; message: string };
        assert.deepEqual(body, {
          code: 'provider_auth_not_configured',
          message: MISSING_PROVIDER_AUTH_CLIENT_ID_MESSAGE,
        });
      },
      { daemonContext },
    );
  } finally {
    if (currentClientId === undefined) {
      delete process.env['PROVIDER_AUTH_CLIENT_ID'];
    } else {
      process.env['PROVIDER_AUTH_CLIENT_ID'] = currentClientId;
    }
    daemonContext.providerAuthRuntime.clearProviderAuthRuntimeState();
    daemonContext.providerAuthBootstrap.clearProviderAuthBootstrapState();
  }
});

void test('provider-auth start route reports callback listener bind failures explicitly', async () => {
  const daemonContext = createRouteTestDaemonContext();
  daemonContext.providerAuthRuntime.clearProviderAuthRuntimeState();
  daemonContext.providerAuthBootstrap.clearProviderAuthBootstrapState();
  daemonContext.providerAuthRuntime.setHydratedProviderAuth(true);
  const previousEnsureListening =
    daemonContext.providerAuthCallbackServer.ensureListening;
  daemonContext.providerAuthCallbackServer.ensureListening = async () => {
    throw new Error('EADDRINUSE');
  };

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/provider-auth/start`,
          {
            method: 'POST',
            headers: authHeaders({
              'Content-Type': 'application/json',
            }),
            body: JSON.stringify({ launcher: 'web-shell' }),
          },
        );

        assert.equal(res.status, 503);
        const body = (await res.json()) as { code: string; message: string };
        assert.deepEqual(body, {
          code: 'provider_auth_callback_unavailable',
          message: 'Provider auth callback listener is unavailable.',
        });
      },
      { daemonContext },
    );
  } finally {
    daemonContext.providerAuthCallbackServer.ensureListening =
      previousEnsureListening;
    daemonContext.providerAuthRuntime.clearProviderAuthRuntimeState();
    daemonContext.providerAuthBootstrap.clearProviderAuthBootstrapState();
  }
});

void test('provider-auth start route falls back generic start failures to provider_auth_exchange_failed', async () => {
  const daemonContext = createRouteTestDaemonContext();
  daemonContext.providerAuthRuntime.clearProviderAuthRuntimeState();
  daemonContext.providerAuthBootstrap.clearProviderAuthBootstrapState();
  daemonContext.providerAuthRuntime.setHydratedProviderAuth(true);
  const previousEnsureListening =
    daemonContext.providerAuthCallbackServer.ensureListening;
  daemonContext.providerAuthCallbackServer.ensureListening = async () => {};
  const previousSetPendingProviderAuthSession =
    daemonContext.providerAuthBootstrap.setPendingProviderAuthSession;
  daemonContext.providerAuthBootstrap.setPendingProviderAuthSession = () => {
    throw new Error('provider auth session store boom');
  };

  try {
    await withAuthenticatedDaemonServer(
      async ({ port }) => {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/provider-auth/start`,
          {
            method: 'POST',
            headers: authHeaders({
              'Content-Type': 'application/json',
            }),
            body: JSON.stringify({ launcher: 'web-shell' }),
          },
        );

        assert.equal(res.status, 502);
        const body = (await res.json()) as { code: string; message: string };
        assert.deepEqual(body, {
          code: 'provider_auth_exchange_failed',
          message: 'Failed to initialize provider auth login.',
        });
      },
      { daemonContext },
    );
  } finally {
    daemonContext.providerAuthCallbackServer.ensureListening =
      previousEnsureListening;
    daemonContext.providerAuthBootstrap.setPendingProviderAuthSession =
      previousSetPendingProviderAuthSession;
    daemonContext.providerAuthRuntime.clearProviderAuthRuntimeState();
    daemonContext.providerAuthBootstrap.clearProviderAuthBootstrapState();
  }
});

void test('provider-auth callback route keeps html fallback for unexpected failures', async () => {
  const daemonContext = createRouteTestDaemonContext();
  daemonContext.providerAuthRuntime.clearProviderAuthRuntimeState();
  daemonContext.providerAuthBootstrap.clearProviderAuthBootstrapState();
  const previousGetProviderAuthSessionSnapshotByState =
    daemonContext.providerAuthBootstrap.getProviderAuthSessionSnapshotByState;
  daemonContext.providerAuthBootstrap.getProviderAuthSessionSnapshotByState =
    () => {
      throw new Error('provider callback boom');
    };

  try {
    await withDaemonServer(
      async ({ port }) => {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/provider-auth/callback?state=test-state&code=test-code`,
        );

        assert.equal(res.status, 500);
        assert.match(res.headers.get('content-type') ?? '', /text\/html/);
        assert.match(await res.text(), /Internal server error/i);
      },
      { daemonContext },
    );
  } finally {
    daemonContext.providerAuthBootstrap.getProviderAuthSessionSnapshotByState =
      previousGetProviderAuthSessionSnapshotByState;
    daemonContext.providerAuthRuntime.clearProviderAuthRuntimeState();
    daemonContext.providerAuthBootstrap.clearProviderAuthBootstrapState();
  }
});
