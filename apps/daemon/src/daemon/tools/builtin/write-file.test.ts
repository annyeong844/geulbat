import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile as fsReadFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from '../../files/read-file.js';
import { normalizePath } from '../../files/normalize-path.js';
import { createFileStateCache } from '../../utils/file-state-cache.js';
import { createSymlinkOrSkip } from '../../../test-support/symlink-test.js';
import { manageFilesTool } from './manage-files.js';
import { writeFileTool } from './write-file.js';

void test('write_file rejects overwriting an existing file without a versionToken', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-tool-'));
  await writeFile(join(computerFileRoot, 'hello.txt'), 'hello\n', 'utf8');

  const result = await writeFileTool.execute(
    { path: 'hello.txt', content: 'updated\n' },
    { callId: 'call-write-1', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /versionToken is required/);
});

void test('write_file allows creating a new file without a versionToken', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-tool-'));

  const result = await writeFileTool.execute(
    { path: 'new.txt', content: 'created\n' },
    { callId: 'call-write-2', computerFileRoot },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as { mode: string; path: string };
  assert.equal(payload.mode, 'created');
  assert.equal(payload.path, 'new.txt');
});

void test('write_file creates an absolute file outside the coordinate base', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-base-'));
  const outsideRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-outside-'));
  const absolutePath = join(outsideRoot, 'created.txt');

  const result = await writeFileTool.execute(
    { path: absolutePath, content: 'created outside\n' },
    { callId: 'call-write-outside-base', computerFileRoot },
  );

  assert.equal(result.ok, true);
  assert.equal(await fsReadFile(absolutePath, 'utf8'), 'created outside\n');
  assert.equal(
    JSON.parse(result.output).path,
    normalizePath(computerFileRoot, absolutePath),
  );
});

void test('write_file creates and overwrites files in ComputerFileScope', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-computer-write-tool-'),
  );
  const absolutePath = join(computerFileRoot, 'notes', 'hello.txt');

  const created = await writeFileTool.execute(
    {
      path: 'notes/hello.txt',
      content: 'hello\n',
    },
    {
      callId: 'call-computer-write-create',
      computerFileRoot,
    },
  );

  assert.equal(created.ok, true);
  assert.equal(await fsReadFile(absolutePath, 'utf8'), 'hello\n');
  assert.equal(JSON.parse(created.output).root, 'computer');

  const current = await readFile(computerFileRoot, 'notes/hello.txt');
  const overwritten = await writeFileTool.execute(
    {
      path: 'notes/hello.txt',
      content: 'updated\n',
      versionToken: current.versionToken,
    },
    {
      callId: 'call-computer-write-overwrite',
      computerFileRoot,
    },
  );

  assert.equal(overwritten.ok, true);
  assert.equal(await fsReadFile(absolutePath, 'utf8'), 'updated\n');
  assert.equal(JSON.parse(overwritten.output).root, 'computer');
});

void test('write_file preserves stale-write detection in the computer root', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-computer-write-tool-'),
  );
  const absolutePath = join(computerFileRoot, 'hello.txt');
  await writeFile(absolutePath, 'hello\n', 'utf8');
  const stale = await readFile(computerFileRoot, 'hello.txt');
  await writeFile(absolutePath, 'changed\n', 'utf8');

  const result = await writeFileTool.execute(
    {
      path: 'hello.txt',
      content: 'updated\n',
      versionToken: stale.versionToken,
    },
    {
      callId: 'call-computer-write-stale',
      computerFileRoot,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'conflict_stale_write');
  assert.equal(await fsReadFile(absolutePath, 'utf8'), 'changed\n');
});

void test('write_file updates a symlink target regardless of its filename', async (t) => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-computer-write-tool-'),
  );
  const reservedFile = join(computerFileRoot, '.env');
  const linkedFile = join(computerFileRoot, 'settings.txt');
  await writeFile(reservedFile, 'SECRET=kept\n', 'utf8');
  if (!(await createSymlinkOrSkip(t, reservedFile, linkedFile))) {
    return;
  }
  const current = await readFile(computerFileRoot, 'settings.txt');

  const result = await writeFileTool.execute(
    {
      path: 'settings.txt',
      content: 'SECRET=changed\n',
      versionToken: current.versionToken,
    },
    {
      callId: 'call-computer-write-reserved-alias',
      computerFileRoot,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(await fsReadFile(reservedFile, 'utf8'), 'SECRET=changed\n');
});

