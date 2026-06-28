import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSymlinkOrSkip } from '../../../test-support/symlink-test.js';
import { manageFilesTool } from './manage-files.js';

function findManageFilesOperationBranch(operation: string) {
  const parameters = manageFilesTool.parameters;
  assert.ok('oneOf' in parameters);
  const branch = parameters.oneOf.find((candidate) => {
    const operationProperty = candidate.properties.operation as
      | { const?: unknown }
      | undefined;
    return operationProperty?.const === operation;
  });
  assert.ok(branch);
  return branch;
}

void test('manage_files outward parameters publish branch destination requirements', () => {
  const createBranch = findManageFilesOperationBranch('create');
  const renameBranch = findManageFilesOperationBranch('rename');
  const moveBranch = findManageFilesOperationBranch('move');

  assert.equal('destination' in createBranch.properties, false);
  assert.deepEqual(renameBranch.required, ['operation', 'path', 'destination']);
  assert.deepEqual(moveBranch.required, ['operation', 'path', 'destination']);
});

void test('manage_files create rejects destination before execution', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));

  const result = await manageFilesTool.execute(
    {
      operation: 'create',
      path: 'empty.txt',
      destination: 'other.txt',
    },
    { callId: 'call-create-destination', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.equal(result.error, 'destination is not allowed for create.');
});

void test('manage_files mkdir rejects destination before execution', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));

  const result = await manageFilesTool.execute(
    {
      operation: 'mkdir',
      path: 'nested/child',
      destination: 'other-dir',
    },
    { callId: 'call-mkdir-destination', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.equal(result.error, 'destination is not allowed for mkdir.');
});

void test('manage_files delete rejects destination before execution', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));

  const result = await manageFilesTool.execute(
    {
      operation: 'delete',
      path: 'delete-me.txt',
      destination: 'other.txt',
    },
    { callId: 'call-delete-destination', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.equal(result.error, 'destination is not allowed for delete.');
});

void test('manage_files rejects blank path before execution', async () => {
  const result = await manageFilesTool.execute(
    { operation: 'create', path: '   ' },
    { callId: 'call-manage-blank-path', workspaceRoot: '/workspace' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /path.*empty/);
});

void test('manage_files rename requires destination before execution', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));

  const result = await manageFilesTool.execute(
    { operation: 'rename', path: 'from.txt' },
    { callId: 'call-rename-missing-destination', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.equal(result.error, 'destination is required for rename.');
});

void test('manage_files rename rejects blank destination before execution', async () => {
  const result = await manageFilesTool.execute(
    { operation: 'rename', path: 'from.txt', destination: '   ' },
    { callId: 'call-rename-blank-destination', workspaceRoot: '/workspace' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.equal(result.error, 'destination is required for rename.');
});

void test('manage_files rename rejects empty destination before execution', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));

  const result = await manageFilesTool.execute(
    { operation: 'rename', path: 'from.txt', destination: '' },
    { callId: 'call-rename-empty-destination', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.equal(result.error, 'destination is required for rename.');
});

void test('manage_files move requires destination before execution', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));

  const result = await manageFilesTool.execute(
    { operation: 'move', path: 'src/note.txt' },
    { callId: 'call-move-missing-destination', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.equal(result.error, 'destination is required for move.');
});

void test('manage_files move rejects empty destination before execution', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));

  const result = await manageFilesTool.execute(
    { operation: 'move', path: 'src/note.txt', destination: '' },
    { callId: 'call-move-empty-destination', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.equal(result.error, 'destination is required for move.');
});

void test('manage_files delete rejects symlink paths', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));
  const outsideRoot = await mkdtemp(join(tmpdir(), 'geulbat-outside-'));
  const outsideDir = join(outsideRoot, 'outside-dir');
  const linkedDir = join(workspaceRoot, 'linked-dir');

  await mkdir(outsideDir, { recursive: true });
  if (!(await createSymlinkOrSkip(t, outsideDir, linkedDir))) {
    return;
  }

  const result = await manageFilesTool.execute(
    { operation: 'delete', path: 'linked-dir' },
    { callId: 'call-1', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'path_out_of_workspace');
});

