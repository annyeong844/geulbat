import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createProviderAuthBootstrapStore } from './bootstrap/session-store.js';
import {
  deleteProviderAuthFile,
  hardenProviderAuthFilePermissions,
  readProviderAuthFile,
  type ProviderCredential,
} from './credentials/store.js';
import { createProviderAuthRuntimeStore } from './runtime-state.js';
import {
  getProviderBootstrapStatus,
  loadCurrentProviderCredential,
  logoutProviderAuth,
} from './status.js';

const PROVIDER_CLIENT_ID_ENV = 'PROVIDER_AUTH_CLIENT_ID';
const PROVIDER_FILE_PATH_ENV = 'GEULBAT_PROVIDER_AUTH_FILE_PATH';

void test('provider bootstrap status exposes every durable login session state', async (t) => {
  const previousClientId = process.env[PROVIDER_CLIENT_ID_ENV];
  process.env[PROVIDER_CLIENT_ID_ENV] = 'status-test-client-id';
  t.after(() => restoreEnvironment(PROVIDER_CLIENT_ID_ENV, previousClientId));

  const runtimeStore = createProviderAuthRuntimeStore();
  const bootstrapStore = createProviderAuthBootstrapStore();
  runtimeStore.setHydratedProviderAuth(true);
  const baseSession = {
    authSessionId: 'status-session',
    providerId: 'openai_codex_direct' as const,
    state: 'status-state',
    codeVerifier: 'status-verifier',
    redirectUri: 'http://localhost:1455/auth/callback',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    status: 'pending' as const,
  };

  bootstrapStore.setPendingProviderAuthSession(baseSession);
  assert.deepEqual(
    await getProviderBootstrapStatus({ runtimeStore, bootstrapStore }),
    {
      state: 'pending',
      authSessionId: baseSession.authSessionId,
      expiresAt: baseSession.expiresAt,
      pollAfterMs: 1_000,
      ready: false,
    },
  );

  bootstrapStore.markProviderAuthSessionConsumed(baseSession.authSessionId);
  bootstrapStore.markProviderAuthSessionReady(baseSession.authSessionId);
  assert.deepEqual(
    await getProviderBootstrapStatus({ runtimeStore, bootstrapStore }),
    {
      state: 'ready',
      authSessionId: baseSession.authSessionId,
      expiresAt: baseSession.expiresAt,
      ready: false,
    },
  );

  bootstrapStore.setPendingProviderAuthSession({
    ...baseSession,
    authSessionId: 'failed-session',
    state: 'failed-state',
  });
  bootstrapStore.markProviderAuthSessionFailure(
    'failed-session',
    'provider_auth_exchange_failed',
    'provider exchange failed',
  );
  assert.deepEqual(
    await getProviderBootstrapStatus({ runtimeStore, bootstrapStore }),
    {
      state: 'exchange_failed',
      authSessionId: 'failed-session',
      expiresAt: baseSession.expiresAt,
      lastErrorCode: 'provider_auth_exchange_failed',
      lastErrorMessage: 'provider exchange failed',
      ready: false,
    },
  );

  bootstrapStore.setPendingProviderAuthSession({
    ...baseSession,
    authSessionId: 'expired-session',
    state: 'expired-state',
  });
  bootstrapStore.markProviderAuthSessionExpired(
    'expired-session',
    'login window expired',
  );
  assert.deepEqual(
    await getProviderBootstrapStatus({ runtimeStore, bootstrapStore }),
    {
      state: 'expired',
      authSessionId: 'expired-session',
      expiresAt: baseSession.expiresAt,
      lastErrorCode: 'provider_auth_session_expired',
      lastErrorMessage: 'login window expired',
      ready: false,
    },
  );

  bootstrapStore.setPendingProviderAuthSession({
    ...baseSession,
    authSessionId: 'other-provider-session',
    providerId: 'grok_oauth',
    state: 'other-provider-state',
  });
  assert.deepEqual(
    await getProviderBootstrapStatus({ runtimeStore, bootstrapStore }),
    { state: 'missing', ready: false },
  );
});

