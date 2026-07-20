import { isPluginRecord as isRecord } from './plugin-value-guards.js';
import { posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  isNonEmptyString,
  PluginPackageAdmissionError,
} from './plugin-package-admission-contract.js';
import {
  isNonPortableAbsolutePath,
  normalizeContainedRuntimePath,
} from './plugin-package-paths.js';
import type { PackageEntry } from './plugin-package-secure-fs.js';

const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const MCP_STDIO_CONFIG_KEYS = new Set([
  'type',
  'command',
  'args',
  'env_vars',
  'env',
  'cwd',
  'connectionTimeoutMs',
  'requestTimeoutMs',
]);

export interface PluginMcpStdioConfig {
  command: string;
  args: string[];
  envKeys: string[];
  relativeCwd: string;
  connectionTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export interface InspectedPluginMcpServer {
  name: string;
  sourcePath: string;
  supportStatus: 'supported' | 'unsupported';
  diagnostic?: string;
  config?: PluginMcpStdioConfig;
}

export interface InspectedMcpServerRecord {
  name: string;
  sourcePath: string;
  configuration: Record<string, unknown>;
  inspected: InspectedPluginMcpServer;
}

export function addInspectedMcpServerEntries(args: {
  destination: Map<string, InspectedMcpServerRecord>;
  entries: Record<string, unknown>;
  sourcePath: string;
  packageEntries: Map<string, PackageEntry>;
}): void {
  for (const [rawName, entry] of Object.entries(args.entries)) {
    if (!isNonEmptyString(rawName) || !isRecord(entry)) {
      throw new PluginPackageAdmissionError(
        'invalid_request',
        `plugin component entries require non-empty names and object values: ${args.sourcePath}`,
      );
    }
    const name = rawName.trim();
    const identity = normalizeMcpServerNameIdentity(name);
    const previous = args.destination.get(identity);
    if (previous !== undefined) {
      if (previous.name !== name) {
        throw new PluginPackageAdmissionError(
          'invalid_request',
          `plugin MCP declaration contains a normalized name collision: ${name}`,
        );
      }
      if (!isDeepStrictEqual(previous.configuration, entry)) {
        throw new PluginPackageAdmissionError(
          'invalid_request',
          `plugin MCP server is declared with conflicting configurations: ${name}`,
        );
      }
      continue;
    }
    args.destination.set(identity, {
      name,
      sourcePath: args.sourcePath,
      configuration: entry,
      inspected: inspectPluginMcpServer({
        name,
        sourcePath: args.sourcePath,
        entry,
        packageEntries: args.packageEntries,
      }),
    });
  }
}

function inspectPluginMcpServer(args: {
  name: string;
  sourcePath: string;
  entry: Record<string, unknown>;
  packageEntries: Map<string, PackageEntry>;
}): InspectedPluginMcpServer {
  const unsupported = (diagnostic: string): InspectedPluginMcpServer => ({
    name: args.name,
    sourcePath: args.sourcePath,
    supportStatus: 'unsupported',
    diagnostic,
  });
  const unsupportedKeys = Object.keys(args.entry).filter(
    (key) => !MCP_STDIO_CONFIG_KEYS.has(key),
  );
  if (unsupportedKeys.length > 0) {
    return unsupported('MCP server uses unsupported configuration fields');
  }
  if (args.entry['type'] !== undefined && args.entry['type'] !== 'stdio') {
    return unsupported('MCP server transport is not supported');
  }
  if (
    isRecord(args.entry['env']) &&
    Object.keys(args.entry['env']).length > 0
  ) {
    return unsupported(
      'MCP server literal environment values are not supported',
    );
  }
  if (args.entry['env'] !== undefined && !isRecord(args.entry['env'])) {
    return unsupported('MCP server environment configuration is invalid');
  }

  const relativeCwd = normalizePluginMcpCwd(
    args.entry['cwd'],
    args.packageEntries,
  );
  if (relativeCwd === null) {
    return unsupported('MCP server cwd is absolute, escaping, or unavailable');
  }
  const command = normalizePluginMcpCommand(
    args.entry['command'],
    relativeCwd,
    args.packageEntries,
  );
  if (command === null) {
    return unsupported(
      'MCP server command is missing, ambiguous, or not portable',
    );
  }
  const rawArgs = args.entry['args'];
  if (rawArgs !== undefined && !isStringArray(rawArgs)) {
    return unsupported('MCP server arguments must be strings');
  }
  const rawEnvKeys = args.entry['env_vars'];
  if (rawEnvKeys !== undefined && !isEnvironmentKeyArray(rawEnvKeys)) {
    return unsupported('MCP server environment references are invalid');
  }
  const connectionTimeoutMs = args.entry['connectionTimeoutMs'];
  const requestTimeoutMs = args.entry['requestTimeoutMs'];
  if (
    !isOptionalPositiveSafeInteger(connectionTimeoutMs) ||
    !isOptionalPositiveSafeInteger(requestTimeoutMs)
  ) {
    return unsupported('MCP server timeout configuration is invalid');
  }

  return {
    name: args.name,
    sourcePath: args.sourcePath,
    supportStatus: 'supported',
    config: {
      command,
      args: rawArgs === undefined ? [] : [...rawArgs],
      envKeys: rawEnvKeys === undefined ? [] : [...new Set(rawEnvKeys)],
      relativeCwd,
      ...(connectionTimeoutMs === undefined ? {} : { connectionTimeoutMs }),
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    },
  };
}

function normalizeMcpServerNameIdentity(name: string): string {
  return name.normalize('NFC').toLocaleLowerCase('en-US');
}

function normalizePluginMcpCommand(
  value: unknown,
  relativeCwd: string,
  entries: Map<string, PackageEntry>,
): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  const command = value.trim();
  if (isNonPortableAbsolutePath(command) || command.includes('\0')) {
    return null;
  }
  if (!command.includes('/') && !command.includes('\\')) {
    return /\s/u.test(command) || entries.get(command)?.kind === 'file'
      ? null
      : command;
  }
  const relativeCommand = normalizeContainedRuntimePath(command);
  if (relativeCommand === null || relativeCommand === '.') {
    return null;
  }
  const packageRelativeCommand =
    relativeCwd === '.'
      ? relativeCommand
      : posix.join(relativeCwd, relativeCommand);
  if (entries.get(packageRelativeCommand)?.kind !== 'file') {
    return null;
  }
  return relativeCommand.includes('/')
    ? relativeCommand
    : `./${relativeCommand}`;
}

function normalizePluginMcpCwd(
  value: unknown,
  entries: Map<string, PackageEntry>,
): string | null {
  if (value === undefined || value === '.') {
    return '.';
  }
  if (typeof value !== 'string') {
    return null;
  }
  const relativeCwd = normalizeContainedRuntimePath(value);
  if (relativeCwd === null) {
    return null;
  }
  return relativeCwd === '.' || entries.get(relativeCwd)?.kind === 'directory'
    ? relativeCwd
    : null;
}

function isOptionalPositiveSafeInteger(
  value: unknown,
): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function isEnvironmentKeyArray(value: unknown): value is string[] {
  return (
    isStringArray(value) &&
    value.every((environmentKey) =>
      ENVIRONMENT_KEY_PATTERN.test(environmentKey),
    )
  );
}
