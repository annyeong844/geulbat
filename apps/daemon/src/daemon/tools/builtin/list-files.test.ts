import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSymlinkOrSkip } from '../../../test-support/symlink-test.js';
import { listFilesTool } from './list-files.js';

void test('list_files defaults a missing path to the current directory', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-list-tool-'));
  await mkdir(join(computerFileRoot, 'src'));
  await writeFile(
    join(computerFileRoot, 'src', 'hello.txt'),
    'hello\n',
    'utf8',
  );

  const result = await listFilesTool.execute(
    {},
    { callId: 'call-list-1', computerFileRoot },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    root: string;
    path: string;
    entries: Array<{ path: string }>;
  };
  assert.equal(payload.root, 'computer');
  assert.equal(payload.path, '.');
  assert.ok(payload.entries.some((entry) => entry.path === 'src'));
});

void test('list_files rejects an empty path instead of treating it as root', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-list-tool-'));

  const result = await listFilesTool.execute(
    { path: '' },
    { callId: 'call-list-2', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /path:/);
});

void test('list_files rejects blank path at the parser boundary', async () => {
  const result = await listFilesTool.execute(
    { path: '   ' },
    { callId: 'call-list-blank-path', computerFileRoot: '/computer' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /path.*empty/);
});

void test('list_files returns entries beyond the old fixed cap', async () => {
  const computerFileRoot = await mkdtemp(join(tmpdir(), 'geulbat-list-tool-'));
  const fileCount = 520;
  await Promise.all(
    Array.from({ length: fileCount }, (_, index) =>
      writeFile(
        join(computerFileRoot, `entry-${String(index).padStart(3, '0')}.txt`),
        'listed\n',
        'utf8',
      ),
    ),
  );

  const result = await listFilesTool.execute(
    {},
    { callId: 'call-list-many', computerFileRoot },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    total: number;
    entries: Array<{ path: string }>;
  };
  assert.equal(payload.total, fileCount);
  assert.equal(payload.entries.length, fileCount);
  assert.equal(
    payload.entries.some((entry) => entry.path === 'entry-519.txt'),
    true,
  );
  assert.equal(Object.hasOwn(payload, 'truncated'), false);
});

void test('list_files infers the computer root for an admitted absolute path', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-list-computer-'),
  );
  const outsideDir = join(computerFileRoot, 'outside');
  await mkdir(outsideDir);
  await writeFile(join(outsideDir, 'hello.txt'), 'hello\n', 'utf8');

  const result = await listFilesTool.execute(
    { path: outsideDir },
    {
      callId: 'call-list-computer-absolute',
      computerFileRoot,
    },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    root: string;
    path: string;
    entries: Array<{ path: string }>;
  };
  assert.equal(payload.root, 'computer');
  assert.equal(payload.path, 'outside');
  assert.deepEqual(
    payload.entries.map((entry) => entry.path),
    ['outside/hello.txt'],
  );
});

void test('list_files resolves relative paths from the current directory', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-list-computer-'),
  );
  await mkdir(join(computerFileRoot, 'downloads'));
  await writeFile(
    join(computerFileRoot, 'downloads', 'note.txt'),
    'note\n',
    'utf8',
  );

  const result = await listFilesTool.execute(
    { path: 'downloads' },
    {
      callId: 'call-list-computer-relative',
      computerFileRoot,
    },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    root: string;
    entries: Array<{ path: string }>;
  };
  assert.equal(payload.root, 'computer');
  assert.deepEqual(
    payload.entries.map((entry) => entry.path),
    ['downloads/note.txt'],
  );
});

void test('list_files traverses outside the coordinate base', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-list-computer-'),
  );
  const outsideRoot = await mkdtemp(join(tmpdir(), 'geulbat-list-outside-'));
  await writeFile(join(outsideRoot, 'note.txt'), 'outside\n', 'utf8');

  const result = await listFilesTool.execute(
    { path: outsideRoot },
    {
      callId: 'call-list-computer-traversal',
      computerFileRoot,
    },
  );

  assert.equal(result.ok, true);
  assert.match(result.output, /note\.txt/u);
});

void test('list_files includes hidden and ignored-looking host entries', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-list-hidden-'),
  );
  await mkdir(join(computerFileRoot, '.git'), { recursive: true });
  await mkdir(join(computerFileRoot, 'node_modules', 'package'), {
    recursive: true,
  });
  await writeFile(join(computerFileRoot, '.env'), 'TOKEN=value\n', 'utf8');
  await writeFile(join(computerFileRoot, '.git', 'config'), '[core]\n', 'utf8');
  await writeFile(
    join(computerFileRoot, 'node_modules', 'package', 'index.js'),
    'export {};\n',
    'utf8',
  );

  const result = await listFilesTool.execute(
    { recursive: true },
    { callId: 'call-list-hidden', computerFileRoot },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    entries: Array<{ path: string }>;
  };
  assert.deepEqual(
    payload.entries.map((entry) => entry.path),
    [
      '.env',
      '.git',
      '.git/config',
      'node_modules',
      'node_modules/package',
      'node_modules/package/index.js',
    ],
  );
});

void test('list_files follows a directory symlink regardless of its target name', async (t) => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-list-computer-'),
  );
  const reservedTarget = join(computerFileRoot, '.geulbat');
  const linkedPath = join(computerFileRoot, 'internal-link');
  await mkdir(reservedTarget);
  await writeFile(join(reservedTarget, 'state.json'), '{}\n', 'utf8');
  if (!(await createSymlinkOrSkip(t, reservedTarget, linkedPath))) {
    return;
  }

  const result = await listFilesTool.execute(
    { path: 'internal-link' },
    {
      callId: 'call-list-computer-reserved-symlink',
      computerFileRoot,
    },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    entries: Array<{ path: string }>;
  };
  assert.deepEqual(
    payload.entries.map((entry) => entry.path),
    ['internal-link/state.json'],
  );
});

void test('list_files rejects the removed legacy root selector', async () => {
  const result = await listFilesTool.execute(
    { root: 'computer', path: 'geulbat-sdk' },
    {
      callId: 'call-list-legacy-root',
      computerFileRoot: '/computer',
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /root/u);
});
