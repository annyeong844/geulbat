import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import type {
  McpServerCreateRequest,
  McpServerRegistration,
  McpServerRuntimeStatus,
  McpServerView,
} from '@geulbat/protocol/mcp';
import { createLogger } from '@geulbat/structured-logger/logger';

import type { ToolRegistryStore } from '../tools/tool-registry-model.js';
import { writeTextFileAtomically } from '../utils/atomic-file.js';
import { getErrorMessage } from '../utils/error.js';
import { McpServerConfigError } from './global-mcp-contract.js';
import {
  resolveServerEnvironment,
  type PluginMcpServerBinding,
} from './global-mcp-registration.js';
import {
  MCP_REGISTRY_RELATIVE_PATH,
  MCP_REGISTRY_SCHEMA_VERSION,
  readPersistedRegistry,
  type PersistedMcpRegistry,
} from './global-mcp-registry-persistence.js';
import {
  assertProjectionNamesAvailable,
  attachSecretSafeStderrDiagnostic,
  createProjectedMcpTool,
  indexModelVisibleTools,
  listAllTools,
  projectMcpToolName,
  requestOptions,
  unregisterProjection,
  type LiveMcpServer,
} from './global-mcp-tool-projection.js';
import { createGlobalMcpStateOwner } from './global-mcp-state.js';
import { OwnedStdioClientTransport } from './owned-stdio-client-transport.js';

const logger = createLogger('global-mcp');

export interface GlobalMcpRuntime {
  initialize(pluginServers?: readonly PluginMcpServerBinding[]): Promise<void>;
  listServers(): McpServerView[];
  addServer(request: McpServerCreateRequest): Promise<McpServerView>;
  setServerEnabled(serverId: string, enabled: boolean): Promise<McpServerView>;
  installTool(serverId: string, toolName: string): Promise<McpServerView>;
  uninstallTool(serverId: string, toolName: string): Promise<McpServerView>;
  removeServer(serverId: string): Promise<void>;
  reconcilePluginServers(
    pluginServers: readonly PluginMcpServerBinding[],
  ): Promise<void>;
  suspendPluginServers(pluginInstallationId: string): Promise<void>;
  removePluginServers(pluginInstallationId: string): Promise<void>;
  close(options?: { signal?: AbortSignal }): Promise<void>;
}

