import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  MCP_SERVER_CONFIG_VERSION,
  isMcpServerRegistration,
  isMcpServerSource,
  isMcpStdioTransportConfig,
  type McpServerRegistration,
} from '@geulbat/protocol/mcp';
import { isRecord } from '@geulbat/protocol/runtime-utils';

import { getErrorMessage } from '../utils/error.js';
import { McpServerConfigError } from './global-mcp-contract.js';
import { validateRegistration } from './global-mcp-registration.js';

export const MCP_REGISTRY_SCHEMA_VERSION = 4 as const;
const PREVIOUS_MCP_REGISTRY_SCHEMA_VERSION = 3 as const;
const LEGACY_V2_MCP_REGISTRY_SCHEMA_VERSION = 2 as const;
const LEGACY_V1_MCP_REGISTRY_SCHEMA_VERSION = 1 as const;
const PREVIOUS_MCP_SERVER_CONFIG_VERSION = 2 as const;
const LEGACY_MCP_SERVER_CONFIG_VERSION = 1 as const;
export const MCP_REGISTRY_RELATIVE_PATH = join('.geulbat', 'mcp-servers.json');

export interface PersistedMcpRegistry {
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

export async function readPersistedRegistry(registryPath: string): Promise<{
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

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code === code
  );
}
