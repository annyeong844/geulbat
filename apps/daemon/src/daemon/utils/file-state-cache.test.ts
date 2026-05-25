import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFileStateCache } from './file-state-cache.js';

void test('file state cache reuses content while the canonical file mtime is unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-file-state-cache-'));
  const target = join(root, 'chapter.md');
  await writeFile(target, 'first draft\n', 'utf8');
  const cache = createFileStateCache();
  let loadCount = 0;

  const load = async (canonicalAbsolutePath: string): Promise<string> => {
    loadCount += 1;
    return readFile(canonicalAbsolutePath, 'utf8');
  };

  assert.equal(await cache.read(target, load), 'first draft\n');
  assert.equal(await cache.read(target, load), 'first draft\n');
  assert.equal(loadCount, 1);
  assert.deepEqual(cache.getStats(), {
    entryCount: 1,
    totalBytes: Buffer.byteLength('first draft\n'),
    maxEntries: 100,
    maxTotalBytes: 25 * 1024 * 1024,
  });
});

void test('file state cache uses realpath keys for equivalent paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-file-state-cache-'));
  const target = join(root, 'chapter.md');
  const alias = join(root, 'alias.md');
  await writeFile(target, 'chapter via alias\n', 'utf8');

  try {
    await symlink(target, alias);
  } catch (error: unknown) {
    if (process.platform === 'win32') {
      return;
    }
    throw error;
  }

  const cache = createFileStateCache();
  let loadCount = 0;
  const load = async (canonicalAbsolutePath: string): Promise<string> => {
    loadCount += 1;
    return readFile(canonicalAbsolutePath, 'utf8');
  };

  assert.equal(await cache.read(target, load), 'chapter via alias\n');
  assert.equal(await cache.read(alias, load), 'chapter via alias\n');
  assert.equal(loadCount, 1);
});

void test('file state cache reloads when mtime changes and after manual invalidation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-file-state-cache-'));
  const target = join(root, 'notes.md');
  await writeFile(target, 'old\n', 'utf8');
  const cache = createFileStateCache();
  let loadCount = 0;
  const load = async (canonicalAbsolutePath: string): Promise<string> => {
    loadCount += 1;
    return readFile(canonicalAbsolutePath, 'utf8');
  };

  assert.equal(await cache.read(target, load), 'old\n');
  await writeFile(target, 'new\n', 'utf8');
  await utimes(
    target,
    new Date('2030-01-01T00:00:00Z'),
    new Date('2030-01-01T00:00:00Z'),
  );

  assert.equal(await cache.read(target, load), 'new\n');
  await cache.invalidatePath(target);
  assert.equal(await cache.read(target, load), 'new\n');
  assert.equal(loadCount, 3);
});

void test('file state cache evicts least recently used entries by entry and byte limits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-file-state-cache-'));
  const first = join(root, 'first.txt');
  const second = join(root, 'second.txt');
  const third = join(root, 'third.txt');
  await writeFile(first, '1111', 'utf8');
  await writeFile(second, '2222', 'utf8');
  await writeFile(third, '3333', 'utf8');
  const cache = createFileStateCache({ maxEntries: 2, maxTotalBytes: 8 });
  let loadCount = 0;
  const load = async (canonicalAbsolutePath: string): Promise<string> => {
    loadCount += 1;
    return readFile(canonicalAbsolutePath, 'utf8');
  };

  assert.equal(await cache.read(first, load), '1111');
  assert.equal(await cache.read(second, load), '2222');
  assert.equal(await cache.read(first, load), '1111');
  assert.equal(await cache.read(third, load), '3333');
  assert.equal(cache.getStats().entryCount, 2);

  assert.equal(await cache.read(second, load), '2222');
  assert.equal(loadCount, 4);
});

void test('file state cache skips entries larger than the byte limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-file-state-cache-'));
  const target = join(root, 'large.txt');
  await writeFile(target, 'larger-than-limit', 'utf8');
  const cache = createFileStateCache({ maxEntries: 10, maxTotalBytes: 4 });

  assert.equal(
    await cache.read(target, (canonicalAbsolutePath) =>
      readFile(canonicalAbsolutePath, 'utf8'),
    ),
    'larger-than-limit',
  );
  assert.equal(cache.getStats().entryCount, 0);
});
