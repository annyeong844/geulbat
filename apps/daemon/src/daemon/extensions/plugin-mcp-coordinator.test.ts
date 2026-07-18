import assert from 'node:assert/strict';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import type { ComputerFileScope } from '../files/computer-file-scope.js';
import { createGlobalMcpRuntime } from '../mcp/global-mcp-runtime.js';
import { createToolRegistryStore } from '../tools/registry.js';
import { createMcpCoordinatedPluginStore } from '../plugin-mcp-coordinator.js';
import { PluginStoreError, createPluginStore } from './plugin-store.js';

const require = createRequire(import.meta.url);

void test('plugin stdio MCP uses the global owner and preserves server preference across package lifecycle', async () => {
  const fixture = await createFixture();
  const sourceRoot = join(fixture.computerRoot, 'portable-mcp-plugin');
  await writePluginPackage(sourceRoot);
  const toolRegistry = createToolRegistryStore({ builtins: [] });
  const globalMcp = createGlobalMcpRuntime({
    homeStateRoot: fixture.homeRoot,
    toolRegistry,
  });
  const pluginStore = createPluginStore({ homeStateRoot: fixture.homeRoot });
  const plugins = createMcpCoordinatedPluginStore({
    pluginStore,
    globalMcp,
  });

  try {
    await plugins.initialize();
    const installed = await plugins.installPlugin(
      { root: 'computer', path: 'portable-mcp-plugin' },
      fixture.computerFileScope,
    );
    const registered = globalMcp.listServers()[0];
    assert.ok(registered);
    assert.equal(registered.source.kind, 'plugin');
    assert.equal(registered.enabled, false);
    assert.equal(registered.runtime.disabledReason, 'server-disabled');

    await globalMcp.setServerEnabled(registered.serverId, true);
    assert.equal(
      globalMcp.listServers()[0]?.runtime.disabledReason,
      'plugin-disabled',
    );

    await plugins.setEnabled(installed.installationId, true);
    assert.equal(globalMcp.listServers()[0]?.runtime.state, 'ready');
    assert.deepEqual(toolRegistry.getAllRegisteredToolNames(), []);
    await globalMcp.installTool(registered.serverId, 'echo');
    assert.equal(toolRegistry.getAllRegisteredToolNames().length, 1);

    const persisted = await readFile(
      join(fixture.homeRoot, '.geulbat', 'mcp-servers.json'),
      'utf8',
    );
    assert.equal(persisted.includes(fixture.root), false);
    assert.doesNotMatch(
      persisted,
      /absoluteCwd|relativeCwd|managedPath|sourcePath/u,
    );

    await plugins.setEnabled(installed.installationId, false);
    const suspended = globalMcp.listServers()[0];
    assert.equal(suspended?.enabled, true);
    assert.equal(suspended?.runtime.disabledReason, 'plugin-disabled');
    assert.deepEqual(toolRegistry.getAllRegisteredToolNames(), []);

    await plugins.setEnabled(installed.installationId, true);
    assert.equal(globalMcp.listServers()[0]?.runtime.state, 'ready');

    const uninstallFromStore = pluginStore.uninstall.bind(pluginStore);
    let injectUninstallFailure = true;
    pluginStore.uninstall = async (installationId) => {
      if (injectUninstallFailure) {
        injectUninstallFailure = false;
        throw new PluginStoreError(
          'conflict',
          'injected package removal failure',
        );
      }
      await uninstallFromStore(installationId);
    };
    await assert.rejects(
      plugins.uninstall(installed.installationId),
      /injected package removal failure/u,
    );
    const restored = globalMcp.listServers()[0];
    assert.equal(restored?.enabled, true);
    assert.equal(restored?.runtime.state, 'ready');
    assert.equal(toolRegistry.getAllRegisteredToolNames().length, 1);

    await plugins.uninstall(installed.installationId);
    assert.deepEqual(globalMcp.listServers(), []);
    assert.deepEqual(toolRegistry.getAllRegisteredToolNames(), []);
    assert.equal(
      await exists(
        join(
          fixture.homeRoot,
          'extensions',
          'plugins',
          installed.installationId,
        ),
      ),
      false,
    );
  } finally {
    await globalMcp.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture(): Promise<{
  root: string;
  computerRoot: string;
  homeRoot: string;
  computerFileScope: ComputerFileScope;
}> {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-plugin-mcp-coordinator-'));
  const computerRoot = join(root, 'computer');
  const homeRoot = join(root, 'home');
  await mkdir(computerRoot, { recursive: true });
  await mkdir(homeRoot, { recursive: true });
  return {
    root,
    computerRoot,
    homeRoot,
    computerFileScope: { root: computerRoot, browseShortcuts: [] },
  };
}

async function writePluginPackage(packageRoot: string): Promise<void> {
  const files = {
    '.codex-plugin/plugin.json': JSON.stringify({
      name: 'portable-mcp-plugin',
      version: '1.0.0',
      description: 'Portable stdio MCP fixture.',
      mcpServers: './.mcp.json',
      interface: { displayName: 'Portable MCP Plugin' },
    }),
    '.mcp.json': JSON.stringify({
      mcpServers: {
        echo: {
          type: 'stdio',
          command: 'node',
          args: ['server.mjs'],
          cwd: 'runtime',
        },
      },
    }),
    'runtime/cwd-sentinel.txt': 'managed package cwd',
    'runtime/server.mjs': createMcpServerSource(),
  };
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(packageRoot, ...relativePath.split('/'));
    await mkdir(join(absolutePath, '..'), { recursive: true });
    await writeFile(absolutePath, content, 'utf8');
  }
}

function createMcpServerSource(): string {
  const serverModule = pathToFileURL(
    require.resolve('@modelcontextprotocol/sdk/server/index.js'),
  ).href;
  const stdioModule = pathToFileURL(
    require.resolve('@modelcontextprotocol/sdk/server/stdio.js'),
  ).href;
  const typesModule = pathToFileURL(
    require.resolve('@modelcontextprotocol/sdk/types.js'),
  ).href;
  return `
import { access } from 'node:fs/promises';
import { Server } from ${JSON.stringify(serverModule)};
import { StdioServerTransport } from ${JSON.stringify(stdioModule)};
import { ListToolsRequestSchema } from ${JSON.stringify(typesModule)};

await access('cwd-sentinel.txt');
const server = new Server(
  { name: 'portable-plugin-test', version: '1.0.0' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'echo',
    description: 'Portable plugin test tool',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }],
}));
await server.connect(new StdioServerTransport());
`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
