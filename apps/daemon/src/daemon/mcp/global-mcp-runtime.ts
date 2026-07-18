import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import type {
  JsonSchemaType,
  JsonSchemaValidator,
} from '@modelcontextprotocol/sdk/validation/types.js';
import {
  MCP_SERVER_CONFIG_VERSION,
  isMcpServerRegistration,
  isMcpServerSource,
  isMcpStdioTransportConfig,
  type McpServerCreateRequest,
  type McpServerRegistration,
  type McpServerRuntimeStatus,
  type McpServerSource,
  type McpStdioTransportConfig,
  type McpServerView,
} from '@geulbat/protocol/mcp';
import { createLogger } from '@geulbat/shared-utils/logger';

import { defineParsedTool } from '../tools/parsed-tool.js';
import { toolError } from '../tools/result.js';
import type {
  ToolObjectParameters,
  ToolRegistryStore,
} from '../tools/tool-registry-model.js';
import { writeTextFileAtomically } from '../utils/atomic-file.js';
import { getErrorMessage } from '../utils/error.js';
import { OwnedStdioClientTransport } from './owned-stdio-client-transport.js';

const MCP_REGISTRY_SCHEMA_VERSION = 4 as const;
const PREVIOUS_MCP_REGISTRY_SCHEMA_VERSION = 3 as const;
const LEGACY_V2_MCP_REGISTRY_SCHEMA_VERSION = 2 as const;
const LEGACY_V1_MCP_REGISTRY_SCHEMA_VERSION = 1 as const;
const PREVIOUS_MCP_SERVER_CONFIG_VERSION = 2 as const;
const LEGACY_MCP_SERVER_CONFIG_VERSION = 1 as const;
const MCP_REGISTRY_RELATIVE_PATH = join('.geulbat', 'mcp-servers.json');
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const logger = createLogger('global-mcp');

interface PersistedMcpRegistry {
  schemaVersion: typeof MCP_REGISTRY_SCHEMA_VERSION;
  servers: McpServerRegistration[];
}

type PreviousMcpServerRegistration = Omit<
  McpServerRegistration,
  'configVersion'
> & {
  configVersion: typeof PREVIOUS_MCP_SERVER_CONFIG_VERSION;
};

interface PreviousPersistedMcpRegistry {
  schemaVersion: typeof PREVIOUS_MCP_REGISTRY_SCHEMA_VERSION;
  servers: PreviousMcpServerRegistration[];
}

type LegacyV2McpServerRegistration = Omit<
  PreviousMcpServerRegistration,
  'configVersion' | 'installedToolNames'
> & {
  configVersion: typeof LEGACY_MCP_SERVER_CONFIG_VERSION;
};

interface LegacyV2PersistedMcpRegistry {
  schemaVersion: typeof LEGACY_V2_MCP_REGISTRY_SCHEMA_VERSION;
  servers: LegacyV2McpServerRegistration[];
}

type LegacyV1McpServerRegistration = Omit<
  LegacyV2McpServerRegistration,
  'source'
>;

interface LegacyV1PersistedMcpRegistry {
  schemaVersion: typeof LEGACY_V1_MCP_REGISTRY_SCHEMA_VERSION;
  servers: LegacyV1McpServerRegistration[];
}

interface LiveMcpServer {
  client: Client;
  transport: OwnedStdioClientTransport;
  schemaValidator: AjvJsonSchemaValidator;
  projectedToolNames: Set<string>;
  detachStderr: () => void;
}

type McpPluginServerSource = Extract<McpServerSource, { kind: 'plugin' }>;

type DiscoveredMcpTool = Awaited<
  ReturnType<Client['listTools']>
>['tools'][number];

export interface PluginMcpServerBinding {
  name: string;
  pluginEnabled: boolean;
  source: McpPluginServerSource;
  transport: McpStdioTransportConfig;
  resolveLaunch(this: void): Promise<{ cwd: string }>;
}

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

export class McpServerNotFoundError extends Error {
  constructor(serverId: string) {
    super(`MCP server not found: ${serverId}`);
    this.name = 'McpServerNotFoundError';
  }
}

export class McpServerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpServerConfigError';
  }
}

export class McpServerOwnershipError extends Error {
  constructor(serverId: string) {
    super(
      `Plugin-provided MCP server must be removed with its plugin: ${serverId}`,
    );
    this.name = 'McpServerOwnershipError';
  }
}

