import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isMcpServerDeleteResponse,
  isMcpServerListResponse,
  isMcpServerMutationResponse,
  type McpServerView,
} from '@geulbat/protocol/mcp';
import {
  authHeaders,
  createRouteTestDaemonContext,
  withAuthenticatedDaemonServer,
} from './test-support/http-routes.js';
import { McpServerOwnershipError } from './daemon/mcp/global-mcp-runtime.js';

void test('authenticated MCP routes add, report, disable, and remove a global stdio registration', async () => {
  const daemonContext = createRouteTestDaemonContext();

  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const createResponse = await fetch(
        `http://127.0.0.1:${port}/api/mcp/servers`,
        {
          method: 'POST',
          headers: authHeaders({ 'content-type': 'application/json' }),
          body: JSON.stringify({
            name: 'Unavailable test server',
            enabled: false,
            transport: {
              kind: 'stdio',
              command: 'geulbat-command-that-does-not-exist',
              args: [],
              envKeys: [],
              connectionTimeoutMs: 2500,
              requestTimeoutMs: 9000,
            },
          }),
        },
      );
      assert.equal(createResponse.status, 201);
      const created: unknown = await createResponse.json();
      assert.equal(isMcpServerMutationResponse(created), true);
      if (!isMcpServerMutationResponse(created)) {
        return;
      }
      assert.equal(created.server.runtime.state, 'disabled');
      assert.equal(created.server.transport.connectionTimeoutMs, 2500);
      assert.equal(created.server.transport.requestTimeoutMs, 9000);

      const listResponse = await fetch(
        `http://127.0.0.1:${port}/api/mcp/servers`,
        { headers: authHeaders() },
      );
      assert.equal(listResponse.status, 200);
      const listed: unknown = await listResponse.json();
      assert.equal(isMcpServerListResponse(listed), true);
      if (!isMcpServerListResponse(listed)) {
        return;
      }
      assert.equal(listed.servers.length, 1);

      const enableResponse = await fetch(
        `http://127.0.0.1:${port}/api/mcp/servers/${created.server.serverId}/enabled`,
        {
          method: 'PATCH',
          headers: authHeaders({ 'content-type': 'application/json' }),
          body: JSON.stringify({ enabled: true }),
        },
      );
      assert.equal(enableResponse.status, 200);
      const enabled: unknown = await enableResponse.json();
      assert.equal(isMcpServerMutationResponse(enabled), true);
      if (isMcpServerMutationResponse(enabled)) {
        assert.equal(enabled.server.runtime.state, 'error');
        assert.match(enabled.server.runtime.error ?? '', /connection failed/iu);
      }

      const deleteResponse = await fetch(
        `http://127.0.0.1:${port}/api/mcp/servers/${created.server.serverId}`,
        { method: 'DELETE', headers: authHeaders() },
      );
      assert.equal(deleteResponse.status, 200);
      const deleted: unknown = await deleteResponse.json();
      assert.equal(isMcpServerDeleteResponse(deleted), true);
      if (isMcpServerDeleteResponse(deleted)) {
        assert.equal(deleted.removedServerId, created.server.serverId);
      }
    },
    { daemonContext },
  );
});

void test('MCP routes reject unknown fields that could smuggle secret values', async () => {
  await withAuthenticatedDaemonServer(async ({ port }) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/mcp/servers`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        name: 'Unsafe server',
        enabled: false,
        transport: {
          kind: 'stdio',
          command: 'node',
          args: [],
          envKeys: [],
          secretValue: 'must-not-be-accepted',
        },
      }),
    });
    assert.equal(response.status, 400);
  });
});

void test('authenticated MCP tool routes install and remove one schema without accepting body fields', async () => {
  const daemonContext = createRouteTestDaemonContext();
  const calls: string[] = [];
  daemonContext.globalMcp.installTool = async (serverId, toolName) => {
    calls.push(`install:${serverId}:${toolName}`);
    return mcpToolSelectionView(serverId, toolName);
  };
  daemonContext.globalMcp.uninstallTool = async (serverId, toolName) => {
    calls.push(`uninstall:${serverId}:${toolName}`);
    return mcpToolSelectionView(serverId);
  };

  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const base = `http://127.0.0.1:${port}/api/mcp/servers/server-one/tools/echo`;
      const rejected = await fetch(base, {
        method: 'PUT',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ schema: 'must-not-be-accepted' }),
      });
      assert.equal(rejected.status, 400);

      const installedResponse = await fetch(base, {
        method: 'PUT',
        headers: authHeaders(),
      });
      assert.equal(installedResponse.status, 200);
      const installed: unknown = await installedResponse.json();
      assert.equal(isMcpServerMutationResponse(installed), true);

      const removedResponse = await fetch(base, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      assert.equal(removedResponse.status, 200);
      const removed: unknown = await removedResponse.json();
      assert.equal(isMcpServerMutationResponse(removed), true);
      assert.deepEqual(calls, [
        'install:server-one:echo',
        'uninstall:server-one:echo',
      ]);
    },
    { daemonContext },
  );
});

void test('MCP route refuses direct removal of a plugin-owned registration', async () => {
  const daemonContext = createRouteTestDaemonContext();
  daemonContext.globalMcp.removeServer = async (serverId) => {
    throw new McpServerOwnershipError(serverId);
  };

  await withAuthenticatedDaemonServer(
    async ({ port }) => {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/mcp/servers/plugin-owned-server`,
        { method: 'DELETE', headers: authHeaders() },
      );
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), {
        code: 'conflict',
        message:
          'Plugin-provided MCP server must be removed with its plugin: plugin-owned-server',
      });
    },
    { daemonContext },
  );
});

function mcpToolSelectionView(
  serverId: string,
  installedToolName?: string,
): McpServerView {
  const installedToolNames =
    installedToolName === undefined ? [] : [installedToolName];
  return {
    configVersion: 3,
    serverId,
    name: 'Test MCP',
    enabled: true,
    installedToolNames,
    source: { kind: 'manual' },
    transport: { kind: 'stdio', command: 'node', args: [], envKeys: [] },
    runtime: {
      state: 'ready',
      advertisedToolCount: 1,
      availableToolNames: ['echo'],
      activeToolNames: installedToolNames,
    },
  };
}
