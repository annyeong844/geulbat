import assert from 'node:assert/strict';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertNoPublication,
  assertRejectedWithoutPublication,
  createFixture,
  escapeRegExp,
  exists,
  getManagedPluginPackageRoot,
  writePluginPackage,
} from '../../test-support/plugin-store-test-support.js';
import { createPluginStore } from './plugin-store.js';
import { PluginStoreError } from './plugin-store-contract.js';

void test('plugin store rejects malformed manifests and Skill documents without partial publication', async () => {
  const fixture = await createFixture('refusals');
  const store = createPluginStore({ homeStateRoot: fixture.homeRoot });

  try {
    await store.initialize();

    const malformed = join(fixture.computerRoot, 'malformed');
    await mkdir(join(malformed, '.codex-plugin'), { recursive: true });
    await writeFile(
      join(malformed, '.codex-plugin', 'plugin.json'),
      '{not-json',
    );
    await assertRejectedWithoutPublication(store, fixture, 'malformed');

    const badSemver = join(fixture.computerRoot, 'bad-semver');
    await writePluginPackage(badSemver, {
      manifest: {
        name: 'bad-semver',
        version: '01.2.3',
        description: 'Leading zero is not strict semver.',
      },
    });
    await assertRejectedWithoutPublication(store, fixture, 'bad-semver');

    const badName = join(fixture.computerRoot, 'bad-name');
    await writePluginPackage(badName, {
      manifest: {
        name: 'Bad_Name',
        version: '1.0.0',
        description: 'Plugin names use canonical kebab-case.',
      },
    });
    await assertRejectedWithoutPublication(store, fixture, 'bad-name');

    for (const [directory, skillDocument] of [
      ['skill-missing-frontmatter', 'plain instructions'],
      [
        'skill-malformed-yaml',
        '---\nname: [broken\ndescription: Invalid YAML.\n---\n',
      ],
    ] as const) {
      const packageRoot = join(fixture.computerRoot, directory);
      await writePluginPackage(packageRoot, {
        manifest: {
          name: directory,
          version: '1.0.0',
          description: 'Invalid Skill package.',
        },
        files: { [`skills/${directory}/SKILL.md`]: skillDocument },
      });
      await assertRejectedWithoutPublication(store, fixture, directory);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

void test('plugin store rejects invalid MCP and app component declarations without partial publication', async () => {
  const fixture = await createFixture('component-refusals');
  const store = createPluginStore({ homeStateRoot: fixture.homeRoot });

  try {
    await store.initialize();

    const invalidInlineMcp = join(
      fixture.computerRoot,
      'inline-mcp-non-object',
    );
    await writePluginPackage(invalidInlineMcp, {
      manifest: {
        name: 'inline-mcp-non-object',
        version: '1.0.0',
        description: 'Inline MCP entries must be objects.',
        mcpServers: { invalid: 'not-an-object' },
      },
    });
    await assertRejectedWithoutPublication(
      store,
      fixture,
      'inline-mcp-non-object',
    );

    const conflictingMcp = join(fixture.computerRoot, 'mcp-config-conflict');
    await writePluginPackage(conflictingMcp, {
      manifest: {
        name: 'mcp-config-conflict',
        version: '1.0.0',
        description: 'Same-name MCP declarations must agree.',
        mcpServers: { shared: { command: 'node' } },
      },
      files: {
        '.mcp.json': JSON.stringify({
          mcpServers: { shared: { command: 'bun' } },
        }),
      },
    });
    await assertRejectedWithoutPublication(
      store,
      fixture,
      'mcp-config-conflict',
    );

    const collidingMcpName = join(fixture.computerRoot, 'mcp-name-collision');
    await writePluginPackage(collidingMcpName, {
      manifest: {
        name: 'mcp-name-collision',
        version: '1.0.0',
        description: 'Normalized MCP names must not collide.',
        mcpServers: { Shared: { command: 'node' } },
      },
      files: {
        '.mcp.json': JSON.stringify({
          mcpServers: { shared: { command: 'node' } },
        }),
      },
    });
    await assertRejectedWithoutPublication(
      store,
      fixture,
      'mcp-name-collision',
    );

    for (const invalidComponent of [
      {
        directory: 'mcp-empty-name',
        file: '.mcp.json',
        config: { mcpServers: { '': {} } },
      },
      {
        directory: 'mcp-non-object',
        file: '.mcp.json',
        config: { mcpServers: { invalid: 'not-an-object' } },
      },
      {
        directory: 'app-empty-name',
        file: '.app.json',
        config: { apps: { '': {} } },
      },
      {
        directory: 'app-non-object',
        file: '.app.json',
        config: { apps: { invalid: 'not-an-object' } },
      },
    ]) {
      const packageRoot = join(
        fixture.computerRoot,
        invalidComponent.directory,
      );
      await writePluginPackage(packageRoot, {
        manifest: {
          name: invalidComponent.directory,
          version: '1.0.0',
          description: 'Named component entries must be objects.',
        },
        files: {
          [invalidComponent.file]: JSON.stringify(invalidComponent.config),
        },
      });
      await assertRejectedWithoutPublication(
        store,
        fixture,
        invalidComponent.directory,
      );
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

void test('plugin store rejects escaping paths, links, and case-fold collisions without partial publication', async (t) => {
  const fixture = await createFixture('filesystem-refusals');
  const store = createPluginStore({ homeStateRoot: fixture.homeRoot });

  try {
    await store.initialize();

    for (const [directory, declaredPath] of [
      ['parent-traversal', '../outside'],
      ['posix-absolute', '/outside'],
      ['windows-absolute', 'C:\\outside\\skills'],
      ['unc-absolute', '\\\\server\\share\\skills'],
    ] as const) {
      const packageRoot = join(fixture.computerRoot, directory);
      await writePluginPackage(packageRoot, {
        manifest: {
          name: directory,
          version: '1.0.0',
          description: 'Escaping component path.',
          skills: declaredPath,
        },
      });
      await assertRejectedWithoutPublication(store, fixture, directory);
    }

    const symlinked = join(fixture.computerRoot, 'symlinked');
    await writePluginPackage(symlinked, {
      manifest: {
        name: 'symlinked',
        version: '1.0.0',
        description: 'Contains a link.',
      },
    });
    const outsideDirectory = join(fixture.root, 'outside-directory');
    await mkdir(outsideDirectory, { recursive: true });
    await symlink(
      outsideDirectory,
      join(symlinked, 'linked-directory'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assertRejectedWithoutPublication(store, fixture, 'symlinked');

    const hardlinked = join(fixture.computerRoot, 'hardlinked');
    await writePluginPackage(hardlinked, {
      manifest: {
        name: 'hardlinked',
        version: '1.0.0',
        description: 'Contains a hard link.',
      },
      files: { 'asset.txt': 'asset' },
    });
    await link(
      join(hardlinked, 'asset.txt'),
      join(hardlinked, 'asset-copy.txt'),
    );
    await assertRejectedWithoutPublication(store, fixture, 'hardlinked');

    const colliding = join(fixture.computerRoot, 'colliding');
    await writePluginPackage(colliding, {
      manifest: {
        name: 'colliding',
        version: '1.0.0',
        description: 'Contains case-folding collisions.',
      },
      files: { 'Readme.md': 'one', 'README.md': 'two' },
    });
    const caseVariants = (await readdir(colliding)).filter(
      (entry) => entry.toLocaleLowerCase('en-US') === 'readme.md',
    );
    if (caseVariants.length === 2) {
      await assertRejectedWithoutPublication(store, fixture, 'colliding');
    } else {
      t.diagnostic(
        'case-fold collision construction is unavailable on this filesystem',
      );
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

void test('plugin store rejects secret-bearing packages and escaping source requests without partial publication', async () => {
  const fixture = await createFixture('secret-and-source-refusals');
  const store = createPluginStore({ homeStateRoot: fixture.homeRoot });

  try {
    await store.initialize();

    const inlineSecret = join(fixture.computerRoot, 'inline-secret');
    await writePluginPackage(inlineSecret, {
      manifest: {
        name: 'inline-secret',
        version: '1.0.0',
        description: 'Must refuse inline credentials.',
        mcpServers: './.mcp.json',
      },
      files: {
        '.mcp.json': JSON.stringify({
          mcpServers: {
            unsafe: { command: 'node', apiKey: 'must-not-be-copied' },
          },
        }),
      },
    });
    await assertRejectedWithoutPublication(store, fixture, 'inline-secret');

    const nestedInlineSecret = join(
      fixture.computerRoot,
      'nested-inline-secret',
    );
    await writePluginPackage(nestedInlineSecret, {
      manifest: {
        name: 'nested-inline-secret',
        version: '1.0.0',
        description: 'Must refuse nested inline credentials.',
        mcpServers: './.mcp.json',
      },
      files: {
        '.mcp.json': JSON.stringify({
          mcpServers: {
            unsafe: {
              command: 'node',
              metadata: {
                apps: { apiKey: 'must-not-be-copied' },
              },
            },
          },
        }),
      },
    });
    await assertRejectedWithoutPublication(
      store,
      fixture,
      'nested-inline-secret',
    );

    for (const path of [
      '../outside',
      '/outside',
      'C:\\outside',
      '\\\\server\\share',
    ]) {
      await assert.rejects(
        store.installPlugin(
          { root: 'computer', path },
          fixture.computerFileScope,
        ),
        (error: unknown) =>
          error instanceof PluginStoreError && error.code === 'invalid_request',
      );
    }
    await assertNoPublication(fixture, store);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

void test('registry publication failure removes renamed package bytes and atomic-write remnants', async () => {
  const fixture = await createFixture('publish-failure');
  const sourceRoot = join(fixture.computerRoot, 'publish-failure');
  const extensionsRoot = join(fixture.homeRoot, 'extensions');

  try {
    await writePluginPackage(sourceRoot, {
      manifest: {
        name: 'publish-failure',
        version: '1.0.0',
        description: 'Registry publication must be the activation truth.',
      },
    });
    const store = createPluginStore({ homeStateRoot: fixture.homeRoot });
    await store.initialize();
    await mkdir(join(extensionsRoot, 'registry.json'), { recursive: true });

    let failure: unknown;
    try {
      await store.installPlugin(
        { root: 'computer', path: 'publish-failure' },
        fixture.computerFileScope,
      );
    } catch (error: unknown) {
      failure = error;
    }
    assert.ok(failure instanceof Error);
    assert.doesNotMatch(
      failure.message,
      new RegExp(escapeRegExp(fixture.root), 'u'),
    );
    assert.deepEqual(store.listPlugins(), []);
    assert.deepEqual(await readdir(join(extensionsRoot, '.staging')), []);
    assert.deepEqual(await readdir(join(extensionsRoot, 'plugins')), []);
    assert.deepEqual((await readdir(extensionsRoot)).sort(), [
      '.staging',
      'plugins',
      'registry.json',
    ]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

void test('managed plugins root symlink fails closed without touching its external target', async () => {
  const fixture = await createFixture('managed-root-link');
  const extensionsRoot = join(fixture.homeRoot, 'extensions');
  const externalRoot = join(fixture.root, 'external-managed-target');
  const sentinel = join(externalRoot, 'sentinel.txt');

  try {
    await mkdir(extensionsRoot, { recursive: true });
    await mkdir(externalRoot, { recursive: true });
    await writeFile(sentinel, 'must survive reconciliation');
    await symlink(
      externalRoot,
      join(extensionsRoot, 'plugins'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const store = createPluginStore({ homeStateRoot: fixture.homeRoot });
    let failure: unknown;
    try {
      await store.initialize();
    } catch (error: unknown) {
      failure = error;
    }
    assert.ok(failure instanceof PluginStoreError);
    assert.equal(failure.code, 'corrupt_registry');
    assert.doesNotMatch(
      failure.message,
      new RegExp(escapeRegExp(fixture.root), 'u'),
    );
    assert.equal(
      await readFile(sentinel, 'utf8'),
      'must survive reconciliation',
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

void test('plugin source cannot contain or live inside the Home state tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-plugin-overlap-'));
  const computerRoot = join(root, 'computer');
  const homeRoot = join(computerRoot, 'home');
  const hardLinkSource = join(computerRoot, '00-stop-before-recursion.txt');

  try {
    await mkdir(homeRoot, { recursive: true });
    await writePluginPackage(computerRoot, {
      manifest: {
        name: 'overlapping-home',
        version: '1.0.0',
        description: 'The source tree must never contain managed staging.',
      },
    });
    await writeFile(hardLinkSource, 'old implementations must stop early');
    await link(hardLinkSource, join(computerRoot, '00-stop-copy.txt'));

    const store = createPluginStore({ homeStateRoot: homeRoot });
    await store.initialize();
    await assert.rejects(
      store.installPlugin(
        { root: 'computer', path: '.' },
        { root: computerRoot, browseShortcuts: [] },
      ),
      (error: unknown) =>
        error instanceof PluginStoreError && error.code === 'invalid_request',
    );
    assert.equal(await exists(join(homeRoot, 'extensions')), false);
    assert.deepEqual(store.listPlugins(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('post-initialization managed-root replacement cannot redirect uninstall', async () => {
  const fixture = await createFixture('managed-root-replacement');
  const sourceRoot = join(fixture.computerRoot, 'managed-root-replacement');
  const extensionsRoot = join(fixture.homeRoot, 'extensions');
  const pluginsRoot = join(extensionsRoot, 'plugins');
  const parkedPluginsRoot = join(extensionsRoot, 'plugins-original');
  const outsidePluginsRoot = join(fixture.root, 'outside-plugins');

  try {
    await writePluginPackage(sourceRoot, {
      manifest: {
        name: 'managed-root-replacement',
        version: '1.0.0',
        description: 'Managed root identity must remain anchored.',
      },
    });
    const store = createPluginStore({ homeStateRoot: fixture.homeRoot });
    await store.initialize();
    const installed = await store.installPlugin(
      { root: 'computer', path: 'managed-root-replacement' },
      fixture.computerFileScope,
    );

    const outsideSentinel = join(
      outsidePluginsRoot,
      installed.installationId,
      'sentinel.txt',
    );
    await mkdir(join(outsideSentinel, '..'), { recursive: true });
    await writeFile(outsideSentinel, 'must not be removed');
    await rename(pluginsRoot, parkedPluginsRoot);
    await symlink(
      outsidePluginsRoot,
      pluginsRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await assert.rejects(
      store.uninstall(installed.installationId),
      (error: unknown) =>
        error instanceof PluginStoreError && error.code === 'corrupt_registry',
    );
    assert.equal(
      await readFile(outsideSentinel, 'utf8'),
      'must not be removed',
    );
    const registry = JSON.parse(
      await readFile(join(extensionsRoot, 'registry.json'), 'utf8'),
    ) as { plugins: Array<{ view: { installationId: string } }> };
    assert.deepEqual(
      registry.plugins.map((plugin) => plugin.view.installationId),
      [installed.installationId],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

void test('enabling refuses tampered managed bytes while uninstall remains available', async () => {
  const fixture = await createFixture('tampered-enable');
  const sourceRoot = join(fixture.computerRoot, 'tampered-enable');

  try {
    await writePluginPackage(sourceRoot, {
      manifest: {
        name: 'tampered-enable',
        version: '1.0.0',
        description: 'Eligibility requires bytes matching the registry digest.',
      },
      files: { 'asset.txt': 'one' },
    });
    const store = createPluginStore({ homeStateRoot: fixture.homeRoot });
    await store.initialize();
    const installed = await store.installPlugin(
      { root: 'computer', path: 'tampered-enable' },
      fixture.computerFileScope,
    );
    const managedAsset = join(
      await getManagedPluginPackageRoot(
        fixture.homeRoot,
        installed.installationId,
      ),
      'asset.txt',
    );
    await writeFile(managedAsset, 'two');

    await assert.rejects(
      store.setEnabled(installed.installationId, true),
      (error: unknown) =>
        error instanceof PluginStoreError && error.code === 'corrupt_registry',
    );
    assert.equal(store.listPlugins()[0]?.enabled, false);

    await store.uninstall(installed.installationId);
    assert.deepEqual(store.listPlugins(), []);
    assert.equal(await exists(managedAsset), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

void test('corrupt registry fails closed before staging or orphan reconciliation', async () => {
  const fixture = await createFixture('corrupt-registry');
  const stagingSentinel = join(
    fixture.homeRoot,
    'extensions',
    '.staging',
    'unfinished',
    'sentinel.txt',
  );
  const orphanSentinel = join(
    fixture.homeRoot,
    'extensions',
    'plugins',
    'orphan',
    'sentinel.txt',
  );

  try {
    await mkdir(join(fixture.homeRoot, 'extensions'), { recursive: true });
    await mkdir(join(stagingSentinel, '..'), { recursive: true });
    await mkdir(join(orphanSentinel, '..'), { recursive: true });
    await writeFile(stagingSentinel, 'keep until registry is understood');
    await writeFile(orphanSentinel, 'keep until registry is understood');
    await writeFile(
      join(fixture.homeRoot, 'extensions', 'registry.json'),
      JSON.stringify({
        schemaVersion: 1,
        plugins: [],
        secretValue: 'must-not-be-accepted',
      }),
    );

    const store = createPluginStore({ homeStateRoot: fixture.homeRoot });
    await assert.rejects(
      store.initialize(),
      (error: unknown) =>
        error instanceof PluginStoreError && error.code === 'corrupt_registry',
    );
    assert.equal(await exists(stagingSentinel), true);
    assert.equal(await exists(orphanSentinel), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
