import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ThreadId } from '@geulbat/protocol/ids';

import {
  enumerateCanonicalChildren,
  resolveDerivedArtifactTarget,
  resolveExplicitExportTarget,
  resolveRuntimeStateTarget,
  resolveSourceDirectoryTarget,
  resolveSourceMutationTarget,
  resolveSourceReadTarget,
} from './file-platform.js';
import { PathEscapeError } from './normalize-path.js';
import { createSymlinkOrSkip } from '../../test-support/symlink-test.js';

const THREAD_ID = '00000000-0000-4000-8000-000000000001' as ThreadId;

void test('resolveSourceReadTarget follows workspace-internal symlink reads', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-file-platform-'));
  const realDir = join(workspaceRoot, 'docs');
  const realFile = join(realDir, 'real.txt');
  const linkedFile = join(workspaceRoot, 'linked.txt');

  try {
    await mkdir(realDir, { recursive: true });
    await writeFile(realFile, 'hello\n', 'utf8');
    if (!(await createSymlinkOrSkip(t, realFile, linkedFile))) {
      return;
    }

    const target = await resolveSourceReadTarget(workspaceRoot, 'linked.txt');
    assert.equal(target.kind, 'source');
    assert.equal(target.mode, 'read');
    assert.equal(target.relativePath, 'linked.txt');
    assert.equal(target.absolutePath, realFile);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test('resolveSourceReadTarget follows a symlink anywhere on the host filesystem', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-file-platform-'));
  const outsideRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-file-platform-outside-'),
  );
  const outsideFile = join(outsideRoot, 'secret.txt');
  const linkedFile = join(workspaceRoot, 'linked.txt');

  try {
    await writeFile(outsideFile, 'secret\n', 'utf8');
    if (!(await createSymlinkOrSkip(t, outsideFile, linkedFile))) {
      return;
    }

    const target = await resolveSourceReadTarget(workspaceRoot, 'linked.txt');
    assert.equal(target.relativePath, 'linked.txt');
    assert.equal(target.absolutePath, outsideFile);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

void test('resolveSourceMutationTarget accepts protected-looking paths and follows symlinked parents', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-file-platform-'));
  const outsideRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-file-platform-outside-'),
  );
  const realDir = join(outsideRoot, 'real-dir');
  const linkedDir = join(workspaceRoot, 'linked-dir');

  try {
    await mkdir(realDir, { recursive: true });

    const internalTarget = await resolveSourceMutationTarget(
      workspaceRoot,
      '.geulbat/index/manifest.json',
      {
        allowMissingLeaf: true,
      },
    );
    assert.equal(
      internalTarget.canonicalAbsolutePath,
      join(workspaceRoot, '.geulbat', 'index', 'manifest.json'),
    );

    if (!(await createSymlinkOrSkip(t, realDir, linkedDir))) {
      return;
    }

    const linkedTarget = await resolveSourceMutationTarget(
      workspaceRoot,
      'linked-dir/child.txt',
      {
        allowMissingLeaf: true,
      },
    );
    assert.equal(linkedTarget.absolutePath, join(linkedDir, 'child.txt'));
    assert.equal(
      linkedTarget.canonicalAbsolutePath,
      join(realDir, 'child.txt'),
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

void test('resolveSourceMutationTarget follows a file symlink regardless of target name', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-file-platform-'));
  const reservedFile = join(workspaceRoot, '.env');
  const linkedFile = join(workspaceRoot, 'settings.txt');

  try {
    await writeFile(reservedFile, 'SECRET=kept\n', 'utf8');
    if (!(await createSymlinkOrSkip(t, reservedFile, linkedFile))) {
      return;
    }

    const target = await resolveSourceMutationTarget(
      workspaceRoot,
      'settings.txt',
      {
        allowMissingLeaf: true,
      },
    );
    assert.equal(target.absolutePath, linkedFile);
    assert.equal(target.canonicalAbsolutePath, reservedFile);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test('resolveSourceMutationTarget returns canonical missing-tail info for create paths', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-file-platform-'));

  try {
    const target = await resolveSourceMutationTarget(
      workspaceRoot,
      'drafts/chapter-1.md',
      {
        allowMissingLeaf: true,
      },
    );

    assert.equal(target.relativePath, 'drafts/chapter-1.md');
    assert.deepEqual(target.missingTailSegments, ['drafts', 'chapter-1.md']);
    assert.equal(
      target.existingCanonicalAncestor,
      target.workspaceCanonicalRoot,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test('resolveSourceMutationTarget returns canonical absolute paths for create-like targets', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-file-platform-'));
  const aliasRootParent = await mkdtemp(
    join(tmpdir(), 'geulbat-file-platform-alias-'),
  );
  const aliasRoot = join(aliasRootParent, 'workspace-link');

  try {
    await mkdir(join(workspaceRoot, 'drafts'), { recursive: true });

    if (!(await createSymlinkOrSkip(t, workspaceRoot, aliasRoot))) {
      return;
    }

    const target = await resolveSourceMutationTarget(
      aliasRoot,
      'drafts/chapter-1.md',
      {
        allowMissingLeaf: true,
      },
    );

    assert.equal(target.relativePath, 'drafts/chapter-1.md');
    assert.equal(
      target.absolutePath,
      join(workspaceRoot, 'drafts/chapter-1.md'),
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(aliasRootParent, { recursive: true, force: true });
  }
});

void test('enumerateCanonicalChildren marks workspace-internal symlink directories as viaSymlink', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-file-platform-'));
  const realDir = join(workspaceRoot, 'docs');
  const linkDir = join(workspaceRoot, 'docs-link');

  try {
    await mkdir(realDir, { recursive: true });
    await writeFile(join(realDir, 'note.md'), '# note\n', 'utf8');
    if (!(await createSymlinkOrSkip(t, realDir, linkDir))) {
      return;
    }

    const root = await resolveSourceReadTarget(workspaceRoot, '.');
    const children = await enumerateCanonicalChildren({
      kind: 'source',
      mode: 'enumerate',
      relativePath: '.',
      canonicalAbsolutePath: root.workspaceCanonicalRoot,
      workspaceCanonicalRoot: root.workspaceCanonicalRoot,
    });
    const linked = children.find((entry) => entry.name === 'docs-link');
    assert.ok(linked);
    assert.equal(linked?.type, 'directory');
    assert.equal(linked?.viaSymlink, true);
    assert.equal(linked?.canonicalAbsolutePath, realDir);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test('enumerateCanonicalChildren includes symlink directories outside the coordinate base', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-file-platform-'));
  const outsideRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-file-platform-outside-'),
  );
  const linkDir = join(workspaceRoot, 'outside-link');

  try {
    await writeFile(join(outsideRoot, 'note.md'), '# outside\n', 'utf8');
    if (!(await createSymlinkOrSkip(t, outsideRoot, linkDir))) {
      return;
    }

    const root = await resolveSourceReadTarget(workspaceRoot, '.');
    const children = await enumerateCanonicalChildren({
      kind: 'source',
      mode: 'enumerate',
      relativePath: '.',
      canonicalAbsolutePath: root.workspaceCanonicalRoot,
      workspaceCanonicalRoot: root.workspaceCanonicalRoot,
    });
    const linked = children.find((entry) => entry.name === 'outside-link');
    assert.equal(linked?.type, 'directory');
    assert.equal(linked?.viaSymlink, true);
    assert.equal(linked?.canonicalAbsolutePath, outsideRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

void test('enumerateCanonicalChildren includes symlink aliases regardless of target name', async (t) => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-file-platform-protected-link-'),
  );
  const outsideRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-file-platform-protected-target-'),
  );
  const protectedDir = join(outsideRoot, '.git');
  const linkDir = join(workspaceRoot, 'history');
  try {
    await mkdir(protectedDir);
    await writeFile(join(protectedDir, 'config'), 'secret\n', 'utf8');
    if (!(await createSymlinkOrSkip(t, protectedDir, linkDir))) {
      return;
    }

    const target = await resolveSourceDirectoryTarget(workspaceRoot, '.');
    const children = await enumerateCanonicalChildren(target);

    const linked = children.find((entry) => entry.name === 'history');
    assert.equal(linked?.type, 'directory');
    assert.equal(linked?.viaSymlink, true);
    assert.equal(linked?.canonicalAbsolutePath, protectedDir);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

void test('resolveDerivedArtifactTarget only allows canonical memory-index paths', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-file-platform-'));

  try {
    const target = await resolveDerivedArtifactTarget(
      workspaceRoot,
      'memory_index',
      'index/manifest.json',
      {
        mode: 'read',
        allowMissingLeaf: true,
      },
    );

    assert.equal(target.kind, 'derived');
    assert.equal(target.owner, 'memory_index');
    assert.equal(target.relativePath, '.geulbat/index/manifest.json');

    await assert.rejects(
      () =>
        resolveDerivedArtifactTarget(
          workspaceRoot,
          'memory_index',
          'sessions/index.json',
          {
            mode: 'read',
            allowMissingLeaf: true,
          },
        ),
      (error: unknown) => error instanceof PathEscapeError,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test('resolveRuntimeStateTarget derives opaque artifact-scoped storage paths', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-file-platform-'));

  try {
    const target = await resolveRuntimeStateTarget(workspaceRoot, {
      threadId: THREAD_ID,
      renderer: 'js',
      artifactId: 'art_demo_js',
      persistenceEpoch: 0,
    });

    assert.equal(target.kind, 'runtime_state');
    assert.match(
      target.relativePath,
      /^\.geulbat\/runtime-persistence\/.+\.json$/,
    );
    assert.match(target.storageRoot, /\.geulbat[\\/]+runtime-persistence$/);
    assert.match(
      target.scopeHandle,
      /^00000000-0000-4000-8000-000000000001:art_demo_js:0$/,
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test('resolveExplicitExportTarget keeps explicit export intent separate from runtime state', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-file-platform-'));

  try {
    const target = await resolveExplicitExportTarget(
      workspaceRoot,
      'drafts/exported.md',
      'intent-001',
    );

    assert.equal(target.kind, 'explicit_export');
    assert.equal(target.mode, 'persist');
    assert.equal(target.targetRelativePath, 'drafts/exported.md');
    assert.equal(target.userIntentSnapshotId, 'intent-001');
    assert.equal(target.versionedMutationRequired, true);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
