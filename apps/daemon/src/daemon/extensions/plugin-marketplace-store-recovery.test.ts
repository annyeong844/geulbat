import assert from 'node:assert/strict';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createMarketplaceFixture,
  createPluginMarketplaceStore,
} from '../../test-support/plugin-marketplace-store-test-support.js';
import { PluginMarketplaceStoreError } from './plugin-marketplace-contract.js';
import { OFFICIAL_CODEX_MARKETPLACE_SOURCE } from './plugin-marketplace-store.js';

void test('Codex official marketplace is daemon-owned, idempotent, and migrates an existing snapshot', async () => {
  const fixture = await createMarketplaceFixture({
    marketplaceName: 'openai-curated',
    marketplaceDisplayName: 'Codex official',
  });
  const homeRoot = join(fixture.root, 'home');
  let acquisitionCount = 0;
  const marketplaces = createPluginMarketplaceStore({
    homeStateRoot: homeRoot,
    acquireGitRepository: async ({ repositoryRoot, url, requestedRef }) => {
      acquisitionCount += 1;
      assert.equal(url, OFFICIAL_CODEX_MARKETPLACE_SOURCE.url);
      assert.equal(requestedRef, OFFICIAL_CODEX_MARKETPLACE_SOURCE.ref);
      await cp(fixture.repositoryRoot, repositoryRoot, { recursive: true });
    },
  });
  try {
    await marketplaces.initialize();
    const first = await marketplaces.ensureOfficialMarketplace();
    const second = await marketplaces.ensureOfficialMarketplace();

    assert.equal(first.marketplaceId, second.marketplaceId);
    assert.equal(first.sourceRole, 'official');
    assert.equal(acquisitionCount, 1);
    assert.equal(marketplaces.list([]).entries.length, 1);
    await assert.rejects(
      marketplaces.remove(first.marketplaceId),
      (error: unknown) =>
        error instanceof PluginMarketplaceStoreError &&
        error.code === 'conflict',
    );
    await assert.rejects(
      marketplaces.add(OFFICIAL_CODEX_MARKETPLACE_SOURCE),
      (error: unknown) =>
        error instanceof PluginMarketplaceStoreError &&
        error.code === 'conflict',
    );

    const registryPath = join(
      homeRoot,
      'extensions',
      'marketplaces',
      'registry.json',
    );
    const legacy = JSON.parse(await readFile(registryPath, 'utf8')) as {
      schemaVersion: number;
      sources: Array<Record<string, unknown>>;
    };
    legacy.schemaVersion = 1;
    delete legacy.sources[0]?.['sourceRole'];
    await writeFile(registryPath, `${JSON.stringify(legacy, null, 2)}\n`);

    const reloaded = createPluginMarketplaceStore({
      homeStateRoot: homeRoot,
      acquireGitRepository: async () => {
        throw new Error('a migrated snapshot must not be acquired again');
      },
    });
    await reloaded.initialize();
    assert.equal(reloaded.list([]).sources[0]?.sourceRole, 'official');
    const migrated = JSON.parse(await readFile(registryPath, 'utf8')) as {
      schemaVersion: number;
      sources: Array<{ sourceRole?: string }>;
    };
    assert.equal(migrated.schemaVersion, 2);
    assert.equal(migrated.sources[0]?.sourceRole, 'official');
  } finally {
    await fixture.cleanup();
  }
});

void test('marketplace reload isolates a corrupt snapshot and reconciles unmanaged directories', async () => {
  const fixture = await createMarketplaceFixture();
  const homeRoot = join(fixture.root, 'home');
  const marketplacesRoot = join(homeRoot, 'extensions', 'marketplaces');
  const marketplaces = createPluginMarketplaceStore({
    homeStateRoot: homeRoot,
    acquireGitRepository: async ({ repositoryRoot }) => {
      await cp(fixture.repositoryRoot, repositoryRoot, { recursive: true });
    },
  });
  try {
    await marketplaces.initialize();
    const source = await marketplaces.add({
      sourceKind: 'git',
      url: 'https://github.com/example/plugins.git',
    });
    const registryPath = join(marketplacesRoot, 'registry.json');
    const persisted = JSON.parse(await readFile(registryPath, 'utf8')) as {
      sources: Array<{ resolvedRevision: string }>;
    };
    assert.ok(persisted.sources[0]);
    persisted.sources[0].resolvedRevision = `git:${'0'.repeat(40)}`;
    await writeFile(registryPath, `${JSON.stringify(persisted, null, 2)}\n`);
    await mkdir(join(marketplacesRoot, '.staging', 'leftover'), {
      recursive: true,
    });
    await mkdir(
      join(marketplacesRoot, 'sources', '22222222-2222-4222-8222-222222222222'),
      { recursive: true },
    );

    const reloaded = createPluginMarketplaceStore({ homeStateRoot: homeRoot });
    await reloaded.initialize();
    const listed = reloaded.list([]);
    assert.equal(listed.sources[0]?.marketplaceId, source.marketplaceId);
    assert.deepEqual(listed.entries, []);
    assert.equal(listed.diagnostics[0]?.code, 'invalid-marketplace');
    assert.deepEqual(await readdir(join(marketplacesRoot, '.staging')), []);
    assert.deepEqual(await readdir(join(marketplacesRoot, 'sources')), [
      source.marketplaceId,
    ]);
  } finally {
    await fixture.cleanup();
  }
});

void test('marketplace registry rejects invalid JSON, shape, encoding, and file type', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-marketplace-registry-'));
  const homeRoot = join(root, 'home');
  const registryRoot = join(homeRoot, 'extensions', 'marketplaces');
  const registryPath = join(registryRoot, 'registry.json');
  await mkdir(registryRoot, { recursive: true });
  try {
    for (const document of [
      '{not-json',
      JSON.stringify({ schemaVersion: 2, sources: [], extra: true }),
      JSON.stringify({ schemaVersion: 99, sources: [] }),
      JSON.stringify({ schemaVersion: 2, sources: 'not-an-array' }),
    ]) {
      await writeFile(registryPath, document);
      const marketplaces = createPluginMarketplaceStore({
        homeStateRoot: homeRoot,
      });
      await assert.rejects(
        marketplaces.initialize(),
        (error: unknown) =>
          error instanceof PluginMarketplaceStoreError &&
          error.code === 'corrupt_registry',
      );
    }

    await writeFile(registryPath, Buffer.from([0xff]));
    await assert.rejects(
      createPluginMarketplaceStore({ homeStateRoot: homeRoot }).initialize(),
      (error: unknown) =>
        error instanceof PluginMarketplaceStoreError &&
        error.code === 'corrupt_registry',
    );
    await rm(registryPath);
    await mkdir(registryPath);
    await assert.rejects(
      createPluginMarketplaceStore({ homeStateRoot: homeRoot }).initialize(),
      (error: unknown) =>
        error instanceof PluginMarketplaceStoreError &&
        error.code === 'corrupt_registry',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
