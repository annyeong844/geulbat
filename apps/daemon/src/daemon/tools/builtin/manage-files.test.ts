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
  assert.equal('root' in createBranch.properties, false);
  assert.equal('root' in renameBranch.properties, false);
  assert.equal('root' in moveBranch.properties, false);
  assert.deepEqual(renameBranch.required, ['operation', 'path', 'destination']);
  assert.deepEqual(moveBranch.required, ['operation', 'path', 'destination']);
  assert.deepEqual(manageFilesTool.exposure, {
    directHot: true,
    sdkVisible: false,
    inCellCallable: false,
    directOnly: true,
    approvalRequired: true,
    effectClass: 'computerWrite',
  });
});

void test('manage_files create rejects destination before execution', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));

  const result = await manageFilesTool.execute(
    {
      operation: 'create',
      path: 'empty.txt',
      destination: 'other.txt',
    },
    { callId: 'call-create-destination', computerFileRoot: computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.equal(result.error, 'destination is not allowed for create.');
});

void test('manage_files mkdir rejects destination before execution', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));

  const result = await manageFilesTool.execute(
    {
      operation: 'mkdir',
      path: 'nested/child',
      destination: 'other-dir',
    },
    { callId: 'call-mkdir-destination', computerFileRoot: computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.equal(result.error, 'destination is not allowed for mkdir.');
});

void test('manage_files delete rejects destination before execution', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));

  const result = await manageFilesTool.execute(
    {
      operation: 'delete',
      path: 'delete-me.txt',
      destination: 'other.txt',
    },
    { callId: 'call-delete-destination', computerFileRoot: computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.equal(result.error, 'destination is not allowed for delete.');
});

void test('manage_files rejects blank path before execution', async () => {
  const result = await manageFilesTool.execute(
    { operation: 'create', path: '   ' },
    { callId: 'call-manage-blank-path', computerFileRoot: '/computer' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /path.*empty/);
});

void test('manage_files rename requires destination before execution', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));

  const result = await manageFilesTool.execute(
    { operation: 'rename', path: 'from.txt' },
    {
      callId: 'call-rename-missing-destination',
      computerFileRoot: computerFileRoot,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.equal(result.error, 'destination is required for rename.');
});

void test('manage_files rename rejects blank destination before execution', async () => {
  const result = await manageFilesTool.execute(
    { operation: 'rename', path: 'from.txt', destination: '   ' },
    { callId: 'call-rename-blank-destination', computerFileRoot: '/computer' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.equal(result.error, 'destination is required for rename.');
});

void test('manage_files rename rejects empty destination before execution', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));

  const result = await manageFilesTool.execute(
    { operation: 'rename', path: 'from.txt', destination: '' },
    {
      callId: 'call-rename-empty-destination',
      computerFileRoot: computerFileRoot,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.equal(result.error, 'destination is required for rename.');
});

void test('manage_files move requires destination before execution', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));

  const result = await manageFilesTool.execute(
    { operation: 'move', path: 'src/note.txt' },
    {
      callId: 'call-move-missing-destination',
      computerFileRoot: computerFileRoot,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.equal(result.error, 'destination is required for move.');
});

void test('manage_files move rejects empty destination before execution', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));

  const result = await manageFilesTool.execute(
    { operation: 'move', path: 'src/note.txt', destination: '' },
    {
      callId: 'call-move-empty-destination',
      computerFileRoot: computerFileRoot,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.equal(result.error, 'destination is required for move.');
});

void test('manage_files delete rejects symlink paths', async (t) => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));
  const outsideRoot = await mkdtemp(join(tmpdir(), 'geulbat-outside-'));
  const outsideDir = join(outsideRoot, 'outside-dir');
  const linkedDir = join(computerFileRoot, 'linked-dir');

  await mkdir(outsideDir, { recursive: true });
  if (!(await createSymlinkOrSkip(t, outsideDir, linkedDir))) {
    return;
  }

  const result = await manageFilesTool.execute(
    { operation: 'delete', path: 'linked-dir' },
    { callId: 'call-1', computerFileRoot: computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'path_out_of_computer_scope');
});

void test('manage_files delete rejects the computer file root', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));

  const result = await manageFilesTool.execute(
    { operation: 'delete', path: '.' },
    { callId: 'call-delete-root', computerFileRoot: computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.equal(result.error, 'cannot delete computer file root.');
  const stats = await import('node:fs/promises').then((fs) =>
    fs.stat(computerFileRoot),
  );
  assert.equal(stats.isDirectory(), true);
});

void test('manage_files delete reports missing source through delete precondition', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));

  const result = await manageFilesTool.execute(
    { operation: 'delete', path: 'missing.txt' },
    { callId: 'call-delete-missing', computerFileRoot: computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'not_found');
  assert.equal(result.error, 'file not found: missing.txt');
});

