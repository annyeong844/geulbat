import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ErrorCode } from '../contract.js';
import {
  DEFAULT_PROVIDER_AUTH_CREDENTIAL_PROVIDER_ID,
  type ProviderAuthCredentialProviderId,
} from '../credentials/store.js';
import { isRecord } from '../../runtime-json.js';
import { getErrorMessage } from '../../utils/error.js';
import { createLogger } from '@geulbat/structured-logger/logger';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const logger = createLogger('provider-auth');
const PROVIDER_AUTH_INSTALLED_CONFIG_PATH_ENV =
  'GEULBAT_PROVIDER_AUTH_INSTALLED_CONFIG_PATH';
const PROVIDER_AUTH_BUNDLED_CONFIG_PATH_ENV =
  'GEULBAT_PROVIDER_AUTH_BUNDLED_CONFIG_PATH';

const PROVIDER_AUTH_AUTHORIZE_URL =
  process.env['PROVIDER_AUTH_AUTHORIZE_URL'] ??
  'https://auth.openai.com/oauth/authorize';

const PROVIDER_AUTH_TOKEN_URL =
  process.env['PROVIDER_AUTH_TOKEN_URL'] ??
  'https://auth.openai.com/oauth/token';

export const MISSING_PROVIDER_AUTH_CLIENT_ID_MESSAGE =
  'PROVIDER_AUTH_CLIENT_ID is not configured.';
export const PROVIDER_AUTH_NOT_CONFIGURED_CODE =
  'provider_auth_not_configured' satisfies ErrorCode;

const PROVIDER_AUTH_SCOPE =
  process.env['PROVIDER_AUTH_SCOPE'] ?? 'openid profile email offline_access';

export const PROVIDER_AUTH_ORIGINATOR =
  process.env['PROVIDER_AUTH_ORIGINATOR'] ?? 'pi';

const GROK_OAUTH_AUTHORIZE_URL =
  process.env['GROK_OAUTH_AUTHORIZE_URL'] ??
  'https://auth.x.ai/oauth2/authorize';

export const GROK_OAUTH_TOKEN_URL =
  process.env['GROK_OAUTH_TOKEN_URL'] ?? 'https://auth.x.ai/oauth2/token';

export const GROK_OAUTH_CLIENT_ID =
  trimToNull(process.env['GROK_OAUTH_CLIENT_ID']) ??
  'b1a00492-073a-47ea-816f-4c329264a828';

export const GROK_OAUTH_SCOPE =
  process.env['GROK_OAUTH_SCOPE'] ??
  'openid profile email offline_access grok-cli:access api:access';

const PROVIDER_AUTH_LOOPBACK_BIND_HOST =
  process.env['PROVIDER_AUTH_LOOPBACK_BIND_HOST'] ?? '127.0.0.1';

const PROVIDER_AUTH_REDIRECT_HOST =
  process.env['PROVIDER_AUTH_REDIRECT_HOST'] ?? 'localhost';

const PROVIDER_AUTH_REDIRECT_PORT = parsePort(
  process.env['PROVIDER_AUTH_REDIRECT_PORT'],
  1455,
);

const PROVIDER_AUTH_REDIRECT_PATH =
  process.env['PROVIDER_AUTH_REDIRECT_PATH'] ?? '/auth/callback';

export interface ProviderAuthCallbackListenerConfig {
  bindHost: string;
  redirectHost: string;
  port: number;
  path: string;
  redirectUri: string;
}

export const PROVIDER_AUTH_CALLBACK_LISTENER =
  createProviderAuthCallbackListenerConfig({
    bindHost: PROVIDER_AUTH_LOOPBACK_BIND_HOST,
    redirectHost: PROVIDER_AUTH_REDIRECT_HOST,
    port: PROVIDER_AUTH_REDIRECT_PORT,
    path: PROVIDER_AUTH_REDIRECT_PATH,
  });

export const PROVIDER_AUTH_REDIRECT_URI =
  PROVIDER_AUTH_CALLBACK_LISTENER.redirectUri;

const GROK_OAUTH_LOOPBACK_BIND_HOST =
  process.env['GROK_OAUTH_LOOPBACK_BIND_HOST'] ?? '127.0.0.1';

