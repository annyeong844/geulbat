import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile as fsReadFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSymlinkOrSkip } from '../../test-support/symlink-test.js';
import {
  AtomicBackupRestoreFailedError,
  type AtomicWriteLike,
} from '../utils/atomic-file.js';
import { hasErrorCode } from '../utils/error.js';
import { StaleWriteError } from './file-domain-error.js';
import { readFile } from './read-file.js';
import { saveFile } from './save-file.js';

void test('saveFile atomically updates the canonical target of an existing symlink', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-save-'));
  const outsideRoot = await mkdtemp(join(tmpdir(), 'geulbat-outside-'));
  const outsideFile = join(outsideRoot, 'outside.txt');
  const insideLink = join(workspaceRoot, 'linked.txt');

  await writeFile(outsideFile, 'outside\n', 'utf8');
  if (!(await createSymlinkOrSkip(t, outsideFile, insideLink))) {
    return;
  }

  const current = await readFile(workspaceRoot, 'linked.txt');
  const result = await saveFile(
    workspaceRoot,
    'linked.txt',
    'updated\n',
    current.versionToken,
  );
  assert.equal(result.ok, true);
  assert.equal(await fsReadFile(outsideFile, 'utf8'), 'updated\n');
});

void test('saveFile creates a file through a symlinked parent directory', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-save-'));
  const outsideRoot = await mkdtemp(join(tmpdir(), 'geulbat-outside-'));
  const realDir = join(outsideRoot, 'real-dir');
  const insideLinkDir = join(workspaceRoot, 'linked-dir');

  await mkdir(realDir, { recursive: true });
  if (!(await createSymlinkOrSkip(t, realDir, insideLinkDir))) {
    return;
  }

  const result = await saveFile(
    workspaceRoot,
    'linked-dir/child.txt',
    'updated\n',
    '',
  );
  assert.equal(result.ok, true);
  assert.equal(
    await fsReadFile(join(realDir, 'child.txt'), 'utf8'),
    'updated\n',
  );
});

void test('saveFile overwrites an existing file when the current versionToken matches', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-save-'));
  const absolutePath = join(workspaceRoot, 'hello.txt');
  await writeFile(absolutePath, 'hello\n', 'utf8');
  const file = await readFile(workspaceRoot, 'hello.txt');

  const result = await saveFile(
    workspaceRoot,
    'hello.txt',
    'updated\n',
    file.versionToken,
  );

  assert.equal(result.ok, true);
  assert.equal(await fsReadFile(absolutePath, 'utf8'), 'updated\n');
});

void test('saveFile rejects stale writes when the file changed after the caller read it', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-save-'));
  const absolutePath = join(workspaceRoot, 'hello.txt');
  await writeFile(absolutePath, 'hello\n', 'utf8');
  const file = await readFile(workspaceRoot, 'hello.txt');
  await writeFile(absolutePath, 'changed\n', 'utf8');

  await assert.rejects(
    () => saveFile(workspaceRoot, 'hello.txt', 'updated\n', file.versionToken),
    (error: unknown) => error instanceof StaleWriteError,
  );
});

void test('saveFile canonicalizes CRLF content to LF before writing', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-save-'));

  const result = await saveFile(
    workspaceRoot,
    'hello.txt',
    'line1\r\nline2\r\n',
    '',
  );

  assert.equal(result.ok, true);
  assert.equal(
    await fsReadFile(join(workspaceRoot, 'hello.txt'), 'utf8'),
    'line1\nline2\n',
  );
});

void test('saveFile treats empty expectedToken as a create-only sentinel', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-save-'));
  const absolutePath = join(workspaceRoot, 'hello.txt');

  const created = await saveFile(
    workspaceRoot,
    'hello.txt',
    'created\n',
    '   ',
  );
  assert.equal(created.ok, true);
  assert.equal(await fsReadFile(absolutePath, 'utf8'), 'created\n');

  await assert.rejects(
    () => saveFile(workspaceRoot, 'hello.txt', 'overwrite\n', ''),
    (error: unknown) => error instanceof StaleWriteError,
  );
  assert.equal(await fsReadFile(absolutePath, 'utf8'), 'created\n');
});

