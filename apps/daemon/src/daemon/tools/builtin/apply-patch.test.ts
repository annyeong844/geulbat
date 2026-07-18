import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile as fsReadFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from '../../files/read-file.js';
import { isToolObjectParameters } from '../types.js';
import { applyPatchTool } from './apply-patch.js';
import { manageFilesTool } from './manage-files.js';

void test('apply_patch publishes only the patch text contract', () => {
  const parameters = applyPatchTool.parameters;

  assert.ok(isToolObjectParameters(parameters));
  assert.deepEqual(parameters.required, ['patch']);
  assert.deepEqual(Object.keys(parameters.properties), ['patch']);
  assert.deepEqual(applyPatchTool.exposure, {
    directHot: true,
    sdkVisible: false,
    inCellCallable: false,
    directOnly: true,
    approvalRequired: true,
    effectClass: 'computerWrite',
  });
});

void test('apply_patch rejects the removed legacy root selector', async () => {
  const result = await applyPatchTool.execute(
    {
      root: 'computer',
      patch: [
        '*** Begin Patch',
        '*** Add File: created.txt',
        '+hello',
        '*** End Patch',
        '',
      ].join('\n'),
    },
    { callId: 'call-apply-patch-legacy-root', computerFileRoot: '/computer' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /root/u);
});

void test('apply_patch rejects unexpected keys instead of silently dropping them', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-'),
  );

  const result = await applyPatchTool.execute(
    {
      patch: updatePatch('hello.txt', 'hello\n', 'updated\n'),
      extra: true,
    },
    { callId: 'call-apply-patch-extra', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /unexpected keys: extra\./);
});

void test('apply_patch rejects malformed patch blocks', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-'),
  );

  const result = await applyPatchTool.execute(
    { patch: '*** Update File: hello.txt\n@@\n-hello\n+updated\n' },
    { callId: 'call-apply-patch-malformed', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /must start with \*\*\* Begin Patch/);
});

void test('apply_patch applies one update hunk with exact context', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-'),
  );
  await writeFile(
    join(computerFileRoot, 'hello.txt'),
    'hello\nworld\n',
    'utf8',
  );

  const result = await applyPatchTool.execute(
    { patch: updatePatch('hello.txt', 'world\n', 'geulbat\n') },
    { callId: 'call-apply-patch-update', computerFileRoot },
  );

  assert.equal(result.ok, true);
  assert.equal(
    await fsReadFile(join(computerFileRoot, 'hello.txt'), 'utf8'),
    'hello\ngeulbat\n',
  );
});

void test('apply_patch applies multiple hunks in one file operation', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-'),
  );
  await writeFile(
    join(computerFileRoot, 'hello.txt'),
    'alpha\nbravo\ncharlie\n',
    'utf8',
  );

  const result = await applyPatchTool.execute(
    {
      patch: [
        '*** Begin Patch',
        '*** Update File: hello.txt',
        '@@ first',
        '-alpha',
        '+ALPHA',
        '@@ second',
        '-charlie',
        '+CHARLIE',
        '*** End Patch',
        '',
      ].join('\n'),
    },
    { callId: 'call-apply-patch-multi-hunk', computerFileRoot },
  );

  assert.equal(result.ok, true);
  assert.equal(
    await fsReadFile(join(computerFileRoot, 'hello.txt'), 'utf8'),
    'ALPHA\nbravo\nCHARLIE\n',
  );
});

void test('apply_patch rejects hunk context that appears more than once', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-'),
  );
  await writeFile(
    join(computerFileRoot, 'hello.txt'),
    'hello\nhello\n',
    'utf8',
  );

  const result = await applyPatchTool.execute(
    { patch: updatePatch('hello.txt', 'hello\n', 'updated\n') },
    { callId: 'call-apply-patch-duplicate', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /matched 2 times/);
});

void test('apply_patch adds a new file', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-'),
  );

  const result = await applyPatchTool.execute(
    {
      patch: [
        '*** Begin Patch',
        '*** Add File: created.txt',
        '+hello',
        '+world',
        '*** End Patch',
        '',
      ].join('\n'),
    },
    { callId: 'call-apply-patch-add', computerFileRoot },
  );

  assert.equal(result.ok, true);
  assert.equal(
    await fsReadFile(join(computerFileRoot, 'created.txt'), 'utf8'),
    'hello\nworld\n',
  );
});

void test('apply_patch adds and updates files in ComputerFileScope', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-computer-apply-patch-'),
  );

  const added = await applyPatchTool.execute(
    {
      patch: [
        '*** Begin Patch',
        '*** Add File: created.txt',
        '+hello',
        '*** End Patch',
        '',
      ].join('\n'),
    },
    {
      callId: 'call-computer-apply-patch-add',
      computerFileRoot,
    },
  );

  assert.equal(added.ok, true);
  assert.equal(JSON.parse(added.output).root, 'computer');
  assert.equal(
    await fsReadFile(join(computerFileRoot, 'created.txt'), 'utf8'),
    'hello\n',
  );

  const updated = await applyPatchTool.execute(
    {
      patch: updatePatch('created.txt', 'hello\n', 'updated\n'),
    },
    {
      callId: 'call-computer-apply-patch-update',
      computerFileRoot,
    },
  );

  assert.equal(updated.ok, true);
  assert.equal(JSON.parse(updated.output).root, 'computer');
  assert.equal(
    await fsReadFile(join(computerFileRoot, 'created.txt'), 'utf8'),
    'updated\n',
  );
});

