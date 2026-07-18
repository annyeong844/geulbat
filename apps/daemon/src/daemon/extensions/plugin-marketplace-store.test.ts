import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
  OFFICIAL_CODEX_MARKETPLACE_SOURCE,
  createPluginMarketplaceStore,
} from './plugin-marketplace-store.js';
import { PluginMarketplaceStoreError } from './plugin-marketplace-contract.js';
import { acquirePluginMarketplaceGitRepository } from './plugin-marketplace-git.js';
import { createPluginStore } from './plugin-store.js';
import { PluginStoreError } from './plugin-store-contract.js';

void test('real Git acquisition resolves a detached local revision without repository hooks', async () => {
  const fixture = await createMarketplaceFixture();
  const checkoutRoot = join(fixture.root, 'checkout');
  try {
    await acquirePluginMarketplaceGitRepository({
      repositoryRoot: checkoutRoot,
      url: fixture.repositoryRoot,
      requestedRef: null,
      isolatedConfigRoot: join(fixture.root, 'git-runtime'),
    });
    assert.equal(
      await readFile(
        join(checkoutRoot, '.agents', 'plugins', 'marketplace.json'),
        'utf8',
      ).then((value) => value.includes('fixture-marketplace')),
      true,
    );
    assert.equal(
      runGit(checkoutRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
      'HEAD',
    );
  } finally {
    await fixture.cleanup();
  }
});

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

async function createMarketplaceFixture(options?: {
  includeUnsupportedNpm?: boolean;
  invalidManifest?: boolean;
  omitIcon?: boolean;
  marketplaceName?: string;
  marketplaceDisplayName?: string;
}) {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-marketplace-'));
  const repositoryRoot = join(root, 'source');
  const pluginRoot = join(repositoryRoot, 'plugins', 'workflow-helper');
  await mkdir(join(repositoryRoot, '.agents', 'plugins'), { recursive: true });
  await mkdir(join(pluginRoot, '.codex-plugin'), { recursive: true });
  await mkdir(join(pluginRoot, 'assets'), { recursive: true });
  await mkdir(join(pluginRoot, 'skills', 'workflow'), { recursive: true });
  const entries: unknown[] = [
    {
      name: 'workflow-helper',
      source: { source: 'local', path: './plugins/workflow-helper' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Productivity',
    },
  ];
  if (options?.includeUnsupportedNpm) {
    entries.push({
      name: 'npm-helper',
      source: {
        source: 'npm',
        package: '@example/npm-helper',
        version: '^1.0.0',
      },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Developer Tools',
    });
  }
  await writeFile(
    join(repositoryRoot, '.agents', 'plugins', 'marketplace.json'),
    `${JSON.stringify(
      {
        name: options?.marketplaceName ?? 'fixture-marketplace',
        interface: {
          displayName: options?.marketplaceDisplayName ?? 'Fixture marketplace',
        },
        plugins: entries,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(pluginRoot, '.codex-plugin', 'plugin.json'),
    `${JSON.stringify(
      options?.invalidManifest
        ? { name: 'different-name', version: '1.0.0', description: 'Invalid.' }
        : {
            name: 'workflow-helper',
            version: '1.0.0',
            description: 'A fixture workflow.',
            interface: {
              displayName: 'Workflow helper',
              ...(options?.omitIcon ? {} : { logo: './assets/logo.png' }),
            },
            skills: './skills',
          },
      null,
      2,
    )}\n`,
  );
  if (!options?.omitIcon) {
    await writeFile(join(pluginRoot, 'assets', 'logo.png'), 'fixture-icon');
  }
  await writeFile(
    join(pluginRoot, 'skills', 'workflow', 'SKILL.md'),
    '---\nname: authored-workflow\ndescription: Use the fixture workflow.\nmetadata:\n  priority: 2\n  tags: [fixture, workflow]\nallowed-tools:\n  - Read\n---\n\n# Workflow\n',
  );
  runGit(repositoryRoot, ['init', '--quiet']);
  runGit(repositoryRoot, ['config', 'user.email', 'fixture@example.com']);
  runGit(repositoryRoot, ['config', 'user.name', 'Fixture']);
  runGit(repositoryRoot, ['add', '.']);
  runGit(repositoryRoot, ['commit', '--quiet', '-m', 'fixture marketplace']);
  return {
    root,
    repositoryRoot,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
