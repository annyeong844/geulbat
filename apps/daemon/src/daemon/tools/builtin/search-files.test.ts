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
    description:
      'Glob pattern to include files (e.g. "*.ts") or exclude them with a leading "!" (e.g. "!**/*.test.ts").',
  });
  assert.equal(parameters.properties.root, undefined);
});

void test('search_files follows a directory symlink anywhere on the host filesystem', async (t) => {
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

  assert.equal(result.ok, true);
  assert.match(result.output, /secret\.txt/u);
  assert.match(result.output, /hello world/u);
});

void test('search_files follows a directory symlink regardless of its target name', async (t) => {
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

  assert.equal(result.ok, true);
  assert.match(result.output, /config/u);
  assert.match(result.output, /secret history/u);
});

void test('search_files follows directory symlinks nested below the selected root', async (t) => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-computer-'),
  );
  const outsideRoot = await mkdtemp(join(tmpdir(), 'geulbat-search-outside-'));
  const linkedDir = join(computerFileRoot, 'linked-external');
  await writeFile(
    join(outsideRoot, 'needle.txt'),
    'nested-symlink-marker\n',
    'utf8',
  );
  if (!(await createSymlinkOrSkip(t, outsideRoot, linkedDir))) {
    return;
  }

  const contentResult = await searchFilesTool.execute(
    { pattern: 'nested-symlink-marker' },
    { callId: 'call-search-nested-symlink-content', computerFileRoot },
  );
  const filenameResult = await searchFilesTool.execute(
    { pattern: '**/needle.txt', type: 'filename' },
    { callId: 'call-search-nested-symlink-filename', computerFileRoot },
  );

  assert.equal(contentResult.ok, true);
  assert.deepEqual(
    (
      JSON.parse(contentResult.output) as {
        results: Array<{ path: string }>;
      }
    ).results.map((entry) => entry.path),
    ['linked-external/needle.txt'],
  );
  assert.equal(filenameResult.ok, true);
  assert.deepEqual(
    (
      JSON.parse(filenameResult.output) as {
        results: Array<{ path: string }>;
      }
    ).results.map((entry) => entry.path),
    ['linked-external/needle.txt'],
  );
});

void test('search_files stops symlink cycles without losing reachable matches', async (t) => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-cycle-'),
  );
  const docsDir = join(computerFileRoot, 'docs');
  const nestedDir = join(docsDir, 'nested');
  await mkdir(nestedDir, { recursive: true });
  await writeFile(join(docsDir, 'needle.txt'), 'cycle-safe-marker\n', 'utf8');
  if (!(await createSymlinkOrSkip(t, docsDir, join(nestedDir, 'loop')))) {
    return;
  }

  const contentResult = await searchFilesTool.execute(
    { pattern: 'cycle-safe-marker' },
    { callId: 'call-search-cycle-content', computerFileRoot },
  );
  const filenameResult = await searchFilesTool.execute(
    { pattern: '**/needle.txt', type: 'filename' },
    { callId: 'call-search-cycle-filename', computerFileRoot },
  );

  assert.equal(contentResult.ok, true);
  assert.deepEqual(
    (
      JSON.parse(contentResult.output) as {
        results: Array<{ path: string }>;
      }
    ).results.map((entry) => entry.path),
    ['docs/needle.txt'],
  );
  assert.equal(filenameResult.ok, true);
  assert.deepEqual(
    (
      JSON.parse(filenameResult.output) as {
        results: Array<{ path: string }>;
      }
    ).results.map((entry) => entry.path),
    ['docs/needle.txt'],
  );
});

void test('search_files accepts a valid include glob longer than 256 characters', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-glob-'),
  );
  const segments = Array.from(
    { length: 30 },
    (_, index) => `segment-${String(index).padStart(2, '0')}`,
  );
  const relativePath = [...segments, 'needle.txt'].join('/');
  assert.ok(relativePath.length > 256);
  await mkdir(join(computerFileRoot, ...segments), { recursive: true });
  await writeFile(
    join(computerFileRoot, ...segments, 'needle.txt'),
    'long-glob-marker\n',
    'utf8',
  );

  const result = await searchFilesTool.execute(
    {
      pattern: '**/needle.txt',
      type: 'filename',
      include: relativePath,
    },
    { callId: 'call-search-2', computerFileRoot },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    results: Array<{ path: string }>;
  };
  assert.deepEqual(
    payload.results.map((entry) => entry.path),
    [relativePath],
  );
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

void test('search_files applies a leading ! include glob as an exclusion', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-negated-glob-'),
  );
  await mkdir(join(computerFileRoot, 'src'), { recursive: true });
  await writeFile(
    join(computerFileRoot, 'src', 'product.ts'),
    'negated-glob-marker\n',
    'utf8',
  );
  await writeFile(
    join(computerFileRoot, 'src', 'product.test.ts'),
    'negated-glob-marker\n',
    'utf8',
  );

  for (const [callId, args] of [
    [
      'call-search-negated-glob-content',
      {
        pattern: 'negated-glob-marker',
        include: '!**/*.test.ts',
      },
    ],
    [
      'call-search-negated-glob-filename',
      {
        pattern: '**/*.ts',
        include: '!**/*.test.ts',
        type: 'filename' as const,
      },
    ],
  ] as const) {
    const result = await searchFilesTool.execute(args, {
      callId,
      computerFileRoot,
    });

    assert.equal(result.ok, true);
    const payload = JSON.parse(result.output) as {
      results: Array<{ path: string }>;
    };
    assert.deepEqual(
      payload.results.map((entry) => entry.path),
      ['src/product.ts'],
    );
  }
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

  assert.equal(payload.backend, 'ripgrep-files');
  assert.equal(payload.total, 1);
  assert.deepEqual(payload.results, [
    { path: 'docs/note.md', line: 0, text: '' },
  ]);
});

void test('search_files filename mode includes hidden and ignored-looking paths', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-hidden-filename-'),
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

  const result = await searchFilesTool.execute(
    { pattern: '**/*', type: 'filename' },
    { callId: 'call-search-hidden-filename', computerFileRoot },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    results: Array<{ path: string }>;
  };
  assert.deepEqual(
    payload.results.map((entry) => entry.path),
    ['.env', '.git/config', 'node_modules/package/index.js'],
  );
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

void test('search_files content mode includes hidden configuration files under the selected root', async () => {
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
  const paths = payload.results.map((entry) => entry.path);
  assert.equal(payload.total, 12);
  assert.equal(paths.includes('project/allowed.txt'), true);
  assert.equal(paths.includes('project/nested/.env'), true);
  assert.equal(paths.includes('project/nested/.env.production'), true);
  assert.equal(paths.includes('project/nested/.GIT/config'), true);
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

void test('search_files content mode evaluates the documented regular expression', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-content-regex-'),
  );
  await mkdir(join(computerFileRoot, 'docs'), { recursive: true });
  await writeFile(
    join(computerFileRoot, 'docs', 'regex.md'),
    ['regex-one', 'regex-two', 'regex-three'].join('\n') + '\n',
    'utf8',
  );

  const result = await searchFilesTool.execute(
    { pattern: 'regex-(one|two)' },
    { callId: 'call-search-content-regex', computerFileRoot },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    total: number;
    results: Array<{ text: string }>;
  };
  assert.equal(payload.total, 2);
  assert.deepEqual(
    payload.results.map((entry) => entry.text),
    ['regex-one', 'regex-two'],
  );
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
