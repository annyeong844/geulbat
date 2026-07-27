import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { createBuiltinToolRegistryStore } from './builtin/catalog.js';
import { buildToolLibraryProjection } from './tool-library-projection.js';
import type { ToolLibraryProjection } from './tool-library-projection-port.js';
import {
  getToolLibraryProjectionManifest,
  getToolLibraryProjectionIdentity,
  getToolLibraryProjectionPin,
} from '@geulbat/tool-library/projection-manifest';
import {
  deleteThreadToolLibraryProjection,
  pruneUnreferencedToolLibraryProjectionContent,
  readVerifiedToolLibraryProjectionMount,
  writeToolLibraryProjectionFiles,
} from './tool-library-projection-store.js';
import { threadProjectionDirectoryName } from './tool-library-projection-path.js';
import {
  BASE_PROJECTION_ARGS,
  createTestProjectionPort,
  pathExists,
} from '../../test-support/tool-library-projection.js';

void test('writeToolLibraryProjectionFiles writes generated SDK files under the projection root', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'geulbat-tool-library-'));
  try {
    const projection = buildToolLibraryProjection({
      ...BASE_PROJECTION_ARGS,
      registry: createBuiltinToolRegistryStore(),
      allowedRegistryNames: ['read_file'],
      rootPath,
      catalogPath: join(rootPath, 'catalog.js'),
    });

    const result = await writeToolLibraryProjectionFiles(projection);

    assert.deepEqual(result, {
      rootPath,
      writtenFiles: projection.files.map((file) => file.path),
    });

    for (const file of projection.files) {
      assert.equal(
        await readFile(join(rootPath, ...file.path.split('/')), 'utf8'),
        file.content,
      );
    }
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

/**
 * projection 콘텐츠는 공유 위치(`<projections>/content/sha256-...`)에 있으므로
 * thread pin 디렉터리는 콘텐츠 경로에서 유도하지 않고 projections 루트에서 만든다.
 */
function threadProjectionRootPathForTest(
  projectionRootPath: string,
  threadId: string,
): string {
  return join(
    dirname(dirname(projectionRootPath)),
    threadProjectionDirectoryName(threadId),
  );
}

void test('readVerifiedToolLibraryProjectionMount rejects a stale pinned manifest', async () => {
  const threadProjectionRootPath = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-pinned-manifest-'),
  );
  try {
    const preliminaryProjection = buildToolLibraryProjection({
      ...BASE_PROJECTION_ARGS,
      registry: createBuiltinToolRegistryStore(),
      allowedRegistryNames: ['read_file'],
      rootPath: join(threadProjectionRootPath, 'preliminary'),
      catalogPath: join(threadProjectionRootPath, 'preliminary', 'catalog.js'),
    });
    const projectionRootPath = join(
      threadProjectionRootPath,
      getToolLibraryProjectionPin(preliminaryProjection).projectionDirectory,
    );
    const projection = buildToolLibraryProjection({
      ...BASE_PROJECTION_ARGS,
      registry: createBuiltinToolRegistryStore(),
      allowedRegistryNames: ['read_file'],
      rootPath: projectionRootPath,
      catalogPath: join(projectionRootPath, 'catalog.js'),
    });
    await writeToolLibraryProjectionFiles(projection);
    const expectedPin = getToolLibraryProjectionPin(projection);
    await writeFile(
      join(threadProjectionRootPath, 'projection-pin.json'),
      `${JSON.stringify(expectedPin)}\n`,
      'utf8',
    );
    await writeFile(
      join(projectionRootPath, 'manifest.js'),
      `export const projectionManifest = ${JSON.stringify({
        ...getToolLibraryProjectionManifest(projection),
        policyId: 'stale-policy',
      })};\n`,
      'utf8',
    );

    assert.deepEqual(
      await readVerifiedToolLibraryProjectionMount({
        // 공유 위치가 비어 있으므로 구 레이아웃 해석 경로를 검증한다.
        contentRootPath: join(threadProjectionRootPath, 'content'),
        threadProjectionRootPath,
        expectedPin,
        importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
      }),
      {
        ok: false,
        reason: 'manifest_mismatch',
        message:
          'Tool library projection manifest does not match expected projection',
      },
    );
  } finally {
    await rm(threadProjectionRootPath, { recursive: true, force: true });
  }
});

