import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createMarketplaceFixture,
  createPluginMarketplaceStore,
} from '../../test-support/plugin-marketplace-store-test-support.js';
import { PluginMarketplaceStoreError } from './plugin-marketplace-contract.js';
import { createPluginStore } from './plugin-store.js';
import { PluginStoreError } from './plugin-store-contract.js';

void test('Git marketplace browse and install use exact managed bytes and sanitized provenance', async () => {
  const fixture = await createMarketplaceFixture({
    includeUnsupportedNpm: true,
  });
  const homeRoot = join(fixture.root, 'home');
  const marketplaces = createPluginMarketplaceStore({
    homeStateRoot: homeRoot,
    acquireGitRepository: async ({ repositoryRoot }) => {
      await cp(fixture.repositoryRoot, repositoryRoot, { recursive: true });
    },
  });
  const plugins = createPluginStore({ homeStateRoot: homeRoot });
  try {
    await plugins.initialize();
    await marketplaces.initialize();
    const source = await marketplaces.add({
      sourceKind: 'git',
      url: 'https://github.com/example/plugins.git',
      ref: 'main',
    });
    assert.equal(source.name, 'fixture-marketplace');
    assert.equal(source.sourceRole, 'custom');
    assert.match(source.resolvedRevision, /^git:[a-f0-9]{40}$/u);

    const beforeInstall = marketplaces.list(plugins.listPlugins());
    assert.equal(beforeInstall.sources.length, 1);
    assert.deepEqual(
      beforeInstall.entries.map((entry) => [
        entry.name,
        entry.status,
        entry.iconAvailable,
      ]),
      [
        ['npm-helper', 'unsupported-source', false],
        ['workflow-helper', 'installable', true],
      ],
    );
    const installable = beforeInstall.entries.find(
      (entry) => entry.name === 'workflow-helper',
    );
    assert.ok(installable?.contentDigest);
    const icon = await marketplaces.resolveEntryIcon(
      source.marketplaceId,
      installable.entryId,
    );
    assert.equal(icon?.contentType, 'image/png');
    assert.equal(
      icon ? await readFile(icon.absolutePath, 'utf8') : null,
      'fixture-icon',
    );

    const candidate = await marketplaces.resolveInstallCandidate({
      marketplaceId: source.marketplaceId,
      entryId: installable.entryId,
      expectedContentDigest: installable.contentDigest,
    });
    const installed = await plugins.installMarketplacePlugin(candidate);
    assert.equal(installed.sourceKind, 'marketplace');
    assert.deepEqual(installed.marketplaceSource, {
      marketplaceId: source.marketplaceId,
      marketplaceName: source.name,
      marketplaceDisplayName: source.displayName,
      entryId: installable.entryId,
      resolvedRevision: source.resolvedRevision,
    });
    assert.equal(installed.enabled, false);
    assert.equal(
      marketplaces
        .list(plugins.listPlugins())
        .entries.find((entry) => entry.entryId === installable.entryId)
        ?.installedInstallationId,
      installed.installationId,
    );

    await assert.rejects(
      plugins.installMarketplacePlugin(candidate),
      (error: unknown) =>
        error instanceof PluginStoreError && error.code === 'conflict',
    );
    await assert.rejects(
      marketplaces.resolveInstallCandidate({
        marketplaceId: source.marketplaceId,
        entryId: installable.entryId,
        expectedContentDigest: `sha256:${'0'.repeat(64)}`,
      }),
      (error: unknown) =>
        error instanceof PluginMarketplaceStoreError &&
        error.code === 'conflict',
    );

    const pluginRegistry = await readFile(
      join(homeRoot, 'extensions', 'registry.json'),
      'utf8',
    );
    const parsedRegistry = JSON.parse(pluginRegistry) as {
      schemaVersion: number;
      plugins: Array<{
        packageObjectId: string;
        view: { installationId: string };
      }>;
    };
    assert.equal(parsedRegistry.schemaVersion, 4);
    assert.notEqual(
      parsedRegistry.plugins[0]?.packageObjectId,
      parsedRegistry.plugins[0]?.view.installationId,
    );
    assert.doesNotMatch(pluginRegistry, /sourceRoot|managedPath|sourceUrl/u);

    await marketplaces.remove(source.marketplaceId);
    assert.deepEqual(marketplaces.list(plugins.listPlugins()).sources, []);
    assert.equal(
      plugins.listPlugins()[0]?.installationId,
      installed.installationId,
    );
  } finally {
    await fixture.cleanup();
  }
});

