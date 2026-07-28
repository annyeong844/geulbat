import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import {
  GROK_OAUTH_REDIRECT_URI,
  getProviderAuthBootstrapProfile,
  PROVIDER_AUTH_REDIRECT_URI,
  readConfiguredProviderAuthClientId,
  resolveBundledProviderAuthConfigPath,
  resolveInstalledProviderAuthConfigPath,
  resolveProviderAuthTokenRequestTimeoutMs,
} from './config.js';

const INSTALLED_PATH_ENV = 'GEULBAT_PROVIDER_AUTH_INSTALLED_CONFIG_PATH';
const BUNDLED_PATH_ENV = 'GEULBAT_PROVIDER_AUTH_BUNDLED_CONFIG_PATH';
const TOKEN_REQUEST_TIMEOUT_ENV =
  'GEULBAT_PROVIDER_AUTH_TOKEN_REQUEST_TIMEOUT_MS';

function restoreEnv(key: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = previous;
}

void test('provider token requests allow one minute by default', () => {
  assert.equal(resolveProviderAuthTokenRequestTimeoutMs({}), 60_000);
  assert.equal(
    resolveProviderAuthTokenRequestTimeoutMs({
      [TOKEN_REQUEST_TIMEOUT_ENV]: '   ',
    }),
    60_000,
  );
});

void test('provider token request timeout accepts a positive operator override', () => {
  assert.equal(
    resolveProviderAuthTokenRequestTimeoutMs({
      [TOKEN_REQUEST_TIMEOUT_ENV]: ' 300000 ',
    }),
    300_000,
  );
});

void test('provider token request timeout rejects invalid operator policy', () => {
  for (const value of ['0', '-1', '1.5', 'NaN', '9007199254740992']) {
    assert.throws(
      () =>
        resolveProviderAuthTokenRequestTimeoutMs({
          [TOKEN_REQUEST_TIMEOUT_ENV]: value,
        }),
      new RegExp(
        `${TOKEN_REQUEST_TIMEOUT_ENV} must be a positive safe integer`,
        'u',
      ),
    );
  }
});

void test('readConfiguredProviderAuthClientId prefers explicit env over installed and bundled config', async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'geulbat-auth-config-'));
  const installedPath = path.join(tempRoot, 'installed.json');
  const bundledPath = path.join(tempRoot, 'bundled.json');
  const previousClientId = process.env['PROVIDER_AUTH_CLIENT_ID'];
  const previousInstalledPath = process.env[INSTALLED_PATH_ENV];
  const previousBundledPath = process.env[BUNDLED_PATH_ENV];

  await writeFile(installedPath, '{"clientId":"installed-client-id"}', 'utf8');
  await writeFile(bundledPath, '{"clientId":"bundled-client-id"}', 'utf8');
  process.env['PROVIDER_AUTH_CLIENT_ID'] = 'explicit-client-id';
  process.env[INSTALLED_PATH_ENV] = installedPath;
  process.env[BUNDLED_PATH_ENV] = bundledPath;

  try {
    assert.equal(
      await readConfiguredProviderAuthClientId(),
      'explicit-client-id',
    );
  } finally {
    restoreEnv('PROVIDER_AUTH_CLIENT_ID', previousClientId);
    restoreEnv(INSTALLED_PATH_ENV, previousInstalledPath);
    restoreEnv(BUNDLED_PATH_ENV, previousBundledPath);
  }
});

void test('readConfiguredProviderAuthClientId prefers installed config over bundled config', async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'geulbat-auth-config-'));
  const installedPath = path.join(tempRoot, 'installed.json');
  const bundledPath = path.join(tempRoot, 'bundled.json');
  const previousClientId = process.env['PROVIDER_AUTH_CLIENT_ID'];
  const previousInstalledPath = process.env[INSTALLED_PATH_ENV];
  const previousBundledPath = process.env[BUNDLED_PATH_ENV];

  await writeFile(installedPath, '{"clientId":"installed-client-id"}', 'utf8');
  await writeFile(bundledPath, '{"clientId":"bundled-client-id"}', 'utf8');
  delete process.env['PROVIDER_AUTH_CLIENT_ID'];
  process.env[INSTALLED_PATH_ENV] = installedPath;
  process.env[BUNDLED_PATH_ENV] = bundledPath;

  try {
    assert.equal(
      await readConfiguredProviderAuthClientId(),
      'installed-client-id',
    );
  } finally {
    restoreEnv('PROVIDER_AUTH_CLIENT_ID', previousClientId);
    restoreEnv(INSTALLED_PATH_ENV, previousInstalledPath);
    restoreEnv(BUNDLED_PATH_ENV, previousBundledPath);
  }
});

