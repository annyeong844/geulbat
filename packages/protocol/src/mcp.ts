import { isBoolean, isRecord, isString } from './runtime-utils.js';

// The named schema version is the public contract owner, not an inline policy literal.
// eslint-disable-next-line @typescript-eslint/no-magic-numbers
export const MCP_SERVER_CONFIG_VERSION = 3 as const;

export interface McpStdioTransportConfig {
  kind: 'stdio';
  command: string;
  args: string[];
  envKeys: string[];
  connectionTimeoutMs?: number;
  requestTimeoutMs?: number;
  shutdownGraceMs?: number;
}

export type McpServerSource =
  | {
      kind: 'manual';
    }
  | {
      kind: 'plugin';
      installationId: string;
      name: string;
      displayName: string;
      version: string;
      contentDigest: string;
      serverName: string;
    };

export interface McpServerRegistration {
  configVersion: typeof MCP_SERVER_CONFIG_VERSION;
  serverId: string;
  name: string;
  enabled: boolean;
  installedToolNames: string[];
  source: McpServerSource;
  transport: McpStdioTransportConfig;
}

type McpServerConnectionState = 'disabled' | 'connecting' | 'ready' | 'error';

type McpServerDisabledReason = 'server-disabled' | 'plugin-disabled';

export interface McpServerRuntimeStatus {
  state: McpServerConnectionState;
  advertisedToolCount: number;
  availableToolNames: string[];
  activeToolNames: string[];
  error?: string;
  disabledReason?: McpServerDisabledReason;
}

export interface McpServerView extends McpServerRegistration {
  runtime: McpServerRuntimeStatus;
}

export interface McpServerListResponse {
  servers: McpServerView[];
}

export interface McpServerCreateRequest {
  name: string;
  enabled?: boolean;
  transport: McpStdioTransportConfig;
}

export interface McpServerEnabledRequest {
  enabled: boolean;
}

export interface McpServerMutationResponse {
  server: McpServerView;
}

export interface McpServerDeleteResponse {
  removedServerId: string;
}

const MCP_SERVER_CONNECTION_STATES = [
  'disabled',
  'connecting',
  'ready',
  'error',
] as const;

export function isMcpStdioTransportConfig(
  value: unknown,
): value is McpStdioTransportConfig {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'kind',
      'command',
      'args',
      'envKeys',
      'connectionTimeoutMs',
      'requestTimeoutMs',
      'shutdownGraceMs',
    ]) &&
    value.kind === 'stdio' &&
    isNonEmptyString(value.command) &&
    isStringArray(value.args) &&
    isStringArray(value.envKeys) &&
    isOptionalPositiveSafeInteger(value.connectionTimeoutMs) &&
    isOptionalPositiveSafeInteger(value.requestTimeoutMs) &&
    isOptionalPositiveSafeInteger(value.shutdownGraceMs)
  );
}

export function isMcpServerSource(value: unknown): value is McpServerSource {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === 'manual') {
    return hasOnlyKeys(value, ['kind']);
  }
  return (
    value.kind === 'plugin' &&
    hasOnlyKeys(value, [
      'kind',
      'installationId',
      'name',
      'displayName',
      'version',
      'contentDigest',
      'serverName',
    ]) &&
    isNonEmptyString(value.installationId) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.displayName) &&
    isNonEmptyString(value.version) &&
    isSha256Digest(value.contentDigest) &&
    isNonEmptyString(value.serverName)
  );
}

const MCP_SERVER_REGISTRATION_KEYS = [
  'configVersion',
  'serverId',
  'name',
  'enabled',
  'installedToolNames',
  'source',
  'transport',
] as const;

function hasMcpServerRegistrationFields(
  value: Record<string, unknown>,
): value is Record<string, unknown> & McpServerRegistration {
  return (
    value.configVersion === MCP_SERVER_CONFIG_VERSION &&
    isNonEmptyString(value.serverId) &&
    isNonEmptyString(value.name) &&
    isBoolean(value.enabled) &&
    isUniqueNonEmptyStringArray(value.installedToolNames) &&
    isMcpServerSource(value.source) &&
    isMcpStdioTransportConfig(value.transport)
  );
}

export function isMcpServerRegistration(
  value: unknown,
): value is McpServerRegistration {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, MCP_SERVER_REGISTRATION_KEYS) &&
    hasMcpServerRegistrationFields(value)
  );
}

export function isMcpServerRuntimeStatus(
  value: unknown,
): value is McpServerRuntimeStatus {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'state',
      'advertisedToolCount',
      'availableToolNames',
      'activeToolNames',
      'error',
      'disabledReason',
    ]) ||
    !isMcpServerConnectionState(value.state) ||
    typeof value.advertisedToolCount !== 'number' ||
    !Number.isSafeInteger(value.advertisedToolCount) ||
    value.advertisedToolCount < 0 ||
    !isUniqueNonEmptyStringArray(value.availableToolNames) ||
    value.advertisedToolCount < value.availableToolNames.length ||
    !isUniqueNonEmptyStringArray(value.activeToolNames) ||
    (value.error !== undefined && !isString(value.error)) ||
    (value.disabledReason !== undefined &&
      ((value.disabledReason !== 'server-disabled' &&
        value.disabledReason !== 'plugin-disabled') ||
        value.state !== 'disabled'))
  ) {
    return false;
  }
  const availableToolNames = value.availableToolNames;
  return value.activeToolNames.every((name) =>
    availableToolNames.includes(name),
  );
}

export function isMcpServerView(value: unknown): value is McpServerView {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [...MCP_SERVER_REGISTRATION_KEYS, 'runtime']) ||
    !hasMcpServerRegistrationFields(value) ||
    !isMcpServerRuntimeStatus(value.runtime)
  ) {
    return false;
  }
  return value.runtime.activeToolNames.every((name) =>
    value.installedToolNames.includes(name),
  );
}

export function isMcpServerListResponse(
  value: unknown,
): value is McpServerListResponse {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['servers']) &&
    Array.isArray(value.servers) &&
    value.servers.every(isMcpServerView)
  );
}

export function isMcpServerMutationResponse(
  value: unknown,
): value is McpServerMutationResponse {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['server']) &&
    isMcpServerView(value.server)
  );
}

export function isMcpServerDeleteResponse(
  value: unknown,
): value is McpServerDeleteResponse {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['removedServerId']) &&
    isNonEmptyString(value.removedServerId)
  );
}

function isMcpServerConnectionState(
  value: unknown,
): value is McpServerConnectionState {
  return (
    isString(value) &&
    (MCP_SERVER_CONNECTION_STATES as readonly string[]).includes(value)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isUniqueNonEmptyStringArray(value: unknown): value is string[] {
  return (
    isStringArray(value) &&
    value.every((entry) => entry.length > 0) &&
    new Set(value).size === value.length
  );
}

function isSha256Digest(value: unknown): value is string {
  return isString(value) && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isOptionalPositiveSafeInteger(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}
