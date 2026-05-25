import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileAccessError } from './file-domain-error.js';
import { readFile } from './read-file.js';
import { PathEscapeError } from './normalize-path.js';
import type { FileStateCache } from '../utils/file-state-cache.js';

void test('readFile blocks reserved .env files', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-'));
  await writeFile(join(workspaceRoot, '.env'), 'SECRET=1\n', 'utf8');

  await assert.rejects(
    () => readFile(workspaceRoot, '.env'),
    (error: unknown) =>
      error instanceof FileAccessError && error.code === 'access_denied',
  );
});

void test('readFile blocks workspace escape paths', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-'));
  await mkdir(join(workspaceRoot, 'docs'), { recursive: true });
  await writeFile(join(workspaceRoot, 'docs', 'sample.md'), '# ok\n', 'utf8');

  await assert.rejects(
    () => readFile(workspaceRoot, '../../etc/passwd'),
    (error: unknown) => error instanceof PathEscapeError,
  );
});

void test('readFile rejects Windows-form absolute paths outside the workspace drive', async () => {
  await assert.rejects(
    () => readFile('C:\\workspace', 'D:\\secrets\\file.txt'),
    (error: unknown) => error instanceof PathEscapeError,
  );
});

void test('readFile returns canonical full-file metadata', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-'));
  await writeFile(join(workspaceRoot, 'hello.txt'), 'line 1\nline 2\n', 'utf8');

  const result = await readFile(workspaceRoot, 'hello.txt');

  assert.equal(result.path, 'hello.txt');
  assert.equal(result.totalLines, 2);
  assert.equal(result.startLine, 1);
  assert.equal(result.endLine, 2);
  assert.equal(result.truncated, false);
});

void test('readFile delegates resolved source reads to the injected file state cache', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-cache-'));
  const absolutePath = join(workspaceRoot, 'hello.txt');
  await writeFile(absolutePath, 'cached\n', 'utf8');
  let loadCount = 0;
  let cachedContent: string | null = null;
  let observedPath: string | null = null;

  const fileStateCache: FileStateCache = {
    async read(path, loadContent) {
      observedPath = path;
      if (cachedContent === null) {
        loadCount += 1;
        cachedContent = await loadContent(path);
      }
      return cachedContent;
    },
    async invalidatePath() {},
    invalidateCacheKey() {},
    clear() {},
    getStats() {
      return {
        entryCount: cachedContent === null ? 0 : 1,
        totalBytes:
          cachedContent === null ? 0 : Buffer.byteLength(cachedContent),
        maxEntries: 100,
        maxTotalBytes: 25 * 1024 * 1024,
      };
    },
  };

  const first = await readFile(workspaceRoot, 'hello.txt', { fileStateCache });
  await writeFile(absolutePath, 'changed\n', 'utf8');
  const second = await readFile(workspaceRoot, 'hello.txt', { fileStateCache });

  assert.equal(observedPath, absolutePath);
  assert.equal(loadCount, 1);
  assert.equal(first.content, 'cached\n');
  assert.equal(second.content, 'cached\n');
});

void test('readFile not_found errors include the normalized path', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-'));

  await assert.rejects(
    () => readFile(workspaceRoot, 'missing.txt'),
    (error: unknown) => {
      const candidate = error as { code?: string; path?: string };
      assert.equal(candidate.code, 'not_found');
      assert.equal(candidate.path, 'missing.txt');
      return true;
    },
  );
});