void test('apply_patch adds a new file without forcing a final newline', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-'),
  );

  const result = await applyPatchTool.execute(
    {
      patch: [
        '*** Begin Patch',
        '*** Add File: no-newline.txt',
        '+hello',
        '*** End of File',
        '*** End Patch',
        '',
      ].join('\n'),
    },
    { callId: 'call-apply-patch-add-no-newline', computerFileRoot },
  );

  assert.equal(result.ok, true);
  assert.equal(
    await fsReadFile(join(computerFileRoot, 'no-newline.txt'), 'utf8'),
    'hello',
  );
});

void test('apply_patch rejects adding over an existing file', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-'),
  );
  await writeFile(join(computerFileRoot, 'hello.txt'), 'hello\n', 'utf8');

  const result = await applyPatchTool.execute(
    {
      patch: [
        '*** Begin Patch',
        '*** Add File: hello.txt',
        '+updated',
        '*** End Patch',
        '',
      ].join('\n'),
    },
    { callId: 'call-apply-patch-existing-add', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /already exists/);
});

void test('apply_patch rejects Delete File sections without removing files or directories', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-'),
  );
  await mkdir(join(computerFileRoot, 'delete-me'), { recursive: true });
  await writeFile(
    join(computerFileRoot, 'delete-me', 'kept.txt'),
    'kept\n',
    'utf8',
  );

  const result = await applyPatchTool.execute(
    {
      patch: [
        '*** Begin Patch',
        '*** Delete File: delete-me',
        '*** End Patch',
        '',
      ].join('\n'),
    },
    { callId: 'call-apply-patch-delete', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /Delete File is not supported/);
  assert.equal(
    (await stat(join(computerFileRoot, 'delete-me'))).isDirectory(),
    true,
  );
  assert.equal(
    await fsReadFile(join(computerFileRoot, 'delete-me', 'kept.txt'), 'utf8'),
    'kept\n',
  );
});

void test('apply_patch rejects more than one file operation in one call', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-'),
  );

  const result = await applyPatchTool.execute(
    {
      patch: [
        '*** Begin Patch',
        '*** Add File: first.txt',
        '+first',
        '*** Add File: second.txt',
        '+second',
        '*** End Patch',
        '',
      ].join('\n'),
    },
    { callId: 'call-apply-patch-multi-file', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /exactly one file operation/);
});

void test('apply_patch rejects old source paths after manage_files rename', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-'),
  );
  await writeFile(
    join(computerFileRoot, 'hello.txt'),
    'hello\nworld\n',
    'utf8',
  );
  await readFile(computerFileRoot, 'hello.txt');

  const renameResult = await manageFilesTool.execute(
    {
      operation: 'rename',
      path: 'hello.txt',
      destination: 'renamed.txt',
    },
    { callId: 'call-manage-rename-apply-patch', computerFileRoot },
  );
  assert.equal(renameResult.ok, true);

  const result = await applyPatchTool.execute(
    { patch: updatePatch('hello.txt', 'world\n', 'updated\n') },
    { callId: 'call-apply-patch-rename', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'not_found');
});

void test('apply_patch updates a file without requiring a final newline', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-'),
  );
  await writeFile(join(computerFileRoot, 'hello.txt'), 'old', 'utf8');

  const result = await applyPatchTool.execute(
    {
      patch: [
        '*** Begin Patch',
        '*** Update File: hello.txt',
        '@@',
        '-old',
        '+new',
        '*** End of File',
        '*** End Patch',
        '',
      ].join('\n'),
    },
    { callId: 'call-apply-patch-update-no-newline', computerFileRoot },
  );

  assert.equal(result.ok, true);
  assert.equal(
    await fsReadFile(join(computerFileRoot, 'hello.txt'), 'utf8'),
    'new',
  );
});

void test('apply_patch rejects old source paths after manage_files move', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-'),
  );
  await mkdir(join(computerFileRoot, 'src'), { recursive: true });
  await writeFile(
    join(computerFileRoot, 'src', 'hello.txt'),
    'hello\nworld\n',
    'utf8',
  );
  await readFile(computerFileRoot, 'src/hello.txt');

  const moveResult = await manageFilesTool.execute(
    {
      operation: 'move',
      path: 'src/hello.txt',
      destination: 'dst/hello.txt',
    },
    { callId: 'call-manage-move-apply-patch', computerFileRoot },
  );
  assert.equal(moveResult.ok, true);

  const result = await applyPatchTool.execute(
    { patch: updatePatch('src/hello.txt', 'world\n', 'updated\n') },
    { callId: 'call-apply-patch-move', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'not_found');
});

void test('apply_patch rejects deleted source paths after manage_files delete', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-apply-patch-'),
  );
  await writeFile(
    join(computerFileRoot, 'hello.txt'),
    'hello\nworld\n',
    'utf8',
  );
  await readFile(computerFileRoot, 'hello.txt');

  const deleteResult = await manageFilesTool.execute(
    { operation: 'delete', path: 'hello.txt' },
    { callId: 'call-manage-delete-apply-patch', computerFileRoot },
  );
  assert.equal(deleteResult.ok, true);

  const result = await applyPatchTool.execute(
    { patch: updatePatch('hello.txt', 'world\n', 'updated\n') },
    { callId: 'call-apply-patch-deleted', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'not_found');
});

function updatePatch(path: string, oldText: string, newText: string): string {
  const oldLines = oldText.endsWith('\n')
    ? oldText.slice(0, -1).split('\n')
    : oldText.split('\n');
  const newLines = newText.endsWith('\n')
    ? newText.slice(0, -1).split('\n')
    : newText.split('\n');
  return [
    '*** Begin Patch',
    `*** Update File: ${path}`,
    '@@',
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    '*** End Patch',
    '',
  ].join('\n');
}
