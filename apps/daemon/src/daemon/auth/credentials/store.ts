/**
 * daemon/auth/store — Provider credential file I/O
 *
 * Reads/writes OAuth credentials for upstream providers.
 * Storage location: ~/.geulbat/auth/provider.json  (user-scoped, NOT workspace)
 * Write strategy: temp file -> rename (atomic).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { isRecord } from '../../runtime-json.js';
import {
  getErrorCode,
  getErrorMessage,
  isNotFoundError,
} from '../../utils/error.js';
import { createLogger } from '@geulbat/structured-logger/logger';
import { writeTextFileAtomically } from '../../utils/atomic-file.js';
import {
  DEFAULT_PROVIDER_AUTH_PROVIDER_ID,
  PROVIDER_AUTH_PROVIDER_IDS,
  type ProviderAuthProviderId,
} from '../contract.js';

// ─── paths ───

const PROVIDER_AUTH_FILE_PATH_ENV = 'GEULBAT_PROVIDER_AUTH_FILE_PATH';
const AUTH_DIR = path.join(os.homedir(), '.geulbat', 'auth');
const AUTH_FILE = path.join(AUTH_DIR, 'provider.json');
const logger = createLogger('provider-auth');

// ─── types ───

export interface ProviderCredential {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  /** epoch-ms when the access token expires, 0 = unknown */
  expiresAt: number;
}

export const DEFAULT_PROVIDER_AUTH_CREDENTIAL_PROVIDER_ID =
  DEFAULT_PROVIDER_AUTH_PROVIDER_ID;

export type ProviderAuthCredentialProviderId = ProviderAuthProviderId;

export function resolveProviderAuthCredentialProviderId(
  providerId?: ProviderAuthCredentialProviderId,
): ProviderAuthCredentialProviderId {
  return providerId ?? DEFAULT_PROVIDER_AUTH_CREDENTIAL_PROVIDER_ID;
}

const PROVIDER_AUTH_CREDENTIAL_PROVIDER_IDS = PROVIDER_AUTH_PROVIDER_IDS;

interface ProviderAuthCredentialSchema {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  expiresAt: number;
}

type ProviderAuthCredentialsByProvider = Partial<
  Record<ProviderAuthCredentialProviderId, ProviderAuthCredentialSchema>
>;

interface ProviderAuthFileSchema {
  version: 2;
  credentials: ProviderAuthCredentialsByProvider;
}

// ─── public ───

/** Read provider credential from disk. Returns null only when the file is missing. */
export async function readProviderAuthFile(
  providerId: ProviderAuthCredentialProviderId = DEFAULT_PROVIDER_AUTH_CREDENTIAL_PROVIDER_ID,
): Promise<ProviderCredential | null> {
  const authFile = resolveProviderAuthFilePath();
  const data = await readProviderAuthFileSchema(authFile);
  if (!data) {
    return null;
  }

  const credential = readCredentialForProvider(data, providerId);
  return credential ? cloneProviderCredential(credential) : null;
}

/** Write provider credential to disk. Atomic: temp file -> rename. POSIX 0o600 best-effort. */
export async function writeProviderAuthFile(
  credential: ProviderCredential,
  providerId: ProviderAuthCredentialProviderId = DEFAULT_PROVIDER_AUTH_CREDENTIAL_PROVIDER_ID,
): Promise<void> {
  const authFile = resolveProviderAuthFilePath();
  const credentials = await readProviderAuthCredentialMapForWrite(authFile);
  credentials[providerId] = cloneProviderCredential(credential);

  const data: ProviderAuthFileSchema = {
    version: 2,
    credentials,
  };

  const content = JSON.stringify(data, null, 2);
  await writeTextFileAtomically(authFile, content, { mode: 0o600 });
  await hardenProviderAuthFilePermissions(authFile);
}

export async function deleteProviderAuthFile(
  providerId?: ProviderAuthCredentialProviderId,
): Promise<void> {
  const authFile = resolveProviderAuthFilePath();
  if (providerId !== undefined) {
    const credentials = await readProviderAuthCredentialMapForWrite(authFile);
    delete credentials[providerId];
    if (Object.keys(credentials).length === 0) {
      await unlinkProviderAuthFileIfPresent(authFile);
      return;
    }

    const data: ProviderAuthFileSchema = {
      version: 2,
      credentials,
    };
    const content = JSON.stringify(data, null, 2);
    await writeTextFileAtomically(authFile, content, { mode: 0o600 });
    await hardenProviderAuthFilePermissions(authFile);
    return;
  }

  await unlinkProviderAuthFileIfPresent(authFile);
}

async function unlinkProviderAuthFileIfPresent(
  authFile: string,
): Promise<void> {
  try {
    await fs.unlink(authFile);
  } catch (error: unknown) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
}

type ChmodLike = Pick<typeof fs, 'chmod'>;
type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { windowsHide?: boolean },
) => Promise<unknown>;
const execFile = promisify(execFileCallback);

/**
 * POSIX hardening path for provider auth file permissions.
 * Windows does not provide portable chmod semantics for this file, so we leave ACLs to the user profile.
 */