void test('readVerifiedToolLibraryProjectionMount verifies an expected pin after the thread pointer moves', async () => {
  const threadProjectionRootPath = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-pinned-pointer-moved-'),
  );
  try {
    const firstPreliminaryProjection = buildToolLibraryProjection({
      ...BASE_PROJECTION_ARGS,
      registry: createBuiltinToolRegistryStore(),
      allowedRegistryNames: ['read_file'],
      rootPath: join(threadProjectionRootPath, 'first-preliminary'),
      catalogPath: join(
        threadProjectionRootPath,
        'first-preliminary',
        'catalog.js',
      ),
    });
    const firstProjectionRootPath = join(
      threadProjectionRootPath,
      getToolLibraryProjectionPin(firstPreliminaryProjection)
        .projectionDirectory,
    );
    const firstProjection = buildToolLibraryProjection({
      ...BASE_PROJECTION_ARGS,
      registry: createBuiltinToolRegistryStore(),
      allowedRegistryNames: ['read_file'],
      rootPath: firstProjectionRootPath,
      catalogPath: join(firstProjectionRootPath, 'catalog.js'),
    });
    await writeToolLibraryProjectionFiles(firstProjection);
    const firstPin = getToolLibraryProjectionPin(firstProjection);

    const secondPreliminaryProjection = buildToolLibraryProjection({
      ...BASE_PROJECTION_ARGS,
      registry: createBuiltinToolRegistryStore(),
      allowedRegistryNames: ['fetch_url'],
      rootPath: join(threadProjectionRootPath, 'second-preliminary'),
      catalogPath: join(
        threadProjectionRootPath,
        'second-preliminary',
        'catalog.js',
      ),
    });
    const secondProjectionRootPath = join(
      threadProjectionRootPath,
      getToolLibraryProjectionPin(secondPreliminaryProjection)
        .projectionDirectory,
    );
    const secondProjection = buildToolLibraryProjection({
      ...BASE_PROJECTION_ARGS,
      registry: createBuiltinToolRegistryStore(),
      allowedRegistryNames: ['fetch_url'],
      rootPath: secondProjectionRootPath,
      catalogPath: join(secondProjectionRootPath, 'catalog.js'),
    });
    await writeToolLibraryProjectionFiles(secondProjection);
    const secondPin = getToolLibraryProjectionPin(secondProjection);
    await writeFile(
      join(threadProjectionRootPath, 'projection-pin.json'),
      `${JSON.stringify(secondPin)}\n`,
      'utf8',
    );

    const firstMountResult = await readVerifiedToolLibraryProjectionMount({
      contentRootPath: join(threadProjectionRootPath, 'content'),
      threadProjectionRootPath,
      expectedPin: firstPin,
      importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
    });
    assert.equal(firstMountResult.ok, true);
    if (!firstMountResult.ok) {
      assert.fail('expected old expected pin to verify after pointer moved');
    }
    assert.equal(
      firstMountResult.mount.projectionRootPath,
      firstProjection.rootPath,
    );
    assert.deepEqual(firstMountResult.pin, firstPin);
  } finally {
    await rm(threadProjectionRootPath, { recursive: true, force: true });
  }
});

