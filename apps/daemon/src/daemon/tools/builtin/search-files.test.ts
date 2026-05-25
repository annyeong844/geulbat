import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSymlinkOrSkip } from '../../../test-support/symlink-test.js';
import { searchFilesTool } from './search-files.js';

void test('search_files rejects a symlinked root path that escapes the workspace', async (t) => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-workspace-'),
  );
  const outsideRoot = await mkdtemp(join(tmpdir(), 'geulbat-search-outside-'));
  const outsideDir = join(outsideRoot, 'outside-dir');
  const linkedDir = join(workspaceRoot, 'linked-dir');

  await mkdir(outsideDir, { recursive: true });
  await writeFile(join(outsideDir, 'secret.txt'), 'hello world\n', 'utf8');
  if (!(await createSymlinkOrSkip(t, outsideDir, linkedDir))) {
    return;
  }

  const result = await searchFilesTool.execute(
    { pattern: 'hello', path: 'linked-dir' },
    { callId: 'call-search-1', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'path_out_of_workspace');
  assert.match(result.error ?? '', /linked-dir/);
});

void test('search_files rejects overly long include globs', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-search-glob-'));

  const result = await searchFilesTool.execute(
    { pattern: 'hello', include: '*'.repeat(257) },
    { callId: 'call-search-2', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /include glob is too long/);
});

void test('search_files rejects unexpected keys instead of ignoring them', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-search-extra-'));

  const result = await searchFilesTool.execute(
    { pattern: 'hello', extra: true },
    { callId: 'call-search-extra', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /unexpected keys: extra\./);
});

void test('search_files rejects include globs starting with !', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-negated-glob-'),
  );

  const result = await searchFilesTool.execute(
    { pattern: 'hello', include: '!.git' },
    { callId: 'call-search-2b', workspaceRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /must not start with "!"/);
});

void test('search_files supports filename mode', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-filename-'),
  );
  await mkdir(join(workspaceRoot, 'docs'), { recursive: true });
  await writeFile(join(workspaceRoot, 'hello.txt'), 'hello\n', 'utf8');
  await writeFile(join(workspaceRoot, 'docs', 'note.md'), '# note\n', 'utf8');

  const result = await searchFilesTool.execute(
    { pattern: '**/*.md', type: 'filename' },
    { callId: 'call-search-3', workspaceRoot },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    backend: string;
    total: number;
    results: Array<{ path: string; line: number; text: string }>;
  };

  assert.equal(payload.backend, 'js-filename');
  assert.equal(payload.total, 1);
  assert.deepEqual(payload.results, [
    { path: 'docs/note.md', line: 0, text: '' },
  ]);
});

void test('search_files filename mode treats **/ as matching workspace-root files', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-root-filename-'),
  );
  await mkdir(join(workspaceRoot, 'docs'), { recursive: true });
  await writeFile(join(workspaceRoot, 'hello.txt'), 'hello\n', 'utf8');
  await writeFile(join(workspaceRoot, 'docs', 'note.txt'), 'note\n', 'utf8');

  const result = await searchFilesTool.execute(
    { pattern: '**/*.txt', type: 'filename' },
    { callId: 'call-search-root-txt', workspaceRoot },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    backend: string;
    total: number;
    results: Array<{ path: string; line: number; text: string }>;
  };

  assert.equal(payload.backend, 'js-filename');
  assert.equal(payload.total, 2);
  assert.deepEqual(payload.results, [
    { path: 'docs/note.txt', line: 0, text: '' },
    { path: 'hello.txt', line: 0, text: '' },
  ]);
});

void test('search_files content mode uses the bundled ripgrep backend', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-content-'),
  );
  await mkdir(join(workspaceRoot, 'docs'), { recursive: true });
  await writeFile(
    join(workspaceRoot, 'docs', 'note.md'),
    '# note\nhello content search\n',
    'utf8',
  );

  const result = await searchFilesTool.execute(
    { pattern: 'hello content search' },
    { callId: 'call-search-4', workspaceRoot },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    backend: string;
    total: number;
    results: Array<{ path: string; line: number; text: string }>;
  };

  assert.equal(payload.backend, 'ripgrep');
  assert.equal(payload.total, 1);
  assert.deepEqual(payload.results, [
    { path: 'docs/note.md', line: 2, text: 'hello content search' },
  ]);
});