void test('saveFile rejects version-token writes after rename removes the source path', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-save-'));
  const sourcePath = join(workspaceRoot, 'hello.txt');
  const renamedPath = join(workspaceRoot, 'renamed.txt');
  await writeFile(sourcePath, 'hello\n', 'utf8');
  const file = await readFile(workspaceRoot, 'hello.txt');
  await rename(sourcePath, renamedPath);

  await assert.rejects(
    () => saveFile(workspaceRoot, 'hello.txt', 'updated\n', file.versionToken),
    (error: unknown) =>
      error instanceof Error &&
      error.name === 'MissingWriteTargetError' &&
      hasErrorCode(error, 'not_found'),
  );
  await assert.rejects(() => fsReadFile(sourcePath, 'utf8'));
  assert.equal(await fsReadFile(renamedPath, 'utf8'), 'hello\n');
});

void test('saveFile rejects version-token writes after move removes the source path', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-save-'));
  const sourceDir = join(workspaceRoot, 'src');
  const targetDir = join(workspaceRoot, 'dst');
  await mkdir(sourceDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });
  const sourcePath = join(sourceDir, 'hello.txt');
  const movedPath = join(targetDir, 'hello.txt');
  await writeFile(sourcePath, 'hello\n', 'utf8');
  const file = await readFile(workspaceRoot, 'src/hello.txt');
  await rename(sourcePath, movedPath);

  await assert.rejects(
    () =>
      saveFile(workspaceRoot, 'src/hello.txt', 'updated\n', file.versionToken),
    (error: unknown) =>
      error instanceof Error &&
      error.name === 'MissingWriteTargetError' &&
      hasErrorCode(error, 'not_found'),
  );
  await assert.rejects(() => fsReadFile(sourcePath, 'utf8'));
  assert.equal(await fsReadFile(movedPath, 'utf8'), 'hello\n');
});

void test('saveFile rejects version-token writes after delete removes the source path', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-save-'));
  const sourcePath = join(workspaceRoot, 'hello.txt');
  await writeFile(sourcePath, 'hello\n', 'utf8');
  const file = await readFile(workspaceRoot, 'hello.txt');
  await unlink(sourcePath);

  await assert.rejects(
    () => saveFile(workspaceRoot, 'hello.txt', 'updated\n', file.versionToken),
    (error: unknown) =>
      error instanceof Error &&
      error.name === 'MissingWriteTargetError' &&
      hasErrorCode(error, 'not_found') &&
      hasErrorCode(error.cause, 'ENOENT'),
  );
});

void test('saveFile cleans up temp files and preserves the original write error', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-save-'));
  const failures: string[] = [];
  let observedTempPath = '';
  const writeFailure = Object.assign(new Error('disk full'), {
    code: 'ENOSPC',
  });
  const atomicFs: AtomicWriteLike = {
    async mkdir(..._args) {},
    async writeFile(...args) {
      observedTempPath = String(args[0]);
      throw writeFailure;
    },
    async rename(..._args) {
      assert.fail('rename should not run when the temp write fails');
    },
    async unlink(...args) {
      failures.push(String(args[0]));
    },
  };

  await assert.rejects(
    () =>
      saveFile(workspaceRoot, 'hello.txt', 'updated\n', '', {
        atomicFs,
      }),
    writeFailure,
  );

  assert.equal(failures.length, 1);
  assert.equal(failures[0], observedTempPath);
});

