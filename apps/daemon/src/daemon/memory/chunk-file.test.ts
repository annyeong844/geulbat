import test from 'node:test';
import assert from 'node:assert/strict';

import { createChunkRecords } from './chunk-file.js';

void test('createChunkRecords derives title from first non-empty heading-like line', () => {
  const records = createChunkRecords(
    {
      path: 'docs/sample.md',
      sourceVersionToken: 'token-1',
      updatedAt: '2026-03-25T00:00:00.000Z',
      content: '# Sample title\nhello\nworld\n',
      lines: ['# Sample title', 'hello', 'world'],
    },
    10,
  );

  assert.equal(records.length, 1);
  assert.equal(records[0]?.title, 'Sample title');
  assert.equal(records[0]?.lineStart, 1);
  assert.equal(records[0]?.lineEnd, 3);
});

void test('createChunkRecords caps derived heading titles', () => {
  const heading = 'A'.repeat(150);
  const records = createChunkRecords(
    {
      path: 'docs/long-title.md',
      sourceVersionToken: 'token-title',
      updatedAt: '2026-03-25T00:00:00.000Z',
      content: `# ${heading}\nbody\n`,
      lines: [`# ${heading}`, 'body'],
    },
    10,
  );

  assert.equal(records[0]?.title, 'A'.repeat(120));
});

void test('createChunkRecords respects remaining budget', () => {
  const lines = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`);
  const records = createChunkRecords(
    {
      path: 'docs/large.md',
      sourceVersionToken: 'token-2',
      updatedAt: '2026-03-25T00:00:00.000Z',
      content: `${lines.join('\n')}\n`,
      lines,
    },
    2,
  );

  assert.equal(records.length, 2);
  assert.equal(records[0]?.lineStart, 1);
  assert.equal(records[0]?.lineEnd, 80);
  assert.equal(records[1]?.lineStart, 81);
  assert.equal(records[1]?.lineEnd, 160);
});