// 상태 전이는 global-mcp-state의 owner가 소유한다. 이 팩토리는 owner가
// 주입받는 I/O 정책 — 레지스트리 파일 persist, SDK client 구성/teardown,
// tool projection 준비와 toolRegistry 반영 — 만 구성한다.
export function createGlobalMcpRuntime(args: {
  homeStateRoot: string;
  toolRegistry: ToolRegistryStore;
}): GlobalMcpRuntime {
  const registryPath = join(args.homeStateRoot, MCP_REGISTRY_RELATIVE_PATH);

  async function prepareProjection(
    registration: McpServerRegistration,
    live: LiveMcpServer,
  ) {
    const advertisedTools = await listAllTools(
      live.client,
      registration.transport.requestTimeoutMs,
    );
    const modelVisibleTools = indexModelVisibleTools(
      registration.serverId,
      advertisedTools,
    );
    const projectedTools = registration.installedToolNames.flatMap(
      (toolName) => {
        const tool = modelVisibleTools.get(toolName);
        return tool === undefined
          ? []
          : [
              {
                publicName: projectMcpToolName(
                  registration.serverId,
                  tool.name,
                ),
                tool,
              },
            ];
      },
    );
    assertProjectionNamesAvailable({
      projectedTools,
      currentProjectionNames: live.projectedToolNames,
      toolRegistry: args.toolRegistry,
    });

    return {
      registeredTools: projectedTools.map((projected) => ({
        publicName: projected.publicName,
        registeredTool: createProjectedMcpTool({
          client: live.client,
          schemaValidator: live.schemaValidator,
          registration,
          publicName: projected.publicName,
          tool: projected.tool,
        }),
      })),
      status: {
        state: 'ready',
        advertisedToolCount: advertisedTools.length,
        availableToolNames: [...modelVisibleTools.keys()].sort(),
        activeToolNames: projectedTools.map(({ tool }) => tool.name).sort(),
      } satisfies McpServerRuntimeStatus,
    };
  }

  return createGlobalMcpStateOwner({
    loadPersistedRegistry: () => readPersistedRegistry(registryPath),

    async persistRegistrations(next) {
      const payload: PersistedMcpRegistry = {
        schemaVersion: MCP_REGISTRY_SCHEMA_VERSION,
        servers: next,
      };
      await writeTextFileAtomically(
        registryPath,
        `${JSON.stringify(payload, null, 2)}\n`,
        { mode: 0o600 },
      );
    },

    async establishLive({
      registration,
      binding,
      onUnexpectedDisconnect,
      onToolListChanged,
    }) {
      let client: Client | undefined;
      let transport: OwnedStdioClientTransport | undefined;
      let detachStderr = () => {};
      try {
        const environment = resolveServerEnvironment(registration);
        const launch =
          registration.source.kind === 'plugin'
            ? await binding?.resolveLaunch()
            : undefined;
        if (registration.source.kind === 'plugin' && launch === undefined) {
          throw new McpServerConfigError(
            'Plugin MCP launch binding is unavailable',
          );
        }
        transport = new OwnedStdioClientTransport({
          command: registration.transport.command,
          args: registration.transport.args,
          env: environment,
          ...(launch === undefined ? {} : { cwd: launch.cwd }),
          ...(registration.transport.shutdownGraceMs === undefined
            ? {}
            : { shutdownGraceMs: registration.transport.shutdownGraceMs }),
        });
        detachStderr = attachSecretSafeStderrDiagnostic(
          registration,
          transport,
        );
        const schemaValidator = new AjvJsonSchemaValidator();
        client = new Client(
          { name: 'geulbat', version: '0.0.0' },
          { jsonSchemaValidator: schemaValidator },
        );
        const connectedClient = client;
        client.onerror = (error) => {
          onUnexpectedDisconnect(
            connectedClient,
            `MCP transport error: ${getErrorMessage(error)}`,
          );
        };
        client.onclose = () => {
          onUnexpectedDisconnect(
            connectedClient,
            'MCP server connection closed',
          );
        };
        client.setNotificationHandler(
          ToolListChangedNotificationSchema,
          async () => {
            await onToolListChanged(connectedClient);
          },
        );

        await client.connect(
          transport,
          requestOptions(registration.transport.connectionTimeoutMs),
        );
        return {
          client,
          transport,
          schemaValidator,
          projectedToolNames: new Set(),
          detachStderr,
        };
      } catch (error: unknown) {
        const connectionError = getErrorMessage(error);
        detachStderr();
        await client?.close().catch(() => undefined);
        let cleanupError: string | undefined;
        try {
          await transport?.close();
        } catch (transportError: unknown) {
          cleanupError = getErrorMessage(transportError);
        }
        throw new Error(
          `${connectionError}${
            cleanupError === undefined
              ? ''
              : `; MCP process cleanup failed: ${cleanupError}`
          }`,
        );
      }
    },

    async teardownLive(serverId, live) {
      live.detachStderr();
      let clientCloseError: unknown;
      try {
        await live.client.close();
      } catch (error: unknown) {
        clientCloseError = error;
      }
      try {
        await live.transport.close();
      } catch (transportCloseError: unknown) {
        const message = [clientCloseError, transportCloseError]
          .filter((error) => error !== undefined)
          .map((error) => getErrorMessage(error))
          .join('; ');
        logger.warn('MCP client cleanup failed:', { serverId, error: message });
        throw new Error(message);
      }
    },

    prepareProjection,

    applyPreparedProjection(live, prepared) {
      unregisterProjection(live, args.toolRegistry);
      for (const projected of prepared.registeredTools) {
        args.toolRegistry.registerTool(projected.registeredTool);
        live.projectedToolNames.add(projected.publicName);
      }
    },

    removeProjectedTool(live, serverId, toolName) {
      const publicName = projectMcpToolName(serverId, toolName);
      args.toolRegistry.unregisterTool(publicName);
      live.projectedToolNames.delete(publicName);
    },

    unregisterProjection: (live) =>
      unregisterProjection(live, args.toolRegistry),
  });
}
