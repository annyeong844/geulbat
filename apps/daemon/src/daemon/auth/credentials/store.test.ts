import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Mode, PathLike } from 'node:fs';
import {
  hardenProviderAuthFilePermissions,
  readProviderAuthFile,
} from './store.js';

const PROVIDER_AUTH_FILE_PATH_ENV = 'GEULBAT_PROVIDER_AUTH_FILE_PATH';

async function withProviderAuthFilePath<T>(
  authFile: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = process.env[PROVIDER_AUTH_FILE_PATH_ENV];
  process.env[PROVIDER_AUTH_FILE_PATH_ENV] = authFile;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env[PROVIDER_AUTH_FILE_PATH_ENV];
    } else {
      process.env[PROVIDER_AUTH_FILE_PATH_ENV] = previous;
    }
  }
}

async function createTempProviderAuthPath(name: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'geulbat-auth-store-'));
  return path.join(dir, name);
}

void test('readProviderAuthFile returns null only when the credential file is missing', async () => {
  const missingFile = await createTempProviderAuthPath('missing-provider.json');

  await withProviderAuthFilePath(missingFile, async () => {
    assert.equal(await readProviderAuthFile(), null);
  });
});

void test('readProviderAuthFile classifies malformed credential JSON as provider_auth_invalid', async () => {
  const authFile = await createTempProviderAuthPath('provider.json');
  await fs.writeFile(authFile, '{', 'utf-8');

  await withProviderAuthFilePath(authFile, async () => {
    await assert.rejects(
      () => readProviderAuthFile(),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(Reflect.get(error, 'code'), 'provider_auth_invalid');
        assert.match(error.message, /invalid provider auth file/i);
        return true;
      },
    );
  });
});

void test('readProviderAuthFile preserves unreadable credential path failures instead of invalidating credentials', async () => {
  const authDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'geulbat-auth-directory-'),
  );

  await withProviderAuthFilePath(authDirectory, async () => {
    await assert.rejects(
      () => readProviderAuthFile(),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(Reflect.get(error, 'code'), 'access_denied');
        assert.doesNotMatch(error.message, /Reconnect the provider/i);
        assert.match(error.message, /provider auth file/i);
        return true;
      },
    );
  });
});

void test('hardenProviderAuthFilePermissions applies chmod on posix platforms', async () => {
  const calls: string[] = [];

  await hardenProviderAuthFilePermissions(
    'provider.json',
    {
      async chmod(target: PathLike, mode: Mode) {
        calls.push(`chmod:${String(target)}:${mode.toString(8)}`);
      },
    },
    'linux',
  );

  assert.deepEqual(calls, ['chmod:provider.json:600']);
});

void test('hardenProviderAuthFilePermissions skips chmod on windows', async () => {
  const calls: string[] = [];

  await hardenProviderAuthFilePermissions(
    'provider.json',
    {
      async chmod(target: PathLike, mode: Mode) {
        calls.push(`chmod:${String(target)}:${mode.toString(8)}`);
      },
    },
    'win32',
    async (file, args) => {
      calls.push(`${file}:${args.join('|')}`);
    },
    {
      USERDOMAIN: 'GEULBAT',
      USERNAME: 'alice',
    },
  );

  assert.deepEqual(calls, [
    'icacls:provider.json|/inheritance:r|/grant:r|GEULBAT\\alice:(F)|/grant:r|*S-1-5-18:(F)|/grant:r|*S-1-5-32-544:(F)',
  ]);
});

void test('hardenProviderAuthFilePermissions skips windows ACL hardening when current user is unavailable', async () => {
  const calls: string[] = [];

  await hardenProviderAuthFilePermissions(
    'provider.json',
    {
      async chmod(target: PathLike, mode: Mode) {
        calls.push(`chmod:${String(target)}:${mode.toString(8)}`);
      },
    },
    'win32',
    async (file, args) => {
      calls.push(`${file}:${args.join('|')}`);
    },
    {},
  );

  assert.deepEqual(calls, []);
});