void test('write_file rejects blank versionToken at the parser boundary', async () => {
  const result = await writeFileTool.execute(
    {
      path: 'new.txt',
      content: 'created\n',
      versionToken: '   ',
    },
    { callId: 'call-write-blank-version-token', computerFileRoot: '/computer' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /versionToken must not be empty/);
});

void test('write_file rejects blank path at the parser boundary', async () => {
  const result = await writeFileTool.execute(
    { path: '   ', content: 'created\n' },
    { callId: 'call-write-blank-path', computerFileRoot: '/computer' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /path.*empty/);
});

void test('write_file rejects the removed legacy root selector', async () => {
  const result = await writeFileTool.execute(
    { root: 'computer', path: 'new.txt', content: 'created\n' },
    { callId: 'call-write-legacy-root', computerFileRoot: '/computer' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /root/u);
});

void test('write_file overwrites an existing file when a valid versionToken is provided', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-tool-'));
  const absolutePath = join(computerFileRoot, 'hello.txt');
  await writeFile(absolutePath, 'hello\n', 'utf8');
  const file = await readFile(computerFileRoot, 'hello.txt');

  const result = await writeFileTool.execute(
    {
      path: 'hello.txt',
      content: 'updated\n',
      versionToken: file.versionToken,
    },
    { callId: 'call-write-3', computerFileRoot },
  );

  assert.equal(result.ok, true);
  assert.equal(await fsReadFile(absolutePath, 'utf8'), 'updated\n');
  const payload = JSON.parse(result.output) as { mode: string };
  assert.equal(payload.mode, 'overwritten');
});

void test('write_file invalidates injected file state cache after a successful overwrite', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-tool-'));
  const absolutePath = join(computerFileRoot, 'hello.txt');
  await writeFile(absolutePath, 'hello\n', 'utf8');
  const fileStateCache = createFileStateCache();
  const file = await readFile(computerFileRoot, 'hello.txt', {
    fileStateCache,
  });

  assert.equal(fileStateCache.getStats().entryCount, 1);

  const result = await writeFileTool.execute(
    {
      path: 'hello.txt',
      content: 'updated\n',
      versionToken: file.versionToken,
    },
    { callId: 'call-write-cache-invalidate', computerFileRoot, fileStateCache },
  );

  assert.equal(result.ok, true);
  assert.equal(fileStateCache.getStats().entryCount, 0);
  assert.equal(await fsReadFile(absolutePath, 'utf8'), 'updated\n');
});

void test('write_file rejects stale versionToken overwrites', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-tool-'));
  const absolutePath = join(computerFileRoot, 'hello.txt');
  await writeFile(absolutePath, 'hello\n', 'utf8');
  const stale = await readFile(computerFileRoot, 'hello.txt');
  await writeFile(absolutePath, 'changed\n', 'utf8');

  const result = await writeFileTool.execute(
    {
      path: 'hello.txt',
      content: 'updated\n',
      versionToken: stale.versionToken,
    },
    { callId: 'call-write-4', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'conflict_stale_write');
});

void test('write_file rejects old source paths after rename when a versionToken is present', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-tool-'));
  const absolutePath = join(computerFileRoot, 'hello.txt');
  await writeFile(absolutePath, 'hello\n', 'utf8');
  const file = await readFile(computerFileRoot, 'hello.txt');
  await rename(absolutePath, join(computerFileRoot, 'renamed.txt'));

  const result = await writeFileTool.execute(
    {
      path: 'hello.txt',
      content: 'updated\n',
      versionToken: file.versionToken,
    },
    { callId: 'call-write-5', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'not_found');
});

void test('write_file rejects old source paths after move when a versionToken is present', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-tool-'));
  await mkdir(join(computerFileRoot, 'src'), { recursive: true });
  await mkdir(join(computerFileRoot, 'dst'), { recursive: true });
  const absolutePath = join(computerFileRoot, 'src', 'hello.txt');
  await writeFile(absolutePath, 'hello\n', 'utf8');
  const file = await readFile(computerFileRoot, 'src/hello.txt');
  await rename(absolutePath, join(computerFileRoot, 'dst', 'hello.txt'));

  const result = await writeFileTool.execute(
    {
      path: 'src/hello.txt',
      content: 'updated\n',
      versionToken: file.versionToken,
    },
    { callId: 'call-write-6', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'not_found');
});

void test('write_file rejects deleted source paths after manage_files delete when a versionToken is present', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-tool-'));
  const absolutePath = join(computerFileRoot, 'hello.txt');
  await writeFile(absolutePath, 'hello\n', 'utf8');
  const file = await readFile(computerFileRoot, 'hello.txt');

  const deleteResult = await manageFilesTool.execute(
    { operation: 'delete', path: 'hello.txt' },
    { callId: 'call-manage-delete-write', computerFileRoot },
  );
  assert.equal(deleteResult.ok, true);

  const result = await writeFileTool.execute(
    {
      path: 'hello.txt',
      content: 'updated\n',
      versionToken: file.versionToken,
    },
    { callId: 'call-write-delete', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'not_found');
});
