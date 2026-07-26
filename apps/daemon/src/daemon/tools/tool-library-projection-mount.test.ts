import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveToolLibraryProjectionMountedModule } from './tool-library-projection-mount.js';
import { createTestProjectionPort } from '../../test-support/tool-library-projection.js';

void test('resolveToolLibraryProjectionMountedModule resolves only owned generated modules', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-mounted-module-'),
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
    const tool = result.projection.tools[0];
    assert.ok(tool);

    assert.deepEqual(
      resolveToolLibraryProjectionMountedModule({
        mount: result.mount,
        specifier: '@geulbat/generated-tools',
      }),
      {
        ok: true,
        module: {
          specifier: '@geulbat/generated-tools',
          filePath: result.mount.indexModulePath,
          role: 'index',
        },
      },
    );
    assert.deepEqual(
      resolveToolLibraryProjectionMountedModule({
        mount: result.mount,
        specifier: '@geulbat/generated-tools/catalog',
      }),
      {
        ok: true,
        module: {
          specifier: '@geulbat/generated-tools/catalog',
          filePath: result.mount.catalogModulePath,
          role: 'catalog',
        },
      },
    );
    assert.deepEqual(
      resolveToolLibraryProjectionMountedModule({
        mount: result.mount,
        specifier: '@geulbat/generated-tools/search',
      }),
      {
        ok: true,
        module: {
          specifier: '@geulbat/generated-tools/search',
          filePath: result.mount.searchModulePath,
          role: 'search',
        },
      },
    );
    assert.deepEqual(
      resolveToolLibraryProjectionMountedModule({
        mount: result.mount,
        specifier: '@geulbat/generated-tools/search-runtime',
      }),
      {
        ok: true,
        module: {
          specifier: '@geulbat/generated-tools/search-runtime',
          filePath: result.mount.searchRuntimeModulePath,
          role: 'search_runtime',
        },
      },
    );
    assert.deepEqual(
      resolveToolLibraryProjectionMountedModule({
        mount: result.mount,
        specifier: '@geulbat/generated-tools/manifest',
      }),
      {
        ok: true,
        module: {
          specifier: '@geulbat/generated-tools/manifest',
          filePath: result.mount.manifestModulePath,
          role: 'manifest',
        },
      },
    );
    assert.deepEqual(
      resolveToolLibraryProjectionMountedModule({
        mount: result.mount,
        specifier: '@geulbat/generated-tools/index.d.ts',
      }),
      {
        ok: true,
        module: {
          specifier: '@geulbat/generated-tools/index.d.ts',
          filePath: result.mount.indexDeclarationPath,
          role: 'index_declaration',
        },
      },
    );
    assert.deepEqual(
      resolveToolLibraryProjectionMountedModule({
        mount: result.mount,
        specifier: '@geulbat/generated-tools/signatures/read-file',
      }),
      {
        ok: true,
        module: {
          specifier: '@geulbat/generated-tools/signatures/read-file',
          filePath: join(result.mount.projectionRootPath, tool.signatureModule),
          role: 'signature',
        },
      },
    );
    assert.deepEqual(
      resolveToolLibraryProjectionMountedModule({
        mount: result.mount,
        specifier: '@geulbat/generated-tools/signatures/read-file.d.ts',
      }),
      {
        ok: true,
        module: {
          specifier: '@geulbat/generated-tools/signatures/read-file.d.ts',
          filePath: join(
            result.mount.projectionRootPath,
            tool.signatureDeclarationModule,
          ),
          role: 'signature_declaration',
        },
      },
    );
    assert.deepEqual(
      resolveToolLibraryProjectionMountedModule({
        mount: result.mount,
        specifier: '@geulbat/generated-tools/files/readFile',
      }),
      {
        ok: true,
        module: {
          specifier: '@geulbat/generated-tools/files/readFile',
          filePath: join(result.mount.projectionRootPath, tool.wrapperModule),
          role: 'wrapper',
        },
      },
    );
    assert.deepEqual(
      resolveToolLibraryProjectionMountedModule({
        mount: result.mount,
        specifier: '@geulbat/generated-tools/files/readFile.d.ts',
      }),
      {
        ok: true,
        module: {
          specifier: '@geulbat/generated-tools/files/readFile.d.ts',
          filePath: join(
            result.mount.projectionRootPath,
            tool.wrapperDeclarationModule,
          ),
          role: 'wrapper_declaration',
        },
      },
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('resolveToolLibraryProjectionMountedModule rejects aliases and traversal-shaped subpaths', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-mounted-module-reject-'),
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

    for (const specifier of [
      '@geulbat/other-tools',
      '@geulbat/generated-tools/',
      '@geulbat/generated-tools/../catalog',
      '@geulbat/generated-tools/catalog.js',
      '@geulbat/generated-tools/search-runtime.js',
      '@geulbat/generated-tools/files/readFile.js',
      '@geulbat/generated-tools/signatures/read_file',
      '@geulbat/generated-tools/tools/missing-tool',
    ]) {
      const resolved = resolveToolLibraryProjectionMountedModule({
        mount: result.mount,
        specifier,
      });
      assert.equal(resolved.ok, false);
      if (resolved.ok) {
        assert.fail(`expected ${specifier} to be rejected`);
      }
      assert.equal(resolved.reason, 'module_not_mounted');
      assert.equal(
        resolved.message,
        'Tool library projection module is not mounted',
      );
      assert.equal(resolved.message.includes(stateRoot), false);
    }
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
