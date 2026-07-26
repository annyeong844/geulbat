import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  deleteQwenTokenPlanCredential,
  readQwenTokenPlanCredential,
  writeQwenTokenPlanCredential,
} from './credential-store.js';

void test('Qwen credential store persists a private user credential and removes it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-qwen-credential-'));
  const filePath = join(root, 'auth', 'qwen-token-plan.json');
  const apiKey = 'x'.repeat(32);
  const hardenedPaths: string[] = [];

  try {
    await writeQwenTokenPlanCredential(
      { apiKey, region: 'global' },
      {
        filePath,
        async hardenPermissions(targetPath) {
          hardenedPaths.push(targetPath);
        },
      },
    );

    assert.deepEqual(await readQwenTokenPlanCredential({ filePath }), {
      apiKey,
      region: 'global',
    });
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    assert.equal((await readFile(filePath, 'utf8')).includes(apiKey), true);
    assert.deepEqual(hardenedPaths, [filePath]);

    await deleteQwenTokenPlanCredential({ filePath });
    assert.equal(await readQwenTokenPlanCredential({ filePath }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('Qwen credential store refuses every Git worktree destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-qwen-git-guard-'));
  const apiKey = 'x'.repeat(32);

  try {
    for (const markerKind of ['directory', 'file'] as const) {
      const checkout = join(root, `checkout-${markerKind}`);
      await mkdir(checkout, { recursive: true });
      if (markerKind === 'directory') {
        await mkdir(join(checkout, '.git'));
      } else {
        await writeFile(join(checkout, '.git'), 'gitdir: ../git-data\n');
      }
      const filePath = join(checkout, 'local', 'qwen-token-plan.json');
      await assert.rejects(
        writeQwenTokenPlanCredential(
          { apiKey, region: 'global' },
          { filePath },
        ),
        (error: unknown) =>
          error instanceof Error &&
          error.name === 'QwenTokenPlanCredentialGitWorktreeError' &&
          !error.message.includes(apiKey),
      );
      assert.equal(await readQwenTokenPlanCredential({ filePath }), null);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('Qwen credential store resolves symlinked parents before checking Git ownership', async (context) => {
  if (process.platform === 'win32') {
    context.skip('directory symlinks require platform-specific privileges');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'geulbat-qwen-git-symlink-'));
  const checkout = join(root, 'checkout');
  const alias = join(root, 'checkout-alias');
  const filePath = join(alias, 'local', 'qwen-token-plan.json');

  try {
    await mkdir(join(checkout, '.git'), { recursive: true });
    await symlink(checkout, alias, 'dir');
    await assert.rejects(
      writeQwenTokenPlanCredential(
        { apiKey: 'x'.repeat(32), region: 'global' },
        { filePath },
      ),
      (error: unknown) =>
        error instanceof Error &&
        error.name === 'QwenTokenPlanCredentialGitWorktreeError',
    );
    assert.equal(await readQwenTokenPlanCredential({ filePath }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('Qwen credential store rejects corrupt bytes without exposing them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-qwen-credential-'));
  const filePath = join(root, 'qwen-token-plan.json');
  const privateMarker = 'private-marker-not-for-errors';

  try {
    await writeFile(filePath, `{\"apiKey\":\"${privateMarker}\"}`, 'utf8');
    await assert.rejects(
      readQwenTokenPlanCredential({ filePath }),
      (error: unknown) =>
        error instanceof Error &&
        error.name === 'QwenTokenPlanCredentialFileError' &&
        !error.message.includes(privateMarker),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
