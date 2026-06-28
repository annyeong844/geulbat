import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDisposableSandboxRoot } from './disposable-root.js';

void test('createDisposableSandboxRoot removes the allocated root when directory setup fails', async () => {
  const parentDir = await mkdtemp(
    join(tmpdir(), 'geulbat-disposable-root-failure-'),
  );
  const createdDirectories: string[] = [];

  try {
    await assert.rejects(
      () =>
        createDisposableSandboxRoot({
          attemptId: 'sandbox-attempt',
          parentDir,
          createDirectory: (targetPath, options) => {
            createdDirectories.push(String(targetPath));
            if (createdDirectories.length === 2) {
              throw new Error('mkdir failed after root allocation');
            }
            return mkdir(targetPath, options);
          },
        }),
      /mkdir failed after root allocation/u,
    );

    assert.equal(createdDirectories.length, 2);
    assert.deepEqual(await readdir(parentDir), []);
  } finally {
    await rm(parentDir, { recursive: true, force: true });
  }
});