void test('manage_files delete rejects the workspace root', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));

  const result = await manageFilesTool.execute(
    { operation: 'delete', path: '.' },
    { callId: 'call-delete-root', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error, /cannot delete workspace root/);
  const stats = await import('node:fs/promises').then((fs) =>
    fs.stat(workspaceRoot),
  );
  assert.equal(stats.isDirectory(), true);
});

void test('manage_files delete reports missing source through delete precondition', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));

  const result = await manageFilesTool.execute(
    { operation: 'delete', path: 'missing.txt' },
    { callId: 'call-delete-missing', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'not_found');
  assert.equal(result.error, 'file not found: missing.txt');
});

void test('manage_files create rejects writes through symlinked parent directories', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));
  const outsideRoot = await mkdtemp(join(tmpdir(), 'geulbat-outside-'));
  const realDir = join(outsideRoot, 'real-dir');
  const insideLinkDir = join(workspaceRoot, 'linked-dir');

  await mkdir(realDir, { recursive: true });
  if (!(await createSymlinkOrSkip(t, realDir, insideLinkDir))) {
    return;
  }

  const result = await manageFilesTool.execute(
    { operation: 'create', path: 'linked-dir/child.txt' },
    { callId: 'call-create-symlink', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'path_out_of_workspace');
});

void test('manage_files create returns already_exists when target file already exists', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));
  await writeFile(join(workspaceRoot, 'hello.txt'), 'hello\n', 'utf8');

  const result = await manageFilesTool.execute(
    { operation: 'create', path: 'hello.txt' },
    { callId: 'call-2', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'already_exists');
});

void test('manage_files create creates an empty file through the shared save chain', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));

  const result = await manageFilesTool.execute(
    { operation: 'create', path: 'empty.txt' },
    { callId: 'call-create-empty', workspaceRoot },
  );

  assert.equal(result.ok, true);
  const content = await import('node:fs/promises').then((fs) =>
    fs.readFile(join(workspaceRoot, 'empty.txt'), 'utf8'),
  );
  assert.equal(content, '');
});

void test('manage_files delete removes an existing file through the shared delete helper', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));
  const filePath = join(workspaceRoot, 'delete-me.txt');
  await writeFile(filePath, 'delete\n', 'utf8');

  const result = await manageFilesTool.execute(
    { operation: 'delete', path: 'delete-me.txt' },
    { callId: 'call-delete-file', workspaceRoot },
  );

  assert.equal(result.ok, true);
  await assert.rejects(() =>
    import('node:fs/promises').then((fs) => fs.stat(filePath)),
  );
});

void test('manage_files mkdir creates nested directories through the shared mkdir helper', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));
  const dirPath = join(workspaceRoot, 'nested', 'child');

  const result = await manageFilesTool.execute(
    { operation: 'mkdir', path: 'nested/child' },
    { callId: 'call-mkdir', workspaceRoot },
  );

  assert.equal(result.ok, true);
  const stats = await import('node:fs/promises').then((fs) => fs.stat(dirPath));
  assert.equal(stats.isDirectory(), true);
});

void test('manage_files mkdir returns already_exists when target is a file', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));
  await writeFile(join(workspaceRoot, 'not-a-directory'), 'file\n', 'utf8');

  const result = await manageFilesTool.execute(
    { operation: 'mkdir', path: 'not-a-directory' },
    { callId: 'call-mkdir-file-conflict', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'already_exists');
});

void test('manage_files rename returns already_exists when destination exists', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));
  await writeFile(join(workspaceRoot, 'from.txt'), 'from\n', 'utf8');
  await writeFile(join(workspaceRoot, 'to.txt'), 'to\n', 'utf8');

  const result = await manageFilesTool.execute(
    { operation: 'rename', path: 'from.txt', destination: 'to.txt' },
    { callId: 'call-3', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'already_exists');
});