const GROK_OAUTH_REDIRECT_HOST =
  process.env['GROK_OAUTH_REDIRECT_HOST'] ?? '127.0.0.1';

const GROK_OAUTH_REDIRECT_PORT = parsePort(
  process.env['GROK_OAUTH_REDIRECT_PORT'],
  56121,
);

const GROK_OAUTH_REDIRECT_PATH =
  process.env['GROK_OAUTH_REDIRECT_PATH'] ?? '/callback';

export const GROK_OAUTH_CALLBACK_LISTENER =
  createProviderAuthCallbackListenerConfig({
    bindHost: GROK_OAUTH_LOOPBACK_BIND_HOST,
    redirectHost: GROK_OAUTH_REDIRECT_HOST,
    port: GROK_OAUTH_REDIRECT_PORT,
    path: GROK_OAUTH_REDIRECT_PATH,
  });

export const GROK_OAUTH_REDIRECT_URI = GROK_OAUTH_CALLBACK_LISTENER.redirectUri;

export const PROVIDER_AUTH_REVOCATION_URL = trimToUndefined(
  process.env['PROVIDER_AUTH_REVOCATION_URL'],
);

export const PROVIDER_AUTH_PENDING_TTL_MS = 10 * 60 * 1000;
export const PROVIDER_AUTH_POLL_AFTER_MS = 1000;
export const PROVIDER_AUTH_REFRESH_MARGIN_MS = 60_000;
export const PROVIDER_AUTH_EXCHANGE_TIMEOUT_MS = 10_000;

export interface ProviderAuthBootstrapProfile {
  providerId: ProviderAuthCredentialProviderId;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scope: string;
  redirectUri: string;
  callbackListener: ProviderAuthCallbackListenerConfig;
  includePkceChallengeInTokenExchange: boolean;
  tokenExchangeRedirectMode?: RequestInit['redirect'];
}

interface ProviderAuthBootstrapProfileDefinition {
  providerId: ProviderAuthCredentialProviderId;
  authorizeUrl: string;
  tokenUrl: string;
  getClientId: () => Promise<string>;
  isConfigured: () => Promise<boolean>;
  scope: string;
  redirectUri: string;
  callbackListener: ProviderAuthCallbackListenerConfig;
  includePkceChallengeInTokenExchange: boolean;
  tokenExchangeRedirectMode?: RequestInit['redirect'];
}

const PROVIDER_AUTH_BOOTSTRAP_PROFILES = {
  [DEFAULT_PROVIDER_AUTH_CREDENTIAL_PROVIDER_ID]: {
    providerId: DEFAULT_PROVIDER_AUTH_CREDENTIAL_PROVIDER_ID,
    authorizeUrl: PROVIDER_AUTH_AUTHORIZE_URL,
    tokenUrl: PROVIDER_AUTH_TOKEN_URL,
    getClientId: getRequiredConfiguredProviderAuthClientId,
    isConfigured: async () =>
      (await readConfiguredProviderAuthClientId()) !== null,
    scope: PROVIDER_AUTH_SCOPE,
    redirectUri: PROVIDER_AUTH_REDIRECT_URI,
    callbackListener: PROVIDER_AUTH_CALLBACK_LISTENER,
    includePkceChallengeInTokenExchange: false,
  },
  grok_oauth: {
    providerId: 'grok_oauth',
    authorizeUrl: GROK_OAUTH_AUTHORIZE_URL,
    tokenUrl: GROK_OAUTH_TOKEN_URL,
    getClientId: async () => GROK_OAUTH_CLIENT_ID,
    isConfigured: async () => GROK_OAUTH_CLIENT_ID.trim() !== '',
    scope: GROK_OAUTH_SCOPE,
    redirectUri: GROK_OAUTH_REDIRECT_URI,
    callbackListener: GROK_OAUTH_CALLBACK_LISTENER,
    includePkceChallengeInTokenExchange: true,
    tokenExchangeRedirectMode: 'error',
  },
} as const satisfies Record<
  ProviderAuthCredentialProviderId,
  ProviderAuthBootstrapProfileDefinition
>;

export async function readConfiguredProviderAuthClientId(): Promise<
  string | null
