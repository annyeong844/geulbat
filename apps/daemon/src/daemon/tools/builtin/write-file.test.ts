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
import { createFileStateCache } from '../../utils/file-state-cache.js';
import { manageFilesTool } from './manage-files.js';
import { writeFileTool } from './write-file.js';

void test('write_file rejects overwriting an existing file without a versionToken', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-tool-'));
  await writeFile(join(workspaceRoot, 'hello.txt'), 'hello\n', 'utf8');

  const result = await writeFileTool.execute(
    { path: 'hello.txt', content: 'updated\n' },
    { callId: 'call-write-1', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /versionToken is required/);
});

void test('write_file allows creating a new file without a versionToken', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-tool-'));

  const result = await writeFileTool.execute(
    { path: 'new.txt', content: 'created\n' },
    { callId: 'call-write-2', workspaceRoot },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as { mode: string; path: string };
  assert.equal(payload.mode, 'created');
  assert.equal(payload.path, 'new.txt');
});

void test('write_file rejects blank versionToken at the parser boundary', async () => {
  const result = await writeFileTool.execute(
    {
      path: 'new.txt',
      content: 'created\n',
      versionToken: '   ',
    },
    { callId: 'call-write-blank-version-token', workspaceRoot: '/workspace' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /versionToken must not be empty/);
});

void test('write_file rejects blank path at the parser boundary', async () => {
  const result = await writeFileTool.execute(
    { path: '   ', content: 'created\n' },
    { callId: 'call-write-blank-path', workspaceRoot: '/workspace' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /path.*empty/);
});

void test('write_file overwrites an existing file when a valid versionToken is provided', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-tool-'));
  const absolutePath = join(workspaceRoot, 'hello.txt');
  await writeFile(absolutePath, 'hello\n', 'utf8');
  const file = await readFile(workspaceRoot, 'hello.txt');

  const result = await writeFileTool.execute(
    {
      path: 'hello.txt',
      content: 'updated\n',
      versionToken: file.versionToken,
    },
    { callId: 'call-write-3', workspaceRoot },
  );

  assert.equal(result.ok, true);
  assert.equal(await fsReadFile(absolutePath, 'utf8'), 'updated\n');
  const payload = JSON.parse(result.output) as { mode: string };
  assert.equal(payload.mode, 'overwritten');
});

void test('write_file invalidates injected file state cache after a successful overwrite', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-tool-'));
  const absolutePath = join(workspaceRoot, 'hello.txt');
  await writeFile(absolutePath, 'hello\n', 'utf8');
  const fileStateCache = createFileStateCache();
  const file = await readFile(workspaceRoot, 'hello.txt', { fileStateCache });

  assert.equal(fileStateCache.getStats().entryCount, 1);

  const result = await writeFileTool.execute(
    {
      path: 'hello.txt',
      content: 'updated\n',
      versionToken: file.versionToken,
    },
    { callId: 'call-write-cache-invalidate', workspaceRoot, fileStateCache },
  );

  assert.equal(result.ok, true);
  assert.equal(fileStateCache.getStats().entryCount, 0);
  assert.equal(await fsReadFile(absolutePath, 'utf8'), 'updated\n');
});

void test('write_file rejects stale versionToken overwrites', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-tool-'));
  const absolutePath = join(workspaceRoot, 'hello.txt');
  await writeFile(absolutePath, 'hello\n', 'utf8');
  const stale = await readFile(workspaceRoot, 'hello.txt');
  await writeFile(absolutePath, 'changed\n', 'utf8');

  const result = await writeFileTool.execute(
    {
      path: 'hello.txt',
      content: 'updated\n',
      versionToken: stale.versionToken,
    },
    { callId: 'call-write-4', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'conflict_stale_write');
});

void test('write_file rejects old source paths after rename when a versionToken is present', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-tool-'));
  const absolutePath = join(workspaceRoot, 'hello.txt');
  await writeFile(absolutePath, 'hello\n', 'utf8');
  const file = await readFile(workspaceRoot, 'hello.txt');
  await rename(absolutePath, join(workspaceRoot, 'renamed.txt'));

  const result = await writeFileTool.execute(
    {
      path: 'hello.txt',
      content: 'updated\n',
      versionToken: file.versionToken,
    },
    { callId: 'call-write-5', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'not_found');
});

void test('write_file rejects old source paths after move when a versionToken is present', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-tool-'));
  await mkdir(join(workspaceRoot, 'src'), { recursive: true });
  await mkdir(join(workspaceRoot, 'dst'), { recursive: true });
  const absolutePath = join(workspaceRoot, 'src', 'hello.txt');
  await writeFile(absolutePath, 'hello\n', 'utf8');
  const file = await readFile(workspaceRoot, 'src/hello.txt');
  await rename(absolutePath, join(workspaceRoot, 'dst', 'hello.txt'));

  const result = await writeFileTool.execute(
    {
      path: 'src/hello.txt',
      content: 'updated\n',
      versionToken: file.versionToken,
    },
    { callId: 'call-write-6', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'not_found');
});

void test('write_file rejects deleted source paths after manage_files delete when a versionToken is present', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-tool-'));
  const absolutePath = join(workspaceRoot, 'hello.txt');
  await writeFile(absolutePath, 'hello\n', 'utf8');
  const file = await readFile(workspaceRoot, 'hello.txt');

  const deleteResult = await manageFilesTool.execute(
    { operation: 'delete', path: 'hello.txt' },
    { callId: 'call-manage-delete-write', workspaceRoot },
  );
  assert.equal(deleteResult.ok, true);

  const result = await writeFileTool.execute(
    {
      path: 'hello.txt',
      content: 'updated\n',
      versionToken: file.versionToken,
    },
    { callId: 'call-write-delete', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'not_found');
});
