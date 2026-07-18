import { createHash, randomUUID } from 'node:crypto';

import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  MCP_SERVER_CONFIG_VERSION,
  type McpServerCreateRequest,
  type McpServerRegistration,
  type McpServerRuntimeStatus,
  type McpServerSource,
  type McpStdioTransportConfig,
  type McpServerView,
} from '@geulbat/protocol/mcp';

import { McpServerConfigError } from './global-mcp-contract.js';

const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

type McpPluginServerSource = Extract<McpServerSource, { kind: 'plugin' }>;

export interface PluginMcpServerBinding {
  name: string;
  pluginEnabled: boolean;
  source: McpPluginServerSource;
  transport: McpStdioTransportConfig;
  resolveLaunch(this: void): Promise<{ cwd: string }>;
}

export function pluginMcpServerId(source: McpPluginServerSource): string {
  return createHash('sha256')
    .update('geulbat-plugin-mcp-v1')
    .update('\0')
    .update(source.installationId)
    .update('\0')
    .update(source.serverName.normalize('NFC'))
    .digest('hex');
}

export function pluginRegistrationFromBinding(
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

export function clonePluginBinding(
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

export function cloneServerSource(
  source: McpPluginServerSource,
): McpPluginServerSource;
export function cloneServerSource(source: McpServerSource): McpServerSource;
export function cloneServerSource(source: McpServerSource): McpServerSource {
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

export function registrationFingerprint(
  registration: McpServerRegistration,
): string {
  return JSON.stringify(registration);
}

export function registrationListFingerprint(
  registrations: readonly McpServerRegistration[],
): string {
  return JSON.stringify(
    [...registrations].sort((left, right) =>
      left.serverId.localeCompare(right.serverId),
    ),
  );
}

export function normalizeCreateRequest(
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

export function validateRegistration(
  registration: McpServerRegistration,
): void {
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

export function resolveServerEnvironment(
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

export function toServerView(
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

export function disabledStatus(
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

export function connectingStatus(): McpServerRuntimeStatus {
  return {
    state: 'connecting',
    advertisedToolCount: 0,
    availableToolNames: [],
    activeToolNames: [],
  };
}

export function errorStatus(error: string): McpServerRuntimeStatus {
  return {
    state: 'error',
    advertisedToolCount: 0,
    availableToolNames: [],
    activeToolNames: [],
    error,
  };
}