void test('readVerifiedToolLibraryProjectionMount rejects stored pin module drift without an expected pin', async () => {
  const threadProjectionRootPath = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-pinned-module-drift-'),
  );
  try {
    const preliminaryProjection = buildToolLibraryProjection({
      ...BASE_PROJECTION_ARGS,
      registry: createBuiltinToolRegistryStore(),
      allowedRegistryNames: ['read_file'],
      rootPath: join(threadProjectionRootPath, 'preliminary'),
      catalogPath: join(threadProjectionRootPath, 'preliminary', 'catalog.js'),
    });
    const projectionRootPath = join(
      threadProjectionRootPath,
      getToolLibraryProjectionPin(preliminaryProjection).projectionDirectory,
    );
    const projection = buildToolLibraryProjection({
      ...BASE_PROJECTION_ARGS,
      registry: createBuiltinToolRegistryStore(),
      allowedRegistryNames: ['read_file'],
      rootPath: projectionRootPath,
      catalogPath: join(projectionRootPath, 'catalog.js'),
    });
    await writeToolLibraryProjectionFiles(projection);
    const pin = getToolLibraryProjectionPin(projection);
    await writeFile(
      join(threadProjectionRootPath, 'projection-pin.json'),
      `${JSON.stringify({
        ...pin,
        catalogModule: 'stale-catalog.js',
      })}\n`,
      'utf8',
    );

    assert.deepEqual(
      await readVerifiedToolLibraryProjectionMount({
        // 공유 위치가 비어 있으므로 구 레이아웃 해석 경로를 검증한다.
        contentRootPath: join(threadProjectionRootPath, 'content'),
        threadProjectionRootPath,
        importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
      }),
      {
        ok: false,
        reason: 'pin_mismatch',
        message: 'Tool library projection pin does not match pinned manifest',
      },
    );
  } finally {
    await rm(threadProjectionRootPath, { recursive: true, force: true });
  }
});

