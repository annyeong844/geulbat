import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAppErrorCode } from '../../utils/error.js';
import { createVersionToken } from '../../files/version-token.js';
import {
  commitPreparedDeletion,
  commitPreparedDirectoryCreation,
  commitPreparedRelocation,
  persistPreparedFile,
  prepareMutatingFilePath,
  prepareResolvedMutatingPath,
  prepareRelocationPaths,
} from './file-mutation-chain.js';

void test('commitPreparedRelocation waits for in-flight atomic saves on the destination path', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-relocate-save-'));
  const targetPath = join(workspaceRoot, 'target.txt');
  const sourcePath = join(workspaceRoot, 'source.txt');
  const initialTargetContent = 'old target\n';
  await writeFile(targetPath, initialTargetContent, 'utf8');
  await writeFile(sourcePath, 'source\n', 'utf8');

  let releaseAtomicFallback!: () => void;
  const waitForRelease = new Promise<void>((resolve) => {
    releaseAtomicFallback = resolve;
  });
  let reportTargetBackedUp!: () => void;
  const targetBackedUp = new Promise<void>((resolve) => {
    reportTargetBackedUp = resolve;
  });
  let forcedWindowsFallback = false;

  const savePrepared = await prepareMutatingFilePath(
    workspaceRoot,
    'target.txt',
  );
  const savePromise = persistPreparedFile(
    savePrepared,
    'saved target\n',
    createVersionToken(initialTargetContent),
    {
      atomicFs: {
        async mkdir(...args) {
          await mkdir(...args);
        },
        async writeFile(...args) {
          await writeFile(...args);
        },
        async rename(from, to) {
          if (
            String(to) === targetPath &&
            String(from).includes('.tmp') &&
            !forcedWindowsFallback
          ) {
            forcedWindowsFallback = true;
            throw Object.assign(new Error('simulated replace conflict'), {
              code: 'EEXIST',
            });
          }
          if (String(from) === targetPath && String(to).includes('.bak')) {
            await rename(from, to);
            reportTargetBackedUp();
            await waitForRelease;
            return;
          }
          await rename(from, to);
        },
        async unlink(...args) {
          await unlink(...args);
        },
      },
    },
  );

  await targetBackedUp;
  const relocationPrepared = await prepareRelocationPaths(
    workspaceRoot,
    'source.txt',
    'target.txt',
  );
  const relocationCommit = commitPreparedRelocation(relocationPrepared).then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (error: unknown) => ({ status: 'rejected' as const, error }),
  );
  const relocationStateBeforeSaveFinishes = await Promise.race([
    relocationCommit.then(() => 'settled' as const),
    delay(50).then(() => 'pending' as const),
  ]);

  releaseAtomicFallback();
  await savePromise;

  assert.equal(
    relocationStateBeforeSaveFinishes,
    'pending',
    'relocation commit must wait for the in-flight save on its destination',
  );
  const relocationOutcome = await relocationCommit;
  assert.equal(relocationOutcome.status, 'rejected');
  if (relocationOutcome.status === 'rejected') {
    assert.equal(getAppErrorCode(relocationOutcome.error), 'already_exists');
  }
  assert.equal(await readFile(targetPath, 'utf8'), 'saved target\n');
  assert.equal(await readFile(sourcePath, 'utf8'), 'source\n');
});

void test('commitPreparedRelocation rejects destination created after preparation', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-relocate-'));
  await writeFile(join(workspaceRoot, 'from.txt'), 'from\n', 'utf8');

  const prepared = await prepareRelocationPaths(
    workspaceRoot,
    'from.txt',
    'to.txt',
  );
  await writeFile(join(workspaceRoot, 'to.txt'), 'raced\n', 'utf8');

  await assert.rejects(
    () => commitPreparedRelocation(prepared),
    (error: unknown) => {
      assert.equal(getAppErrorCode(error), 'already_exists');
      return true;
    },
  );

  assert.equal(
    await readFile(join(workspaceRoot, 'from.txt'), 'utf8'),
    'from\n',
  );
  assert.equal(
    await readFile(join(workspaceRoot, 'to.txt'), 'utf8'),
    'raced\n',
  );
});

void test('commitPreparedRelocation reports not_found when source disappears after preparation', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-relocate-source-'),
  );
  const sourcePath = join(workspaceRoot, 'from.txt');
  await writeFile(sourcePath, 'from\n', 'utf8');

  const prepared = await prepareRelocationPaths(
    workspaceRoot,
    'from.txt',
    'to.txt',
  );
  await rm(sourcePath);

  await assert.rejects(
    () => commitPreparedRelocation(prepared),
    (error: unknown) => {
      assert.equal(getAppErrorCode(error), 'not_found');
      return true;
    },
  );
});

void test('commitPreparedRelocation reports conflict when source kind changes after preparation', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-relocate-source-kind-'),
  );
  const sourcePath = join(workspaceRoot, 'from');
  await writeFile(sourcePath, 'from\n', 'utf8');

  const prepared = await prepareRelocationPaths(workspaceRoot, 'from', 'to');
  await rm(sourcePath);
  await mkdir(sourcePath);

  await assert.rejects(
    () => commitPreparedRelocation(prepared),
    (error: unknown) => {
      assert.equal(getAppErrorCode(error), 'conflict');
      return true;
    },
  );

  const sourceStats = await stat(sourcePath);
  assert.equal(sourceStats.isDirectory(), true);
  await assert.rejects(() => stat(join(workspaceRoot, 'to')));
});

