/**
 * daemon/auth/store — Provider credential file I/O
 *
 * Reads/writes OAuth credentials for the upstream provider (ChatGPT).
 * Storage location: ~/.geulbat/auth/provider.json  (user-scoped, NOT workspace)
 * Write strategy: temp file -> rename (atomic).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import {
  getErrorCode,
  getErrorMessage,
  isNotFoundError,
} from '../../utils/error.js';
import { createLogger } from '@geulbat/shared-utils/logger';
import { writeTextFileAtomically } from '../../utils/atomic-file.js';

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

interface ProviderAuthFileSchema {
  version: 1;
  credential: {
    accessToken: string;
    refreshToken: string;
    accountId: string;
    expiresAt: number;
  };
}

// ─── public ───

/** Read provider credential from disk. Returns null only when the file is missing. */
export async function readProviderAuthFile(): Promise<ProviderCredential | null> {
  const authFile = resolveProviderAuthFilePath();
  let raw: string;
  try {
    raw = await fs.readFile(authFile, 'utf-8');
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw createProviderAuthFileReadError(error);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error: unknown) {
    throw createProviderAuthInvalidFileError(
      `invalid provider auth file: ${getErrorMessage(error)}`,
    );
  }
  if (!isProviderAuthFileSchema(data)) {
    throw createProviderAuthInvalidFileError(
      'invalid provider auth file schema',
    );
  }

  return {
    accessToken: data.credential.accessToken,
    refreshToken: data.credential.refreshToken,
    accountId: data.credential.accountId,
    expiresAt: data.credential.expiresAt,
  };
}

/** Write provider credential to disk. Atomic: temp file -> rename. POSIX 0o600 best-effort. */
export async function writeProviderAuthFile(
  credential: ProviderCredential,
): Promise<void> {
  const authFile = resolveProviderAuthFilePath();
  const data: ProviderAuthFileSchema = {
    version: 1,
    credential: {
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken,
      accountId: credential.accountId,
      expiresAt: credential.expiresAt,
    },
  };

  const content = JSON.stringify(data, null, 2);
  await writeTextFileAtomically(authFile, content, { mode: 0o600 });
  await hardenProviderAuthFilePermissions(authFile);
}

export async function deleteProviderAuthFile(): Promise<void> {
  const authFile = resolveProviderAuthFilePath();
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

function isProviderAuthFileSchema(
  value: unknown,
): value is ProviderAuthFileSchema {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const credential = Reflect.get(value, 'credential');
  if (!credential || typeof credential !== 'object') {
    return false;
  }

  return (
    Reflect.get(value, 'version') === 1 &&
    typeof Reflect.get(credential, 'accessToken') === 'string' &&
    typeof Reflect.get(credential, 'refreshToken') === 'string' &&
    typeof Reflect.get(credential, 'accountId') === 'string' &&
    typeof Reflect.get(credential, 'expiresAt') === 'number' &&
    Reflect.get(credential, 'accessToken') !== '' &&
    Reflect.get(credential, 'accountId') !== ''
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
