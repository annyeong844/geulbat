import test from 'node:test';
import assert from 'node:assert/strict';
import { MCP_SERVER_CONFIG_VERSION } from '@geulbat/protocol/mcp';

import {
  addMcpServer,
  installMcpServerTool,
  listMcpServers,
  removeMcpServer,
  setMcpServerEnabled,
  uninstallMcpServerTool,
} from './mcp.js';

void test('MCP APIs use the global authenticated server routes', async (t) => {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (init?.body) {
      assert.equal(
        new Headers(init.headers).get('content-type'),
        'application/json',
      );
    }
    calls.push({
      url,
      method,
      ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
    });

    if (method === 'GET') {
      return jsonResponse({ servers: [] });
    }
    const toolMutation = url.includes('/tools/');
    if (method === 'DELETE' && !toolMutation) {
      return jsonResponse({ removedServerId: 'server/one' });
    }
    const enabled = method !== 'POST';
    const installedToolNames = method === 'PUT' ? ['tool/name'] : [];
    return jsonResponse({
      server: {
        configVersion: MCP_SERVER_CONFIG_VERSION,
        serverId: 'server/one',
        name: '테스트 MCP',
        enabled,
        installedToolNames,
        source: { kind: 'manual' },
        transport: {
          kind: 'stdio',
          command: 'mcp-server',
          args: [],
          envKeys: [],
        },
        runtime: {
          state: enabled ? 'ready' : 'disabled',
          advertisedToolCount: toolMutation ? 1 : 0,
          availableToolNames: toolMutation ? ['tool/name'] : [],
          activeToolNames: installedToolNames,
          ...(enabled ? {} : { disabledReason: 'server-disabled' }),
        },
      },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await listMcpServers();
  await addMcpServer({
    name: '테스트 MCP',
    enabled: false,
    transport: {
      kind: 'stdio',
      command: 'mcp-server',
      args: [],
      envKeys: [],
      connectionTimeoutMs: 2500,
      requestTimeoutMs: 9000,
    },
  });
  await setMcpServerEnabled('server/one', true);
  await installMcpServerTool('server/one', 'tool/name');
  await uninstallMcpServerTool('server/one', 'tool/name');
  await removeMcpServer('server/one');

  assert.deepEqual(calls, [
    { url: '/api/mcp/servers', method: 'GET' },
    {
      url: '/api/mcp/servers',
      method: 'POST',
      body: {
        name: '테스트 MCP',
        enabled: false,
        transport: {
          kind: 'stdio',
          command: 'mcp-server',
          args: [],
          envKeys: [],
          connectionTimeoutMs: 2500,
          requestTimeoutMs: 9000,
        },
      },
    },
    {
      url: '/api/mcp/servers/server%2Fone/enabled',
      method: 'PATCH',
      body: { enabled: true },
    },
    {
      url: '/api/mcp/servers/server%2Fone/tools/tool%2Fname',
      method: 'PUT',
    },
    {
      url: '/api/mcp/servers/server%2Fone/tools/tool%2Fname',
      method: 'DELETE',
    },
    {
      url: '/api/mcp/servers/server%2Fone',
      method: 'DELETE',
    },
  ]);
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