void test('manage_files create rejects writes through symlinked parent directories', async (t) => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));
  const outsideRoot = await mkdtemp(join(tmpdir(), 'geulbat-outside-'));
  const realDir = join(outsideRoot, 'real-dir');
  const insideLinkDir = join(computerFileRoot, 'linked-dir');

  await mkdir(realDir, { recursive: true });
  if (!(await createSymlinkOrSkip(t, realDir, insideLinkDir))) {
    return;
  }

  const result = await manageFilesTool.execute(
    { operation: 'create', path: 'linked-dir/child.txt' },
    { callId: 'call-create-symlink', computerFileRoot: computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'path_out_of_computer_scope');
});

void test('manage_files create returns already_exists when target file already exists', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));
  await writeFile(join(computerFileRoot, 'hello.txt'), 'hello\n', 'utf8');

  const result = await manageFilesTool.execute(
    { operation: 'create', path: 'hello.txt' },
    { callId: 'call-2', computerFileRoot: computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'already_exists');
});

void test('manage_files create creates an empty file through the shared save chain', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));

  const result = await manageFilesTool.execute(
    { operation: 'create', path: 'empty.txt' },
    { callId: 'call-create-empty', computerFileRoot: computerFileRoot },
  );

  assert.equal(result.ok, true);
  const content = await import('node:fs/promises').then((fs) =>
    fs.readFile(join(computerFileRoot, 'empty.txt'), 'utf8'),
  );
  assert.equal(content, '');
});

void test('manage_files delete removes an existing file through the shared delete helper', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));
  const filePath = join(computerFileRoot, 'delete-me.txt');
  await writeFile(filePath, 'delete\n', 'utf8');

  const result = await manageFilesTool.execute(
    { operation: 'delete', path: 'delete-me.txt' },
    { callId: 'call-delete-file', computerFileRoot: computerFileRoot },
  );

  assert.equal(result.ok, true);
  await assert.rejects(() =>
    import('node:fs/promises').then((fs) => fs.stat(filePath)),
  );
});

void test('manage_files mkdir creates nested directories through the shared mkdir helper', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));
  const dirPath = join(computerFileRoot, 'nested', 'child');

  const result = await manageFilesTool.execute(
    { operation: 'mkdir', path: 'nested/child' },
    { callId: 'call-mkdir', computerFileRoot: computerFileRoot },
  );

  assert.equal(result.ok, true);
  const stats = await import('node:fs/promises').then((fs) => fs.stat(dirPath));
  assert.equal(stats.isDirectory(), true);
});

void test('manage_files mkdir returns already_exists when target is a file', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));
  await writeFile(join(computerFileRoot, 'not-a-directory'), 'file\n', 'utf8');

  const result = await manageFilesTool.execute(
    { operation: 'mkdir', path: 'not-a-directory' },
    { callId: 'call-mkdir-file-conflict', computerFileRoot: computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'already_exists');
});

void test('manage_files rename returns already_exists when destination exists', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));
  await writeFile(join(computerFileRoot, 'from.txt'), 'from\n', 'utf8');
  await writeFile(join(computerFileRoot, 'to.txt'), 'to\n', 'utf8');

  const result = await manageFilesTool.execute(
    { operation: 'rename', path: 'from.txt', destination: 'to.txt' },
    { callId: 'call-3', computerFileRoot: computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'already_exists');
});

void test('manage_files rename rejects same canonical source and destination', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));
  await writeFile(join(computerFileRoot, 'from.txt'), 'from\n', 'utf8');

  const result = await manageFilesTool.execute(
    { operation: 'rename', path: 'from.txt', destination: './from.txt' },
    { callId: 'call-rename-same-target', computerFileRoot: computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(
    result.error,
    /source and destination resolve to the same target/,
  );
});

void test('manage_files rename rejects the computer file root as source', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));

  const result = await manageFilesTool.execute(
    { operation: 'rename', path: '.', destination: 'renamed-root' },
    { callId: 'call-rename-root', computerFileRoot: computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.equal(result.error, 'cannot relocate computer file root.');
  const stats = await import('node:fs/promises').then((fs) =>
    fs.stat(computerFileRoot),
  );
  assert.equal(stats.isDirectory(), true);
});

void test('manage_files rename rejects moving a directory into its own descendant', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));
  await mkdir(join(computerFileRoot, 'src'), { recursive: true });

  const result = await manageFilesTool.execute(
    { operation: 'rename', path: 'src', destination: 'src/child' },
    { callId: 'call-rename-descendant', computerFileRoot: computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error, /cannot relocate a directory into itself/);
  const sourceStats = await import('node:fs/promises').then((fs) =>
    fs.stat(join(computerFileRoot, 'src')),
  );
  assert.equal(sourceStats.isDirectory(), true);
  await assert.rejects(() =>
    import('node:fs/promises').then((fs) =>
      fs.stat(join(computerFileRoot, 'src', 'child')),
    ),
  );
});