void test('readVerifiedToolLibraryProjectionMount rehydrates from observer projection identity', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-replay-identity-'),
  );
  try {
    const runtime = createTestProjectionPort();
    const result = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-runtime-test',
      allowedRegistryNames: ['read_file'],
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      assert.fail('expected projection port to resolve');
    }

    const expectedIdentity = getToolLibraryProjectionIdentity(result.pin);
    const mountResult = await readVerifiedToolLibraryProjectionMount({
      contentRootPath: dirname(result.projection.rootPath),
      threadProjectionRootPath: threadProjectionRootPathForTest(
        result.projection.rootPath,
        'thread-runtime-test',
      ),
      expectedIdentity,
      importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
    });

    assert.equal(mountResult.ok, true);
    if (!mountResult.ok) {
      assert.fail('expected projection mount verification to pass');
    }
    assert.deepEqual(getToolLibraryProjectionIdentity(mountResult.mount), {
      sdkVersion: expectedIdentity.sdkVersion,
      sdkProjectionHash: expectedIdentity.sdkProjectionHash,
      policyId: expectedIdentity.policyId,
    });
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('readVerifiedToolLibraryProjectionMount rejects replay identity mismatch', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-replay-identity-mismatch-'),
  );
  try {
    const runtime = createTestProjectionPort();
    const result = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-runtime-test',
      allowedRegistryNames: ['read_file'],
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      assert.fail('expected projection port to resolve');
    }

    assert.deepEqual(
      await readVerifiedToolLibraryProjectionMount({
        contentRootPath: dirname(result.projection.rootPath),
        threadProjectionRootPath: threadProjectionRootPathForTest(
          result.projection.rootPath,
          'thread-runtime-test',
        ),
        expectedIdentity: {
          ...getToolLibraryProjectionIdentity(result.pin),
          policyId: 'stale-policy',
        },
        importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
      }),
      {
        ok: false,
        reason: 'projection_identity_mismatch',
        message:
          'Tool library projection identity does not match expected replay projection',
      },
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('readVerifiedToolLibraryProjectionMount rejects import specifier mismatch', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-mount-mismatch-'),
  );
  try {
    const runtime = createTestProjectionPort();
    const result = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-runtime-test',
      allowedRegistryNames: ['read_file'],
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      assert.fail('expected projection port to resolve');
    }

    assert.deepEqual(
      await readVerifiedToolLibraryProjectionMount({
        contentRootPath: dirname(result.projection.rootPath),
        threadProjectionRootPath: threadProjectionRootPathForTest(
          result.projection.rootPath,
          'thread-runtime-test',
        ),
        expectedPin: result.pin,
        importSpecifier: '@geulbat/other-tools',
      }),
      {
        ok: false,
        reason: 'import_specifier_mismatch',
        message:
          'Tool library projection import specifier does not match expected runtime mount',
      },
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('readVerifiedToolLibraryProjectionMount rejects missing mount files', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-mount-missing-'),
  );
  try {
    const runtime = createTestProjectionPort();
    const result = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-runtime-test',
      allowedRegistryNames: ['read_file'],
    });
    assert.equal(result.ok, true);
    if (!result.ok) {
      assert.fail('expected projection port to resolve');
    }
    await rm(join(result.projection.rootPath, 'index.js'));

    const mountResult = await readVerifiedToolLibraryProjectionMount({
      contentRootPath: dirname(result.projection.rootPath),
      threadProjectionRootPath: threadProjectionRootPathForTest(
        result.projection.rootPath,
        'thread-runtime-test',
      ),
      expectedPin: result.pin,
      importSpecifier: BASE_PROJECTION_ARGS.importSpecifier,
    });
    assert.equal(mountResult.ok, false);
    if (mountResult.ok) {
      assert.fail('expected projection mount verification to fail');
    }
    assert.equal(mountResult.reason, 'mount_file_missing');
    assert.equal(
      mountResult.message,
      'Tool library projection mount file could not be read',
    );
    assert.equal(mountResult.message.includes(stateRoot), false);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('writeToolLibraryProjectionFiles rejects unsafe generated file paths', async () => {
  const parentPath = await mkdtemp(join(tmpdir(), 'geulbat-tool-library-'));
  const rootPath = join(parentPath, 'sdk');
  const outsidePath = join(parentPath, 'escape.ts');
  try {
    await mkdir(rootPath);

    const projection = {
      rootPath,
      files: [
        {
          path: '../escape.ts',
          role: 'wrapper',
          content: 'export {};\n',
        },
      ],
    } satisfies Pick<ToolLibraryProjection, 'rootPath' | 'files'>;

    await assert.rejects(
      () => writeToolLibraryProjectionFiles(projection),
      /Invalid tool library projection file path: \.\.\/escape\.ts/u,
    );
    assert.equal(await pathExists(outsidePath), false);
  } finally {
    await rm(parentPath, { recursive: true, force: true });
  }
});

void test('legacy in-thread projection content migrates into the shared store', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-migrate-'),
  );
  try {
    const runtime = createTestProjectionPort();
    const first = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-migrate',
      allowedRegistryNames: ['read_file'],
    });
    assert.equal(first.ok, true);
    if (!first.ok) {
      assert.fail('expected projection port to resolve');
    }
    const contentRootPath = dirname(first.projection.rootPath);
    const projectionsRootPath = dirname(contentRootPath);
    const threadProjectionRootPath = join(
      projectionsRootPath,
      threadProjectionDirectoryName('thread-migrate'),
    );
    const projectionDirectory = first.pin.projectionDirectory;

    // 구 레이아웃 재현: 콘텐츠를 thread 디렉터리 안으로 되돌린다.
    await rename(
      join(contentRootPath, projectionDirectory),
      join(threadProjectionRootPath, projectionDirectory),
    );
    await rm(contentRootPath, { recursive: true, force: true });
    assert.equal(
      await pathExists(join(threadProjectionRootPath, projectionDirectory)),
      true,
    );

    const second = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-migrate',
      allowedRegistryNames: ['read_file'],
    });
    assert.equal(second.ok, true);
    if (!second.ok) {
      assert.fail('expected the migrated projection to resolve');
    }
    assert.deepEqual(second.pin, first.pin);
    assert.equal(
      await pathExists(join(contentRootPath, projectionDirectory)),
      true,
    );
    assert.equal(
      await pathExists(join(threadProjectionRootPath, projectionDirectory)),
      false,
    );
    assert.equal(
      await pathExists(join(threadProjectionRootPath, 'projection-pin.json')),
      true,
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('two threads sharing one projection digest keep a single content copy', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-share-'),
  );
  try {
    const runtime = createTestProjectionPort();
    const first = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-share-a',
      allowedRegistryNames: ['read_file'],
    });
    const second = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-share-b',
      allowedRegistryNames: ['read_file'],
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) {
      assert.fail('expected both projections to resolve');
    }
    assert.equal(first.projection.rootPath, second.projection.rootPath);
    // 두 번째 스레드는 콘텐츠를 다시 쓰지 않는다.
    assert.deepEqual(second.writtenFiles, []);

    const contentRootPath = dirname(first.projection.rootPath);
    const contentEntries = await readdir(contentRootPath);
    assert.deepEqual(contentEntries, [first.pin.projectionDirectory]);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('unreferenced shared content is pruned while pinned content survives', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-tool-library-gc-'));
  try {
    const runtime = createTestProjectionPort();
    const pinned = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-gc-pinned',
      allowedRegistryNames: ['read_file'],
    });
    assert.equal(pinned.ok, true);
    if (!pinned.ok) {
      assert.fail('expected projection port to resolve');
    }
    const contentRootPath = dirname(pinned.projection.rootPath);
    const projectionsRootPath = dirname(contentRootPath);
    const orphanDirectory = `sha256-${'a'.repeat(64)}`;
    await mkdir(join(contentRootPath, orphanDirectory), { recursive: true });
    await writeFile(
      join(contentRootPath, orphanDirectory, 'manifest.js'),
      'export const projectionManifest = {};\n',
      'utf8',
    );

    const result = await pruneUnreferencedToolLibraryProjectionContent({
      projectionsRootPath,
      contentRootPath,
    });

    assert.deepEqual(result.removedDirectories, [orphanDirectory]);
    assert.deepEqual(result.failedDirectories, []);
    assert.deepEqual(result.retainedDirectories, [
      pinned.pin.projectionDirectory,
    ]);
    assert.deepEqual(result.unreadableThreadDirectories, []);
    assert.equal(
      await pathExists(join(contentRootPath, orphanDirectory)),
      false,
    );
    assert.equal(await pathExists(pinned.projection.rootPath), true);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('content GC refuses to remove anything when a thread pin is unreadable', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-gc-guard-'),
  );
  try {
    const runtime = createTestProjectionPort();
    const pinned = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-gc-guard',
      allowedRegistryNames: ['read_file'],
    });
    assert.equal(pinned.ok, true);
    if (!pinned.ok) {
      assert.fail('expected projection port to resolve');
    }
    const contentRootPath = dirname(pinned.projection.rootPath);
    const projectionsRootPath = dirname(contentRootPath);
    const orphanDirectory = `sha256-${'b'.repeat(64)}`;
    await mkdir(join(contentRootPath, orphanDirectory), { recursive: true });

    // 참조 집합을 신뢰할 수 없으면 아무것도 지우지 않아야 한다.
    await writeFile(
      join(
        projectionsRootPath,
        threadProjectionDirectoryName('thread-gc-guard'),
        'projection-pin.json',
      ),
      'not json\n',
      'utf8',
    );

    const result = await pruneUnreferencedToolLibraryProjectionContent({
      projectionsRootPath,
      contentRootPath,
    });

    assert.deepEqual(result.removedDirectories, []);
    assert.equal(result.unreadableThreadDirectories.length, 1);
    assert.equal(
      await pathExists(join(contentRootPath, orphanDirectory)),
      true,
    );
    assert.equal(await pathExists(pinned.projection.rootPath), true);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('deleting a thread projection removes only its pin directory', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-delete-'),
  );
  try {
    const runtime = createTestProjectionPort();
    const kept = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-delete-kept',
      allowedRegistryNames: ['read_file'],
    });
    const removed = await runtime.resolveProjection({
      stateRoot,
      threadId: 'thread-delete-removed',
      allowedRegistryNames: ['read_file'],
    });
    assert.equal(kept.ok, true);
    assert.equal(removed.ok, true);
    if (!kept.ok || !removed.ok) {
      assert.fail('expected both projections to resolve');
    }
    const projectionsRootPath = dirname(dirname(kept.projection.rootPath));

    assert.equal(
      await deleteThreadToolLibraryProjection({
        projectionsRootPath,
        threadId: 'thread-delete-removed',
      }),
      true,
    );

    assert.equal(
      await pathExists(
        join(
          projectionsRootPath,
          threadProjectionDirectoryName('thread-delete-removed'),
        ),
      ),
      false,
    );
    assert.equal(
      await pathExists(
        join(
          projectionsRootPath,
          threadProjectionDirectoryName('thread-delete-kept'),
        ),
      ),
      true,
    );
    // 공유 콘텐츠는 남은 스레드가 참조하므로 유지된다.
    assert.equal(await pathExists(kept.projection.rootPath), true);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