void test('commitPreparedRelocation reports already_exists when destination parent becomes a file', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-relocate-parent-'),
  );
  await writeFile(join(workspaceRoot, 'from.txt'), 'from\n', 'utf8');

  const prepared = await prepareRelocationPaths(
    workspaceRoot,
    'from.txt',
    'dst/to.txt',
  );
  await writeFile(join(workspaceRoot, 'dst'), 'not a directory\n', 'utf8');

  await assert.rejects(
    () => commitPreparedRelocation(prepared),
    (error: unknown) => {
      assert.equal(getAppErrorCode(error), 'already_exists');
      return true;
    },
  );

  assert.equal(
    await readFile(join(workspaceRoot, 'from.txt'), 'utf8'),
    'from\n',
  );
});

void test('persistPreparedFile reports already_exists when a create-only target appears after preparation', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-create-race-'));

  const prepared = await prepareMutatingFilePath(workspaceRoot, 'new.txt', {
    allowMissingLeaf: true,
  });
  await writeFile(join(workspaceRoot, 'new.txt'), 'competing\n', 'utf8');

  await assert.rejects(
    () => persistPreparedFile(prepared, 'created\n', ''),
    (error: unknown) => {
      assert.equal(getAppErrorCode(error), 'already_exists');
      return true;
    },
  );

  assert.equal(
    await readFile(join(workspaceRoot, 'new.txt'), 'utf8'),
    'competing\n',
  );
});

void test('persistPreparedFile reports already_exists when a create-only parent becomes a file', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-create-parent-'));

  const prepared = await prepareMutatingFilePath(workspaceRoot, 'dst/new.txt', {
    allowMissingLeaf: true,
  });
  await writeFile(join(workspaceRoot, 'dst'), 'not a directory\n', 'utf8');

  await assert.rejects(
    () => persistPreparedFile(prepared, 'created\n', ''),
    (error: unknown) => {
      assert.equal(getAppErrorCode(error), 'already_exists');
      return true;
    },
  );
});

void test('commitPreparedDeletion reports not_found when target disappears after preparation', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-delete-'));
  const targetPath = join(workspaceRoot, 'delete-me.txt');
  await writeFile(targetPath, 'delete\n', 'utf8');

  const prepared = await prepareResolvedMutatingPath(
    workspaceRoot,
    'delete-me.txt',
  );
  await rm(targetPath);

  await assert.rejects(
    () => commitPreparedDeletion(prepared),
    (error: unknown) => {
      assert.equal(getAppErrorCode(error), 'not_found');
      return true;
    },
  );
});

void test('commitPreparedDeletion reports conflict when target kind changes after preparation', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-delete-kind-'));
  const targetPath = join(workspaceRoot, 'delete-me');
  await writeFile(targetPath, 'delete\n', 'utf8');

  const prepared = await prepareResolvedMutatingPath(
    workspaceRoot,
    'delete-me',
  );
  await rm(targetPath);
  await mkdir(targetPath);
  await writeFile(join(targetPath, 'replacement.txt'), 'replacement\n', 'utf8');

  await assert.rejects(
    () => commitPreparedDeletion(prepared),
    (error: unknown) => {
      assert.equal(getAppErrorCode(error), 'conflict');
      return true;
    },
  );

  const targetStats = await stat(targetPath);
  assert.equal(targetStats.isDirectory(), true);
  assert.equal(
    await readFile(join(targetPath, 'replacement.txt'), 'utf8'),
    'replacement\n',
  );
});

void test('commitPreparedDeletion reports not_found when target parent becomes a file', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-delete-parent-'));
  const parentPath = join(workspaceRoot, 'nested');
  await mkdir(parentPath, { recursive: true });
  await writeFile(join(parentPath, 'delete-me.txt'), 'delete\n', 'utf8');

  const prepared = await prepareResolvedMutatingPath(
    workspaceRoot,
    'nested/delete-me.txt',
  );
  await rm(parentPath, { recursive: true });
  await writeFile(parentPath, 'not a directory\n', 'utf8');

  await assert.rejects(
    () => commitPreparedDeletion(prepared),
    (error: unknown) => {
      assert.equal(getAppErrorCode(error), 'not_found');
      return true;
    },
  );
});

void test('commitPreparedDirectoryCreation reports already_exists when target appears after preparation', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-mkdir-race-'));

  const prepared = await prepareResolvedMutatingPath(
    workspaceRoot,
    'nested/child',
    { allowMissingLeaf: true },
  );
  await mkdir(join(workspaceRoot, 'nested', 'child'), { recursive: true });

  await assert.rejects(
    () => commitPreparedDirectoryCreation(prepared),
    (error: unknown) => {
      assert.equal(getAppErrorCode(error), 'already_exists');
      return true;
    },
  );
});

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