void test('marketplace reload reuses its revision-pinned catalog but revalidates selected install bytes', async () => {
  const fixture = await createMarketplaceFixture();
  const homeRoot = join(fixture.root, 'home');
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
      ref: 'main',
    });
    const originalEntry = marketplaces
      .list([])
      .entries.find((entry) => entry.entryId === 'workflow-helper');
    assert.ok(originalEntry?.contentDigest);
    const managedSourceRoot = join(
      homeRoot,
      'extensions',
      'marketplaces',
      'sources',
      source.marketplaceId,
    );
    const cache = JSON.parse(
      await readFile(join(managedSourceRoot, 'catalog-cache.json'), 'utf8'),
    ) as { schemaVersion?: unknown };
    assert.equal(cache.schemaVersion, 1);

    const managedSkillPath = join(
      managedSourceRoot,
      'repository',
      'plugins',
      'workflow-helper',
      'skills',
      'workflow',
      'SKILL.md',
    );
    await writeFile(
      managedSkillPath,
      `${await readFile(managedSkillPath, 'utf8')}\nLocally changed after catalog inspection.\n`,
    );

    const reloaded = createPluginMarketplaceStore({
      homeStateRoot: homeRoot,
    });
    await reloaded.initialize();
    const cachedEntry = reloaded
      .list([])
      .entries.find((entry) => entry.entryId === 'workflow-helper');
    assert.equal(cachedEntry?.status, 'installable');
    assert.equal(cachedEntry?.contentDigest, originalEntry.contentDigest);
    await assert.rejects(
      reloaded.resolveInstallCandidate({
        marketplaceId: source.marketplaceId,
        entryId: 'workflow-helper',
        expectedContentDigest: originalEntry.contentDigest,
      }),
      (error: unknown) =>
        error instanceof PluginMarketplaceStoreError &&
        error.code === 'conflict',
    );
  } finally {
    await fixture.cleanup();
  }
});

void test('marketplace reload rebuilds a corrupt derived catalog cache from its managed revision', async () => {
  const fixture = await createMarketplaceFixture();
  const homeRoot = join(fixture.root, 'home');
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
    const cachePath = join(
      homeRoot,
      'extensions',
      'marketplaces',
      'sources',
      source.marketplaceId,
      'catalog-cache.json',
    );
    await writeFile(cachePath, '{not-json');

    const reloaded = createPluginMarketplaceStore({
      homeStateRoot: homeRoot,
    });
    await reloaded.initialize();

    assert.equal(reloaded.list([]).entries[0]?.status, 'installable');
    const rebuiltCache = JSON.parse(await readFile(cachePath, 'utf8')) as {
      schemaVersion?: unknown;
    };
    assert.equal(rebuiltCache.schemaVersion, 1);
  } finally {
    await fixture.cleanup();
  }
});

void test('invalid marketplace packages stay visible as diagnostics and never resolve', async () => {
  const fixture = await createMarketplaceFixture({ invalidManifest: true });
  const homeRoot = join(fixture.root, 'home');
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
      url: 'https://github.com/example/invalid-plugins.git',
    });
    const list = marketplaces.list([]);
    assert.equal(list.entries[0]?.status, 'invalid-package');
    assert.equal(list.diagnostics[0]?.code, 'invalid-package');
    await assert.rejects(
      marketplaces.resolveInstallCandidate({
        marketplaceId: source.marketplaceId,
        entryId: 'workflow-helper',
        expectedContentDigest: `sha256:${'1'.repeat(64)}`,
      }),
      (error: unknown) =>
        error instanceof PluginMarketplaceStoreError &&
        error.code === 'invalid_request',
    );
  } finally {
    await fixture.cleanup();
  }
});

