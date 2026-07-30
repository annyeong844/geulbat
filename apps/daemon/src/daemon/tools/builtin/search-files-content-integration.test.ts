import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeSearchFiles } from '../../../test-support/search-files-test-support.js';

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

  const result = await executeSearchFiles(
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
    {
      path: 'docs/note.md',
      line: 2,
      text: 'hello content search',
      textBytes: 20,
    },
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

  const result = await executeSearchFiles(
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
      textBytes: 22,
    },
  ]);
});

void test('search_files accepts a local WSL UNC alias for a host directory', async (t) => {
  const previousDistroName = process.env.WSL_DISTRO_NAME;
  t.after(() => {
    if (previousDistroName === undefined) {
      delete process.env.WSL_DISTRO_NAME;
    } else {
      process.env.WSL_DISTRO_NAME = previousDistroName;
    }
  });
  process.env.WSL_DISTRO_NAME = 'GeulbatTest';

  const searchDirectory = await mkdtemp(
    join(tmpdir(), 'geulbat-search-computer-'),
  );
  const uncPath = `\\\\wsl.localhost\\GeulbatTest${searchDirectory.replaceAll('/', '\\')}`;
  await writeFile(join(searchDirectory, 'unc-note.md'), 'unc search\n', 'utf8');

  const result = await executeSearchFiles(
    {
      pattern: '**/unc-note.md',
      path: uncPath,
      type: 'filename',
      maxResults: 50,
    },
    {
      callId: 'call-search-computer-wsl-unc',
      computerFileRoot: '/',
    },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    root: string;
    path: string;
    results: Array<{ path: string }>;
  };
  const relativeSearchDirectory = searchDirectory.slice(1);
  assert.equal(payload.root, 'computer');
  assert.equal(payload.path, relativeSearchDirectory);
  assert.deepEqual(
    payload.results.map((entry) => entry.path),
    [`${relativeSearchDirectory}/unc-note.md`],
  );
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

  const result = await executeSearchFiles(
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

void test('search_files content mode respects ignore files unless explicitly included', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-content-ignore-'),
  );
  await mkdir(join(computerFileRoot, '.git'));
  await mkdir(join(computerFileRoot, 'ignored'));
  await writeFile(join(computerFileRoot, '.gitignore'), 'ignored/\n', 'utf8');
  await writeFile(
    join(computerFileRoot, '.visible-config'),
    'ignore-policy-marker\n',
    'utf8',
  );
  await writeFile(
    join(computerFileRoot, 'ignored', 'generated.txt'),
    'ignore-policy-marker\n',
    'utf8',
  );

  const defaultResult = await executeSearchFiles(
    { pattern: 'ignore-policy-marker' },
    { callId: 'call-search-content-ignore-default', computerFileRoot },
  );
  const ignoredResult = await executeSearchFiles(
    { pattern: 'ignore-policy-marker', includeIgnored: true },
    { callId: 'call-search-content-ignore-explicit', computerFileRoot },
  );

  assert.equal(defaultResult.ok, true);
  assert.deepEqual(
    (
      JSON.parse(defaultResult.output) as {
        results: Array<{ path: string }>;
      }
    ).results.map((entry) => entry.path),
    ['.visible-config'],
  );
  assert.equal(ignoredResult.ok, true);
  assert.deepEqual(
    (
      JSON.parse(ignoredResult.output) as {
        results: Array<{ path: string }>;
      }
    ).results
      .map((entry) => entry.path)
      .sort(),
    ['.visible-config', 'ignored/generated.txt'],
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

  const result = await executeSearchFiles(
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

  const result = await executeSearchFiles(
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

  const result = await executeSearchFiles(
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

  const result = await executeSearchFiles(
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

  const result = await executeSearchFiles(
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
    { path: 'docs/dash.md', line: 2, text: '--literal-needle', textBytes: 16 },
  ]);
});
