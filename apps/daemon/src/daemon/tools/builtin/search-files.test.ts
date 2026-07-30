import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSymlinkOrSkip } from '../../../test-support/symlink-test.js';
import { executeSearchFiles } from '../../../test-support/search-files-test-support.js';
import { isToolObjectParameters } from '../types.js';
import { searchFilesTool } from './search-files.js';

void test('search_files projects parser-owned scalar constraints into tool parameters', () => {
  const parameters = searchFilesTool.parameters;
  assert.ok(isToolObjectParameters(parameters));
  assert.equal(searchFilesTool.recoveryStrategy, 'replay_safe');
  assert.deepEqual(parameters.properties.include, {
    type: 'string',
    description:
      'Glob pattern to include files (e.g. "*.ts") or exclude them with a leading "!" (e.g. "!**/*.test.ts").',
  });
  assert.deepEqual(parameters.properties.consistency, {
    type: 'string',
    enum: ['filesystem_snapshot', 'eventual_index'],
    description:
      'Filename-search consistency. The default filesystem_snapshot scans the exposed filesystem for an exact total. eventual_index performs fast bounded basename-glob discovery through Windows Search, requires maxResults, and may omit new or unindexed files.',
  });
  assert.deepEqual(parameters.properties.includeIgnored, {
    type: 'boolean',
    description:
      'Whether to include paths excluded by ignore files such as .gitignore. Defaults to false; hidden paths remain searchable.',
  });
  assert.equal(parameters.properties.root, undefined);
});

void test('search_files fails closed without the daemon host command runtime', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-no-host-runtime-'),
  );
  await writeFile(join(computerFileRoot, 'needle.txt'), 'needle\n', 'utf8');

  const result = await searchFilesTool.execute(
    { pattern: 'needle' },
    {
      callId: 'call-search-no-host-runtime',
      computerFileRoot,
      stateRoot: computerFileRoot,
      workingDirectory: '',
    },
  );

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /requires the daemon host command runtime/u);
});

void test('search_files preserves the content-scan reason and retry guidance', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-invalid-pattern-'),
  );
  await writeFile(join(computerFileRoot, 'needle.txt'), 'needle\n', 'utf8');

  const result = await executeSearchFiles(
    { pattern: '[' },
    {
      callId: 'call-search-invalid-pattern',
      computerFileRoot,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'execution_failed');
  assert.match(result.error ?? '', /ripgrep error/u);
  assert.deepEqual(result.ok ? undefined : result.diagnostics, {
    phase: 'content_scan',
    reasonCode: 'ripgrep_exit_nonzero',
    retryHint:
      'Review the ripgrep diagnostic, then correct the pattern, include glob, or filesystem access before retrying.',
  });
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

  const result = await executeSearchFiles(
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

  const result = await executeSearchFiles(
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

  const contentResult = await executeSearchFiles(
    { pattern: 'nested-symlink-marker' },
    { callId: 'call-search-nested-symlink-content', computerFileRoot },
  );
  const filenameResult = await executeSearchFiles(
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

  const contentResult = await executeSearchFiles(
    { pattern: 'cycle-safe-marker' },
    { callId: 'call-search-cycle-content', computerFileRoot },
  );
  const filenameResult = await executeSearchFiles(
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

  const result = await executeSearchFiles(
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

  const result = await executeSearchFiles(
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

  const result = await executeSearchFiles(
    { pattern: 'needle', path: '' },
    { callId: 'call-search-empty-path', computerFileRoot },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /path.*empty/);
});

void test('search_files rejects blank path at the parser boundary', async () => {
  const result = await executeSearchFiles(
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
    const result = await executeSearchFiles(args, {
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
    const result = await executeSearchFiles(
      { pattern: 'hello', maxResults },
      { callId: `call-search-max-results-${maxResults}`, computerFileRoot },
    );

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'invalid_args');
    assert.match(result.error ?? '', /maxResults.*positive integer/);
  }
});

void test('search_files requires an explicit bounded filename request for eventual-index consistency', async () => {
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-index-contract-'),
  );

  for (const [callId, args, message] of [
    [
      'call-search-index-content',
      { pattern: 'geulbat', consistency: 'eventual_index' as const },
      /eventual_index.*filename/u,
    ],
    [
      'call-search-index-unbounded',
      {
        pattern: '*geulbat*',
        type: 'filename' as const,
        consistency: 'eventual_index' as const,
      },
      /eventual_index.*maxResults/u,
    ],
    [
      'call-search-index-include',
      {
        pattern: '*geulbat*',
        type: 'filename' as const,
        consistency: 'eventual_index' as const,
        maxResults: 50,
        include: '**/*.json',
      },
      /eventual_index.*include/u,
    ],
  ] as const) {
    const result = await executeSearchFiles(args, {
      callId,
      computerFileRoot,
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'invalid_args');
    assert.match(result.error ?? '', message);
  }
});

void test('search_files rejects the removed legacy root selector', async () => {
  const result = await executeSearchFiles(
    { root: 'workspace', pattern: 'read_file', path: 'geulbat-sdk' },
    { callId: 'call-search-legacy-root', computerFileRoot: '/computer' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /root/u);
});