> {
  return (
    trimToNull(process.env['PROVIDER_AUTH_CLIENT_ID']) ??
    (await readProviderAuthClientIdFromConfig(
      resolveInstalledProviderAuthConfigPath(),
    )) ??
    (await readProviderAuthClientIdFromConfig(
      resolveBundledProviderAuthConfigPath(),
    ))
  );
}

export async function getRequiredProviderAuthClientId(
  providerId: ProviderAuthCredentialProviderId = DEFAULT_PROVIDER_AUTH_CREDENTIAL_PROVIDER_ID,
): Promise<string> {
  return getProviderAuthBootstrapProfileDefinition(providerId).getClientId();
}

async function getRequiredConfiguredProviderAuthClientId(): Promise<string> {
  const clientId = await readConfiguredProviderAuthClientId();
  if (clientId === null) {
    const error = new Error(MISSING_PROVIDER_AUTH_CLIENT_ID_MESSAGE);
    Object.assign(error, {
      code: PROVIDER_AUTH_NOT_CONFIGURED_CODE,
    });
    throw error;
  }
  return clientId;
}

export async function isProviderAuthConfigured(
  providerId: ProviderAuthCredentialProviderId = DEFAULT_PROVIDER_AUTH_CREDENTIAL_PROVIDER_ID,
): Promise<boolean> {
  return getProviderAuthBootstrapProfileDefinition(providerId).isConfigured();
}

export async function getProviderAuthBootstrapProfile(
  providerId: ProviderAuthCredentialProviderId = DEFAULT_PROVIDER_AUTH_CREDENTIAL_PROVIDER_ID,
): Promise<ProviderAuthBootstrapProfile> {
  const profile = getProviderAuthBootstrapProfileDefinition(providerId);
  return {
    providerId: profile.providerId,
    authorizeUrl: profile.authorizeUrl,
    tokenUrl: profile.tokenUrl,
    clientId: await profile.getClientId(),
    scope: profile.scope,
    redirectUri: profile.redirectUri,
    callbackListener: profile.callbackListener,
    includePkceChallengeInTokenExchange:
      profile.includePkceChallengeInTokenExchange,
    ...(profile.tokenExchangeRedirectMode !== undefined
      ? { tokenExchangeRedirectMode: profile.tokenExchangeRedirectMode }
      : {}),
  };
}

function getProviderAuthBootstrapProfileDefinition(
  providerId: ProviderAuthCredentialProviderId,
): ProviderAuthBootstrapProfileDefinition {
  return PROVIDER_AUTH_BOOTSTRAP_PROFILES[providerId];
}

export function resolveInstalledProviderAuthConfigPath(): string {
  return (
    trimToNull(process.env[PROVIDER_AUTH_INSTALLED_CONFIG_PATH_ENV]) ??
    path.join(os.homedir(), '.geulbat', 'config', 'provider-auth.json')
  );
}

export function resolveBundledProviderAuthConfigPath(): string {
  return (
    trimToNull(process.env[PROVIDER_AUTH_BUNDLED_CONFIG_PATH_ENV]) ??
    path.resolve(MODULE_DIR, '../../../../provider-auth.config.json')
  );
}

async function readProviderAuthClientIdFromConfig(
  filePath: string,
): Promise<string | null> {
  try {
    return parseProviderAuthClientIdConfig(await readFile(filePath, 'utf8'));
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return null;
    }
    logger.warn(
      'failed to read provider auth config; falling back to next source:',
      `${filePath}: ${getErrorMessage(error)}`,
    );
    return null;
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function parseProviderAuthClientIdConfig(contents: string): string | null {
  const parsed: unknown = JSON.parse(contents);
  if (!isRecord(parsed)) {
    throw new TypeError('Provider auth config must contain a JSON object.');
  }

  const directClientId = trimToNull(readString(parsed, 'clientId'));
  if (directClientId !== null) {
    return directClientId;
  }

  return trimToNull(readString(parsed, 'client_id'));
}

function trimToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function createProviderAuthCallbackListenerConfig(args: {
  bindHost: string;
  redirectHost: string;
  port: number;
  path: string;
}): ProviderAuthCallbackListenerConfig {
  return {
    ...args,
    redirectUri: new URL(
      args.path,
      `http://${args.redirectHost}:${args.port}`,
    ).toString(),
  };
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535
    ? parsed
    : fallback;
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}
