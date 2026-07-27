import assert from 'node:assert/strict';
import { chmod, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  createFixture,
  downgradeRegistryFixture,
  escapeRegExp,
  exists,
  getManagedPluginPackageRoot,
  writePluginPackage,
} from '../../test-support/plugin-store-test-support.js';
import { inspectPluginPackage } from './plugin-package-admission.js';
import { createPluginStore } from './plugin-store.js';
import { PluginStoreError } from './plugin-store-contract.js';

void test('fresh Home initialization creates the root without materializing plugin storage', async () => {
  const fixture = await createFixture('fresh-home');

  try {
    await rm(fixture.homeRoot, { recursive: true, force: true });
    const store = createPluginStore({ homeStateRoot: fixture.homeRoot });
    await store.initialize();
    assert.deepEqual(store.listPlugins(), []);
    assert.equal(await exists(fixture.homeRoot), true);
    assert.equal(await exists(join(fixture.homeRoot, 'extensions')), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

void test('plugin store imports an official package shape, preserves additive metadata, and reloads its managed copy', async () => {
  const fixture = await createFixture('valid');
  const sourceRoot = join(fixture.computerRoot, 'plugins', 'official-example');
  const lifecycleMarker = join(fixture.root, 'install-script-ran');

  try {
    await writePluginPackage(sourceRoot, {
      manifest: {
        name: 'official-example',
        version: '1.2.3-beta.1+build.7',
        description: 'Official-shaped example.',
        author: { name: 'Example author', futureField: true },
        skills: './skills/',
        mcpServers: {
          inline: {
            command: 'node',
            args: ['inline-server.mjs'],
            env: {
              XCODEBUILDMCP_ENABLED_WORKFLOWS: 'build,test',
            },
          },
          shared: { command: 'node', args: ['inline-shared.mjs'] },
        },
        apps: './.app.json',
        futureMetadata: { preserved: true },
        interface: {
          displayName: 'Official Example',
          capabilities: ['Interactive', 'Write'],
          futureInterfaceField: 'inert',
        },
      },
      files: {
        'skills/example/SKILL.md':
          '---\nname: example\ndescription: Example skill\n---\n',
        '.mcp.json': JSON.stringify({
          mcpServers: {
            example: {
              type: 'http',
              url: 'https://example.invalid/mcp',
              bearer_token_env_var: 'EXAMPLE_MCP_TOKEN',
              additiveField: true,
            },
            shared: {
              command: 'node',
              args: ['inline-shared.mjs'],
            },
          },
        }),
        '.app.json': JSON.stringify({
          apps: {
            example: {
              id: 'connector_example',
              required: true,
              additiveField: { remainsInPackage: true },
            },
          },
          futureTopLevelField: true,
        }),
        'package.json': JSON.stringify({
          scripts: {
            install: `node -e "require('node:fs').writeFileSync('${lifecycleMarker}', 'ran')"`,
          },
        }),
      },
    });

    const firstStore = createPluginStore({ homeStateRoot: fixture.homeRoot });
    await firstStore.initialize();
    const installed = await firstStore.installPlugin(
      { root: 'computer', path: 'plugins/official-example' },
      fixture.computerFileScope,
    );

    assert.equal(installed.name, 'official-example');
    assert.equal(installed.displayName, 'Official Example');
    assert.equal(installed.version, '1.2.3-beta.1+build.7');
    assert.equal(installed.enabled, false);
    assert.match(installed.contentDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(installed.capabilities, [
      {
        kind: 'skills',
        supportStatus: 'supported',
        itemCount: 1,
      },
      {
        kind: 'mcpServers',
        supportStatus: 'partially-supported',
        itemCount: 3,
      },
      { kind: 'apps', supportStatus: 'unsupported', itemCount: 1 },
    ]);
    assert.equal(await exists(lifecycleMarker), false);

    const registryPath = join(fixture.homeRoot, 'extensions', 'registry.json');
    const registry = await readFile(registryPath, 'utf8');
    assert.doesNotMatch(registry, new RegExp(escapeRegExp(fixture.root), 'u'));
    assert.doesNotMatch(registry, /sourcePath|managedPath|secretValue/u);
    const managedPackageRoot = await getManagedPluginPackageRoot(
      fixture.homeRoot,
      installed.installationId,
    );

    const managedManifest = JSON.parse(
      await readFile(
        join(managedPackageRoot, '.codex-plugin', 'plugin.json'),
        'utf8',
      ),
    ) as {
      author?: { futureField?: boolean };
      futureMetadata?: { preserved?: boolean };
      interface?: { futureInterfaceField?: string };
    };
    assert.equal(managedManifest.author?.futureField, true);
    assert.equal(managedManifest.futureMetadata?.preserved, true);
    assert.equal(managedManifest.interface?.futureInterfaceField, 'inert');

    await rm(sourceRoot, { recursive: true, force: true });
    const reloadedStore = createPluginStore({
      homeStateRoot: fixture.homeRoot,
    });
    await reloadedStore.initialize();
    assert.deepEqual(reloadedStore.listPlugins(), [installed]);
    assert.equal(
      await exists(join(managedPackageRoot, 'skills', 'example', 'SKILL.md')),
      true,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

void test('enabled plugin Skills are discovered by metadata and read from the managed copy on demand', async () => {
  const fixture = await createFixture('skill-runtime');
  const sourceRoot = join(fixture.computerRoot, 'skill-runtime');
  const bodySentinel = 'BODY_SENTINEL_ONLY_AFTER_EXPLICIT_READ';

  try {
    await writePluginPackage(sourceRoot, {
      manifest: {
        name: 'skill-runtime',
        version: '1.0.0',
        description: 'Exercises managed Skill discovery and reads.',
      },
      files: {
        'skills/active/SKILL.md': `---\nname: active\ndescription: Helps with active documents.\n---\n\n${bodySentinel}\n`,
        'skills/active/agents/openai.yaml':
          'policy:\n  allow_implicit_invocation: false\n',
        'skills/active/references/guide.md': '# Managed guide\n',
        'skills/dependent/SKILL.md':
          '---\nname: dependent\ndescription: Needs an unavailable external tool.\n---\n',
        'skills/dependent/agents/openai.yaml':
          'dependencies:\n  tools:\n    - type: mcp\n      value: unavailable\n',
      },
    });

    const store = createPluginStore({ homeStateRoot: fixture.homeRoot });
    await store.initialize();
    const installed = await store.installPlugin(
      { root: 'computer', path: 'skill-runtime' },
      fixture.computerFileScope,
    );

    assert.deepEqual(await store.listPluginSkills(), {
      skills: [],
      diagnostics: [],
    });
    const disabledInventory = await store.listPluginSkills({
      includeDisabled: true,
    });
    assert.equal(disabledInventory.skills.length, 2);
    const disabledActive = disabledInventory.skills.find(
      (skill) => skill.name === 'active',
    );
    assert.ok(disabledActive);
    assert.equal(disabledActive.enabled, false);
    assert.equal(disabledActive.allowImplicitInvocation, false);
    assert.match(
      disabledActive.instructionsRef,
      new RegExp(
        `^geulbat-skill/${installed.installationId}/[a-f0-9]{64}/SKILL\\.md$`,
        'u',
      ),
    );
    assert.doesNotMatch(
      JSON.stringify(disabledInventory),
      new RegExp(`${escapeRegExp(fixture.root)}|${bodySentinel}`, 'u'),
    );
    await assert.rejects(
      store.readEnabledSkillFile(disabledActive.instructionsRef),
      (error: unknown) =>
        error instanceof PluginStoreError && error.code === 'not_found',
    );

    await store.setEnabled(installed.installationId, true);
    await rm(sourceRoot, { recursive: true, force: true });
    const enabledInventory = await store.listPluginSkills();
    const enabledActive = enabledInventory.skills.find(
      (skill) => skill.name === 'active',
    );
    assert.ok(enabledActive);
    assert.doesNotMatch(
      JSON.stringify(enabledInventory),
      new RegExp(bodySentinel, 'u'),
    );

    const instructions = await store.readEnabledSkillFile(
      enabledActive.instructionsRef,
    );
    assert.match(instructions.content, new RegExp(bodySentinel, 'u'));
    assert.equal(instructions.packageRelativePath, 'skills/active/SKILL.md');
    assert.match(instructions.contentDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.doesNotMatch(
      JSON.stringify(instructions),
      new RegExp(fixture.root, 'u'),
    );

    const guide = await store.readEnabledSkillFile(
      `${enabledActive.skillRootRef}/references/guide.md`,
    );
    assert.equal(guide.content, '# Managed guide\n');
    const rootListing = await store.listEnabledSkillDirectory(
      enabledActive.skillRootRef,
      false,
    );
    assert.deepEqual(
      rootListing.entries.map((entry) => [entry.name, entry.type]),
      [
        ['agents', 'directory'],
        ['references', 'directory'],
        ['SKILL.md', 'file'],
      ],
    );

    const dependent = enabledInventory.skills.find(
      (skill) => skill.name === 'dependent',
    );
    assert.equal(dependent?.runtimeStatus, 'unavailable-tool-dependencies');

    await store.setEnabled(installed.installationId, false);
    await assert.rejects(
      store.readEnabledSkillFile(enabledActive.instructionsRef),
      (error: unknown) =>
        error instanceof PluginStoreError && error.code === 'not_found',
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

void test('legacy plugin registries migrate only host support labels while preserving package inventory checks', async () => {
  const fixture = await createFixture('registry-v1-migration');
  const sourceRoot = join(fixture.computerRoot, 'registry-v1-migration');

  try {
    await writePluginPackage(sourceRoot, {
      manifest: {
        name: 'registry-v1-migration',
        version: '1.0.0',
        description: 'Migrates the host-owned Skill support label.',
      },
      files: {
        'skills/example/SKILL.md':
          '---\nname: example\ndescription: Example migration skill.\n---\n',
      },
    });
    const firstStore = createPluginStore({ homeStateRoot: fixture.homeRoot });
    await firstStore.initialize();
    const installed = await firstStore.installPlugin(
      { root: 'computer', path: 'registry-v1-migration' },
      fixture.computerFileScope,
    );
    const registryPath = join(fixture.homeRoot, 'extensions', 'registry.json');
    await downgradeRegistryFixture({
      homeRoot: fixture.homeRoot,
      installed,
      schemaVersion: 1,
      mutateView: (view) => ({
        ...view,
        capabilities: view.capabilities.map((capability) =>
          capability.kind === 'skills'
            ? { ...capability, supportStatus: 'not-yet-supported' as const }
            : capability,
        ),
      }),
    });

    const reloadedStore = createPluginStore({
      homeStateRoot: fixture.homeRoot,
    });
    await reloadedStore.initialize();
    assert.equal(
      reloadedStore.listPlugins()[0]?.capabilities[0]?.supportStatus,
      'supported',
    );
    const migratedRegistry = JSON.parse(
      await readFile(registryPath, 'utf8'),
    ) as { schemaVersion: number };
    assert.equal(migratedRegistry.schemaVersion, 4);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

void test('v2 registries migrate MCP support labels without weakening inventory matching', async () => {
  const fixture = await createFixture('registry-v2-mcp-migration');
  const sourceRoot = join(fixture.computerRoot, 'registry-v2-mcp-migration');

  try {
    await writePluginPackage(sourceRoot, {
      manifest: {
        name: 'registry-v2-mcp-migration',
        version: '1.0.0',
        description: 'Migrates the host-owned MCP support label.',
        mcpServers: {
          runnable: { command: 'node' },
          remote: {
            type: 'http',
            url: 'https://example.invalid/mcp',
          },
        },
      },
    });
    const firstStore = createPluginStore({ homeStateRoot: fixture.homeRoot });
    await firstStore.initialize();
    const installed = await firstStore.installPlugin(
      { root: 'computer', path: 'registry-v2-mcp-migration' },
      fixture.computerFileScope,
    );
    assert.equal(installed.enabled, false);
    const registryPath = join(fixture.homeRoot, 'extensions', 'registry.json');
    await downgradeRegistryFixture({
      homeRoot: fixture.homeRoot,
      installed,
      schemaVersion: 2,
      mutateView: (view) => ({
        ...view,
        capabilities: view.capabilities.map((capability) =>
          capability.kind === 'mcpServers'
            ? { ...capability, supportStatus: 'not-yet-supported' as const }
            : capability,
        ),
      }),
    });

    const reloadedStore = createPluginStore({
      homeStateRoot: fixture.homeRoot,
    });
    await reloadedStore.initialize();
    assert.deepEqual(reloadedStore.listPlugins()[0]?.capabilities, [
      {
        kind: 'mcpServers',
        supportStatus: 'partially-supported',
        itemCount: 2,
      },
    ]);
    const migratedRegistry = JSON.parse(
      await readFile(registryPath, 'utf8'),
    ) as { schemaVersion: number };
    assert.equal(migratedRegistry.schemaVersion, 4);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

void test('enabled Skill discovery and reads fail closed after managed bytes are tampered', async () => {
  const fixture = await createFixture('skill-tamper');
  const sourceRoot = join(fixture.computerRoot, 'skill-tamper');

  try {
    await writePluginPackage(sourceRoot, {
      manifest: {
        name: 'skill-tamper',
        version: '1.0.0',
        description: 'Tampered Skill bytes must never reach the model.',
      },
      files: {
        'skills/guarded/SKILL.md':
          '---\nname: guarded\ndescription: Original trusted metadata.\n---\n',
      },
    });
    const store = createPluginStore({ homeStateRoot: fixture.homeRoot });
    await store.initialize();
    const installed = await store.installPlugin(
      { root: 'computer', path: 'skill-tamper' },
      fixture.computerFileScope,
    );
    await store.setEnabled(installed.installationId, true);
    const before = await store.listPluginSkills();
    const instructionsRef = before.skills[0]?.instructionsRef;
    assert.ok(instructionsRef);
    const managedPackageRoot = await getManagedPluginPackageRoot(
      fixture.homeRoot,
      installed.installationId,
    );

    await writeFile(
      join(managedPackageRoot, 'skills', 'guarded', 'SKILL.md'),
      '---\nname: guarded\ndescription: Tampered metadata.\n---\n',
    );

    const after = await store.listPluginSkills();
    assert.deepEqual(after.skills, []);
    assert.deepEqual(after.diagnostics, [
      {
        pluginInstallationId: installed.installationId,
        pluginName: installed.name,
        code: 'managed-package-invalid',
        message: 'managed plugin package is missing, invalid, or inconsistent',
      },
    ]);
    await assert.rejects(
      store.readEnabledSkillFile(instructionsRef),
      (error: unknown) =>
        error instanceof PluginStoreError && error.code === 'corrupt_registry',
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

void test('interface capability labels do not become executable capability inventory', async () => {
  const fixture = await createFixture('interface-inert');
  const sourceRoot = join(fixture.computerRoot, 'interface-only');

  try {
    await writePluginPackage(sourceRoot, {
      manifest: {
        name: 'interface-only',
        version: '0.1.0',
        description: 'Metadata is not execution authority.',
        interface: {
          displayName: 'Interface only',
          capabilities: ['Skills', 'MCP', 'Hooks'],
        },
        documentationPath: 'docs/missing.md',
      },
    });
    const store = createPluginStore({ homeStateRoot: fixture.homeRoot });
    await store.initialize();
    const installed = await store.installPlugin(
      { root: 'computer', path: 'interface-only' },
      fixture.computerFileScope,
    );
    assert.deepEqual(installed.capabilities, []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

void test('content digest is stable across portable filesystem mode differences', async () => {
  const fixture = await createFixture('portable-digest');
  const sourceA = join(fixture.computerRoot, 'portable-a');
  const sourceB = join(fixture.computerRoot, 'portable-b');
  const manifest = {
    name: 'portable-digest',
    version: '1.0.0',
    description: 'Logical package bytes own the digest.',
  };

  try {
    await writePluginPackage(sourceA, {
      manifest,
      files: { 'assets/example.txt': 'same bytes' },
    });
    await writePluginPackage(sourceB, {
      manifest,
      files: { 'assets/example.txt': 'same bytes' },
    });
    if (process.platform !== 'win32') {
      await chmod(sourceB, 0o755);
      await chmod(join(sourceB, 'assets'), 0o700);
      await chmod(join(sourceB, 'assets', 'example.txt'), 0o700);
    }

    const store = createPluginStore({ homeStateRoot: fixture.homeRoot });
    await store.initialize();
    const installedA = await store.installPlugin(
      { root: 'computer', path: 'portable-a' },
      fixture.computerFileScope,
    );
    const installedB = await store.installPlugin(
      { root: 'computer', path: 'portable-b' },
      fixture.computerFileScope,
    );
    assert.equal(installedA.contentDigest, installedB.contentDigest);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

void test('custom component paths supplement conventional paths and de-duplicate named entries', async () => {
  const fixture = await createFixture('supplemental-paths');
  const sourceRoot = join(fixture.computerRoot, 'supplemental-paths');

  try {
    await writePluginPackage(sourceRoot, {
      manifest: {
        name: 'supplemental-paths',
        version: '1.0.0',
        description: 'Custom and conventional component paths coexist.',
        skills: './custom-skills',
        mcpServers: './config/custom-mcp.json',
        apps: './config/custom-app.json',
        hooks: './config/custom-hook.json',
      },
      files: {
        'skills/default/SKILL.md':
          '---\nname: default\ndescription: Default skill\n---\n',
        'custom-skills/custom/SKILL.md':
          '---\nname: custom\ndescription: Custom skill\n---\n',
        '.mcp.json': JSON.stringify({
          mcpServers: { shared: {}, default: {} },
        }),
        'config/custom-mcp.json': JSON.stringify({
          mcpServers: { shared: {}, custom: {} },
        }),
        '.app.json': JSON.stringify({
          apps: { shared: {}, default: {} },
        }),
        'config/custom-app.json': JSON.stringify({
          apps: { shared: {}, custom: {} },
        }),
        'hooks/default.json': '{}',
        'config/custom-hook.json': '{}',
      },
    });
    const store = createPluginStore({ homeStateRoot: fixture.homeRoot });
    await store.initialize();
    const installed = await store.installPlugin(
      { root: 'computer', path: 'supplemental-paths' },
      fixture.computerFileScope,
    );

    assert.deepEqual(installed.capabilities, [
      {
        kind: 'skills',
        supportStatus: 'supported',
        itemCount: 2,
      },
      {
        kind: 'mcpServers',
        supportStatus: 'not-yet-supported',
        itemCount: 3,
      },
      { kind: 'apps', supportStatus: 'unsupported', itemCount: 3 },
      { kind: 'hooks', supportStatus: 'unsupported', itemCount: 2 },
    ]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

void test('credential-shaped MCP server identities remain names rather than credential values', async () => {
  const fixture = await createFixture('credential-shaped-mcp-name');
  const sourceRoot = join(fixture.computerRoot, 'credential-shaped-mcp-name');

  try {
    await writePluginPackage(sourceRoot, {
      manifest: {
        name: 'credential-shaped-mcp-name',
        version: '1.0.0',
        description: 'Component identities are not configuration field names.',
        mcpServers: './.mcp.json',
      },
      files: {
        '.mcp.json': JSON.stringify({
          mcpServers: {
            'openai-api-key-local-confirmation': {
              cwd: '.',
              command: 'node',
              args: ['./mcp/server.mjs'],
            },
          },
        }),
        'mcp/server.mjs': 'process.stdin.resume();\n',
      },
    });

    const inspected = await inspectPluginPackage(sourceRoot);
    assert.deepEqual(
      inspected.mcpServers.map((server) => ({
        name: server.name,
        supportStatus: server.supportStatus,
      })),
      [
        {
          name: 'openai-api-key-local-confirmation',
          supportStatus: 'supported',
        },
      ],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

void test('bundled MCP inventory keeps unsupported entries inert and resolves only enabled digest-pinned stdio servers', async () => {
  const fixture = await createFixture('bundled-mcp-runtime');
  const sourceRoot = join(fixture.computerRoot, 'bundled-mcp-runtime');
  const runnableConfig = {
    type: 'stdio',
    command: './server.mjs',
    args: ['--mode', 'plugin'],
    cwd: 'runtime',
    env_vars: ['MCP_TOKEN', 'HOME', 'MCP_TOKEN'],
    connectionTimeoutMs: 3_000,
    requestTimeoutMs: 9_000,
  };

  try {
    await writePluginPackage(sourceRoot, {
      manifest: {
        name: 'bundled-mcp-runtime',
        version: '1.0.0',
        description: 'Runnable and inert bundled MCP declarations.',
        mcpServers: './config/custom-mcp.json',
      },
      files: {
        'runtime/server.mjs': 'process.stdin.resume();\n',
        'config/custom-mcp.json': JSON.stringify({
          runnable: runnableConfig,
        }),
        '.mcp.json': JSON.stringify({
          mcpServers: {
            runnable: runnableConfig,
            http: {
              type: 'http',
              url: 'https://example.invalid/mcp',
            },
            'literal-env': {
              command: 'node',
              env: { PLUGIN_MODE: 'literal' },
            },
            'absolute-cwd': { command: 'node', cwd: '/tmp' },
            'absolute-command': { command: '/usr/bin/node' },
            'ambiguous-command': { command: 'node --version' },
          },
        }),
      },
    });

    const inspected = await inspectPluginPackage(sourceRoot);
    assert.deepEqual(inspected.capabilities, [
      {
        kind: 'mcpServers',
        supportStatus: 'partially-supported',
        itemCount: 6,
      },
    ]);
    assert.deepEqual(
      inspected.mcpServers.map((server) => ({
        name: server.name,
        sourcePath: server.sourcePath,
        supportStatus: server.supportStatus,
        hasDiagnostic: server.diagnostic !== undefined,
      })),
      [
        {
          name: 'absolute-command',
          sourcePath: '.mcp.json',
          supportStatus: 'unsupported',
          hasDiagnostic: true,
        },
        {
          name: 'absolute-cwd',
          sourcePath: '.mcp.json',
          supportStatus: 'unsupported',
          hasDiagnostic: true,
        },
        {
          name: 'ambiguous-command',
          sourcePath: '.mcp.json',
          supportStatus: 'unsupported',
          hasDiagnostic: true,
        },
        {
          name: 'http',
          sourcePath: '.mcp.json',
          supportStatus: 'unsupported',
          hasDiagnostic: true,
        },
        {
          name: 'literal-env',
          sourcePath: '.mcp.json',
          supportStatus: 'unsupported',
          hasDiagnostic: true,
        },
        {
          name: 'runnable',
          sourcePath: 'config/custom-mcp.json',
          supportStatus: 'supported',
          hasDiagnostic: false,
        },
      ],
    );
    assert.deepEqual(
      inspected.mcpServers.find((server) => server.name === 'runnable')?.config,
      {
        command: './server.mjs',
        args: ['--mode', 'plugin'],
        envKeys: ['MCP_TOKEN', 'HOME'],
        relativeCwd: 'runtime',
        connectionTimeoutMs: 3_000,
        requestTimeoutMs: 9_000,
      },
    );

    const store = createPluginStore({ homeStateRoot: fixture.homeRoot });
    await store.initialize();
    const installed = await store.installPlugin(
      { root: 'computer', path: 'bundled-mcp-runtime' },
      fixture.computerFileScope,
    );
    const disabledServers = await store.listSupportedBundledMcpServers();
    assert.equal(disabledServers.length, 1);
    assert.deepEqual(disabledServers[0], {
      installationId: installed.installationId,
      pluginName: installed.name,
      pluginDisplayName: installed.displayName,
      pluginVersion: installed.version,
      pluginContentDigest: installed.contentDigest,
      pluginEnabled: false,
      pluginServerName: 'runnable',
      sourcePath: 'config/custom-mcp.json',
      config: {
        command: './server.mjs',
        args: ['--mode', 'plugin'],
        envKeys: ['MCP_TOKEN', 'HOME'],
        relativeCwd: 'runtime',
        connectionTimeoutMs: 3_000,
        requestTimeoutMs: 9_000,
      },
    });
    assert.doesNotMatch(
      JSON.stringify(disabledServers),
      new RegExp(escapeRegExp(fixture.root), 'u'),
    );
    await assert.rejects(
      store.resolveBundledMcpServerLaunch({
        installationId: installed.installationId,
        pluginContentDigest: installed.contentDigest,
        pluginServerName: 'runnable',
      }),
      (error: unknown) =>
        error instanceof PluginStoreError && error.code === 'not_found',
    );

    await store.setEnabled(installed.installationId, true);
    const [enabledServer] = await store.listSupportedBundledMcpServers();
    assert.equal(enabledServer?.pluginEnabled, true);
    await assert.rejects(
      store.resolveBundledMcpServerLaunch({
        installationId: installed.installationId,
        pluginContentDigest: `sha256:${'0'.repeat(64)}`,
        pluginServerName: 'runnable',
      }),
      (error: unknown) =>
        error instanceof PluginStoreError && error.code === 'conflict',
    );
    await assert.rejects(
      store.resolveBundledMcpServerLaunch({
        installationId: installed.installationId,
        pluginContentDigest: installed.contentDigest,
        pluginServerName: 'http',
      }),
      (error: unknown) =>
        error instanceof PluginStoreError && error.code === 'not_found',
    );

    const launch = await store.resolveBundledMcpServerLaunch({
      installationId: installed.installationId,
      pluginContentDigest: installed.contentDigest,
      pluginServerName: 'runnable',
    });
    const managedPackageRoot = await getManagedPluginPackageRoot(
      fixture.homeRoot,
      installed.installationId,
    );
    assert.deepEqual(launch, {
      ...enabledServer,
      absoluteCwd: await realpath(join(managedPackageRoot, 'runtime')),
    });
    const persistedRegistry = await readFile(
      join(fixture.homeRoot, 'extensions', 'registry.json'),
      'utf8',
    );
    assert.doesNotMatch(
      persistedRegistry,
      new RegExp(escapeRegExp(launch.absoluteCwd), 'u'),
    );

    await writeFile(
      join(managedPackageRoot, 'runtime', 'server.mjs'),
      'process.exit(1);\n',
      'utf8',
    );
    await assert.rejects(
      store.resolveBundledMcpServerLaunch({
        installationId: installed.installationId,
        pluginContentDigest: installed.contentDigest,
        pluginServerName: 'runnable',
      }),
      (error: unknown) =>
        error instanceof PluginStoreError && error.code === 'corrupt_registry',
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

void test('plugin disable and uninstall persist their registry state and remove managed bytes', async () => {
  const fixture = await createFixture('uninstall');
  const sourceRoot = join(fixture.computerRoot, 'remove-me');

  try {
    await writePluginPackage(sourceRoot, {
      manifest: {
        name: 'remove-me',
        version: '1.0.0',
        description: 'Uninstall test.',
      },
    });
    const store = createPluginStore({ homeStateRoot: fixture.homeRoot });
    await store.initialize();
    const installed = await store.installPlugin(
      { root: 'computer', path: 'remove-me' },
      fixture.computerFileScope,
    );
    const enabled = await store.setEnabled(installed.installationId, true);
    assert.equal(enabled.enabled, true);

    const disabled = await store.setEnabled(installed.installationId, false);
    assert.equal(disabled.enabled, false);

    const managedObjectRoot = join(
      await getManagedPluginPackageRoot(
        fixture.homeRoot,
        installed.installationId,
      ),
      '..',
    );
    await store.setEnabled(installed.installationId, true);
    await store.uninstall(installed.installationId);
    assert.deepEqual(store.listPlugins(), []);
    assert.equal(await exists(managedObjectRoot), false);
    const registry = JSON.parse(
      await readFile(
        join(fixture.homeRoot, 'extensions', 'registry.json'),
        'utf8',
      ),
    ) as { plugins: unknown[] };
    assert.deepEqual(registry.plugins, []);
    await assert.rejects(
      store.setEnabled(installed.installationId, true),
      (error: unknown) =>
        error instanceof PluginStoreError && error.code === 'not_found',
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
