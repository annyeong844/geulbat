import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSymlinkOrSkip } from '../../../test-support/symlink-test.js';
import { isToolObjectParameters } from '../types.js';
import { searchFilesTool } from './search-files.js';

void test('search_files projects parser-owned scalar constraints into tool parameters', () => {
  const parameters = searchFilesTool.parameters;
  assert.ok(isToolObjectParameters(parameters));
  assert.deepEqual(parameters.properties.include, {
    type: 'string',
    maxLength: 256,
    pattern: '^(?!!).*$',
    description: 'Glob pattern to filter which files to search (e.g. "*.ts").',
  });
  assert.equal(parameters.properties.root, undefined);
});

void test('search_files rejects a symlinked path that escapes ComputerFileScope', async (t) => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-computer-'),
  );
  const outsideRoot = await mkdtemp(join(tmpdir(), 'geulbat-search-outside-'));
  const outsideDir = join(outsideRoot, 'outside-dir');
  const linkedDir = join(computerFileRoot, 'linked-dir');

  await mkdir(outsideDir, { recursive: true });
  await writeFile(join(outsideDir, 'secret.txt'), 'hello world\n', 'utf8');
  if (!(await createSymlinkOrSkip(t, outsideDir, linkedDir))) {
    return;
  }

  const result = await searchFilesTool.execute(
    { pattern: 'hello', path: 'linked-dir' },
    { callId: 'call-search-1', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'path_out_of_computer_scope');
  assert.match(result.error ?? '', /linked-dir/);
});

void test('search_files rejects a symlinked path that escapes the computer root', async (t) => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-computer-'),
  );
  const outsideRoot = await mkdtemp(join(tmpdir(), 'geulbat-search-outside-'));
  const linkedDir = join(computerFileRoot, 'linked-dir');

  await writeFile(join(outsideRoot, 'secret.txt'), 'hello world\n', 'utf8');
  if (!(await createSymlinkOrSkip(t, outsideRoot, linkedDir))) {
    return;
  }

  const result = await searchFilesTool.execute(
    { pattern: 'hello', path: 'linked-dir' },
    {
      callId: 'call-search-computer-symlink',
      computerFileRoot,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'path_out_of_computer_scope');
  assert.match(result.error ?? '', /linked-dir/);
});

void test('search_files rejects a safe symlink whose canonical target is reserved', async (t) => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-computer-'),
  );
  const reservedTarget = join(computerFileRoot, '.git');
  const linkedDir = join(computerFileRoot, 'history-link');
  await mkdir(reservedTarget);
  await writeFile(join(reservedTarget, 'config'), 'secret history\n', 'utf8');
  if (!(await createSymlinkOrSkip(t, reservedTarget, linkedDir))) {
    return;
  }

  const result = await searchFilesTool.execute(
    { pattern: 'secret history', path: 'history-link' },
    {
      callId: 'call-search-computer-reserved-symlink',
      computerFileRoot,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'access_denied');
  assert.match(result.error ?? '', /reserved path: \.git/);
});

void test('search_files rejects overly long include globs', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-glob-'),
  );

  const result = await searchFilesTool.execute(
    { pattern: 'hello', include: '*'.repeat(257) },
    { callId: 'call-search-2', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /include glob is too long/);
});

void test('search_files rejects unexpected keys instead of ignoring them', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-extra-'),
  );

  const result = await searchFilesTool.execute(
    { pattern: 'hello', extra: true },
    { callId: 'call-search-extra', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /unexpected keys: extra\./);
});

void test('search_files rejects an empty path instead of treating it as root', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-empty-path-'),
  );

  const result = await searchFilesTool.execute(
    { pattern: 'needle', path: '' },
    { callId: 'call-search-empty-path', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /path.*empty/);
});

