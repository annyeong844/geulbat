import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createSymlinkOrSkip } from '../../test-support/symlink-test.js';
import { listTree } from './list-tree.js';

void test('listTree rejects a missing workspace root', async () => {
  const missingRoot = join(tmpdir(), `geulbat-missing-tree-${Date.now()}`);

  await assert.rejects(() => listTree(missingRoot));
});

void test('listTree hides dotfiles and returns visible entries', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-tree-'));
  await mkdir(join(workspaceRoot, 'docs'), { recursive: true });
  await writeFile(join(workspaceRoot, '.secret'), 'hidden\n', 'utf8');
  await writeFile(join(workspaceRoot, 'hello.txt'), 'hello\n', 'utf8');
  await writeFile(join(workspaceRoot, 'docs', 'note.md'), '# note\n', 'utf8');

  const tree = await listTree(workspaceRoot);

  assert.deepEqual(tree, [
    {
      name: 'docs',
      path: 'docs',
      type: 'directory',
      children: [
        {
          name: 'note.md',
          path: 'docs/note.md',
          type: 'file',
        },
      ],
    },
    {
      name: 'hello.txt',
      path: 'hello.txt',
      type: 'file',
    },
  ]);
});

void test('listTree rejects directory trees deeper than the max depth guard', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-tree-depth-'));

  let current = workspaceRoot;
  for (let depth = 0; depth <= 3; depth += 1) {
    current = join(current, `level-${depth}`);
    await mkdir(current, { recursive: true });
  }

  await assert.rejects(() => listTree(workspaceRoot, { maxDepth: 2 }), {
    code: 'buffer_limit_exceeded',
    message: /max depth 2 exceeded/,
  });
});

void test('listTree rejects trees that exceed the node cap', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-tree-count-'));

  for (let index = 0; index <= 4; index += 1) {
    await writeFile(join(workspaceRoot, `file-${index}.txt`), 'x\n', 'utf8');
  }

  await assert.rejects(() => listTree(workspaceRoot, { maxNodes: 3 }), {
    code: 'buffer_limit_exceeded',
    message: /max nodes 3 exceeded/,
  });
});

void test('listTree has no hidden default depth guard', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-tree-deep-'));

  let current = workspaceRoot;
  for (let depth = 0; depth <= 16; depth += 1) {
    current = join(current, `level-${depth}`);
    await mkdir(current, { recursive: true });
  }
  await writeFile(join(current, 'leaf.txt'), 'x\n', 'utf8');

  const tree = await listTree(workspaceRoot);

  let node = tree[0];
  for (let depth = 0; depth <= 16; depth += 1) {
    assert.equal(node?.name, `level-${depth}`);
    node = node?.children?.[0];
  }
  assert.equal(node?.name, 'leaf.txt');
});

void test('listTree has no hidden default node cap', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-tree-wide-'));

  for (let index = 0; index < 10_005; index += 1) {
    await writeFile(join(workspaceRoot, `file-${index}.txt`), 'x\n', 'utf8');
  }

  const tree = await listTree(workspaceRoot);

  assert.equal(tree.length, 10_005);
});

void test('listTree skips repeated real-directory branches created by symlink cycles', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-tree-cycle-'));
  const docsDir = join(workspaceRoot, 'docs');
  const nestedDir = join(docsDir, 'nested');

  await mkdir(nestedDir, { recursive: true });
  await writeFile(join(docsDir, 'keep.md'), '# keep\n', 'utf8');

  if (!(await createSymlinkOrSkip(t, docsDir, join(nestedDir, 'loop')))) {
    return;
  }

  const tree = await listTree(workspaceRoot);

  assert.deepEqual(tree, [
    {
      name: 'docs',
      path: 'docs',
      type: 'directory',
      children: [
        {
          name: 'keep.md',
          path: 'docs/keep.md',
          type: 'file',
        },
        {
          name: 'nested',
          path: 'docs/nested',
          type: 'directory',
          children: [],
        },
      ],
    },
  ]);
});
