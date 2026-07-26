import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  PermissionModeStoreCorruptError,
  readPermissionModeState,
  resolvePermissionModeFilePath,
  writePermissionModeState,
} from './permission-mode-store.js';

async function withHomeStateRoot(
  run: (homeStateRoot: string) => Promise<void>,
): Promise<void> {
  const homeStateRoot = await mkdtemp(join(tmpdir(), 'geulbat-permission-'));
  try {
    await run(homeStateRoot);
  } finally {
    await rm(homeStateRoot, { recursive: true, force: true });
  }
}

async function writeStoredDocument(
  homeStateRoot: string,
  content: string,
): Promise<void> {
  const filePath = resolvePermissionModeFilePath(homeStateRoot);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
}

void test('a first run without a stored file reports the safe default', async () => {
  await withHomeStateRoot(async (homeStateRoot) => {
    assert.deepEqual(await readPermissionModeState(homeStateRoot), {
      permissionMode: 'basic',
      updatedAt: null,
    });
  });
});

void test('a written mode survives being read back by a separate call', async () => {
  await withHomeStateRoot(async (homeStateRoot) => {
    const written = await writePermissionModeState(
      homeStateRoot,
      'full_access',
      () => new Date('2026-07-25T11:00:00.000Z'),
    );
    assert.deepEqual(written, {
      permissionMode: 'full_access',
      updatedAt: '2026-07-25T11:00:00.000Z',
    });

    assert.deepEqual(await readPermissionModeState(homeStateRoot), {
      permissionMode: 'full_access',
      updatedAt: '2026-07-25T11:00:00.000Z',
    });
  });
});

void test('a later write replaces the stored mode instead of appending', async () => {
  await withHomeStateRoot(async (homeStateRoot) => {
    await writePermissionModeState(
      homeStateRoot,
      'full_access',
      () => new Date('2026-07-25T11:00:00.000Z'),
    );
    await writePermissionModeState(
      homeStateRoot,
      'basic',
      () => new Date('2026-07-25T12:00:00.000Z'),
    );

    assert.deepEqual(await readPermissionModeState(homeStateRoot), {
      permissionMode: 'basic',
      updatedAt: '2026-07-25T12:00:00.000Z',
    });
  });
});

void test('the stored document is written owner-only so other local users cannot read the mode', async () => {
  if (process.platform === 'win32') {
    return;
  }
  await withHomeStateRoot(async (homeStateRoot) => {
    await writePermissionModeState(homeStateRoot, 'full_access');
    const stats = await stat(resolvePermissionModeFilePath(homeStateRoot));
    assert.equal(stats.mode & 0o777, 0o600);
  });
});

void test('the stored document keeps an explicit version so a future format change is detectable', async () => {
  await withHomeStateRoot(async (homeStateRoot) => {
    await writePermissionModeState(homeStateRoot, 'full_access');
    const raw = await readFile(
      resolvePermissionModeFilePath(homeStateRoot),
      'utf-8',
    );
    assert.equal(JSON.parse(raw).version, 1);
  });
});

void test('an unparseable stored document fails loudly instead of resetting to basic', async () => {
  await withHomeStateRoot(async (homeStateRoot) => {
    await writeStoredDocument(homeStateRoot, '{ this is not json');
    await assert.rejects(
      readPermissionModeState(homeStateRoot),
      PermissionModeStoreCorruptError,
    );
  });
});

void test('a stored document with an unknown mode is rejected rather than trusted', async () => {
  await withHomeStateRoot(async (homeStateRoot) => {
    await writeStoredDocument(
      homeStateRoot,
      JSON.stringify({
        version: 1,
        permissionMode: 'unrestricted',
        updatedAt: '2026-07-25T11:00:00.000Z',
      }),
    );
    await assert.rejects(
      readPermissionModeState(homeStateRoot),
      PermissionModeStoreCorruptError,
    );
  });
});

void test('a stored document from an unsupported version is rejected rather than guessed', async () => {
  await withHomeStateRoot(async (homeStateRoot) => {
    await writeStoredDocument(
      homeStateRoot,
      JSON.stringify({
        version: 2,
        permissionMode: 'full_access',
        updatedAt: '2026-07-25T11:00:00.000Z',
      }),
    );
    await assert.rejects(
      readPermissionModeState(homeStateRoot),
      PermissionModeStoreCorruptError,
    );
  });
});
