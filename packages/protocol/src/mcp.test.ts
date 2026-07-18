import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isMcpServerDeleteResponse,
  isMcpServerListResponse,
  isMcpServerMutationResponse,
  isMcpServerRegistration,
  isMcpServerRuntimeStatus,
  isMcpServerSource,
  isMcpServerView,
  isMcpStdioTransportConfig,
  type McpServerCreateRequest,
  type McpStdioTransportConfig,
} from './mcp.js';

const transport: McpStdioTransportConfig = {
  kind: 'stdio',
  command: 'example-mcp-server',
  args: ['--stdio'],
  envKeys: ['EXAMPLE_API_KEY'],
  connectionTimeoutMs: 5_000,
  requestTimeoutMs: 30_000,
  shutdownGraceMs: 2_500,
};

const manualRegistration = {
  configVersion: 3,
  serverId: 'manual-server',
  name: 'Manual server',
  enabled: false,
  installedToolNames: [],
  source: { kind: 'manual' },
  transport,
} as const;

const pluginSource = {
  kind: 'plugin',
  installationId: '00000000-0000-4000-8000-000000000000',
  name: 'example-plugin',
  displayName: 'Example plugin',
  version: '1.2.3',
  contentDigest: `sha256:${'a'.repeat(64)}`,
  serverName: 'example-server',
} as const;

void test('MCP protocol admits manual and plugin-owned server views', () => {
  const manualView = {
    ...manualRegistration,
    runtime: {
      state: 'disabled',
      advertisedToolCount: 0,
      availableToolNames: [],
      activeToolNames: [],
      disabledReason: 'server-disabled',
    },
  } as const;
  const pluginView = {
    ...manualRegistration,
    serverId: 'plugin-server',
    source: pluginSource,
    runtime: {
      state: 'disabled',
      advertisedToolCount: 0,
      availableToolNames: [],
      activeToolNames: [],
      disabledReason: 'plugin-disabled',
    },
  } as const;

  assert.equal(isMcpServerSource({ kind: 'manual' }), true);
  assert.equal(isMcpServerSource(pluginSource), true);
  assert.equal(isMcpServerRegistration(manualRegistration), true);
  assert.equal(isMcpServerView(manualView), true);
  assert.equal(isMcpServerView(pluginView), true);
  assert.equal(
    isMcpServerListResponse({ servers: [manualView, pluginView] }),
    true,
  );
  assert.equal(isMcpServerMutationResponse({ server: pluginView }), true);
  assert.equal(
    isMcpServerDeleteResponse({ removedServerId: pluginView.serverId }),
    true,
  );

  const createRequest = {
    name: 'Manual server',
    transport,
  } satisfies McpServerCreateRequest;
  assert.equal('source' in createRequest, false);
});

void test('MCP guards reject private fields and incomplete ownership metadata', () => {
  assert.equal(
    isMcpStdioTransportConfig({ ...transport, cwd: '/private/plugin/root' }),
    false,
  );
  for (const shutdownGraceMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(
      isMcpStdioTransportConfig({ ...transport, shutdownGraceMs }),
      false,
    );
  }
  assert.equal(
    isMcpServerSource({ kind: 'manual', cwd: '/private/plugin/root' }),
    false,
  );
  assert.equal(
    isMcpServerSource({ ...pluginSource, sourcePath: '/private/plugin/root' }),
    false,
  );
  assert.equal(
    isMcpServerSource({ ...pluginSource, contentDigest: 'not-a-digest' }),
    false,
  );
  assert.equal(isMcpServerSource({ ...pluginSource, serverName: '' }), false);
  assert.equal(
    isMcpServerRegistration({
      configVersion: 1,
      serverId: 'legacy-server',
      name: 'Legacy server',
      enabled: true,
      installedToolNames: [],
      transport,
    }),
    false,
  );
  assert.equal(
    isMcpServerRegistration({
      ...manualRegistration,
      managedPath: '/private/managed/path',
    }),
    false,
  );
  assert.equal(
    isMcpServerView({
      ...manualRegistration,
      runtime: {
        state: 'ready',
        advertisedToolCount: 1,
        availableToolNames: ['example_tool'],
        activeToolNames: [],
        processId: 1234,
      },
    }),
    false,
  );
  assert.equal(
    isMcpServerListResponse({
      servers: [],
      registryPath: '/private/mcp-servers.json',
    }),
    false,
  );
});

void test('MCP disabled reasons are exact and confined to disabled runtime state', () => {
  assert.equal(
    isMcpServerRuntimeStatus({
      state: 'disabled',
      advertisedToolCount: 0,
      availableToolNames: [],
      activeToolNames: [],
    }),
    true,
  );
  for (const disabledReason of ['server-disabled', 'plugin-disabled']) {
    assert.equal(
      isMcpServerRuntimeStatus({
        state: 'disabled',
        advertisedToolCount: 0,
        availableToolNames: [],
        activeToolNames: [],
        disabledReason,
      }),
      true,
    );
  }
  assert.equal(
    isMcpServerRuntimeStatus({
      state: 'disabled',
      advertisedToolCount: 0,
      availableToolNames: [],
      activeToolNames: [],
      disabledReason: 'policy-disabled',
    }),
    false,
  );
  assert.equal(
    isMcpServerRuntimeStatus({
      state: 'ready',
      advertisedToolCount: 1,
      availableToolNames: ['example_tool'],
      activeToolNames: [],
      disabledReason: 'plugin-disabled',
    }),
    false,
  );
  assert.equal(
    isMcpServerRuntimeStatus({
      state: 'disabled',
      advertisedToolCount: 0,
      availableToolNames: [],
      activeToolNames: [],
      disabledReason: 'server-disabled',
      sourcePath: '/private/plugin/root',
    }),
    false,
  );
  assert.equal(
    isMcpServerRuntimeStatus({
      state: 'ready',
      advertisedToolCount: 0,
      availableToolNames: ['example_tool'],
      activeToolNames: [],
    }),
    false,
  );
  assert.equal(
    isMcpServerRuntimeStatus({
      state: 'ready',
      advertisedToolCount: 1,
      availableToolNames: ['example_tool'],
      activeToolNames: ['missing_tool'],
    }),
    false,
  );
  assert.equal(
    isMcpServerView({
      ...manualRegistration,
      runtime: {
        state: 'ready',
        advertisedToolCount: 1,
        availableToolNames: ['example_tool'],
        activeToolNames: ['example_tool'],
      },
    }),
    false,
  );
});
