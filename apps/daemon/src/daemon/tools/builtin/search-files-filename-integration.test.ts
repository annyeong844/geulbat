import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeSearchFiles } from '../../../test-support/search-files-test-support.js';

void test('search_files supports filename mode', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-filename-'),
  );
  await mkdir(join(computerFileRoot, 'docs'), { recursive: true });
  await writeFile(join(computerFileRoot, 'hello.txt'), 'hello\n', 'utf8');
  await writeFile(
    join(computerFileRoot, 'docs', 'note.md'),
    '# note\n',
    'utf8',
  );

  const result = await executeSearchFiles(
    { pattern: '**/*.md', type: 'filename' },
    { callId: 'call-search-3', computerFileRoot },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    backend: string;
    total: number;
    results: Array<{ path: string; line: number; text: string }>;
  };

  assert.equal(payload.backend, 'ripgrep-files');
  assert.equal(payload.total, 1);
  assert.deepEqual(payload.results, [
    { path: 'docs/note.md', line: 0, text: '' },
  ]);
});

void test('search_files filename mode respects ignore files unless explicitly included', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-hidden-filename-'),
  );
  await mkdir(join(computerFileRoot, '.git'), { recursive: true });
  await mkdir(join(computerFileRoot, 'node_modules', 'package'), {
    recursive: true,
  });
  await writeFile(join(computerFileRoot, '.env'), 'TOKEN=value\n', 'utf8');
  await writeFile(
    join(computerFileRoot, '.gitignore'),
    'node_modules/\n',
    'utf8',
  );
  await writeFile(join(computerFileRoot, '.git', 'config'), '[core]\n', 'utf8');
  await writeFile(
    join(computerFileRoot, 'node_modules', 'package', 'index.js'),
    'export {};\n',
    'utf8',
  );

  const defaultResult = await executeSearchFiles(
    { pattern: '**/*', type: 'filename' },
    { callId: 'call-search-hidden-filename', computerFileRoot },
  );
  const ignoredResult = await executeSearchFiles(
    { pattern: '**/*', type: 'filename', includeIgnored: true },
    { callId: 'call-search-ignored-filename', computerFileRoot },
  );

  assert.equal(defaultResult.ok, true);
  const defaultPayload = JSON.parse(defaultResult.output) as {
    results: Array<{ path: string }>;
  };
  assert.deepEqual(
    defaultPayload.results.map((entry) => entry.path),
    ['.env', '.git/config', '.gitignore'],
  );

  assert.equal(ignoredResult.ok, true);
  const ignoredPayload = JSON.parse(ignoredResult.output) as {
    results: Array<{ path: string }>;
  };
  assert.deepEqual(
    ignoredPayload.results.map((entry) => entry.path),
    ['.env', '.git/config', '.gitignore', 'node_modules/package/index.js'],
  );
});

void test('search_files filename mode treats **/ as matching authority-root files', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-root-filename-'),
  );
  await mkdir(join(computerFileRoot, 'docs'), { recursive: true });
  await writeFile(join(computerFileRoot, 'hello.txt'), 'hello\n', 'utf8');
  await writeFile(join(computerFileRoot, 'docs', 'note.txt'), 'note\n', 'utf8');

  const result = await executeSearchFiles(
    { pattern: '**/*.txt', type: 'filename' },
    { callId: 'call-search-root-txt', computerFileRoot },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    backend: string;
    total: number;
    results: Array<{ path: string; line: number; text: string }>;
  };

  assert.equal(payload.backend, 'ripgrep-files');
  assert.equal(payload.total, 2);
  assert.deepEqual(payload.results, [
    { path: 'docs/note.txt', line: 0, text: '' },
    { path: 'hello.txt', line: 0, text: '' },
  ]);
});

void test('search_files filename mode returns all matches when maxResults is omitted', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-filename-all-'),
  );
  const fileCount = 120;
  await Promise.all(
    Array.from({ length: fileCount }, (_, index) =>
      writeFile(
        join(computerFileRoot, `needle-${String(index).padStart(3, '0')}.txt`),
        'filename match\n',
        'utf8',
      ),
    ),
  );

  const result = await executeSearchFiles(
    { pattern: 'needle-*.txt', type: 'filename' },
    { callId: 'call-search-filename-all', computerFileRoot },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    total: number;
    truncated: boolean;
    results: Array<{ path: string }>;
  };
  assert.equal(payload.total, fileCount);
  assert.equal(payload.results.length, fileCount);
  assert.equal(payload.truncated, false);
});

void test('search_files filename mode keeps accurate totals with explicit maxResults', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-filename-limited-'),
  );
  const fileCount = 5;
  await Promise.all(
    Array.from({ length: fileCount }, (_, index) =>
      writeFile(
        join(computerFileRoot, `limited-${String(index).padStart(2, '0')}.txt`),
        'filename match\n',
        'utf8',
      ),
    ),
  );

  const result = await executeSearchFiles(
    { pattern: 'limited-*.txt', type: 'filename', maxResults: 2 },
    { callId: 'call-search-filename-limited', computerFileRoot },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    total: number;
    truncated: boolean;
    results: Array<{ path: string }>;
  };
  assert.equal(payload.total, fileCount);
  assert.equal(payload.results.length, 2);
  assert.equal(payload.truncated, true);
});