void test('manage_files rename rejects same canonical source and destination', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));
  await writeFile(join(workspaceRoot, 'from.txt'), 'from\n', 'utf8');

  const result = await manageFilesTool.execute(
    { operation: 'rename', path: 'from.txt', destination: './from.txt' },
    { callId: 'call-rename-same-target', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(
    result.error,
    /source and destination resolve to the same target/,
  );
});

void test('manage_files rename rejects the workspace root as source', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));

  const result = await manageFilesTool.execute(
    { operation: 'rename', path: '.', destination: 'renamed-root' },
    { callId: 'call-rename-root', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error, /cannot relocate workspace root/);
  const stats = await import('node:fs/promises').then((fs) =>
    fs.stat(workspaceRoot),
  );
  assert.equal(stats.isDirectory(), true);
});

void test('manage_files rename rejects moving a directory into its own descendant', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));
  await mkdir(join(workspaceRoot, 'src'), { recursive: true });

  const result = await manageFilesTool.execute(
    { operation: 'rename', path: 'src', destination: 'src/child' },
    { callId: 'call-rename-descendant', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error, /cannot relocate a directory into itself/);
  const sourceStats = await import('node:fs/promises').then((fs) =>
    fs.stat(join(workspaceRoot, 'src')),
  );
  assert.equal(sourceStats.isDirectory(), true);
  await assert.rejects(() =>
    import('node:fs/promises').then((fs) =>
      fs.stat(join(workspaceRoot, 'src', 'child')),
    ),
  );
});

void test('manage_files rename reports path-kind conflict when file destination is below source path', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));
  await writeFile(join(workspaceRoot, 'src'), 'file\n', 'utf8');

  const result = await manageFilesTool.execute(
    { operation: 'rename', path: 'src', destination: 'src/child' },
    { callId: 'call-rename-file-child', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'already_exists');
  assert.equal(await readFile(join(workspaceRoot, 'src'), 'utf8'), 'file\n');
  await assert.rejects(() =>
    import('node:fs/promises').then((fs) =>
      fs.stat(join(workspaceRoot, 'src', 'child')),
    ),
  );
});

void test('manage_files move returns already_exists when destination exists', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));
  await mkdir(join(workspaceRoot, 'src'), { recursive: true });
  await mkdir(join(workspaceRoot, 'dst'), { recursive: true });
  await writeFile(join(workspaceRoot, 'src', 'note.txt'), 'from\n', 'utf8');
  await writeFile(join(workspaceRoot, 'dst', 'note.txt'), 'to\n', 'utf8');

  const result = await manageFilesTool.execute(
    { operation: 'move', path: 'src/note.txt', destination: 'dst/note.txt' },
    { callId: 'call-4', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'already_exists');
});

void test('manage_files rename moves a file when the destination is free', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));
  await writeFile(join(workspaceRoot, 'from.txt'), 'from\n', 'utf8');

  const result = await manageFilesTool.execute(
    { operation: 'rename', path: 'from.txt', destination: 'to.txt' },
    { callId: 'call-5', workspaceRoot },
  );

  assert.equal(result.ok, true);
  await assert.rejects(() =>
    import('node:fs/promises').then((fs) =>
      fs.stat(join(workspaceRoot, 'from.txt')),
    ),
  );
  const renamed = await import('node:fs/promises').then((fs) =>
    fs.readFile(join(workspaceRoot, 'to.txt'), 'utf8'),
  );
  assert.equal(renamed, 'from\n');
});

void test('manage_files move relocates a file into a new directory when destination is free', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));
  await mkdir(join(workspaceRoot, 'src'), { recursive: true });
  await writeFile(join(workspaceRoot, 'src', 'note.txt'), 'from\n', 'utf8');

  const result = await manageFilesTool.execute(
    { operation: 'move', path: 'src/note.txt', destination: 'dst/note.txt' },
    { callId: 'call-6', workspaceRoot },
  );

  assert.equal(result.ok, true);
  const moved = await import('node:fs/promises').then((fs) =>
    fs.readFile(join(workspaceRoot, 'dst', 'note.txt'), 'utf8'),
  );
  assert.equal(moved, 'from\n');
});