void test('valid marketplace packages without an icon advertise no icon asset', async () => {
  const fixture = await createMarketplaceFixture({ omitIcon: true });
  const homeRoot = join(fixture.root, 'home');
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
    const entry = marketplaces.list([]).entries[0];
    assert.equal(entry?.status, 'installable');
    assert.equal(entry?.iconAvailable, false);
    assert.equal(
      await marketplaces.resolveEntryIcon(
        source.marketplaceId,
        entry?.entryId ?? '',
      ),
      null,
    );
  } finally {
    await fixture.cleanup();
  }
});

void test('failed Git acquisition leaves no published marketplace source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-marketplace-failure-'));
  const marketplaces = createPluginMarketplaceStore({
    homeStateRoot: join(root, 'home'),
    acquireGitRepository: async () => {
      throw new Error('fixture acquisition failed');
    },
  });
  try {
    await marketplaces.initialize();
    await assert.rejects(
      marketplaces.add({
        sourceKind: 'git',
        url: 'https://github.com/example/plugins.git',
      }),
      (error: unknown) => error instanceof PluginMarketplaceStoreError,
    );
    assert.deepEqual(marketplaces.list([]), {
      sources: [],
      entries: [],
      diagnostics: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('marketplace store rejects use before initialization and malformed identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-marketplace-guards-'));
  const marketplaces = createPluginMarketplaceStore({
    homeStateRoot: join(root, 'home'),
    acquireGitRepository: async () => {
      throw new Error('invalid requests must not acquire a repository');
    },
  });
  try {
    assert.throws(() => marketplaces.list([]), /not initialized/u);
    await assert.rejects(
      marketplaces.add({
        sourceKind: 'git',
        url: 'https://github.com/example/plugins.git',
      }),
      /not initialized/u,
    );

    await marketplaces.initialize();
    await marketplaces.initialize();
    await assert.rejects(
      marketplaces.add({ sourceKind: 'git', url: 'http://example.test/a.git' }),
      (error: unknown) =>
        error instanceof PluginMarketplaceStoreError &&
        error.code === 'invalid_request',
    );
    await assert.rejects(
      marketplaces.remove('not-a-marketplace-id'),
      (error: unknown) =>
        error instanceof PluginMarketplaceStoreError &&
        error.code === 'invalid_request',
    );
    await assert.rejects(
      marketplaces.remove('11111111-1111-4111-8111-111111111111'),
      (error: unknown) =>
        error instanceof PluginMarketplaceStoreError &&
        error.code === 'not_found',
    );
    assert.equal(
      await marketplaces.resolveEntryIcon('not-an-id', 'workflow-helper'),
      null,
    );
    assert.equal(
      await marketplaces.resolveEntryIcon(
        '11111111-1111-4111-8111-111111111111',
        'Not-A-Plugin',
      ),
      null,
    );
    assert.equal(
      await marketplaces.resolveEntryIcon(
        '11111111-1111-4111-8111-111111111111',
        'workflow-helper',
      ),
      null,
    );
    await assert.rejects(
      marketplaces.resolveInstallCandidate({
        marketplaceId: 'not-an-id',
        entryId: 'Not-A-Plugin',
        expectedContentDigest: 'invalid-digest',
      }),
      (error: unknown) =>
        error instanceof PluginMarketplaceStoreError &&
        error.code === 'invalid_request',
    );
    await assert.rejects(
      marketplaces.resolveInstallCandidate({
        marketplaceId: '11111111-1111-4111-8111-111111111111',
        entryId: 'workflow-helper',
        expectedContentDigest: `sha256:${'1'.repeat(64)}`,
      }),
      (error: unknown) =>
        error instanceof PluginMarketplaceStoreError &&
        error.code === 'not_found',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('marketplace catalog classifies invalid policy, source, path, and package entries', async () => {
  const fixture = await createMarketplaceFixture();
  const catalogPath = join(
    fixture.repositoryRoot,
    '.agents',
    'plugins',
    'marketplace.json',
  );
  await writeFile(
    catalogPath,
    `${JSON.stringify(
      {
        name: 'fixture-marketplace',
        interface: { displayName: 'Fixture marketplace' },
        plugins: [
          null,
          { name: 'policyless-helper', source: './plugins/workflow-helper' },
          {
            name: 'npm-helper',
            source: { source: 'npm', package: '@example/helper' },
            policy: {
              installation: 'AVAILABLE',
              authentication: 'ON_INSTALL',
            },
            category: 'Developer Tools',
          },
          {
            name: 'npm-helper',
            source: { source: 'npm', package: '@example/duplicate' },
            policy: {
              installation: 'AVAILABLE',
              authentication: 'ON_INSTALL',
            },
            category: 'Developer Tools',
          },
          {
            name: 'git-helper',
            source: { source: 'url', url: 'https://example.test/helper.git' },
            policy: {
              installation: 'AVAILABLE',
              authentication: 'ON_INSTALL',
            },
            category: 'Developer Tools',
          },
          {
            name: 'unknown-helper',
            source: { source: 'future-source' },
            policy: {
              installation: 'AVAILABLE',
              authentication: 'ON_INSTALL',
            },
            category: 'Developer Tools',
          },
          {
            name: 'bad-local-path',
            source: { source: 'local', path: '../outside' },
            policy: {
              installation: 'AVAILABLE',
              authentication: 'ON_INSTALL',
            },
            category: 'Productivity',
          },
          {
            name: 'workflow-helper',
            source: './plugins/workflow-helper',
            policy: {
              installation: 'NOT_AVAILABLE',
              authentication: 'ON_INSTALL',
            },
            category: 'Productivity',
          },
          {
            name: 'mismatch-helper',
            source: { source: 'local', path: './plugins/workflow-helper' },
            policy: {
              installation: 'AVAILABLE',
              authentication: 'ON_INSTALL',
            },
            category: 'Productivity',
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  const marketplaces = createPluginMarketplaceStore({
    homeStateRoot: join(fixture.root, 'home'),
    acquireGitRepository: async ({ repositoryRoot }) => {
      await cp(fixture.repositoryRoot, repositoryRoot, { recursive: true });
    },
  });
  try {
    await marketplaces.initialize();
    const source = await marketplaces.add({
      sourceKind: 'git',
      url: 'https://github.com/example/classified-plugins.git',
    });
    const listed = marketplaces.list([]);
    const statusByName = new Map(
      listed.entries.map((entry) => [entry.name, entry.status]),
    );
    assert.equal(statusByName.get('npm-helper'), 'unsupported-source');
    assert.equal(statusByName.get('git-helper'), 'unsupported-source');
    assert.equal(statusByName.get('unknown-helper'), 'unsupported-source');
    assert.equal(statusByName.get('bad-local-path'), 'invalid-package');
    assert.equal(statusByName.get('workflow-helper'), 'not-available');
    assert.equal(statusByName.get('mismatch-helper'), 'invalid-package');
    assert.equal(
      listed.diagnostics.filter((entry) => entry.code === 'invalid-entry')
        .length,
      4,
    );
    assert.equal(
      listed.diagnostics.filter((entry) => entry.code === 'unsupported-source')
        .length,
      3,
    );
    await assert.rejects(
      marketplaces.resolveInstallCandidate({
        marketplaceId: source.marketplaceId,
        entryId: 'workflow-helper',
        expectedContentDigest:
          listed.entries.find((entry) => entry.name === 'workflow-helper')
            ?.contentDigest ?? `sha256:${'0'.repeat(64)}`,
      }),
      (error: unknown) =>
        error instanceof PluginMarketplaceStoreError &&
        error.code === 'invalid_request',
    );
  } finally {
    await fixture.cleanup();
  }
});

void test('marketplace detects duplicate sources, invalid icons, and post-inspection byte changes', async () => {
  const fixture = await createMarketplaceFixture();
  const homeRoot = join(fixture.root, 'home');
  const marketplaces = createPluginMarketplaceStore({
    homeStateRoot: homeRoot,
    acquireGitRepository: async ({ repositoryRoot }) => {
      await cp(fixture.repositoryRoot, repositoryRoot, { recursive: true });
    },
  });
  try {
    await marketplaces.initialize();
    const request = {
      sourceKind: 'git' as const,
      url: 'https://github.com/example/plugins.git',
      ref: 'main',
    };
    const source = await marketplaces.add(request);
    await assert.rejects(
      marketplaces.add(request),
      (error: unknown) =>
        error instanceof PluginMarketplaceStoreError &&
        error.code === 'conflict',
    );
    await assert.rejects(
      marketplaces.add({
        sourceKind: 'git',
        url: 'https://github.com/example/same-name.git',
      }),
      (error: unknown) =>
        error instanceof PluginMarketplaceStoreError &&
        error.code === 'conflict',
    );

    const entry = marketplaces.list([]).entries[0];
    assert.ok(entry?.contentDigest);
    const icon = await marketplaces.resolveEntryIcon(
      source.marketplaceId,
      entry.entryId,
    );
    assert.ok(icon);
    await rm(icon.absolutePath);
    await mkdir(icon.absolutePath);
    await assert.rejects(
      marketplaces.resolveEntryIcon(source.marketplaceId, entry.entryId),
      (error: unknown) =>
        error instanceof PluginMarketplaceStoreError &&
        error.code === 'corrupt_registry',
    );
    await rm(icon.absolutePath, { recursive: true });
    await writeFile(icon.absolutePath, 'fixture-icon');

    const managedPluginRoot = join(
      homeRoot,
      'extensions',
      'marketplaces',
      'sources',
      source.marketplaceId,
      'repository',
      'plugins',
      'workflow-helper',
    );
    const managedSkillPath = join(
      managedPluginRoot,
      'skills',
      'workflow',
      'SKILL.md',
    );
    const managedSkill = await readFile(managedSkillPath, 'utf8');
    await writeFile(
      managedSkillPath,
      `${managedSkill}\nChanged after catalog inspection.\n`,
    );
    await assert.rejects(
      marketplaces.resolveInstallCandidate({
        marketplaceId: source.marketplaceId,
        entryId: entry.entryId,
        expectedContentDigest: entry.contentDigest,
      }),
      (error: unknown) =>
        error instanceof PluginMarketplaceStoreError &&
        error.code === 'conflict',
    );
  } finally {
    await fixture.cleanup();
  }
});

void test('marketplace acquisition rejects missing and malformed catalogs before publication', async () => {
  const fixture = await createMarketplaceFixture();
  const marketplaces = createPluginMarketplaceStore({
    homeStateRoot: join(fixture.root, 'home'),
    acquireGitRepository: async ({ repositoryRoot, url }) => {
      await cp(fixture.repositoryRoot, repositoryRoot, { recursive: true });
      const catalogPath = join(
        repositoryRoot,
        '.agents',
        'plugins',
        'marketplace.json',
      );
      if (url.endsWith('/missing.git')) {
        await rm(catalogPath);
      } else if (url.endsWith('/invalid-json.git')) {
        await writeFile(catalogPath, '{not-json');
      } else if (url.endsWith('/invalid-identity.git')) {
        await writeFile(catalogPath, JSON.stringify({ name: '', plugins: [] }));
      } else if (url.endsWith('/invalid-plugins.git')) {
        await writeFile(
          catalogPath,
          JSON.stringify({ name: 'invalid-plugins', plugins: {} }),
        );
      }
    },
  });
  try {
    await marketplaces.initialize();
    for (const name of [
      'missing',
      'invalid-json',
      'invalid-identity',
      'invalid-plugins',
    ]) {
      await assert.rejects(
        marketplaces.add({
          sourceKind: 'git',
          url: `https://github.com/example/${name}.git`,
        }),
        (error: unknown) =>
          error instanceof PluginMarketplaceStoreError &&
          error.code === 'invalid_request',
      );
    }
    await assert.rejects(
      marketplaces.ensureOfficialMarketplace(),
      (error: unknown) =>
        error instanceof PluginMarketplaceStoreError &&
        error.code === 'invalid_request',
    );
    assert.deepEqual(marketplaces.list([]), {
      sources: [],
      entries: [],
      diagnostics: [],
    });
  } finally {
    await fixture.cleanup();
  }
});
