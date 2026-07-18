import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createBuiltinToolRegistryStore } from './builtin/catalog.js';
import { createToolLibraryProjectionPort } from './tool-library-projection.js';

void test('projection rehydration rejects files outside the generated exact tree', async () => {
  await expectProjectionMutationRejected(async (rootPath) => {
    await writeFile(
      join(rootPath, 'unowned-wrapper.js'),
      'export const unowned = true;\n',
      'utf8',
    );
  });
});

void test('projection rehydration rejects unowned empty directories', async () => {
  await expectProjectionMutationRejected(async (rootPath) => {
    await mkdir(join(rootPath, 'unowned-empty-directory'));
  });
});

void test('projection rehydration rejects a symlinked projection root', async () => {
  await expectProjectionMutationRejected(async (rootPath) => {
    const movedRootPath = `${rootPath}-target`;
    await rename(rootPath, movedRootPath);
    await symlink(movedRootPath, rootPath, 'dir');
  });
});

async function expectProjectionMutationRejected(
  mutate: (rootPath: string) => Promise<void>,
): Promise<void> {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-library-exact-tree-'),
  );
  try {
    const port = createToolLibraryProjectionPort({
      registry: createBuiltinToolRegistryStore(),
      runtimeRootForState: (root) =>
        join(root, '.geulbat', 'tool-library', 'projections'),
      sdkVersion: 'sdk-exact-tree-v1',
      sourceRegistryVersion: 'registry-exact-tree-v1',
      runtimeCompatibilityRange: 'ptc_execute_code_sdk_v1',
      modelFacingCatalogRef: 'geulbat-sdk://catalog',
      importSpecifier: 'geulbat-sdk',
    });
    const resolved = await port.resolveProjection({
      stateRoot,
      threadId: 'thread-exact-tree',
      allowedRegistryNames: ['read_file'],
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) {
      assert.fail('expected projection');
    }

    await mutate(resolved.projection.rootPath);
    const rehydrated = await port.rehydrateProjectionMount({
      stateRoot,
      threadId: 'thread-exact-tree',
      expectedIdentity: {
        sdkVersion: resolved.pin.sdkVersion,
        sdkProjectionHash: resolved.pin.sdkProjectionHash,
        policyId: resolved.pin.policyId,
      },
    });
    assert.deepEqual(rehydrated, {
      ok: false,
      reason: 'projection_failed',
      message:
        'Tool library projection files no longer match their generated source',
    });
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
}
