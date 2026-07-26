import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  readVerifiedToolLibraryProjectionMount,
  writeToolLibraryProjectionFiles,
} from './tool-library-projection-store.js';
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
      threadProjectionRootPath: dirname(result.projection.rootPath),
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
        threadProjectionRootPath: dirname(result.projection.rootPath),
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
        threadProjectionRootPath: dirname(result.projection.rootPath),
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
      threadProjectionRootPath: dirname(result.projection.rootPath),
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