void test('saveFile retries Windows-style replace failures through the atomic write seam', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-save-'));
  const absolutePath = join(workspaceRoot, 'hello.txt');
  await writeFile(absolutePath, 'hello\n', 'utf8');
  const file = await readFile(workspaceRoot, 'hello.txt');
  const calls: string[] = [];
  let renameAttempt = 0;
  let tempPath = '';

  const result = await saveFile(
    workspaceRoot,
    'hello.txt',
    'updated\n',
    file.versionToken,
    {
      atomicFs: {
        async mkdir(..._args) {},
        async writeFile(...args) {
          tempPath = String(args[0]);
          calls.push(`write:${tempPath}`);
        },
        async rename(...args) {
          const from = String(args[0]);
          const to = String(args[1]);
          calls.push(`rename:${from}->${to}`);
          renameAttempt += 1;
          if (renameAttempt === 1) {
            throw Object.assign(new Error('rename blocked'), { code: 'EPERM' });
          }
        },
        async unlink(...args) {
          calls.push(`unlink:${String(args[0])}`);
        },
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(renameAttempt, 3);
  assert.equal(calls[0], `write:${tempPath}`);
  assert.equal(calls[1], `rename:${tempPath}->${absolutePath}`);
  assert.match(
    calls[2]!,
    new RegExp(
      `^rename:${escapeRegExp(absolutePath)}->${escapeRegExp(absolutePath)}\\..+\\.bak$`,
    ),
  );
  assert.equal(calls[3], `rename:${tempPath}->${absolutePath}`);
  assert.match(
    calls[4]!,
    new RegExp(`^unlink:${escapeRegExp(absolutePath)}\\..+\\.bak$`),
  );
});

void test('saveFile surfaces backup restore failure when a Windows fallback race blocks restore', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-save-'));
  const absolutePath = join(workspaceRoot, 'hello.txt');
  await writeFile(absolutePath, 'hello\n', 'utf8');
  const file = await readFile(workspaceRoot, 'hello.txt');
  let renameAttempt = 0;
  let tempPath = '';

  await assert.rejects(
    () =>
      saveFile(workspaceRoot, 'hello.txt', 'updated\n', file.versionToken, {
        atomicFs: {
          async mkdir(..._args) {},
          async writeFile(...args) {
            tempPath = String(args[0]);
            await writeFile(tempPath, String(args[1]), 'utf8');
          },
          async rename(..._args) {
            renameAttempt += 1;
            if (renameAttempt === 1) {
              throw Object.assign(new Error('rename blocked'), {
                code: 'EPERM',
              });
            }
            if (renameAttempt === 2) {
              await rename(String(_args[0]), String(_args[1]));
              return;
            }
            if (renameAttempt === 3) {
              await writeFile(absolutePath, 'competing\n', 'utf8');
              throw Object.assign(new Error('target recreated'), {
                code: 'EEXIST',
              });
            }
            throw Object.assign(new Error('restore blocked'), {
              code: 'EEXIST',
            });
          },
          async unlink(...args) {
            await unlink(String(args[0]));
          },
        },
      }),
    (error: unknown) =>
      error instanceof AtomicBackupRestoreFailedError &&
      error.targetPath === absolutePath &&
      error.cause instanceof Error &&
      error.cause.message === 'restore blocked',
  );

  await assert.rejects(() => fsReadFile(tempPath, 'utf8'));
  assert.equal(await fsReadFile(absolutePath, 'utf8'), 'competing\n');
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

void test('saveFile serializes concurrent same-path writes and surfaces stale conflict to the later caller', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-save-'));
  const absolutePath = join(workspaceRoot, 'hello.txt');
  await writeFile(absolutePath, 'hello\n', 'utf8');
  const file = await readFile(workspaceRoot, 'hello.txt');

  let releaseFirstWrite!: () => void;
  const allowFirstWrite = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve;
  });
  let markFirstWriteStarted!: () => void;
  const firstWriteStarted = new Promise<void>((resolve) => {
    markFirstWriteStarted = resolve;
  });

  const blockingAtomicFs: AtomicWriteLike = {
    async mkdir(...args) {
      await mkdir(...args);
    },
    async writeFile(...args) {
      markFirstWriteStarted();
      await allowFirstWrite;
      await writeFile(...args);
    },
    async rename(...args) {
      await rename(...args);
    },
    async unlink(...args) {
      await unlink(...args);
    },
  };

  const firstSave = saveFile(
    workspaceRoot,
    'hello.txt',
    'first\n',
    file.versionToken,
    { atomicFs: blockingAtomicFs },
  );
  await firstWriteStarted;

  const secondSave = saveFile(
    workspaceRoot,
    'hello.txt',
    'second\n',
    file.versionToken,
  );
  let secondSettled = false;
  void secondSave.then(
    () => {
      secondSettled = true;
    },
    () => {
      secondSettled = true;
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    secondSettled,
    false,
    'same-path write should stay queued while the first save holds the path lock',
  );

  releaseFirstWrite();
  const firstResult = await firstSave;
  assert.equal(firstResult.ok, true);

  await assert.rejects(
    () => secondSave,
    (error: unknown) =>
      error instanceof StaleWriteError &&
      error.currentVersionToken === firstResult.versionToken,
  );
  assert.equal(await fsReadFile(absolutePath, 'utf8'), 'first\n');
});
