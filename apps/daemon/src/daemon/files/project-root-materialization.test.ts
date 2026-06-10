import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { ProjectId } from '@geulbat/protocol/ids';
import { ensureProjectRootDirectory } from './project-root-materialization.js';

async function withTempRoot(
  prefix: string,
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function projectId(value: string): ProjectId {
  return value as ProjectId;
}

void test('ensureProjectRootDirectory creates a missing project root under the registry root', async () => {
  await withTempRoot('geulbat-project-root-create-', async (root) => {
    const id = projectId('alpha-route');

    await ensureProjectRootDirectory({
      projectId: id,
      projectRegistryRoot: root,
      resolveProjectRoot: () => null,
    });

    assert.equal((await stat(join(root, id))).isDirectory(), true);
  });
});

void test('ensureProjectRootDirectory keeps existing project directories intact', async () => {
  await withTempRoot('geulbat-project-root-existing-', async (root) => {
    const id = projectId('existing-route');
    const projectRoot = join(root, id);
    await ensureProjectRootDirectory({
      projectId: id,
      projectRegistryRoot: root,
      resolveProjectRoot: () => null,
    });
    await writeFile(join(projectRoot, 'note.txt'), 'keep me\n', 'utf8');

    await ensureProjectRootDirectory({
      projectId: id,
      projectRegistryRoot: root,
      resolveProjectRoot: () => null,
    });

    assert.equal(
      await readFile(join(projectRoot, 'note.txt'), 'utf8'),
      'keep me\n',
    );
  });
});

void test('ensureProjectRootDirectory fails closed when the project root path is a file', async () => {
  await withTempRoot('geulbat-project-root-file-', async (root) => {
    const id = projectId('file-route');
    const filePath = join(root, id);
    await writeFile(filePath, 'not a directory\n', 'utf8');

    await assert.rejects(
      () =>
        ensureProjectRootDirectory({
          projectId: id,
          projectRegistryRoot: root,
          resolveProjectRoot: () => null,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          `project root already exists as a file: ${filePath}`,
        );
        assert.equal((error as { code?: unknown }).code, 'already_exists');
        return true;
      },
    );
  });
});
