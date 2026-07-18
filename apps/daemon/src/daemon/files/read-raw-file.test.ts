import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createRawFileStream,
  UnsatisfiableRangeError,
} from './read-raw-file.js';

async function readAll(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

void test('createRawFileStream streams the requested byte range', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-raw-'));
  await writeFile(join(root, 'clip.bin'), Buffer.from('0123456789'));
  const result = await createRawFileStream(root, 'clip.bin', {
    start: 2,
    end: 5,
  });
  assert.equal(result.totalSize, 10);
  assert.equal(result.start, 2);
  assert.equal(result.end, 5);
  assert.equal((await readAll(result.stream)).toString('utf8'), '2345');
});

void test('unsatisfiable range carries the real total size', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-raw-'));
  await writeFile(join(root, 'clip.bin'), Buffer.from('0123456789'));
  await assert.rejects(
    createRawFileStream(root, 'clip.bin', { start: 99 }),
    (error: unknown) =>
      error instanceof UnsatisfiableRangeError && error.totalSize === 10,
  );
});