void test('manage_files rename reports path-kind conflict when file destination is below source path', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));
  await writeFile(join(computerFileRoot, 'src'), 'file\n', 'utf8');

  const result = await manageFilesTool.execute(
    { operation: 'rename', path: 'src', destination: 'src/child' },
    { callId: 'call-rename-file-child', computerFileRoot: computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'already_exists');
  assert.equal(await readFile(join(computerFileRoot, 'src'), 'utf8'), 'file\n');
  await assert.rejects(() =>
    import('node:fs/promises').then((fs) =>
      fs.stat(join(computerFileRoot, 'src', 'child')),
    ),
  );
});

void test('manage_files move returns already_exists when destination exists', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));
  await mkdir(join(computerFileRoot, 'src'), { recursive: true });
  await mkdir(join(computerFileRoot, 'dst'), { recursive: true });
  await writeFile(join(computerFileRoot, 'src', 'note.txt'), 'from\n', 'utf8');
  await writeFile(join(computerFileRoot, 'dst', 'note.txt'), 'to\n', 'utf8');

  const result = await manageFilesTool.execute(
    { operation: 'move', path: 'src/note.txt', destination: 'dst/note.txt' },
    { callId: 'call-4', computerFileRoot: computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'already_exists');
});

void test('manage_files rename moves a file when the destination is free', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));
  await writeFile(join(computerFileRoot, 'from.txt'), 'from\n', 'utf8');

  const result = await manageFilesTool.execute(
    { operation: 'rename', path: 'from.txt', destination: 'to.txt' },
    { callId: 'call-5', computerFileRoot: computerFileRoot },
  );

  assert.equal(result.ok, true);
  await assert.rejects(() =>
    import('node:fs/promises').then((fs) =>
      fs.stat(join(computerFileRoot, 'from.txt')),
    ),
  );
  const renamed = await import('node:fs/promises').then((fs) =>
    fs.readFile(join(computerFileRoot, 'to.txt'), 'utf8'),
  );
  assert.equal(renamed, 'from\n');
});

void test('manage_files move relocates a file into a new directory when destination is free', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-manage-'));
  await mkdir(join(computerFileRoot, 'src'), { recursive: true });
  await writeFile(join(computerFileRoot, 'src', 'note.txt'), 'from\n', 'utf8');

  const result = await manageFilesTool.execute(
    { operation: 'move', path: 'src/note.txt', destination: 'dst/note.txt' },
    { callId: 'call-6', computerFileRoot: computerFileRoot },
  );

  assert.equal(result.ok, true);
  const moved = await import('node:fs/promises').then((fs) =>
    fs.readFile(join(computerFileRoot, 'dst', 'note.txt'), 'utf8'),
  );
  assert.equal(moved, 'from\n');
});

void test('manage_files creates, moves, and deletes within the explicit computer root', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-computer-manage-'),
  );
  const context = {
    callId: 'call-computer-manage',
    computerFileRoot,
  };

  const created = await manageFilesTool.execute(
    { operation: 'create', path: 'from.txt' },
    context,
  );
  assert.equal(created.ok, true);
  assert.equal(JSON.parse(created.output).root, 'computer');

  const moved = await manageFilesTool.execute(
    {
      operation: 'move',
      path: 'from.txt',
      destination: 'nested/to.txt',
    },
    { ...context, callId: 'call-computer-manage-move' },
  );
  assert.equal(moved.ok, true);
  assert.equal(JSON.parse(moved.output).root, 'computer');
  assert.equal(
    await readFile(join(computerFileRoot, 'nested', 'to.txt'), 'utf8'),
    '',
  );

  const deleted = await manageFilesTool.execute(
    { operation: 'delete', path: 'nested/to.txt' },
    { ...context, callId: 'call-computer-manage-delete' },
  );
  assert.equal(deleted.ok, true);
  assert.equal(JSON.parse(deleted.output).root, 'computer');

  const rootDelete = await manageFilesTool.execute(
    { operation: 'delete', path: '.' },
    { ...context, callId: 'call-computer-manage-delete-root' },
  );
  assert.equal(rootDelete.ok, false);
  assert.equal(rootDelete.errorCode, 'invalid_args');
  assert.equal(rootDelete.error, 'cannot delete computer file root.');

  const rootMove = await manageFilesTool.execute(
    {
      operation: 'move',
      path: '.',
      destination: 'nested/root',
    },
    { ...context, callId: 'call-computer-manage-move-root' },
  );
  assert.equal(rootMove.ok, false);
  assert.equal(rootMove.errorCode, 'invalid_args');
  assert.equal(rootMove.error, 'cannot relocate computer file root.');
});