export function createGlobalMcpRuntime(args: {
  homeStateRoot: string;
  toolRegistry: ToolRegistryStore;
}): GlobalMcpRuntime {
  const registryPath = join(args.homeStateRoot, MCP_REGISTRY_RELATIVE_PATH);
  const registrations = new Map<string, McpServerRegistration>();
  const statuses = new Map<string, McpServerRuntimeStatus>();
  const liveServers = new Map<string, LiveMcpServer>();
  const pluginBindings = new Map<string, PluginMcpServerBinding>();
  const suspendedPluginIds = new Set<string>();
  let initialized = false;
  let closed = false;
  let mutationTail: Promise<void> = Promise.resolve();

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function assertUsable(): void {
    if (!initialized) {
      throw new Error('global MCP runtime is not initialized');
    }
    if (closed) {
      throw new Error('global MCP runtime is closed');
    }
  }

  function isPluginRegistrationEligible(
    registration: McpServerRegistration,
  ): boolean {
    if (registration.source.kind === 'manual') {
      return true;
    }
    const binding = pluginBindings.get(registration.serverId);
    return (
      binding !== undefined &&
      binding.pluginEnabled &&
      !suspendedPluginIds.has(registration.source.installationId)
    );
  }

  function statusForRegistration(
    registration: McpServerRegistration,
  ): McpServerRuntimeStatus {
    if (!registration.enabled) {
      return disabledStatus('server-disabled');
    }
    if (!isPluginRegistrationEligible(registration)) {
      return disabledStatus('plugin-disabled');
    }
    return connectingStatus();
  }

  function normalizePluginBindings(
    bindings: readonly PluginMcpServerBinding[],
  ): Map<string, PluginMcpServerBinding> {
    const normalized = new Map<string, PluginMcpServerBinding>();
    for (const binding of bindings) {
      const serverId = pluginMcpServerId(binding.source);
      if (normalized.has(serverId)) {
        throw new McpServerConfigError(
          `Plugin MCP snapshot contains duplicate server identity: ${binding.source.serverName}`,
        );
      }
      const registration = pluginRegistrationFromBinding(binding, false);
      validateRegistration(registration);
      normalized.set(serverId, clonePluginBinding(binding));
    }
    return normalized;
  }

  function listServers(): McpServerView[] {
    return [...registrations.values()]
      .map((registration) => toServerView(registration, statuses))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  function scheduleUnexpectedDisconnect(
    serverId: string,
    client: Client,
    reason: string,
  ): void {
    void serialize(async () => {
      const live = liveServers.get(serverId);
      if (closed || live?.client !== client) {
        return;
      }
      try {
        await disconnectServer(serverId);
        statuses.set(serverId, errorStatus(reason));
      } catch (error: unknown) {
        const cleanupError = getErrorMessage(error);
        statuses.set(
          serverId,
          errorStatus(`${reason}; MCP process cleanup failed: ${cleanupError}`),
        );
        logger.warn('MCP client cleanup after disconnect failed:', {
          serverId,
          error: cleanupError,
        });
      }
    });
  }

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

  function applyPreparedProjection(
    serverId: string,
    live: LiveMcpServer,
    prepared: Awaited<ReturnType<typeof prepareProjection>>,
  ): void {
    unregisterProjection(live, args.toolRegistry);
    for (const projected of prepared.registeredTools) {
      args.toolRegistry.registerTool(projected.registeredTool);
      live.projectedToolNames.add(projected.publicName);
    }
    statuses.set(serverId, prepared.status);
  }

  async function refreshProjection(serverId: string): Promise<void> {
    const registration = registrations.get(serverId);
    const live = liveServers.get(serverId);
    if (
      !registration ||
      !live ||
      !registration.enabled ||
      !isPluginRegistrationEligible(registration)
    ) {
      return;
    }
    applyPreparedProjection(
      serverId,
      live,
      await prepareProjection(registration, live),
    );
  }

  async function connectServer(
    registration: McpServerRegistration,
  ): Promise<void> {
    if (!registration.enabled || !isPluginRegistrationEligible(registration)) {
      statuses.set(registration.serverId, statusForRegistration(registration));
      return;
    }
    statuses.set(registration.serverId, connectingStatus());
    let client: Client | undefined;
    let transport: OwnedStdioClientTransport | undefined;
    let detachStderr = () => {};
    try {
      await disconnectServer(registration.serverId);
      const environment = resolveServerEnvironment(registration);
      const launch =
        registration.source.kind === 'plugin'
          ? await pluginBindings.get(registration.serverId)?.resolveLaunch()
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
      detachStderr = attachSecretSafeStderrDiagnostic(registration, transport);
      const schemaValidator = new AjvJsonSchemaValidator();
      client = new Client(
        { name: 'geulbat', version: '0.0.0' },
        { jsonSchemaValidator: schemaValidator },
      );
      const connectedClient = client;
      client.onerror = (error) => {
        scheduleUnexpectedDisconnect(
          registration.serverId,
          connectedClient,
          `MCP transport error: ${getErrorMessage(error)}`,
        );
      };
      client.onclose = () => {
        scheduleUnexpectedDisconnect(
          registration.serverId,
          connectedClient,
          'MCP server connection closed',
        );
      };
      client.setNotificationHandler(
        ToolListChangedNotificationSchema,
        async () => {
          await serialize(async () => {
            try {
              await refreshProjection(registration.serverId);
            } catch (error: unknown) {
              const live = liveServers.get(registration.serverId);
              if (live?.client === connectedClient) {
                unregisterProjection(live, args.toolRegistry);
                statuses.set(
                  registration.serverId,
                  errorStatus(
                    `MCP tool refresh failed: ${getErrorMessage(error)}`,
                  ),
                );
              }
            }
          });
        },
      );

      await client.connect(
        transport,
        requestOptions(registration.transport.connectionTimeoutMs),
      );
      liveServers.set(registration.serverId, {
        client,
        transport,
        schemaValidator,
        projectedToolNames: new Set(),
        detachStderr,
      });
      await refreshProjection(registration.serverId);
    } catch (error: unknown) {
      const connectionError = getErrorMessage(error);
      const live = liveServers.get(registration.serverId);
      let cleanupError: string | undefined;
      if (client && live?.client === client) {
        try {
          await disconnectServer(registration.serverId);
        } catch (disconnectError: unknown) {
          cleanupError = getErrorMessage(disconnectError);
        }
      } else {
        detachStderr();
        await client?.close().catch(() => undefined);
        try {
          await transport?.close();
        } catch (transportError: unknown) {
          cleanupError = getErrorMessage(transportError);
        }
      }
      statuses.set(
        registration.serverId,
        errorStatus(
          `MCP connection failed: ${connectionError}${
            cleanupError === undefined
              ? ''
              : `; MCP process cleanup failed: ${cleanupError}`
          }`,
        ),
      );
    }
  }

  async function disconnectServer(serverId: string): Promise<void> {
    const live = liveServers.get(serverId);
    if (!live) {
      return;
    }
    unregisterProjection(live, args.toolRegistry);
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
      statuses.set(
        serverId,
        errorStatus(`MCP process cleanup failed: ${message}`),
      );
      logger.warn('MCP client cleanup failed:', { serverId, error: message });
      throw new Error(message);
    }
    if (liveServers.get(serverId) === live) {
      liveServers.delete(serverId);
    }
  }

  async function persist(
    nextRegistrations: McpServerRegistration[],
  ): Promise<void> {
    const payload: PersistedMcpRegistry = {
      schemaVersion: MCP_REGISTRY_SCHEMA_VERSION,
      servers: nextRegistrations,
    };
    await writeTextFileAtomically(
      registryPath,
      `${JSON.stringify(payload, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  async function replacePluginBindings(
    bindings: readonly PluginMcpServerBinding[],
  ): Promise<void> {
    const nextBindings = normalizePluginBindings(bindings);
    const currentRegistrations = [...registrations.values()];
    const nextRegistrations = currentRegistrations.filter(
      (registration) => registration.source.kind === 'manual',
    );
    for (const [serverId, binding] of nextBindings) {
      const current = registrations.get(serverId);
      if (current?.source.kind === 'manual') {
        throw new McpServerConfigError(
          `Plugin MCP server identity conflicts with a manual registration: ${serverId}`,
        );
      }
      nextRegistrations.push(
        pluginRegistrationFromBinding(
          binding,
          current?.enabled ?? false,
          current?.installedToolNames ?? [],
        ),
      );
    }

    const nextById = new Map(
      nextRegistrations.map((registration) => [
        registration.serverId,
        registration,
      ]),
    );
    const disconnected: McpServerRegistration[] = [];
    for (const [serverId] of liveServers) {
      const current = registrations.get(serverId);
      const next = nextById.get(serverId);
      const nextBinding = nextBindings.get(serverId);
      const remainsEligible =
        next?.source.kind === 'manual' ||
        (nextBinding?.pluginEnabled === true &&
          !suspendedPluginIds.has(nextBinding.source.installationId));
      if (
        current &&
        (!next ||
          !remainsEligible ||
          registrationFingerprint(current) !== registrationFingerprint(next))
      ) {
        await disconnectServer(serverId);
        disconnected.push(current);
      }
    }

    try {
      if (
        registrationListFingerprint(currentRegistrations) !==
        registrationListFingerprint(nextRegistrations)
      ) {
        await persist(nextRegistrations);
      }
    } catch (error: unknown) {
      await Promise.all(
        disconnected.map((registration) => connectServer(registration)),
      ).catch(() => undefined);
      throw error;
    }

    registrations.clear();
    for (const registration of nextRegistrations) {
      registrations.set(registration.serverId, registration);
    }
    pluginBindings.clear();
    for (const [serverId, binding] of nextBindings) {
      pluginBindings.set(serverId, binding);
    }
    suspendedPluginIds.clear();
    for (const serverId of [...statuses.keys()]) {
      if (!registrations.has(serverId)) {
        statuses.delete(serverId);
      }
    }
    for (const registration of registrations.values()) {
      if (!liveServers.has(registration.serverId)) {
        statuses.set(
          registration.serverId,
          statusForRegistration(registration),
        );
      }
    }
    await Promise.all(
      [...registrations.values()]
        .filter(
          (registration) =>
            registration.enabled &&
            isPluginRegistrationEligible(registration) &&
            !liveServers.has(registration.serverId),
        )
        .map((registration) => connectServer(registration)),
    );
  }

  return {
    async initialize(initialPluginServers = []) {
      await serialize(async () => {
        if (initialized) {
          return;
        }
        if (closed) {
          throw new Error('global MCP runtime is closed');
        }
        const persisted = await readPersistedRegistry(registryPath);
        for (const registration of persisted.registry.servers) {
          registrations.set(registration.serverId, registration);
        }
        const initialBindings = normalizePluginBindings(initialPluginServers);
        pluginBindings.clear();
        for (const [serverId, binding] of initialBindings) {
          pluginBindings.set(serverId, binding);
        }
        const reconciled = [...registrations.values()].filter(
          (registration) => registration.source.kind === 'manual',
        );
        for (const [serverId, binding] of initialBindings) {
          const previous = registrations.get(serverId);
          if (previous?.source.kind === 'manual') {
            throw new McpServerConfigError(
              `Plugin MCP server identity conflicts with a manual registration: ${serverId}`,
            );
          }
          reconciled.push(
            pluginRegistrationFromBinding(
              binding,
              previous?.source.kind === 'plugin' ? previous.enabled : false,
              previous?.source.kind === 'plugin'
                ? previous.installedToolNames
                : [],
            ),
          );
        }
        registrations.clear();
        for (const registration of reconciled) {
          registrations.set(registration.serverId, registration);
          statuses.set(
            registration.serverId,
            statusForRegistration(registration),
          );
        }
        if (
          persisted.migrationRequired ||
          registrationListFingerprint(persisted.registry.servers) !==
            registrationListFingerprint(reconciled)
        ) {
          await persist(reconciled);
        }
        initialized = true;
        await Promise.all(
          [...registrations.values()]
            .filter(
              (registration) =>
                registration.enabled &&
                isPluginRegistrationEligible(registration),
            )
            .map((registration) => connectServer(registration)),
        );
      });
    },

    listServers() {
      assertUsable();
      return listServers();
    },

    async addServer(request) {
      return serialize(async () => {
        assertUsable();
        const registration = normalizeCreateRequest(request);
        await persist([...registrations.values(), registration]);
        registrations.set(registration.serverId, registration);
        statuses.set(
          registration.serverId,
          statusForRegistration(registration),
        );
        if (
          registration.enabled &&
          isPluginRegistrationEligible(registration)
        ) {
          await connectServer(registration);
        }
        return toServerView(registration, statuses);
      });
    },

    async setServerEnabled(serverId, enabled) {
      return serialize(async () => {
        assertUsable();
        const current = registrations.get(serverId);
        if (!current) {
          throw new McpServerNotFoundError(serverId);
        }
        if (current.enabled === enabled) {
          return toServerView(current, statuses);
        }
        const updated: McpServerRegistration = { ...current, enabled };
        const next = [...registrations.values()].map((registration) =>
          registration.serverId === serverId ? updated : registration,
        );
        await persist(next);
        registrations.set(serverId, updated);
        if (enabled && isPluginRegistrationEligible(updated)) {
          await connectServer(updated);
        } else {
          statuses.set(serverId, statusForRegistration(updated));
          await disconnectServer(serverId);
        }
        return toServerView(updated, statuses);
      });
    },

    async installTool(serverId, toolName) {
      return serialize(async () => {
        assertUsable();
        const current = registrations.get(serverId);
        if (!current) {
          throw new McpServerNotFoundError(serverId);
        }
        assertRequestedToolName(toolName);
        if (current.installedToolNames.includes(toolName)) {
          return toServerView(current, statuses);
        }
        const live = liveServers.get(serverId);
        if (
          !live ||
          !current.enabled ||
          !isPluginRegistrationEligible(current)
        ) {
          throw new McpServerConfigError(
            `MCP tool cannot be installed while its server is unavailable: ${toolName}`,
          );
        }
        const updated: McpServerRegistration = {
          ...current,
          installedToolNames: [...current.installedToolNames, toolName].sort(),
        };
        const prepared = await prepareProjection(updated, live);
        if (!prepared.status.availableToolNames.includes(toolName)) {
          throw new McpServerConfigError(
            `MCP server does not advertise a model-visible tool named: ${toolName}`,
          );
        }
        const next = [...registrations.values()].map((registration) =>
          registration.serverId === serverId ? updated : registration,
        );
        await persist(next);
        registrations.set(serverId, updated);
        applyPreparedProjection(serverId, live, prepared);
        return toServerView(updated, statuses);
      });
    },

    async uninstallTool(serverId, toolName) {
      return serialize(async () => {
        assertUsable();
        const current = registrations.get(serverId);
        if (!current) {
          throw new McpServerNotFoundError(serverId);
        }
        assertRequestedToolName(toolName);
        if (!current.installedToolNames.includes(toolName)) {
          return toServerView(current, statuses);
        }
        const updated: McpServerRegistration = {
          ...current,
          installedToolNames: current.installedToolNames.filter(
            (installedName) => installedName !== toolName,
          ),
        };
        const next = [...registrations.values()].map((registration) =>
          registration.serverId === serverId ? updated : registration,
        );
        await persist(next);
        registrations.set(serverId, updated);
        const live = liveServers.get(serverId);
        if (live) {
          const publicName = projectMcpToolName(serverId, toolName);
          args.toolRegistry.unregisterTool(publicName);
          live.projectedToolNames.delete(publicName);
        }
        const status = statuses.get(serverId);
        if (status?.state === 'ready') {
          statuses.set(serverId, {
            ...status,
            activeToolNames: status.activeToolNames.filter(
              (activeName) => activeName !== toolName,
            ),
          });
        }
        return toServerView(updated, statuses);
      });
    },

    async removeServer(serverId) {
      await serialize(async () => {
        assertUsable();
        const registration = registrations.get(serverId);
        if (!registration) {
          throw new McpServerNotFoundError(serverId);
        }
        if (registration.source.kind === 'plugin') {
          throw new McpServerOwnershipError(serverId);
        }
        const next = [...registrations.values()].filter(
          (registration) => registration.serverId !== serverId,
        );
        await disconnectServer(serverId);
        await persist(next);
        registrations.delete(serverId);
        statuses.delete(serverId);
      });
    },

    async reconcilePluginServers(bindings) {
      await serialize(async () => {
        assertUsable();
        await replacePluginBindings(bindings);
      });
    },

    async suspendPluginServers(pluginInstallationId) {
      await serialize(async () => {
        assertUsable();
        suspendedPluginIds.add(pluginInstallationId);
        const affected = [...registrations.values()].filter(
          (registration) =>
            registration.source.kind === 'plugin' &&
            registration.source.installationId === pluginInstallationId,
        );
        for (const registration of affected) {
          statuses.set(
            registration.serverId,
            disabledStatus('plugin-disabled'),
          );
        }
        await Promise.all(
          affected.map((registration) =>
            disconnectServer(registration.serverId),
          ),
        );
      });
    },

    async removePluginServers(pluginInstallationId) {
      await serialize(async () => {
        assertUsable();
        const removedIds = [...registrations.values()]
          .filter(
            (registration) =>
              registration.source.kind === 'plugin' &&
              registration.source.installationId === pluginInstallationId,
          )
          .map((registration) => registration.serverId);
        if (removedIds.length === 0) {
          return;
        }
        const removed = new Set(removedIds);
        const next = [...registrations.values()].filter(
          (registration) => !removed.has(registration.serverId),
        );
        await Promise.all(
          removedIds.map((serverId) => disconnectServer(serverId)),
        );
        await persist(next);
        for (const serverId of removedIds) {
          registrations.delete(serverId);
          statuses.delete(serverId);
          pluginBindings.delete(serverId);
        }
        suspendedPluginIds.delete(pluginInstallationId);
      });
    },

    async close() {
      await serialize(async () => {
        if (closed) {
          return;
        }
        const serverIds = [...liveServers.keys()];
        const results = await Promise.allSettled(
          serverIds.map((serverId) => disconnectServer(serverId)),
        );
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [getErrorMessage(result.reason)] : [],
        );
        if (failures.length > 0) {
          throw new Error(`MCP shutdown failed: ${failures.join('; ')}`);
        }
        closed = true;
      });
    },
  };
}

async function readPersistedRegistry(registryPath: string): Promise<{
  registry: PersistedMcpRegistry;
  migrationRequired: boolean;
}> {
  let raw: string;
  try {
    raw = await readFile(registryPath, 'utf8');
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return {
        registry: { schemaVersion: MCP_REGISTRY_SCHEMA_VERSION, servers: [] },
        migrationRequired: false,
      };
    }
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    throw new McpServerConfigError(
      `MCP registry is not valid JSON: ${getErrorMessage(error)}`,
    );
  }
  let registry: PersistedMcpRegistry;
  let migrationRequired = false;
  if (isPersistedMcpRegistry(value)) {
    registry = value;
  } else if (isPreviousPersistedMcpRegistry(value)) {
    registry = {
      schemaVersion: MCP_REGISTRY_SCHEMA_VERSION,
      servers: value.servers.map(migratePreviousRegistration),
    };
    migrationRequired = true;
  } else if (isLegacyV2PersistedMcpRegistry(value)) {
    registry = {
      schemaVersion: MCP_REGISTRY_SCHEMA_VERSION,
      servers: value.servers.map(migrateLegacyV2Registration),
    };
    migrationRequired = true;
  } else if (isLegacyV1PersistedMcpRegistry(value)) {
    registry = {
      schemaVersion: MCP_REGISTRY_SCHEMA_VERSION,
      servers: value.servers.map((server) => ({
        ...server,
        configVersion: MCP_SERVER_CONFIG_VERSION,
        installedToolNames: [],
        source: { kind: 'manual' },
      })),
    };
    migrationRequired = true;
  } else {
    throw new McpServerConfigError('MCP registry has an invalid shape');
  }
  const seenIds = new Set<string>();
  for (const registration of registry.servers) {
    if (seenIds.has(registration.serverId)) {
      throw new McpServerConfigError(
        `MCP registry contains duplicate server id: ${registration.serverId}`,
      );
    }
    seenIds.add(registration.serverId);
    validateRegistration(registration);
  }
  return { registry, migrationRequired };
}

function migratePreviousRegistration(
  registration: PreviousMcpServerRegistration,
): McpServerRegistration {
  return {
    ...registration,
    configVersion: MCP_SERVER_CONFIG_VERSION,
  };
}

function migrateLegacyV2Registration(
  registration: LegacyV2McpServerRegistration,
): McpServerRegistration {
  return {
    ...registration,
    configVersion: MCP_SERVER_CONFIG_VERSION,
    installedToolNames: [],
  };
}

function pluginMcpServerId(source: McpPluginServerSource): string {
  return createHash('sha256')
    .update('geulbat-plugin-mcp-v1')
    .update('\0')
    .update(source.installationId)
    .update('\0')
    .update(source.serverName.normalize('NFC'))
    .digest('hex');
}

function pluginRegistrationFromBinding(
  binding: PluginMcpServerBinding,
  enabled: boolean,
  installedToolNames: readonly string[] = [],
): McpServerRegistration {
  return {
    configVersion: MCP_SERVER_CONFIG_VERSION,
    serverId: pluginMcpServerId(binding.source),
    name: binding.name.trim(),
    enabled,
    installedToolNames: [...installedToolNames],
    source: cloneServerSource(binding.source),
    transport: cloneTransport(binding.transport),
  };
}

function clonePluginBinding(
  binding: PluginMcpServerBinding,
): PluginMcpServerBinding {
  return {
    name: binding.name,
    pluginEnabled: binding.pluginEnabled,
    source: cloneServerSource(binding.source),
    transport: cloneTransport(binding.transport),
    resolveLaunch: binding.resolveLaunch,
  };
}

function cloneServerSource(
  source: McpPluginServerSource,
): McpPluginServerSource;
function cloneServerSource(source: McpServerSource): McpServerSource;
function cloneServerSource(source: McpServerSource): McpServerSource {
  return source.kind === 'manual'
    ? { kind: 'manual' }
    : {
        kind: 'plugin',
        installationId: source.installationId,
        name: source.name,
        displayName: source.displayName,
        version: source.version,
        contentDigest: source.contentDigest,
        serverName: source.serverName,
      };
}

function cloneTransport(
  transport: McpStdioTransportConfig,
): McpStdioTransportConfig {
  return {
    kind: 'stdio',
    command: transport.command,
    args: [...transport.args],
    envKeys: [...transport.envKeys],
    ...(transport.connectionTimeoutMs === undefined
      ? {}
      : { connectionTimeoutMs: transport.connectionTimeoutMs }),
    ...(transport.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: transport.requestTimeoutMs }),
    ...(transport.shutdownGraceMs === undefined
      ? {}
      : { shutdownGraceMs: transport.shutdownGraceMs }),
  };
}

function registrationFingerprint(registration: McpServerRegistration): string {
  return JSON.stringify(registration);
}

function registrationListFingerprint(
  registrations: readonly McpServerRegistration[],
): string {
  return JSON.stringify(
    [...registrations].sort((left, right) =>
      left.serverId.localeCompare(right.serverId),
    ),
  );
}

function normalizeCreateRequest(
  request: McpServerCreateRequest,
): McpServerRegistration {
  const registration: McpServerRegistration = {
    configVersion: MCP_SERVER_CONFIG_VERSION,
    serverId: randomUUID().replaceAll('-', ''),
    name: request.name.trim(),
    enabled: request.enabled ?? true,
    installedToolNames: [],
    source: { kind: 'manual' },
    transport: {
      kind: 'stdio',
      command: request.transport.command.trim(),
      args: [...request.transport.args],
      envKeys: [...new Set(request.transport.envKeys)],
      ...(request.transport.connectionTimeoutMs === undefined
        ? {}
        : { connectionTimeoutMs: request.transport.connectionTimeoutMs }),
      ...(request.transport.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: request.transport.requestTimeoutMs }),
      ...(request.transport.shutdownGraceMs === undefined
        ? {}
        : { shutdownGraceMs: request.transport.shutdownGraceMs }),
    },
  };
  validateRegistration(registration);
  return registration;
}

function validateRegistration(registration: McpServerRegistration): void {
  if (registration.name.length === 0) {
    throw new McpServerConfigError('MCP server name is required');
  }
  if (registration.transport.command.length === 0) {
    throw new McpServerConfigError('MCP stdio command is required');
  }
  for (const key of registration.transport.envKeys) {
    if (!ENVIRONMENT_KEY_PATTERN.test(key)) {
      throw new McpServerConfigError(`Invalid MCP environment key: ${key}`);
    }
  }
  validateOptionalTimeout(
    registration.transport.connectionTimeoutMs,
    'connectionTimeoutMs',
  );
  validateOptionalTimeout(
    registration.transport.requestTimeoutMs,
    'requestTimeoutMs',
  );
  validateOptionalTimeout(
    registration.transport.shutdownGraceMs,
    'shutdownGraceMs',
  );
}

function resolveServerEnvironment(
  registration: McpServerRegistration,
): Record<string, string> {
  const environment = getDefaultEnvironment();
  for (const key of registration.transport.envKeys) {
    const value = process.env[key];
    if (value === undefined) {
      throw new McpServerConfigError(
        `MCP environment key is not available in the daemon process: ${key}`,
      );
    }
    environment[key] = value;
  }
  return environment;
}

async function listAllTools(
  client: Client,
  timeoutMs: number | undefined,
): Promise<DiscoveredMcpTool[]> {
  const tools: DiscoveredMcpTool[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.request(
      {
        method: 'tools/list',
        ...(cursor === undefined ? {} : { params: { cursor } }),
      },
      ListToolsResultSchema,
      requestOptions(timeoutMs),
    );
    tools.push(...page.tools);
    const nextCursor = page.nextCursor;
    if (nextCursor !== undefined) {
      if (seenCursors.has(nextCursor)) {
        throw new McpServerConfigError(
          'MCP tools/list repeated a pagination cursor',
        );
      }
      seenCursors.add(nextCursor);
    }
    cursor = nextCursor;
  } while (cursor !== undefined);
  return tools;
}

function indexModelVisibleTools(
  serverId: string,
  advertisedTools: readonly DiscoveredMcpTool[],
): Map<string, DiscoveredMcpTool> {
  const toolsByName = new Map<string, DiscoveredMcpTool>();
  const publicNames = new Set<string>();
  for (const tool of advertisedTools) {
    if (!isMcpToolVisibleToModel(tool)) {
      continue;
    }
    const publicName = projectMcpToolName(serverId, tool.name);
    if (toolsByName.has(tool.name) || publicNames.has(publicName)) {
      throw new McpServerConfigError(
        `MCP server published colliding tool names: ${tool.name}`,
      );
    }
    toolsByName.set(tool.name, tool);
    publicNames.add(publicName);
  }
  return toolsByName;
}

function isMcpToolVisibleToModel(tool: DiscoveredMcpTool): boolean {
  const ui = isRecord(tool._meta) ? tool._meta['ui'] : undefined;
  if (!isRecord(ui) || !Object.hasOwn(ui, 'visibility')) {
    return true;
  }
  const visibility = ui['visibility'];
  return Array.isArray(visibility) && visibility.includes('model');
}

function createProjectedMcpTool(args: {
  client: Client;
  schemaValidator: AjvJsonSchemaValidator;
  registration: McpServerRegistration;
  publicName: string;
  tool: DiscoveredMcpTool;
}) {
  if (args.tool.execution?.taskSupport === 'required') {
    throw new McpServerConfigError(
      `MCP tool "${args.tool.name}" requires task-based execution, which is not supported by this runtime`,
    );
  }
  let validateInput: JsonSchemaValidator<Record<string, unknown>>;
  try {
    validateInput = args.schemaValidator.getValidator<Record<string, unknown>>(
      args.tool.inputSchema as JsonSchemaType,
    );
  } catch (error: unknown) {
    throw new McpServerConfigError(
      `MCP tool "${args.tool.name}" has an invalid input schema: ${getErrorMessage(error)}`,
    );
  }
  let validateOutput: JsonSchemaValidator<Record<string, unknown>> | undefined;
  if (args.tool.outputSchema !== undefined) {
    try {
      validateOutput = args.schemaValidator.getValidator<
        Record<string, unknown>
      >(args.tool.outputSchema as JsonSchemaType);
    } catch (error: unknown) {
      throw new McpServerConfigError(
        `MCP tool "${args.tool.name}" has an invalid output schema: ${getErrorMessage(error)}`,
      );
    }
  }
  return defineParsedTool<Record<string, unknown>>({
    name: args.publicName,
    description:
      `MCP server "${args.registration.name}" tool "${args.tool.name}". ${args.tool.description ?? ''}`.trim(),
    parameters: normalizeMcpInputSchema(args.tool.inputSchema),
    strict: false,
    sideEffectLevel: 'write',
    mayMutateComputerFiles: true,
    ...(args.registration.transport.requestTimeoutMs === undefined
      ? {}
      : { timeoutMs: args.registration.transport.requestTimeoutMs }),
    requiresApproval: true,
    exposure: {
      directHot: false,
      sdkVisible: true,
      inCellCallable: true,
      directOnly: false,
      approvalRequired: true,
      effectClass: 'hostStateMutation',
    },
    catalogSearchMetadata: {
      family: 'catalog',
      searchHints: [
        'mcp external tool',
        args.registration.name,
        args.tool.name,
      ],
      tags: ['external-tool', 'mcp'],
      whenToUse: `Use the configured MCP tool "${args.tool.name}" from "${args.registration.name}".`,
      notFor: 'Calls that do not require this configured external MCP server.',
    },
    parseArgs(raw) {
      if (!isRecord(raw)) {
        return { ok: false, message: 'MCP tool arguments must be an object' };
      }
      const validated = validateInput(raw);
      if (!validated.valid) {
        return {
          ok: false,
          message: `MCP tool arguments do not match its input schema: ${validated.errorMessage}`,
        };
      }
      return { ok: true, value: { ...validated.data } };
    },
    async executeParsed(toolArgs, context) {
      try {
        const result = await args.client.request(
          {
            method: 'tools/call',
            params: { name: args.tool.name, arguments: toolArgs },
          },
          CallToolResultSchema,
          requestOptions(
            args.registration.transport.requestTimeoutMs,
            context.signal,
          ),
        );
        if (validateOutput !== undefined && result.isError !== true) {
          if (result.structuredContent === undefined) {
            return toolError(
              'execution_failed',
              `MCP tool "${args.tool.name}" did not return structured content required by its output schema`,
            );
          }
          const validatedOutput = validateOutput(result.structuredContent);
          if (!validatedOutput.valid) {
            return toolError(
              'execution_failed',
              `MCP tool output does not match its output schema: ${validatedOutput.errorMessage}`,
            );
          }
        }
        const output = JSON.stringify({
          mcp: {
            serverId: args.registration.serverId,
            serverName: args.registration.name,
            toolName: args.tool.name,
            source: cloneServerSource(args.registration.source),
          },
          result,
        });
        if (result.isError === true) {
          return toolError('execution_failed', output);
        }
        return { ok: true, output };
      } catch (error: unknown) {
        return toolError(
          'execution_failed',
          `MCP tool call failed: ${getErrorMessage(error)}`,
        );
      }
    },
  });
}

function normalizeMcpInputSchema(
  schema: DiscoveredMcpTool['inputSchema'],
): ToolObjectParameters {
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    properties[key] = normalizeMcpSchemaNode({
      value,
      root: schema,
      resolvingRefs: new Set(),
    });
  }
  const required = (schema.required ?? []).filter((key) =>
    Object.hasOwn(properties, key),
  );
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

function normalizeMcpSchemaNode(args: {
  value: unknown;
  root: unknown;
  resolvingRefs: ReadonlySet<string>;
}): unknown {
  if (Array.isArray(args.value)) {
    return args.value.map((value) =>
      normalizeMcpSchemaNode({ ...args, value }),
    );
  }
  if (!isRecord(args.value)) {
    return args.value;
  }
  const schemaRecord = args.value;

  const ref = schemaRecord['$ref'];
  if (typeof ref === 'string') {
    if (args.resolvingRefs.has(ref)) {
      throw new McpServerConfigError(
        `MCP input schema contains a recursive local reference: ${ref}`,
      );
    }
    const nextRefs = new Set(args.resolvingRefs).add(ref);
    const target = resolveLocalMcpSchemaRef(args.root, ref);
    const resolved = normalizeMcpSchemaNode({
      value: target,
      root: args.root,
      resolvingRefs: nextRefs,
    });
    const siblings = normalizeMcpSchemaRecord({
      value: Object.fromEntries(
        Object.entries(schemaRecord).filter(([key]) => key !== '$ref'),
      ),
      root: args.root,
      resolvingRefs: nextRefs,
    });
    return Object.keys(siblings).length === 0
      ? resolved
      : { allOf: [resolved], ...siblings };
  }

  return normalizeMcpSchemaRecord({ ...args, value: schemaRecord });
}

function normalizeMcpSchemaRecord(args: {
  value: Record<string, unknown>;
  root: unknown;
  resolvingRefs: ReadonlySet<string>;
}): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args.value)) {
    if (
      (key === 'properties' ||
        key === 'patternProperties' ||
        key === '$defs' ||
        key === 'definitions' ||
        key === 'dependentSchemas') &&
      isRecord(value)
    ) {
      normalized[key] = Object.fromEntries(
        Object.entries(value).map(([name, schema]) => [
          name,
          normalizeMcpSchemaNode({ ...args, value: schema }),
        ]),
      );
      continue;
    }
    normalized[key] = normalizeMcpSchemaNode({ ...args, value });
  }
  return normalized;
}

function resolveLocalMcpSchemaRef(root: unknown, ref: string): unknown {
  if (ref === '#') {
    return root;
  }
  if (!ref.startsWith('#/')) {
    throw new McpServerConfigError(
      `MCP input schema contains an unsupported non-local reference: ${ref}`,
    );
  }
  let current = root;
  for (const rawSegment of ref.slice(2).split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment)
        .replaceAll('~1', '/')
        .replaceAll('~0', '~');
    } catch {
      throw new McpServerConfigError(
        `MCP input schema contains an invalid local reference: ${ref}`,
      );
    }
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      throw new McpServerConfigError(
        `MCP input schema local reference does not resolve: ${ref}`,
      );
    }
    current = current[segment];
  }
  return current;
}

function projectMcpToolName(serverId: string, toolName: string): string {
  if (toolName.length === 0) {
    throw new McpServerConfigError('MCP server published an empty tool name');
  }
  const identity = createHash('sha256')
    .update(serverId)
    .update('\0')
    .update(toolName)
    .digest('base64url');
  return `mcp_${identity}`;
}

function assertRequestedToolName(toolName: string): void {
  if (toolName.length === 0) {
    throw new McpServerConfigError('MCP tool name is required');
  }
}

function assertProjectionNamesAvailable(args: {
  projectedTools: Array<{ publicName: string; tool: DiscoveredMcpTool }>;
  currentProjectionNames: ReadonlySet<string>;
  toolRegistry: ToolRegistryStore;
}): void {
  const nextNames = new Set<string>();
  for (const projected of args.projectedTools) {
    if (nextNames.has(projected.publicName)) {
      throw new McpServerConfigError(
        `MCP server published colliding tool names: ${projected.tool.name}`,
      );
    }
    nextNames.add(projected.publicName);
    if (
      !args.currentProjectionNames.has(projected.publicName) &&
      args.toolRegistry.getTool(projected.publicName) !== undefined
    ) {
      throw new McpServerConfigError(
        `MCP tool projection collides with an existing tool: ${projected.publicName}`,
      );
    }
  }
}

function unregisterProjection(
  live: LiveMcpServer,
  toolRegistry: ToolRegistryStore,
): void {
  for (const name of live.projectedToolNames) {
    toolRegistry.unregisterTool(name);
  }
  live.projectedToolNames.clear();
}

function toServerView(
  registration: McpServerRegistration,
  statuses: ReadonlyMap<string, McpServerRuntimeStatus>,
): McpServerView {
  const runtime =
    statuses.get(registration.serverId) ??
    (registration.enabled
      ? connectingStatus()
      : disabledStatus('server-disabled'));
  return {
    configVersion: registration.configVersion,
    serverId: registration.serverId,
    name: registration.name,
    enabled: registration.enabled,
    installedToolNames: [...registration.installedToolNames],
    source: cloneServerSource(registration.source),
    transport: {
      kind: 'stdio',
      command: registration.transport.command,
      args: [...registration.transport.args],
      envKeys: [...registration.transport.envKeys],
      ...(registration.transport.connectionTimeoutMs === undefined
        ? {}
        : {
            connectionTimeoutMs: registration.transport.connectionTimeoutMs,
          }),
      ...(registration.transport.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: registration.transport.requestTimeoutMs }),
      ...(registration.transport.shutdownGraceMs === undefined
        ? {}
        : { shutdownGraceMs: registration.transport.shutdownGraceMs }),
    },
    runtime: {
      ...runtime,
      availableToolNames: [...runtime.availableToolNames],
      activeToolNames: [...runtime.activeToolNames],
    },
  };
}

function disabledStatus(
  disabledReason: 'server-disabled' | 'plugin-disabled',
): McpServerRuntimeStatus {
  return {
    state: 'disabled',
    advertisedToolCount: 0,
    availableToolNames: [],
    activeToolNames: [],
    disabledReason,
  };
}

function connectingStatus(): McpServerRuntimeStatus {
  return {
    state: 'connecting',
    advertisedToolCount: 0,
    availableToolNames: [],
    activeToolNames: [],
  };
}

function errorStatus(error: string): McpServerRuntimeStatus {
  return {
    state: 'error',
    advertisedToolCount: 0,
    availableToolNames: [],
    activeToolNames: [],
    error,
  };
}

function requestOptions(
  timeoutMs: number | undefined,
  signal?: AbortSignal,
): { timeout?: number; signal?: AbortSignal } | undefined {
  if (timeoutMs === undefined && signal === undefined) {
    return undefined;
  }
  return {
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
    ...(signal === undefined ? {} : { signal }),
  };
}

function validateOptionalTimeout(
  value: number | undefined,
  field: string,
): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new McpServerConfigError(
      `MCP ${field} must be a positive safe integer`,
    );
  }
}

function attachSecretSafeStderrDiagnostic(
  registration: McpServerRegistration,
  transport: OwnedStdioClientTransport,
): () => void {
  const stderr = transport.stderr;
  if (!stderr) {
    return () => {};
  }
  let reported = false;
  const onData = () => {
    if (reported) {
      return;
    }
    reported = true;
    logger
      .withContext({
        serverId: registration.serverId,
        serverName: registration.name,
      })
      .warn('MCP server emitted stderr; diagnostic contents were suppressed');
  };
  stderr.on('data', onData);
  return () => stderr.off('data', onData);
}

function isPersistedMcpRegistry(value: unknown): value is PersistedMcpRegistry {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['schemaVersion', 'servers']) &&
    value.schemaVersion === MCP_REGISTRY_SCHEMA_VERSION &&
    Array.isArray(value.servers) &&
    value.servers.every(isMcpServerRegistration)
  );
}

function isPreviousPersistedMcpRegistry(
  value: unknown,
): value is PreviousPersistedMcpRegistry {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['schemaVersion', 'servers']) &&
    value.schemaVersion === PREVIOUS_MCP_REGISTRY_SCHEMA_VERSION &&
    Array.isArray(value.servers) &&
    value.servers.every(isPreviousMcpServerRegistration)
  );
}

function isLegacyV2PersistedMcpRegistry(
  value: unknown,
): value is LegacyV2PersistedMcpRegistry {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['schemaVersion', 'servers']) &&
    value.schemaVersion === LEGACY_V2_MCP_REGISTRY_SCHEMA_VERSION &&
    Array.isArray(value.servers) &&
    value.servers.every(isLegacyV2McpServerRegistration)
  );
}

function isLegacyV1PersistedMcpRegistry(
  value: unknown,
): value is LegacyV1PersistedMcpRegistry {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['schemaVersion', 'servers']) &&
    value.schemaVersion === LEGACY_V1_MCP_REGISTRY_SCHEMA_VERSION &&
    Array.isArray(value.servers) &&
    value.servers.every(isLegacyV1McpServerRegistration)
  );
}

function isLegacyV1McpServerRegistration(
  value: unknown,
): value is LegacyV1McpServerRegistration {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'configVersion',
      'serverId',
      'name',
      'enabled',
      'transport',
    ]) &&
    value['configVersion'] === LEGACY_MCP_SERVER_CONFIG_VERSION &&
    typeof value['serverId'] === 'string' &&
    value['serverId'].trim().length > 0 &&
    typeof value['name'] === 'string' &&
    value['name'].trim().length > 0 &&
    typeof value['enabled'] === 'boolean' &&
    isMcpStdioTransportConfig(value['transport'])
  );
}

function isPreviousMcpServerRegistration(
  value: unknown,
): value is PreviousMcpServerRegistration {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'configVersion',
      'serverId',
      'name',
      'enabled',
      'installedToolNames',
      'source',
      'transport',
    ]) &&
    value['configVersion'] === PREVIOUS_MCP_SERVER_CONFIG_VERSION &&
    typeof value['serverId'] === 'string' &&
    value['serverId'].trim().length > 0 &&
    typeof value['name'] === 'string' &&
    value['name'].trim().length > 0 &&
    typeof value['enabled'] === 'boolean' &&
    isUniqueNonEmptyStringArray(value['installedToolNames']) &&
    isMcpServerSource(value['source']) &&
    isMcpStdioTransportConfig(value['transport'])
  );
}

function isLegacyV2McpServerRegistration(
  value: unknown,
): value is LegacyV2McpServerRegistration {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'configVersion',
      'serverId',
      'name',
      'enabled',
      'source',
      'transport',
    ]) &&
    value['configVersion'] === LEGACY_MCP_SERVER_CONFIG_VERSION &&
    typeof value['serverId'] === 'string' &&
    value['serverId'].trim().length > 0 &&
    typeof value['name'] === 'string' &&
    value['name'].trim().length > 0 &&
    typeof value['enabled'] === 'boolean' &&
    isMcpServerSource(value['source']) &&
    isMcpStdioTransportConfig(value['transport'])
  );
}

function isUniqueNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry): entry is string => typeof entry === 'string' && entry.length > 0,
    ) &&
    new Set(value).size === value.length
  );
}

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code === code
  );
}