void test('current credential hydration is cached and logout removes only the selected provider', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-auth-status-'));
  const credentialPath = join(stateRoot, 'provider.json');
  const previousFilePath = process.env[PROVIDER_FILE_PATH_ENV];
  process.env[PROVIDER_FILE_PATH_ENV] = credentialPath;
  t.after(async () => {
    restoreEnvironment(PROVIDER_FILE_PATH_ENV, previousFilePath);
    await rm(stateRoot, { recursive: true, force: true });
  });

  const runtimeStore = createProviderAuthRuntimeStore({
    hardenPermissions: async () => undefined,
  });
  const bootstrapStore = createProviderAuthBootstrapStore();
  const credential: ProviderCredential = {
    accessToken: 'status-access-token',
    refreshToken: 'status-refresh-token',
    accountId: 'status-account',
    expiresAt: Date.now() + 60_000,
  };
  let reads = 0;
  const readCredential = async () => {
    reads += 1;
    return credential;
  };

  assert.deepEqual(
    await loadCurrentProviderCredential({ runtimeStore, readCredential }),
    credential,
  );
  assert.deepEqual(
    await loadCurrentProviderCredential({ runtimeStore, readCredential }),
    credential,
  );
  assert.equal(reads, 1);

  await runtimeStore.persistProviderCredential(credential);
  bootstrapStore.setPendingProviderAuthSession({
    authSessionId: 'logout-session',
    providerId: 'openai_codex_direct',
    state: 'logout-state',
    codeVerifier: 'logout-verifier',
    redirectUri: 'http://localhost:1455/auth/callback',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    status: 'pending',
  });
  assert.match(await readFile(credentialPath, 'utf8'), /status-access-token/u);

  await logoutProviderAuth({ runtimeStore, bootstrapStore });

  assert.equal(runtimeStore.hasHydratedProviderAuth(), false);
  assert.equal(runtimeStore.getCachedProviderCredential(), null);
  assert.equal(bootstrapStore.getProviderAuthSessionSnapshot(), null);
  await assert.rejects(readFile(credentialPath, 'utf8'), /ENOENT/u);

  bootstrapStore.setPendingProviderAuthSession({
    authSessionId: 'other-provider-session',
    providerId: 'grok_oauth',
    state: 'other-provider-state',
    codeVerifier: 'other-provider-verifier',
    redirectUri: 'http://localhost:1455/auth/callback',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    status: 'pending',
  });
  await logoutProviderAuth({ runtimeStore, bootstrapStore });
  assert.equal(
    bootstrapStore.getProviderAuthSessionSnapshot()?.providerId,
    'grok_oauth',
  );
});

void test('bootstrap status preserves credential load and refresh diagnostics', async () => {
  const previousClientId = process.env[PROVIDER_CLIENT_ID_ENV];
  process.env[PROVIDER_CLIENT_ID_ENV] = 'status-hydration-client-id';
  try {
    const unhydratedRuntimeStore = createProviderAuthRuntimeStore();
    assert.deepEqual(
      await getProviderBootstrapStatus({
        runtimeStore: unhydratedRuntimeStore,
        bootstrapStore: createProviderAuthBootstrapStore(),
        readCredential: async () => null,
      }),
      { state: 'missing', ready: false },
    );
  } finally {
    restoreEnvironment(PROVIDER_CLIENT_ID_ENV, previousClientId);
  }

  const runtimeStore = createProviderAuthRuntimeStore();
  const bootstrapStore = createProviderAuthBootstrapStore();
  runtimeStore.setHydratedProviderAuth(true);
  runtimeStore.setCachedProviderAuthLoadError({
    code: 'access_denied',
    message: 'credential file access denied',
  });

  assert.deepEqual(
    await getProviderBootstrapStatus({ runtimeStore, bootstrapStore }),
    {
      state: 'exchange_failed',
      lastErrorCode: 'access_denied',
      lastErrorMessage: 'credential file access denied',
      ready: false,
    },
  );

  const expiresAt = Date.now() + 60_000;
  runtimeStore.setCachedProviderAuthLoadError(null);
  runtimeStore.setCachedProviderCredential({
    accessToken: 'usable-token',
    refreshToken: 'usable-refresh-token',
    accountId: 'usable-account',
    expiresAt,
  });
  runtimeStore.setCachedProviderAuthRefreshError({
    code: 'provider_auth_refresh_failed',
    message: 'temporary refresh outage',
  });
  assert.deepEqual(
    await getProviderBootstrapStatus({ runtimeStore, bootstrapStore }),
    {
      state: 'ready',
      ready: true,
      expiresAt,
      lastErrorCode: 'provider_auth_refresh_failed',
      lastErrorMessage: 'temporary refresh outage',
    },
  );
});

void test('credential file operations fail closed on corrupt schemas and permission errors', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-auth-file-guards-'));
  const credentialPath = join(stateRoot, 'provider.json');
  const previousFilePath = process.env[PROVIDER_FILE_PATH_ENV];
  process.env[PROVIDER_FILE_PATH_ENV] = credentialPath;
  t.after(async () => {
    restoreEnvironment(PROVIDER_FILE_PATH_ENV, previousFilePath);
    await rm(stateRoot, { recursive: true, force: true });
  });

  const invalidSchemas = [
    'null',
    '{"version":2,"credentials":[]}',
    '{"version":2,"credentials":{"openai_codex_direct":{"accessToken":7}}}',
    '{"version":3,"credentials":{}}',
  ];
  for (const serialized of invalidSchemas) {
    await writeFile(credentialPath, serialized, 'utf8');
    await assert.rejects(
      readProviderAuthFile(),
      /invalid provider auth file schema/u,
    );
  }

  await writeFile(credentialPath, '{}', 'utf8');
  await deleteProviderAuthFile();
  await assert.rejects(readFile(credentialPath, 'utf8'), /ENOENT/u);

  await mkdir(credentialPath);
  await assert.rejects(deleteProviderAuthFile(), /EISDIR|EPERM/u);

  await hardenProviderAuthFilePermissions(credentialPath, {
    platform: 'linux',
    chmodLike: {
      async chmod() {
        throw new Error('chmod unavailable');
      },
    },
  });
  await hardenProviderAuthFilePermissions(credentialPath, {
    platform: 'win32',
    env: { USERNAME: 'status-test-user' },
    async runWindowsAclCommand() {
      throw new Error('icacls unavailable');
    },
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
