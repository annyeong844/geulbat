import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ErrorCode } from '../contract.js';
import { getErrorMessage } from '../../utils/error.js';
import { createLogger } from '@geulbat/shared-utils/logger';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const logger = createLogger('provider-auth');
const PROVIDER_AUTH_INSTALLED_CONFIG_PATH_ENV =
  'GEULBAT_PROVIDER_AUTH_INSTALLED_CONFIG_PATH';
const PROVIDER_AUTH_BUNDLED_CONFIG_PATH_ENV =
  'GEULBAT_PROVIDER_AUTH_BUNDLED_CONFIG_PATH';

export const PROVIDER_AUTH_AUTHORIZE_URL =
  process.env['PROVIDER_AUTH_AUTHORIZE_URL'] ??
  'https://auth.openai.com/oauth/authorize';

export const PROVIDER_AUTH_TOKEN_URL =
  process.env['PROVIDER_AUTH_TOKEN_URL'] ??
  'https://auth.openai.com/oauth/token';

export const MISSING_PROVIDER_AUTH_CLIENT_ID_MESSAGE =
  'PROVIDER_AUTH_CLIENT_ID is not configured.';
export const PROVIDER_AUTH_NOT_CONFIGURED_CODE =
  'provider_auth_not_configured' satisfies ErrorCode;

export const PROVIDER_AUTH_SCOPE =
  process.env['PROVIDER_AUTH_SCOPE'] ?? 'openid profile email offline_access';

export const PROVIDER_AUTH_ORIGINATOR =
  process.env['PROVIDER_AUTH_ORIGINATOR'] ?? 'pi';

export const PROVIDER_AUTH_LOOPBACK_BIND_HOST =
  process.env['PROVIDER_AUTH_LOOPBACK_BIND_HOST'] ?? '127.0.0.1';

export const PROVIDER_AUTH_REDIRECT_HOST =
  process.env['PROVIDER_AUTH_REDIRECT_HOST'] ?? 'localhost';

export const PROVIDER_AUTH_REDIRECT_PORT = parsePort(
  process.env['PROVIDER_AUTH_REDIRECT_PORT'],
  1455,
);

export const PROVIDER_AUTH_REDIRECT_PATH =
  process.env['PROVIDER_AUTH_REDIRECT_PATH'] ?? '/auth/callback';

export const PROVIDER_AUTH_REDIRECT_URI = new URL(
  PROVIDER_AUTH_REDIRECT_PATH,
  `http://${PROVIDER_AUTH_REDIRECT_HOST}:${PROVIDER_AUTH_REDIRECT_PORT}`,
).toString();

export const PROVIDER_AUTH_REVOCATION_URL = trimToUndefined(
  process.env['PROVIDER_AUTH_REVOCATION_URL'],
);

export const PROVIDER_AUTH_PENDING_TTL_MS = 10 * 60 * 1000;
export const PROVIDER_AUTH_POLL_AFTER_MS = 1000;
export const PROVIDER_AUTH_REFRESH_MARGIN_MS = 60_000;
export const PROVIDER_AUTH_EXCHANGE_TIMEOUT_MS = 10_000;

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

export async function getRequiredProviderAuthClientId(): Promise<string> {
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

export async function isProviderAuthConfigured(): Promise<boolean> {
  return (await readConfiguredProviderAuthClientId()) !== null;
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
  const parsed = JSON.parse(contents) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const directClientId = trimToNull(readString(record, 'clientId'));
  if (directClientId !== null) {
    return directClientId;
  }

  return trimToNull(readString(record, 'client_id'));
}

function trimToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
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
