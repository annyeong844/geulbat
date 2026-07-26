import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  MCP_SERVER_CONFIG_VERSION,
  isMcpServerRegistration,
  isMcpServerSource,
  isMcpStdioTransportConfig,
  type McpServerRegistration,
} from '@geulbat/protocol/mcp';
import { isMcpRecord as isRecord } from './mcp-value-guards.js';

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
  // 폐기된 전송 필드는 읽는 자리에서 떼어낸다. 저장된 값이 데몬을 막아서는
  // 안 되지만, 지킬 수 없는 값을 계속 들고 있어서도 안 된다.
  const retired = stripRetiredTransportField(value);
  let migrationRequired = retired.stripped;
  if (isPersistedMcpRegistry(retired.value)) {
    registry = retired.value;
  } else if (isPreviousPersistedMcpRegistry(retired.value)) {
    registry = {
      schemaVersion: MCP_REGISTRY_SCHEMA_VERSION,
      servers: retired.value.servers.map(migratePreviousRegistration),
    };
    migrationRequired = true;
  } else if (isLegacyV2PersistedMcpRegistry(retired.value)) {
    registry = {
      schemaVersion: MCP_REGISTRY_SCHEMA_VERSION,
      servers: retired.value.servers.map(migrateLegacyV2Registration),
    };
    migrationRequired = true;
  } else if (isLegacyV1PersistedMcpRegistry(retired.value)) {
    registry = {
      schemaVersion: MCP_REGISTRY_SCHEMA_VERSION,
      servers: retired.value.servers.map((server) => ({
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

/**
 * P7.6 §11.6 — `shutdownGraceMs`는 폐기된 전송 필드다. 종료 유예는 프로세스를
 * 든 쪽만 지킬 수 있고, 그 프로세스는 이제 command-host 세션의 것이다. 이미
 * 저장된 값이 데몬 부팅을 막으면 안 되므로 읽는 자리에서 떼어내고,
 * 마이그레이션으로 표시해 다음 저장에서 파일에서도 사라지게 한다.
 */
const RETIRED_TRANSPORT_FIELD = 'shutdownGraceMs';

function stripRetiredTransportField(value: unknown): {
  value: unknown;
  stripped: boolean;
} {
  if (!isRecord(value) || !Array.isArray(value.servers)) {
    return { value, stripped: false };
  }
  let stripped = false;
  const servers = value.servers.map((server: unknown) => {
    if (
      !isRecord(server) ||
      !isRecord(server.transport) ||
      !(RETIRED_TRANSPORT_FIELD in server.transport)
    ) {
      return server;
    }
    stripped = true;
    const transport = { ...server.transport };
    delete transport[RETIRED_TRANSPORT_FIELD];
    return { ...server, transport };
  });
  return stripped
    ? { value: { ...value, servers }, stripped: true }
    : { value, stripped: false };
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