void test('readConfiguredProviderAuthClientId falls back to bundled config when installed config is absent', async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'geulbat-auth-config-'));
  const missingInstalledPath = path.join(tempRoot, 'missing', 'installed.json');
  const bundledPath = path.join(tempRoot, 'bundled.json');
  const previousClientId = process.env['PROVIDER_AUTH_CLIENT_ID'];
  const previousInstalledPath = process.env[INSTALLED_PATH_ENV];
  const previousBundledPath = process.env[BUNDLED_PATH_ENV];

  await writeFile(bundledPath, '{"client_id":"bundled-client-id"}', 'utf8');
  delete process.env['PROVIDER_AUTH_CLIENT_ID'];
  process.env[INSTALLED_PATH_ENV] = missingInstalledPath;
  process.env[BUNDLED_PATH_ENV] = bundledPath;

  try {
    assert.equal(
      await readConfiguredProviderAuthClientId(),
      'bundled-client-id',
    );
  } finally {
    restoreEnv('PROVIDER_AUTH_CLIENT_ID', previousClientId);
    restoreEnv(INSTALLED_PATH_ENV, previousInstalledPath);
    restoreEnv(BUNDLED_PATH_ENV, previousBundledPath);
  }
});

void test('readConfiguredProviderAuthClientId warns when installed config is malformed before falling back', async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'geulbat-auth-config-'));
  const installedPath = path.join(tempRoot, 'installed.json');
  const bundledPath = path.join(tempRoot, 'bundled.json');
  const previousClientId = process.env['PROVIDER_AUTH_CLIENT_ID'];
  const previousInstalledPath = process.env[INSTALLED_PATH_ENV];
  const previousBundledPath = process.env[BUNDLED_PATH_ENV];
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  await writeFile(installedPath, '{not-json', 'utf8');
  await writeFile(bundledPath, '{"clientId":"bundled-client-id"}', 'utf8');
  delete process.env['PROVIDER_AUTH_CLIENT_ID'];
  process.env[INSTALLED_PATH_ENV] = installedPath;
  process.env[BUNDLED_PATH_ENV] = bundledPath;

  try {
    assert.equal(
      await readConfiguredProviderAuthClientId(),
      'bundled-client-id',
    );
    assert.equal(warnings.length, 1);
    assert.match(
      String(warnings[0]?.[0] ?? ''),
      /failed to read provider auth config/i,
    );
    assert.match(String(warnings[0]?.[1] ?? ''), /installed\.json/);

    await writeFile(installedPath, '[]', 'utf8');
    assert.equal(
      await readConfiguredProviderAuthClientId(),
      'bundled-client-id',
    );
    assert.equal(warnings.length, 2);
  } finally {
    console.warn = originalWarn;
    restoreEnv('PROVIDER_AUTH_CLIENT_ID', previousClientId);
    restoreEnv(INSTALLED_PATH_ENV, previousInstalledPath);
    restoreEnv(BUNDLED_PATH_ENV, previousBundledPath);
  }
});

void test('resolve provider auth config paths respect override envs', async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'geulbat-auth-config-'));
  const installedPath = path.join(tempRoot, 'installed', 'provider-auth.json');
  const bundledPath = path.join(
    tempRoot,
    'bundled',
    'provider-auth.config.json',
  );
  const previousInstalledPath = process.env[INSTALLED_PATH_ENV];
  const previousBundledPath = process.env[BUNDLED_PATH_ENV];

  await mkdir(path.dirname(installedPath), { recursive: true });
  await mkdir(path.dirname(bundledPath), { recursive: true });
  process.env[INSTALLED_PATH_ENV] = installedPath;
  process.env[BUNDLED_PATH_ENV] = bundledPath;

  try {
    assert.equal(resolveInstalledProviderAuthConfigPath(), installedPath);
    assert.equal(resolveBundledProviderAuthConfigPath(), bundledPath);
  } finally {
    restoreEnv(INSTALLED_PATH_ENV, previousInstalledPath);
    restoreEnv(BUNDLED_PATH_ENV, previousBundledPath);
  }
});

void test('provider auth bootstrap profiles keep Codex and Grok callback listeners separate', async () => {
  const previousClientId = process.env['PROVIDER_AUTH_CLIENT_ID'];
  process.env['PROVIDER_AUTH_CLIENT_ID'] = 'profile-client-id';

  try {
    const openai = await getProviderAuthBootstrapProfile('openai_codex_direct');
    const grok = await getProviderAuthBootstrapProfile('grok_oauth');

    assert.equal(openai.redirectUri, PROVIDER_AUTH_REDIRECT_URI);
    assert.equal(
      openai.callbackListener.redirectUri,
      PROVIDER_AUTH_REDIRECT_URI,
    );
    assert.equal(openai.callbackListener.path, '/auth/callback');
    assert.equal(openai.includePkceChallengeInTokenExchange, false);
    assert.equal(openai.tokenExchangeRedirectMode, undefined);

    assert.equal(grok.redirectUri, GROK_OAUTH_REDIRECT_URI);
    assert.equal(grok.callbackListener.redirectUri, GROK_OAUTH_REDIRECT_URI);
    assert.equal(grok.callbackListener.bindHost, '127.0.0.1');
    assert.equal(grok.callbackListener.redirectHost, '127.0.0.1');
    assert.equal(grok.callbackListener.port, 56121);
    assert.equal(grok.callbackListener.path, '/callback');
    assert.equal(grok.includePkceChallengeInTokenExchange, true);
    assert.equal(grok.tokenExchangeRedirectMode, 'error');
  } finally {
    restoreEnv('PROVIDER_AUTH_CLIENT_ID', previousClientId);
  }
});