void test('search_files rejects blank path at the parser boundary', async () => {
  const result = await searchFilesTool.execute(
    { pattern: 'needle', path: '   ' },
    { callId: 'call-search-blank-path', computerFileRoot: '/computer' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /path.*empty/);
});

void test('search_files rejects include globs starting with ! at the parser boundary', async () => {
  const result = await searchFilesTool.execute(
    { pattern: 'hello', include: '!.git' },
    { callId: 'call-search-negated-glob', computerFileRoot: '/computer' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /must not start with "!"/);
});

void test('search_files rejects non-positive or fractional maxResults at the parser boundary', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-max-results-'),
  );

  for (const maxResults of [0, -1, 1.5]) {
    const result = await searchFilesTool.execute(
      { pattern: 'hello', maxResults },
      { callId: `call-search-max-results-${maxResults}`, computerFileRoot },
    );

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'invalid_args');
    assert.match(result.error ?? '', /maxResults.*positive integer/);
  }
});

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

  const result = await searchFilesTool.execute(
    { pattern: '**/*.md', type: 'filename' },
    { callId: 'call-search-3', computerFileRoot },
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

void test('search_files filename mode treats **/ as matching authority-root files', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-root-filename-'),
  );
  await mkdir(join(computerFileRoot, 'docs'), { recursive: true });
  await writeFile(join(computerFileRoot, 'hello.txt'), 'hello\n', 'utf8');
  await writeFile(join(computerFileRoot, 'docs', 'note.txt'), 'note\n', 'utf8');

  const result = await searchFilesTool.execute(
    { pattern: '**/*.txt', type: 'filename' },
    { callId: 'call-search-root-txt', computerFileRoot },
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

  const result = await searchFilesTool.execute(
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

  const result = await searchFilesTool.execute(
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

void test('search_files content mode uses the bundled ripgrep backend', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-content-'),
  );
  await mkdir(join(computerFileRoot, 'docs'), { recursive: true });
  await writeFile(
    join(computerFileRoot, 'docs', 'note.md'),
    '# note\nhello content search\n',
    'utf8',
  );

  const result = await searchFilesTool.execute(
    { pattern: 'hello content search' },
    { callId: 'call-search-4', computerFileRoot },
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

void test('search_files infers the computer root for an admitted absolute path', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-computer-'),
  );
  const outsideDir = join(computerFileRoot, 'downloads');
  await mkdir(outsideDir);
  await writeFile(
    join(outsideDir, 'note.md'),
    'outside content search\n',
    'utf8',
  );

  const result = await searchFilesTool.execute(
    { pattern: 'outside content search', path: outsideDir },
    {
      callId: 'call-search-computer-absolute',
      computerFileRoot,
    },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    root: string;
    path: string;
    results: Array<{ path: string; line: number; text: string }>;
  };
  assert.equal(payload.root, 'computer');
  assert.equal(payload.path, 'downloads');
  assert.deepEqual(payload.results, [
    {
      path: 'downloads/note.md',
      line: 1,
      text: 'outside content search',
    },
  ]);
});

void test('search_files content mode excludes nested secret configuration files under the computer root', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-computer-'),
  );
  const projectDir = join(computerFileRoot, 'project');
  const nestedDir = join(projectDir, 'nested');
  await mkdir(nestedDir, { recursive: true });
  await writeFile(
    join(projectDir, 'allowed.txt'),
    'computer-secret-marker\n',
    'utf8',
  );
  for (const secretName of [
    '.env',
    '.env.production',
    '.envrc',
    '.npmrc',
    '.yarnrc.yml',
    '.Env',
    '.ENV.Production',
    '.ENVRC',
    '.NPMRC',
    '.YARNRC.YML',
  ]) {
    await writeFile(
      join(nestedDir, secretName),
      'computer-secret-marker\n',
      'utf8',
    );
  }
  await mkdir(join(nestedDir, '.GIT'));
  await writeFile(
    join(nestedDir, '.GIT', 'config'),
    'computer-secret-marker\n',
    'utf8',
  );

  const result = await searchFilesTool.execute(
    {
      pattern: 'computer-secret-marker',
      path: 'project',
      include: '*',
    },
    {
      callId: 'call-search-computer-secret-excludes',
      computerFileRoot,
    },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    total: number;
    results: Array<{ path: string }>;
  };
  assert.equal(payload.total, 1);
  assert.deepEqual(
    payload.results.map((entry) => entry.path),
    ['project/allowed.txt'],
  );
});

void test('search_files content mode returns all matches when maxResults is omitted', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-content-all-'),
  );
  const matchCount = 120;
  await mkdir(join(computerFileRoot, 'docs'), { recursive: true });
  await writeFile(
    join(computerFileRoot, 'docs', 'many.md'),
    Array.from(
      { length: matchCount },
      (_, index) => `needle-all-${index}`,
    ).join('\n') + '\n',
    'utf8',
  );

  const result = await searchFilesTool.execute(
    { pattern: 'needle-all-' },
    { callId: 'call-search-content-all', computerFileRoot },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    total: number;
    truncated: boolean;
    results: Array<{ path: string }>;
  };
  assert.equal(payload.total, matchCount);
  assert.equal(payload.results.length, matchCount);
  assert.equal(payload.truncated, false);
});

void test('search_files content mode keeps accurate totals with explicit maxResults', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-content-limited-'),
  );
  await mkdir(join(computerFileRoot, 'docs'), { recursive: true });
  await writeFile(
    join(computerFileRoot, 'docs', 'many.md'),
    ['limited-needle one', 'limited-needle two', 'limited-needle three'].join(
      '\n',
    ) + '\n',
    'utf8',
  );

  const result = await searchFilesTool.execute(
    { pattern: 'limited-needle', maxResults: 1 },
    { callId: 'call-search-content-limited', computerFileRoot },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    total: number;
    truncated: boolean;
    results: Array<{ path: string }>;
  };
  assert.equal(payload.total, 3);
  assert.equal(payload.results.length, 1);
  assert.equal(payload.truncated, true);
});

void test('search_files content mode preserves full matching line text', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-content-long-line-'),
  );
  await mkdir(join(computerFileRoot, 'docs'), { recursive: true });
  const longLine = `needle-long-line ${'x'.repeat(500)}`;
  await writeFile(
    join(computerFileRoot, 'docs', 'long.md'),
    `${longLine}\n`,
    'utf8',
  );

  const result = await searchFilesTool.execute(
    { pattern: 'needle-long-line' },
    { callId: 'call-search-content-long-line', computerFileRoot },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    results: Array<{ text: string }>;
  };
  assert.equal(payload.results[0]?.text, longLine);
});

void test('search_files content mode treats dash-prefixed patterns as literals', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-dash-pattern-'),
  );
  await mkdir(join(computerFileRoot, 'docs'), { recursive: true });
  await writeFile(
    join(computerFileRoot, 'docs', 'dash.md'),
    '# dash\n--literal-needle\n',
    'utf8',
  );

  const result = await searchFilesTool.execute(
    { pattern: '--literal-needle' },
    { callId: 'call-search-dash-pattern', computerFileRoot },
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
    { path: 'docs/dash.md', line: 2, text: '--literal-needle' },
  ]);
});

void test('search_files rejects the removed legacy root selector', async () => {
  const result = await searchFilesTool.execute(
    { root: 'workspace', pattern: 'read_file', path: 'geulbat-sdk' },
    { callId: 'call-search-legacy-root', computerFileRoot: '/computer' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /root/u);
});