export async function hardenProviderAuthFilePermissions(
  targetPath: string,
  chmodLike: ChmodLike = fs,
  platform = process.platform,
  execFileLike: ExecFileLike = execFile,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (platform === 'win32') {
    const currentPrincipal = resolveCurrentWindowsPrincipal(env);
    if (!currentPrincipal) {
      logger.warn(
        'windows ACL hardening skipped: current user principal unavailable',
      );
      return;
    }
    try {
      await execFileLike(
        'icacls',
        [
          targetPath,
          '/inheritance:r',
          '/grant:r',
          `${currentPrincipal}:(F)`,
          '/grant:r',
          '*S-1-5-18:(F)',
          '/grant:r',
          '*S-1-5-32-544:(F)',
        ],
        { windowsHide: true },
      );
    } catch (error: unknown) {
      logger.warn('windows ACL hardening failed:', getErrorMessage(error));
    }
    return;
  }
  try {
    await chmodLike.chmod(targetPath, 0o600);
  } catch (error: unknown) {
    logger.warn('chmod hardening failed:', getErrorMessage(error));
  }
}

function resolveProviderAuthFilePath(): string {
  const overridden = process.env[PROVIDER_AUTH_FILE_PATH_ENV]?.trim();
  return overridden ? overridden : AUTH_FILE;
}

async function readProviderAuthFileSchema(
  authFile: string,
): Promise<ProviderAuthFileSchema | null> {
  let raw: string;
  try {
    raw = await fs.readFile(authFile, 'utf-8');
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw createProviderAuthFileReadError(error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw createProviderAuthInvalidFileError(
      `invalid provider auth file: ${getErrorMessage(error)}`,
    );
  }

  const data = parseProviderAuthFileSchema(parsed);
  if (!data) {
    throw createProviderAuthInvalidFileError(
      'invalid provider auth file schema',
    );
  }
  return data;
}

async function readProviderAuthCredentialMapForWrite(
  authFile: string,
): Promise<ProviderAuthCredentialsByProvider> {
  const data = await readProviderAuthFileSchema(authFile);
  if (!data) {
    return {};
  }
  return cloneProviderCredentialMap(data.credentials);
}

function parseProviderAuthFileSchema(
  value: unknown,
): ProviderAuthFileSchema | null {
  if (!isRecord(value)) {
    return null;
  }
  const version = value.version;
  if (version === 2) {
    const credentials = value.credentials;
    if (!isRecord(credentials)) {
      return null;
    }

    const parsedCredentials: ProviderAuthCredentialsByProvider = {};
    for (const providerId of PROVIDER_AUTH_CREDENTIAL_PROVIDER_IDS) {
      const credential = credentials[providerId];
      if (credential === undefined) {
        continue;
      }
      if (!isProviderAuthCredentialSchema(credential)) {
        return null;
      }
      parsedCredentials[providerId] = cloneProviderCredential(credential);
    }

    return {
      version,
      credentials: parsedCredentials,
    };
  }
  if (
    (version === undefined || version === 1) &&
    isProviderAuthCredentialSchema(value)
  ) {
    return {
      version: 2,
      credentials: {
        [DEFAULT_PROVIDER_AUTH_CREDENTIAL_PROVIDER_ID]:
          cloneProviderCredential(value),
      },
    };
  }
  return null;
}

function readCredentialForProvider(
  data: ProviderAuthFileSchema,
  providerId: ProviderAuthCredentialProviderId,
): ProviderCredential | null {
  return data.credentials[providerId] ?? null;
}

function cloneProviderCredentialMap(
  credentials: ProviderAuthCredentialsByProvider,
): ProviderAuthCredentialsByProvider {
  const cloned: ProviderAuthCredentialsByProvider = {};
  for (const providerId of PROVIDER_AUTH_CREDENTIAL_PROVIDER_IDS) {
    const credential = credentials[providerId];
    if (credential !== undefined) {
      cloned[providerId] = cloneProviderCredential(credential);
    }
  }
  return cloned;
}

function cloneProviderCredential(
  credential: ProviderCredential,
): ProviderCredential {
  return {
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken,
    accountId: credential.accountId,
    expiresAt: credential.expiresAt,
  };
}

function isProviderAuthCredentialSchema(
  value: unknown,
): value is ProviderAuthCredentialSchema {
  return (
    isRecord(value) &&
    typeof value.accessToken === 'string' &&
    typeof value.refreshToken === 'string' &&
    typeof value.accountId === 'string' &&
    typeof value.expiresAt === 'number' &&
    value.accessToken !== '' &&
    value.accountId !== ''
  );
}

function createProviderAuthInvalidFileError(message: string): Error {
  return Object.assign(new Error(message), {
    code: 'provider_auth_invalid',
  });
}

function createProviderAuthFileReadError(error: unknown): Error {
  const code = getErrorCode(error);
  if (code === 'EACCES' || code === 'EPERM' || code === 'EISDIR') {
    return Object.assign(
      new Error(
        `provider auth file is not readable: ${getErrorMessage(error)}`,
      ),
      {
        code: 'access_denied',
      },
    );
  }

  return Object.assign(
    new Error(`provider auth file read failed: ${getErrorMessage(error)}`),
    {
      code: 'internal',
    },
  );
}

function resolveCurrentWindowsPrincipal(env: NodeJS.ProcessEnv): string | null {
  const username = env['USERNAME']?.trim();
  if (!username) {
    return null;
  }
  const domain = env['USERDOMAIN']?.trim();
  return domain ? `${domain}\\${username}` : username;
}
