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
import { readFile } from '../../files/read-file.js';
import { isToolAnyOfParameters } from '../types.js';
import { manageFilesTool } from './manage-files.js';
import { patchFileTool } from './patch-file.js';

void test('patch_file publishes append and replace modes in its parameters schema', () => {
  const parameters = patchFileTool.parameters;

  assert.ok(isToolAnyOfParameters(parameters));

  const appendBranch = parameters.anyOf.find((branch) => {
    const oldStringSchema = branch.properties.old_string as
      | { const?: unknown }
      | undefined;
    return oldStringSchema?.const === '';
  });
  const replaceBranch = parameters.anyOf.find((branch) => {
    const oldStringSchema = branch.properties.old_string as
      | { minLength?: unknown }
      | undefined;
    return oldStringSchema?.minLength === 1;
  });

  assert.ok(appendBranch);
  assert.ok(replaceBranch);
  assert.deepEqual(appendBranch.required, ['path', 'old_string', 'new_string']);
  assert.deepEqual(replaceBranch.required, [
    'path',
    'old_string',
    'new_string',
  ]);
});

void test('patch_file rejects patching an existing file without a versionToken', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-patch-tool-'));
  await writeFile(join(workspaceRoot, 'hello.txt'), 'hello\n', 'utf8');

  const result = await patchFileTool.execute(
    { path: 'hello.txt', old_string: 'hello', new_string: 'updated' },
    { callId: 'call-patch-1', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /versionToken is required/);
});

void test('patch_file rejects unexpected keys instead of silently dropping them', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-patch-tool-'));

  const result = await patchFileTool.execute(
    {
      path: 'hello.txt',
      old_string: 'hello',
      new_string: 'updated',
      extra: true,
    },
    { callId: 'call-patch-extra', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /unexpected keys: extra\./);
});

void test('patch_file rejects blank versionToken at the parser boundary', async () => {
  const result = await patchFileTool.execute(
    {
      path: 'hello.txt',
      old_string: 'hello',
      new_string: 'updated',
      versionToken: '   ',
    },
    { callId: 'call-patch-blank-version-token', workspaceRoot: '/workspace' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /versionToken must not be empty/);
});

void test('patch_file rejects blank path at the parser boundary', async () => {
  const result = await patchFileTool.execute(
    {
      path: '   ',
      old_string: 'hello',
      new_string: 'updated',
      versionToken: 'token',
    },
    { callId: 'call-patch-blank-path', workspaceRoot: '/workspace' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /path.*empty/);
});

void test('patch_file replaces exactly one matching string', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-patch-tool-'));
  await writeFile(join(workspaceRoot, 'hello.txt'), 'hello\nworld\n', 'utf8');
  const file = await readFile(workspaceRoot, 'hello.txt');

  const result = await patchFileTool.execute(
    {
      path: 'hello.txt',
      old_string: 'world',
      new_string: 'geulbat',
      versionToken: file.versionToken,
    },
    { callId: 'call-patch-2', workspaceRoot },
  );

  assert.equal(result.ok, true);
  assert.equal(
    await fsReadFile(join(workspaceRoot, 'hello.txt'), 'utf8'),
    'hello\ngeulbat\n',
  );
});

void test('patch_file rejects old_string matches that appear more than once', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-patch-tool-'));
  await writeFile(join(workspaceRoot, 'hello.txt'), 'hello\nhello\n', 'utf8');
  const file = await readFile(workspaceRoot, 'hello.txt');

  const result = await patchFileTool.execute(
    {
      path: 'hello.txt',
      old_string: 'hello',
      new_string: 'updated',
      versionToken: file.versionToken,
    },
    { callId: 'call-patch-3', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /matched 2 times/);
});

void test('patch_file supports append mode when old_string is empty', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-patch-tool-'));
  await writeFile(join(workspaceRoot, 'hello.txt'), 'hello\n', 'utf8');
  const file = await readFile(workspaceRoot, 'hello.txt');

  const result = await patchFileTool.execute(
    {
      path: 'hello.txt',
      old_string: '',
      new_string: 'appended\n',
      versionToken: file.versionToken,
    },
    { callId: 'call-patch-4', workspaceRoot },
  );

  assert.equal(result.ok, true);
  assert.equal(
    await fsReadFile(join(workspaceRoot, 'hello.txt'), 'utf8'),
    'hello\nappended\n',
  );
});

void test('patch_file rejects stale versionToken writes', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-patch-tool-'));
  const path = join(workspaceRoot, 'hello.txt');
  await writeFile(path, 'hello\nworld\n', 'utf8');
  const stale = await readFile(workspaceRoot, 'hello.txt');
  await writeFile(path, 'hello\nchanged\n', 'utf8');

  const result = await patchFileTool.execute(
    {
      path: 'hello.txt',
      old_string: 'changed',
      new_string: 'updated',
      versionToken: stale.versionToken,
    },
    { callId: 'call-patch-5', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'conflict_stale_write');
});

void test('patch_file rejects old source paths after manage_files rename when a versionToken is present', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-patch-tool-'));
  await writeFile(join(workspaceRoot, 'hello.txt'), 'hello\nworld\n', 'utf8');
  const file = await readFile(workspaceRoot, 'hello.txt');

  const renameResult = await manageFilesTool.execute(
    {
      operation: 'rename',
      path: 'hello.txt',
      destination: 'renamed.txt',
    },
    { callId: 'call-manage-rename-patch', workspaceRoot },
  );
  assert.equal(renameResult.ok, true);

  const result = await patchFileTool.execute(
    {
      path: 'hello.txt',
      old_string: 'world',
      new_string: 'updated',
      versionToken: file.versionToken,
    },
    { callId: 'call-patch-rename', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'not_found');
});

void test('patch_file rejects old source paths after manage_files move when a versionToken is present', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-patch-tool-'));
  await mkdir(join(workspaceRoot, 'src'), { recursive: true });
  await writeFile(
    join(workspaceRoot, 'src', 'hello.txt'),
    'hello\nworld\n',
    'utf8',
  );
  const file = await readFile(workspaceRoot, 'src/hello.txt');

  const moveResult = await manageFilesTool.execute(
    {
      operation: 'move',
      path: 'src/hello.txt',
      destination: 'dst/hello.txt',
    },
    { callId: 'call-manage-move-patch', workspaceRoot },
  );
  assert.equal(moveResult.ok, true);

  const result = await patchFileTool.execute(
    {
      path: 'src/hello.txt',
      old_string: 'world',
      new_string: 'updated',
      versionToken: file.versionToken,
    },
    { callId: 'call-patch-move', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'not_found');
});

void test('patch_file rejects deleted source paths after manage_files delete when a versionToken is present', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-patch-tool-'));
  await writeFile(join(workspaceRoot, 'hello.txt'), 'hello\nworld\n', 'utf8');
  const file = await readFile(workspaceRoot, 'hello.txt');

  const deleteResult = await manageFilesTool.execute(
    { operation: 'delete', path: 'hello.txt' },
    { callId: 'call-manage-delete-patch', workspaceRoot },
  );
  assert.equal(deleteResult.ok, true);

  const result = await patchFileTool.execute(
    {
      path: 'hello.txt',
      old_string: 'world',
      new_string: 'updated',
      versionToken: file.versionToken,
    },
    { callId: 'call-patch-delete', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'not_found');
});
