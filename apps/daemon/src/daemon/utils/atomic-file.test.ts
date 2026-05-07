import test from 'node:test';
import assert from 'node:assert/strict';
import type { PathLike } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AtomicBackupRestoreFailedError,
  AtomicReplaceConflictError,
  replaceFileAtomically,
  writeFileAtomically,
  writeTextFileAtomically,
} from './atomic-file.js';

void test('replaceFileAtomically uses backup-then-swap for Windows-style rename failures', async () => {
  const calls: string[] = [];
  let renameAttempt = 0;

  await replaceFileAtomically('temp.json', 'provider.json', {
    async rename(from: PathLike, to: PathLike) {
      calls.push(`rename:${String(from)}->${String(to)}`);
      renameAttempt += 1;
      if (renameAttempt === 1) {
        const error = Object.assign(new Error('rename blocked'), {
          code: 'EPERM',
        });
        throw error;
      }
    },
    async unlink(target: PathLike) {
      calls.push(`unlink:${String(target)}`);
    },
  });

  assert.equal(calls[0], 'rename:temp.json->provider.json');
  assert.match(calls[1]!, /^rename:provider\.json->provider\.json\..+\.bak$/);
  assert.equal(calls[2], 'rename:temp.json->provider.json');
  assert.match(calls[3]!, /^unlink:provider\.json\..+\.bak$/);
});

void test('writeTextFileAtomically creates parent directories and writes utf8 content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-atomic-file-'));
  const targetPath = join(root, 'nested', 'summary.md');

  await writeTextFileAtomically(targetPath, '# summary\n');

  assert.equal(await readFile(targetPath, 'utf8'), '# summary\n');
});

void test('writeFileAtomically creates parent directories and writes binary content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-atomic-file-'));
  const targetPath = join(root, 'nested', 'entry.js');

  await writeFileAtomically(targetPath, new Uint8Array([0x00, 0x01, 0x02]));

  assert.deepEqual(await readFile(targetPath), Buffer.from([0x00, 0x01, 0x02]));
});

void test('replaceFileAtomically surfaces a conflict when another writer recreates the target during fallback', async () => {
  let renameAttempt = 0;
  const calls: string[] = [];

  await assert.rejects(
    () =>
      replaceFileAtomically('temp.json', 'provider.json', {
        async rename(from: PathLike, to: PathLike) {
          calls.push(`rename:${String(from)}->${String(to)}`);
          renameAttempt += 1;
          if (renameAttempt === 1) {
            throw Object.assign(new Error('rename blocked'), { code: 'EPERM' });
          }
          if (renameAttempt === 2) {
            return;
          }
          if (renameAttempt === 3) {
            throw Object.assign(new Error('rename blocked'), {
              code: 'EEXIST',
            });
          }
          return;
        },
        async unlink(target: PathLike) {
          calls.push(`unlink:${String(target)}`);
        },
      }),
    (error: unknown) =>
      error instanceof AtomicReplaceConflictError &&
      error.code === 'conflict' &&
      error.targetPath === 'provider.json',
  );

  assert.equal(calls[0], 'rename:temp.json->provider.json');
  assert.match(calls[1]!, /^rename:provider\.json->provider\.json\..+\.bak$/);
  assert.equal(calls[2], 'rename:temp.json->provider.json');
  assert.match(calls[3]!, /^rename:provider\.json\..+\.bak->provider\.json$/);
});

void test('replaceFileAtomically surfaces backup restore failure with both failure causes', async () => {
  let renameAttempt = 0;
  const calls: string[] = [];
  const replaceError = Object.assign(new Error('replace failed'), {
    code: 'EIO',
  });
  const restoreError = Object.assign(new Error('restore failed'), {
    code: 'EACCES',
  });

  await assert.rejects(
    () =>
      replaceFileAtomically('temp.json', 'provider.json', {
        async rename(from: PathLike, to: PathLike) {
          calls.push(`rename:${String(from)}->${String(to)}`);
          renameAttempt += 1;
          if (renameAttempt === 1) {
            throw Object.assign(new Error('rename blocked'), { code: 'EPERM' });
          }
          if (renameAttempt === 2) {
            return;
          }
          if (renameAttempt === 3) {
            throw replaceError;
          }
          throw restoreError;
        },
        async unlink(target: PathLike) {
          calls.push(`unlink:${String(target)}`);
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof AtomicBackupRestoreFailedError);
      assert.equal(Reflect.get(error, 'code'), 'internal');
      assert.equal(Reflect.get(error, 'targetPath'), 'provider.json');
      assert.match(
        String(Reflect.get(error, 'backupPath')),
        /^provider\.json\..+\.bak$/,
      );
      assert.equal(Reflect.get(error, 'replaceError'), replaceError);
      assert.equal(error.cause, restoreError);
      return true;
    },
  );

  assert.equal(calls[0], 'rename:temp.json->provider.json');
  assert.match(calls[1]!, /^rename:provider\.json->provider\.json\..+\.bak$/);
  assert.equal(calls[2], 'rename:temp.json->provider.json');
  assert.match(calls[3]!, /^rename:provider\.json\..+\.bak->provider\.json$/);
});
