import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile as fsReadFile,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSymlinkOrSkip } from '../../test-support/symlink-test.js';
import {
  getErrorCode,
  getErrorStringProperty,
  hasErrorCode,
} from '../utils/error.js';
import { replaceBinaryFile, saveBinaryFile } from './save-binary-file.js';
import { createBinaryVersionToken } from './version-token.js';

void test('saveBinaryFile creates a new binary file and returns binary metadata', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-save-binary-'));
  const payload = new Uint8Array([0x00, 0x01, 0x02, 0xff]);

  const result = await saveBinaryFile(
    workspaceRoot,
    'exports/demo.bin',
    payload,
  );

  assert.equal(result.ok, true);
  assert.equal(result.path, 'exports/demo.bin');
  assert.equal(result.totalLines, 0);
  assert.deepEqual(
    await fsReadFile(join(workspaceRoot, 'exports/demo.bin')),
    Buffer.from(payload),
  );
});

void test('saveBinaryFile is create-only and returns already_exists when the target exists', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-save-binary-'));
  const absolutePath = join(workspaceRoot, 'exports/demo.bin');
  await mkdir(join(workspaceRoot, 'exports'), { recursive: true });
  await writeFile(absolutePath, Buffer.from([0x01]));

  await assert.rejects(
    () =>
      saveBinaryFile(workspaceRoot, 'exports/demo.bin', new Uint8Array([0x02])),
    (error: unknown) =>
      error instanceof Error && getErrorCode(error) === 'already_exists',
  );
});

void test('saveBinaryFile creates a file through a symlinked parent directory', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-save-binary-'));
  const outsideRoot = await mkdtemp(join(tmpdir(), 'geulbat-outside-'));
  const realDir = join(outsideRoot, 'real-dir');
  const insideLinkDir = join(workspaceRoot, 'linked-dir');

  await mkdir(realDir, { recursive: true });
  if (!(await createSymlinkOrSkip(t, realDir, insideLinkDir))) {
    return;
  }

  const result = await saveBinaryFile(
    workspaceRoot,
    'linked-dir/child.bin',
    new Uint8Array([1]),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(
    await fsReadFile(join(realDir, 'child.bin')),
    Buffer.from([1]),
  );
});

void test('replaceBinaryFile overwrites an existing binary file when versionToken matches', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-replace-binary-'),
  );
  const absolutePath = join(workspaceRoot, 'exports/demo.bin');
  const initial = Buffer.from([0x00, 0x01]);
  const replacement = new Uint8Array([0x02, 0x03, 0x04]);

  await mkdir(join(workspaceRoot, 'exports'), { recursive: true });
  await writeFile(absolutePath, initial);

  const result = await replaceBinaryFile(
    workspaceRoot,
    'exports/demo.bin',
    replacement,
    createBinaryVersionToken(initial),
  );

  assert.equal(result.ok, true);
  assert.equal(result.path, 'exports/demo.bin');
  assert.equal(result.versionToken, createBinaryVersionToken(replacement));
  assert.deepEqual(await fsReadFile(absolutePath), Buffer.from(replacement));
});

void test('replaceBinaryFile rejects missing binary targets with not_found', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-replace-binary-'),
  );

  await assert.rejects(
    () =>
      replaceBinaryFile(
        workspaceRoot,
        'exports/missing.bin',
        new Uint8Array([0x01]),
        'token-1',
      ),
    (error: unknown) =>
      error instanceof Error &&
      getErrorCode(error) === 'not_found' &&
      hasErrorCode(error.cause, 'ENOENT'),
  );
});

void test('replaceBinaryFile rejects stale binary version tokens with conflict_stale_write', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-replace-binary-'),
  );
  const absolutePath = join(workspaceRoot, 'exports/demo.bin');

  await mkdir(join(workspaceRoot, 'exports'), { recursive: true });
  await writeFile(absolutePath, Buffer.from([0x00, 0x01]));

  await assert.rejects(
    () =>
      replaceBinaryFile(
        workspaceRoot,
        'exports/demo.bin',
        new Uint8Array([0x02]),
        'stale-token',
      ),
    (error: unknown) =>
      error instanceof Error &&
      getErrorCode(error) === 'conflict_stale_write' &&
      typeof getErrorStringProperty(error, 'currentVersionToken') === 'string',
  );
});
