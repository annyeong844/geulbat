import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIN_LOCAL_DEV_AUTH_TOKEN_LENGTH = 16;

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '..');
const DEFAULT_LOCAL_DEV_AUTH_TOKEN_FILE = resolve(
  REPO_ROOT,
  '.geulbat',
  'dev-auth-token',
);

export function ensureLocalDevAuthToken(env = process.env) {
  const explicitToken = readExplicitLocalDevAuthToken(env);
  if (explicitToken) {
    assertValidLocalDevAuthToken(
      explicitToken,
      'configured local dev auth token',
    );
    return explicitToken;
  }

  const tokenFile = resolveLocalDevAuthTokenFile(env);
  const existingToken = readStoredLocalDevAuthToken(tokenFile);
  if (existingToken) {
    assertValidLocalDevAuthToken(existingToken, 'local dev auth token');
    return existingToken;
  }

  const generatedToken = createLocalDevAuthToken();
  try {
    mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 });
    writeFileSync(tokenFile, `${generatedToken}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return generatedToken;
  } catch (error) {
    if (!isNodeErrorWithCode(error, 'EEXIST')) {
      throw error;
    }
    const racedToken = readStoredLocalDevAuthToken(tokenFile);
    if (!racedToken) {
      throw new Error(`local dev auth token file is empty: ${tokenFile}`);
    }
    assertValidLocalDevAuthToken(racedToken, 'local dev auth token');
    return racedToken;
  }
}

export function createLocalDevAuthEnv(baseEnv = process.env) {
  const token = ensureLocalDevAuthToken(baseEnv);
  return {
    ...baseEnv,
    GEULBAT_DEV_TOKEN: token,
    VITE_GEULBAT_DEV_TOKEN: token,
  };
}

function readExplicitLocalDevAuthToken(env) {
  const daemonToken = normalizeLocalDevAuthToken(env.GEULBAT_DEV_TOKEN);
  const shellToken = normalizeLocalDevAuthToken(env.VITE_GEULBAT_DEV_TOKEN);

  if (daemonToken && shellToken && daemonToken !== shellToken) {
    throw new Error(
      'GEULBAT_DEV_TOKEN and VITE_GEULBAT_DEV_TOKEN must match for local dev auth',
    );
  }

  return daemonToken ?? shellToken;
}

function resolveLocalDevAuthTokenFile(env) {
  const configuredPath = normalizeLocalDevAuthToken(env.GEULBAT_DEV_TOKEN_FILE);
  return configuredPath
    ? resolve(configuredPath)
    : DEFAULT_LOCAL_DEV_AUTH_TOKEN_FILE;
}

function readStoredLocalDevAuthToken(tokenFile) {
  try {
    return normalizeLocalDevAuthToken(readFileSync(tokenFile, 'utf8'));
  } catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
}

function createLocalDevAuthToken() {
  return randomBytes(32).toString('hex');
}

function normalizeLocalDevAuthToken(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function assertValidLocalDevAuthToken(token, source) {
  if (token.length < MIN_LOCAL_DEV_AUTH_TOKEN_LENGTH) {
    throw new Error(
      `${source} is shorter than ${MIN_LOCAL_DEV_AUTH_TOKEN_LENGTH} characters`,
    );
  }
}

function isNodeErrorWithCode(error, code) {
  return error instanceof Error && 'code' in error && error.code === code;
}
