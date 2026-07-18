import type {
  PluginCapabilityKind,
  PluginCapabilityView,
} from '@geulbat/protocol/plugins';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  constants,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
} from 'node:fs/promises';
import {
  basename,
  isAbsolute,
  join,
  posix,
  relative,
  sep,
  win32,
} from 'node:path';
import { pipeline } from 'node:stream/promises';
import { isDeepStrictEqual } from 'node:util';

import { getErrorCode } from '../utils/error.js';
import {
  parsePluginSkillDocument,
  PluginSkillDocumentError,
  type InspectedPluginSkill,
} from './plugin-skill-runtime.js';

const MANIFEST_RELATIVE_PATH = '.codex-plugin/plugin.json';
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
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

const COMPONENT_SUPPORT: Record<
  Exclude<PluginCapabilityKind, 'mcpServers'>,
  PluginCapabilityView['supportStatus']
> = {
  skills: 'supported',
  apps: 'unsupported',
  hooks: 'unsupported',
};

interface PackageEntry {
  relativePath: string;
  kind: 'directory' | 'file';
  size: number;
  device: number;
  inode: number;
}

interface DirectoryIdentity {
  device: number;
  inode: number;
  birthtimeMs: number;
}

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

export interface InspectedPluginPackage {
  manifest: {
    name: string;
    version: string;
    description: string;
    displayName: string;
    iconPath: string | null;
  };
  contentDigest: string;
  capabilities: PluginCapabilityView[];
  skills: InspectedPluginSkill[];
  mcpServers: InspectedPluginMcpServer[];
}

export class PluginPackageAdmissionError extends Error {
  constructor(
    readonly code: 'invalid_request',
    message: string,
  ) {
    super(message);
    this.name = 'PluginPackageAdmissionError';
  }
}

export async function stagePluginPackage(args: {
  sourceRoot: string;
  destinationRoot: string;
}): Promise<InspectedPluginPackage> {
  return runAdmission(
    'plugin source could not be admitted safely',
    async () => {
      await copyPackageTree(args.sourceRoot, args.destinationRoot);
      return inspectPluginPackageUnchecked(args.destinationRoot);
    },
  );
}

export async function inspectPluginPackage(
  packageRoot: string,
): Promise<InspectedPluginPackage> {
  return runAdmission(
    'managed plugin package could not be inspected safely',
    () => inspectPluginPackageUnchecked(packageRoot),
  );
}

export async function readPluginPackageFile(args: {
  packageRoot: string;
  relativePath: string;
}): Promise<Buffer> {
  return runAdmission(
    'managed plugin file could not be read safely',
    async () => {
      const relativePath = normalizeDeclaredPackagePath(
        args.relativePath,
        'skill resource',
      );
      const entries = await inventoryPackageTree(args.packageRoot);
      const entry = entries.get(relativePath);
      if (entry?.kind !== 'file') {
        throw new PluginPackageAdmissionError(
          'invalid_request',
          'requested plugin skill resource is not an admitted file',
        );
      }
      return readPackageBuffer(
        toAbsolutePackagePath(args.packageRoot, relativePath),
        entry,
      );
    },
  );
}

async function runAdmission<T>(
  safeMessage: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof PluginPackageAdmissionError) {
      throw error;
    }
    const errorCode = getErrorCode(error);
    throw new PluginPackageAdmissionError(
      'invalid_request',
      errorCode ? `${safeMessage} (${errorCode})` : safeMessage,
    );
  }
}

async function copyPackageTree(
  sourceRoot: string,
  destinationRoot: string,
): Promise<void> {
  const normalizedPaths = new Map<string, string>();
  const canonicalSourceRoot = await realpath(sourceRoot);
  const canonicalDestinationRoot = await realpath(destinationRoot);
  if (
    isSameOrContainedPath(canonicalSourceRoot, canonicalDestinationRoot) ||
    isSameOrContainedPath(canonicalDestinationRoot, canonicalSourceRoot)
  ) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      'plugin source and managed staging trees must be disjoint',
    );
  }

  async function copyDirectory(relativeDirectory: string): Promise<void> {
    const sourceDirectory = toAbsolutePackagePath(
      sourceRoot,
      relativeDirectory,
    );
    const expectedDirectory = await inspectContainedDirectory({
      path: sourceDirectory,
      canonicalRoot: canonicalSourceRoot,
      displayPath: relativeDirectory || '.',
    });
    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      registerNormalizedPath(normalizedPaths, relativePath);
      const sourcePath = toAbsolutePackagePath(sourceRoot, relativePath);
      const destinationPath = toAbsolutePackagePath(
        destinationRoot,
        relativePath,
      );
      const stats = await lstat(sourcePath);
      assertSupportedPackageEntry(stats, relativePath);

      if (stats.isDirectory()) {
        await mkdir(destinationPath, {
          mode: stats.mode & 0o777,
        });
        await copyDirectory(relativePath);
      } else {
        await copyRegularFile({
          sourcePath,
          destinationPath,
          relativePath,
          expectedDevice: stats.dev,
          expectedInode: stats.ino,
          mode: stats.mode & 0o777,
        });
      }
    }

    await assertDirectoryIdentity(
      sourceDirectory,
      expectedDirectory,
      relativeDirectory || '.',
    );
  }

  await copyDirectory('');
}

async function copyRegularFile(args: {
  sourcePath: string;
  destinationPath: string;
  relativePath: string;
  expectedDevice: number;
  expectedInode: number;
  mode: number;
}): Promise<void> {
  const source = await open(
    args.sourcePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let destination: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const openedStats = await source.stat();
    assertSupportedPackageEntry(openedStats, args.relativePath);
    if (
      openedStats.dev !== args.expectedDevice ||
      openedStats.ino !== args.expectedInode
    ) {
      throw new PluginPackageAdmissionError(
        'invalid_request',
        `plugin package entry changed during import: ${args.relativePath}`,
      );
    }
    destination = await open(args.destinationPath, 'wx', args.mode);
    await pipeline(source.createReadStream(), destination.createWriteStream());
  } finally {
    await destination?.close().catch(() => undefined);
    await source.close().catch(() => undefined);
  }
}

async function inspectContainedDirectory(args: {
  path: string;
  canonicalRoot: string;
  displayPath: string;
}): Promise<DirectoryIdentity> {
  const stats = await lstat(args.path);
  assertSupportedPackageEntry(stats, args.displayPath);
  if (!stats.isDirectory()) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      `plugin package directory changed during import: ${args.displayPath}`,
    );
  }
  const canonicalPath = await realpath(args.path);
  if (!isSameOrContainedPath(args.canonicalRoot, canonicalPath)) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      `plugin package directory escaped during import: ${args.displayPath}`,
    );
  }
  return directoryIdentity(stats);
}

async function assertDirectoryIdentity(
  path: string,
  expected: DirectoryIdentity,
  displayPath: string,
): Promise<void> {
  const stats = await lstat(path);
  assertSupportedPackageEntry(stats, displayPath);
  if (
    !stats.isDirectory() ||
    !sameDirectoryIdentity(expected, directoryIdentity(stats))
  ) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      `plugin package directory changed during import: ${displayPath}`,
    );
  }
}

function directoryIdentity(
  stats: Awaited<ReturnType<typeof lstat>>,
): DirectoryIdentity {
  return {
    device: Number(stats.dev),
    inode: Number(stats.ino),
    birthtimeMs: Number(stats.birthtimeMs),
  };
}

function sameDirectoryIdentity(
  left: DirectoryIdentity,
  right: DirectoryIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeMs === right.birthtimeMs
  );
}

function isSameOrContainedPath(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

async function inspectPluginPackageUnchecked(
  packageRoot: string,
): Promise<InspectedPluginPackage> {
  const entries = await inventoryPackageTree(packageRoot);
  const manifestEntry = entries.get(MANIFEST_RELATIVE_PATH);
  if (manifestEntry?.kind !== 'file') {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      `plugin package is missing ${MANIFEST_RELATIVE_PATH}`,
    );
  }

  const manifest = await readJsonObject(
    toAbsolutePackagePath(packageRoot, MANIFEST_RELATIVE_PATH),
    MANIFEST_RELATIVE_PATH,
    manifestEntry,
  );
  assertNoEmbeddedCredentials(manifest, MANIFEST_RELATIVE_PATH, {
    rootComponentIdentityFields: ['mcpServers', 'apps'],
  });
  const normalizedManifest = {
    ...validateManifest(manifest),
    iconPath: readPluginIconPath(manifest, entries),
  };
  const inventory = await inventoryCapabilities({
    packageRoot,
    entries,
    manifest,
  });
  const contentDigest = await digestPackage(packageRoot, entries);

  return {
    manifest: normalizedManifest,
    contentDigest,
    capabilities: inventory.capabilities,
    skills: inventory.skills,
    mcpServers: inventory.mcpServers,
  };
}

async function inventoryPackageTree(
  packageRoot: string,
): Promise<Map<string, PackageEntry>> {
  let rootStats;
  try {
    rootStats = await lstat(packageRoot);
  } catch (error: unknown) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      getErrorCode(error) === 'ENOENT'
        ? 'managed plugin package is missing'
        : 'managed plugin package cannot be inspected',
    );
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      'plugin package root must be a directory',
    );
  }

  const entries = new Map<string, PackageEntry>();
  const normalizedPaths = new Map<string, string>();
  const canonicalPackageRoot = await realpath(packageRoot);

  async function inspectDirectory(relativeDirectory: string): Promise<void> {
    const directoryPath = toAbsolutePackagePath(packageRoot, relativeDirectory);
    const expectedDirectory = await inspectContainedDirectory({
      path: directoryPath,
      canonicalRoot: canonicalPackageRoot,
      displayPath: relativeDirectory || '.',
    });
    const children = await readdir(directoryPath, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${child.name}`
        : child.name;
      registerNormalizedPath(normalizedPaths, relativePath);
      const stats = await lstat(
        toAbsolutePackagePath(packageRoot, relativePath),
      );
      assertSupportedPackageEntry(stats, relativePath);
      const kind = stats.isDirectory() ? 'directory' : 'file';
      entries.set(relativePath, {
        relativePath,
        kind,
        size: stats.size,
        device: stats.dev,
        inode: stats.ino,
      });
      if (kind === 'directory') {
        await inspectDirectory(relativePath);
      }
    }
    await assertDirectoryIdentity(
      directoryPath,
      expectedDirectory,
      relativeDirectory || '.',
    );
  }

  await inspectDirectory('');
  return entries;
}

function assertSupportedPackageEntry(
  stats: Awaited<ReturnType<typeof lstat>>,
  relativePath: string,
): void {
  if (stats.isSymbolicLink()) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      `plugin package contains a link: ${relativePath}`,
    );
  }
  if (stats.isFile()) {
    if (stats.nlink > 1) {
      throw new PluginPackageAdmissionError(
        'invalid_request',
        `plugin package contains a hard-linked file: ${relativePath}`,
      );
    }
    return;
  }
  if (!stats.isDirectory()) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      `plugin package contains an unsupported file kind: ${relativePath}`,
    );
  }
}

function registerNormalizedPath(
  normalizedPaths: Map<string, string>,
  relativePath: string,
): void {
  const normalized = relativePath.normalize('NFC').toLocaleLowerCase('en-US');
  const previous = normalizedPaths.get(normalized);
  if (previous !== undefined && previous !== relativePath) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      `plugin package contains colliding paths: ${previous}, ${relativePath}`,
    );
  }
  normalizedPaths.set(normalized, relativePath);
}

function validateManifest(manifest: Record<string, unknown>): {
  name: string;
  version: string;
  description: string;
  displayName: string;
} {
  const { name, version, description } = manifest;
  if (
    !isNonEmptyString(name) ||
    !PLUGIN_NAME_PATTERN.test(name) ||
    !isNonEmptyString(version) ||
    !SEMVER_PATTERN.test(version) ||
    !isNonEmptyString(description)
  ) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      'plugin manifest requires a valid name, strict semver version, and description',
    );
  }
  if (manifest.author !== undefined && !isValidAuthor(manifest.author)) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      'plugin manifest author has an invalid shape',
    );
  }
  if (manifest.interface !== undefined && !isRecord(manifest.interface)) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      'plugin manifest interface must be an object',
    );
  }
  const displayName = isRecord(manifest.interface)
    ? manifest.interface['displayName']
    : undefined;
  if (displayName !== undefined && !isNonEmptyString(displayName)) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      'plugin manifest interface.displayName must be a non-empty string',
    );
  }
  return {
    name,
    version,
    description,
    displayName: displayName ?? name,
  };
}

function readPluginIconPath(
  manifest: Record<string, unknown>,
  entries: Map<string, PackageEntry>,
): string | null {
  if (!isRecord(manifest.interface)) {
    return null;
  }
  for (const field of ['logo', 'composerIcon'] as const) {
    const value = manifest.interface[field];
    if (value === undefined) {
      continue;
    }
    if (!isNonEmptyString(value)) {
      throw new PluginPackageAdmissionError(
        'invalid_request',
        `plugin manifest interface.${field} must be a relative file path`,
      );
    }
    const relativePath = normalizeDeclaredPackagePath(
      value,
      `interface.${field}`,
    );
    if (entries.get(relativePath)?.kind !== 'file') {
      throw new PluginPackageAdmissionError(
        'invalid_request',
        `plugin manifest interface.${field} file does not exist`,
      );
    }
    if (pluginIconContentType(relativePath) === null) {
      throw new PluginPackageAdmissionError(
        'invalid_request',
        `plugin manifest interface.${field} has an unsupported image type`,
      );
    }
    return relativePath;
  }
  return null;
}

export function pluginIconContentType(relativePath: string): string | null {
  const extension = posix.extname(relativePath).toLocaleLowerCase('en-US');
  switch (extension) {
    case '.gif':
      return 'image/gif';
    case '.jpeg':
    case '.jpg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.svg':
      return 'image/svg+xml';
    case '.webp':
      return 'image/webp';
    default:
      return null;
  }
}

async function inventoryCapabilities(args: {
  packageRoot: string;
  entries: Map<string, PackageEntry>;
  manifest: Record<string, unknown>;
}): Promise<{
  capabilities: PluginCapabilityView[];
  skills: InspectedPluginSkill[];
  mcpServers: InspectedPluginMcpServer[];
}> {
  const counts = new Map<PluginCapabilityKind, number>();

  const skillPaths = collectComponentPaths({
    declared: args.manifest['skills'],
    field: 'skills',
    conventionalPath: 'skills',
    entries: args.entries,
    requiredKind: 'directory',
  });
  const skillEntryPaths = new Set(
    [...args.entries.values()]
      .filter(
        (entry) =>
          entry.kind === 'file' &&
          basename(entry.relativePath) === 'SKILL.md' &&
          skillPaths.some((skillPath) => {
            const relativeSkillPath = posix.relative(
              skillPath,
              entry.relativePath,
            );
            const segments = relativeSkillPath.split('/');
            return (
              segments.length === 2 &&
              segments[0] !== '' &&
              segments[1] === 'SKILL.md'
            );
          }),
      )
      .map((entry) => entry.relativePath),
  );
  const skills: InspectedPluginSkill[] = [];
  for (const entryPath of [...skillEntryPaths].sort((left, right) =>
    left.localeCompare(right),
  )) {
    const directoryPath = posix.dirname(entryPath);
    const resourcePaths = [...args.entries.values()]
      .filter(
        (entry) =>
          entry.kind === 'file' &&
          entry.relativePath !== entryPath &&
          isPathWithin(entry.relativePath, directoryPath),
      )
      .map((entry) => entry.relativePath);
    const openAiMetadataPath = `${directoryPath}/agents/openai.yaml`;
    const openAiMetadataEntry = args.entries.get(openAiMetadataPath);
    try {
      skills.push(
        parsePluginSkillDocument({
          entryPath,
          content: await readPackageBuffer(
            toAbsolutePackagePath(args.packageRoot, entryPath),
            args.entries.get(entryPath)!,
          ),
          ...(openAiMetadataEntry?.kind === 'file'
            ? {
                openAiMetadata: await readPackageBuffer(
                  toAbsolutePackagePath(args.packageRoot, openAiMetadataPath),
                  openAiMetadataEntry,
                ),
              }
            : {}),
          resourcePaths,
        }),
      );
    } catch (error: unknown) {
      if (error instanceof PluginSkillDocumentError) {
        throw new PluginPackageAdmissionError('invalid_request', error.message);
      }
      throw error;
    }
  }
  if (skills.length > 0) {
    counts.set('skills', skills.length);
  }

  const mcpServersByIdentity = new Map<
    string,
    {
      name: string;
      sourcePath: string;
      configuration: Record<string, unknown>;
      inspected: InspectedPluginMcpServer;
    }
  >();
  const declaredMcp = args.manifest['mcpServers'];
  if (isRecord(declaredMcp)) {
    addInspectedMcpServerEntries({
      destination: mcpServersByIdentity,
      entries: declaredMcp,
      sourcePath: MANIFEST_RELATIVE_PATH,
      packageEntries: args.entries,
    });
  } else if (declaredMcp !== undefined && !isNonEmptyString(declaredMcp)) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      'plugin manifest mcpServers must be a relative path or object',
    );
  }
  const mcpPaths = collectComponentPaths({
    declared: isNonEmptyString(declaredMcp) ? declaredMcp : undefined,
    field: 'mcpServers',
    conventionalPath: '.mcp.json',
    entries: args.entries,
    requiredKind: 'file',
  });
  for (const mcpPath of mcpPaths) {
    const config = await readJsonObject(
      toAbsolutePackagePath(args.packageRoot, mcpPath),
      mcpPath,
      args.entries.get(mcpPath)!,
    );
    const wrappedServers = config['mcpServers'];
    if (wrappedServers !== undefined && !isRecord(wrappedServers)) {
      throw new PluginPackageAdmissionError(
        'invalid_request',
        `plugin MCP declaration has an invalid shape: ${mcpPath}`,
      );
    }
    assertNoEmbeddedCredentials(config, mcpPath, {
      rootKeysAreComponentIdentities: wrappedServers === undefined,
      rootComponentIdentityFields: ['mcpServers'],
    });
    addInspectedMcpServerEntries({
      destination: mcpServersByIdentity,
      entries: isRecord(wrappedServers) ? wrappedServers : config,
      sourcePath: mcpPath,
      packageEntries: args.entries,
    });
  }
  const mcpServers = [...mcpServersByIdentity.values()]
    .map((entry) => entry.inspected)
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.sourcePath.localeCompare(right.sourcePath),
    );
  let mcpSupportStatus: PluginCapabilityView['supportStatus'] | undefined;
  if (mcpServers.length > 0) {
    counts.set('mcpServers', mcpServers.length);
    const supportedCount = mcpServers.filter(
      (server) => server.supportStatus === 'supported',
    ).length;
    mcpSupportStatus =
      supportedCount === mcpServers.length
        ? 'supported'
        : supportedCount === 0
          ? 'not-yet-supported'
          : 'partially-supported';
  }

  const appNames = new Set<string>();
  const appPaths = collectComponentPaths({
    declared: args.manifest['apps'],
    field: 'apps',
    conventionalPath: '.app.json',
    entries: args.entries,
    requiredKind: 'file',
  });
  for (const appsPath of appPaths) {
    const config = await readJsonObject(
      toAbsolutePackagePath(args.packageRoot, appsPath),
      appsPath,
      args.entries.get(appsPath)!,
    );
    const apps = config['apps'];
    if (!isRecord(apps)) {
      throw new PluginPackageAdmissionError(
        'invalid_request',
        `plugin App declaration has an invalid shape: ${appsPath}`,
      );
    }
    assertNoEmbeddedCredentials(config, appsPath, {
      rootComponentIdentityFields: ['apps'],
    });
    addNamedComponentEntries(appNames, apps, appsPath);
  }
  if (appNames.size > 0) {
    counts.set('apps', appNames.size);
  }

  const hookPaths = collectComponentPaths({
    declared: args.manifest['hooks'],
    field: 'hooks',
    conventionalPath: 'hooks',
    entries: args.entries,
  });
  const hookEntries = new Set<string>();
  for (const hooksPath of hookPaths) {
    const entry = args.entries.get(hooksPath)!;
    if (entry.kind === 'file') {
      hookEntries.add(hooksPath);
      continue;
    }
    for (const candidate of args.entries.values()) {
      if (
        candidate.kind === 'file' &&
        isPathWithin(candidate.relativePath, hooksPath)
      ) {
        hookEntries.add(candidate.relativePath);
      }
    }
  }
  if (hookEntries.size > 0) {
    counts.set('hooks', hookEntries.size);
  }

  return {
    capabilities: (
      ['skills', 'mcpServers', 'apps', 'hooks'] as const
    ).flatMap<PluginCapabilityView>((kind) => {
      const itemCount = counts.get(kind);
      if (itemCount === undefined) {
        return [];
      }
      if (kind === 'mcpServers') {
        if (mcpSupportStatus === undefined) {
          throw new PluginPackageAdmissionError(
            'invalid_request',
            'plugin MCP inventory support status is unavailable',
          );
        }
        return [{ kind, supportStatus: mcpSupportStatus, itemCount }];
      }
      return [
        {
          kind,
          supportStatus: COMPONENT_SUPPORT[kind],
          itemCount,
        },
      ];
    }),
    skills,
    mcpServers,
  };
}

function addInspectedMcpServerEntries(args: {
  destination: Map<
    string,
    {
      name: string;
      sourcePath: string;
      configuration: Record<string, unknown>;
      inspected: InspectedPluginMcpServer;
    }
  >;
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

function normalizeContainedRuntimePath(value: string): string | null {
  if (value.includes('\0') || isNonPortableAbsolutePath(value)) {
    return null;
  }
  const segments = value.replaceAll('\\', '/').split('/');
  if (segments.some((segment) => segment === '..')) {
    return null;
  }
  const normalized = posix.normalize(value.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../')) {
    return null;
  }
  return normalized.replace(/^\.\//u, '').replace(/\/+$/u, '') || '.';
}

function isNonPortableAbsolutePath(value: string): boolean {
  return (
    isAbsolute(value) || win32.isAbsolute(value) || /^[A-Za-z]:/u.test(value)
  );
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

function collectComponentPaths(args: {
  declared: unknown;
  field: 'skills' | 'mcpServers' | 'apps' | 'hooks';
  conventionalPath: string;
  entries: Map<string, PackageEntry>;
  requiredKind?: PackageEntry['kind'];
}): string[] {
  if (args.declared !== undefined && !isNonEmptyString(args.declared)) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      `plugin manifest ${args.field} declaration must be a relative path`,
    );
  }
  const paths = new Set<string>();
  if (isNonEmptyString(args.declared)) {
    paths.add(normalizeDeclaredPackagePath(args.declared, args.field));
  }
  if (args.entries.has(args.conventionalPath)) {
    paths.add(args.conventionalPath);
  }
  for (const componentPath of paths) {
    const entry = args.entries.get(componentPath);
    if (!entry) {
      throw new PluginPackageAdmissionError(
        'invalid_request',
        `plugin manifest component path does not exist: ${args.field}`,
      );
    }
    if (args.requiredKind && entry.kind !== args.requiredKind) {
      throw new PluginPackageAdmissionError(
        'invalid_request',
        `plugin manifest component has the wrong file kind: ${args.field}`,
      );
    }
  }
  return [...paths];
}

function addNamedComponentEntries(
  names: Set<string>,
  entries: Record<string, unknown>,
  sourceLabel: string,
): void {
  for (const [name, entry] of Object.entries(entries)) {
    if (!isNonEmptyString(name) || !isRecord(entry)) {
      throw new PluginPackageAdmissionError(
        'invalid_request',
        `plugin component entries require non-empty names and object values: ${sourceLabel}`,
      );
    }
    names.add(name);
  }
}

function normalizeDeclaredPackagePath(value: string, field: string): string {
  if (
    value.includes('\0') ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      `plugin manifest component path is not contained: ${field}`,
    );
  }
  const segments = value.replaceAll('\\', '/').split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      `plugin manifest component path is not contained: ${field}`,
    );
  }
  const normalized = posix.normalize(value.replaceAll('\\', '/'));
  if (
    normalized === '.' ||
    normalized === '' ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      `plugin manifest component path is not contained: ${field}`,
    );
  }
  return normalized.replace(/^\.\//u, '').replace(/\/+$/u, '');
}

async function digestPackage(
  packageRoot: string,
  entries: Map<string, PackageEntry>,
): Promise<string> {
  const digest = createHash('sha256');
  const orderedEntries = [...entries.values()].sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.relativePath, 'utf8'),
      Buffer.from(right.relativePath, 'utf8'),
    ),
  );
  for (const entry of orderedEntries) {
    if (entry.kind === 'directory') {
      digest.update(`D\0${entry.relativePath}\0`);
    } else {
      digest.update(`F\0${entry.relativePath}\0${entry.size}\0`);
      const file = await openPackageFile(
        toAbsolutePackagePath(packageRoot, entry.relativePath),
        entry,
      );
      try {
        for await (const chunk of file.createReadStream()) {
          if (!Buffer.isBuffer(chunk)) {
            throw new PluginPackageAdmissionError(
              'invalid_request',
              `plugin package file stream produced non-binary data: ${entry.relativePath}`,
            );
          }
          digest.update(chunk);
        }
      } finally {
        await file.close().catch(() => undefined);
      }
    }
    digest.update('\0');
  }
  return `sha256:${digest.digest('hex')}`;
}

async function openPackageFile(
  absolutePath: string,
  expectedEntry: PackageEntry,
): Promise<Awaited<ReturnType<typeof open>>> {
  const expectedStats = await lstat(absolutePath);
  assertSupportedPackageEntry(expectedStats, expectedEntry.relativePath);
  if (
    expectedEntry.kind !== 'file' ||
    !expectedStats.isFile() ||
    expectedStats.dev !== expectedEntry.device ||
    expectedStats.ino !== expectedEntry.inode ||
    expectedStats.size !== expectedEntry.size
  ) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      `plugin package entry changed during inspection: ${expectedEntry.relativePath}`,
    );
  }

  const file = await open(
    absolutePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const openedStats = await file.stat();
    assertSupportedPackageEntry(openedStats, expectedEntry.relativePath);
    if (
      !openedStats.isFile() ||
      openedStats.dev !== expectedEntry.device ||
      openedStats.ino !== expectedEntry.inode ||
      openedStats.size !== expectedEntry.size
    ) {
      throw new PluginPackageAdmissionError(
        'invalid_request',
        `plugin package entry changed during inspection: ${expectedEntry.relativePath}`,
      );
    }
    return file;
  } catch (error: unknown) {
    await file.close().catch(() => undefined);
    throw error;
  }
}

async function readPackageBuffer(
  absolutePath: string,
  expectedEntry: PackageEntry,
): Promise<Buffer> {
  const file = await openPackageFile(absolutePath, expectedEntry);
  try {
    return await file.readFile();
  } finally {
    await file.close().catch(() => undefined);
  }
}

async function readJsonObject(
  absolutePath: string,
  displayPath: string,
  expectedEntry: PackageEntry,
): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    const file = await openPackageFile(absolutePath, expectedEntry);
    try {
      parsed = JSON.parse(await file.readFile('utf8')) as unknown;
    } finally {
      await file.close().catch(() => undefined);
    }
  } catch (error: unknown) {
    if (error instanceof PluginPackageAdmissionError) {
      throw error;
    }
    throw new PluginPackageAdmissionError(
      'invalid_request',
      `plugin JSON is invalid: ${displayPath}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new PluginPackageAdmissionError(
      'invalid_request',
      `plugin JSON must contain an object: ${displayPath}`,
    );
  }
  return parsed;
}

function assertNoEmbeddedCredentials(
  root: Record<string, unknown>,
  displayPath: string,
  options: {
    rootKeysAreComponentIdentities?: boolean;
    rootComponentIdentityFields?: readonly string[];
  } = {},
): void {
  const rootComponentIdentityFields = new Set(
    options.rootComponentIdentityFields ?? [],
  );
  const pending: Array<{
    value: Record<string, unknown> | unknown[];
    keysAreComponentIdentities: boolean;
  }> = [
    {
      value: root,
      keysAreComponentIdentities:
        options.rootKeysAreComponentIdentities === true,
    },
  ];
  while (pending.length > 0) {
    const { value, keysAreComponentIdentities } = pending.pop()!;
    for (const [key, child] of Object.entries(value)) {
      if (
        !keysAreComponentIdentities &&
        isCredentialValueKey(key) &&
        !isCredentialReferenceKey(key)
      ) {
        throw new PluginPackageAdmissionError(
          'invalid_request',
          `plugin configuration contains an inline credential field: ${displayPath}`,
        );
      }
      if (Array.isArray(child) || isRecord(child)) {
        pending.push({
          value: child,
          keysAreComponentIdentities:
            !keysAreComponentIdentities &&
            value === root &&
            rootComponentIdentityFields.has(key),
        });
      }
    }
  }
}

function isCredentialValueKey(key: string): boolean {
  return /(?:secret|password|passphrase|token|api[_-]?key|credential|private[_-]?key|authorization|cookie)/iu.test(
    key,
  );
}

function isCredentialReferenceKey(key: string): boolean {
  return /(?:env(?:ironment)?[_-]?(?:var|key)|[_-](?:ref|reference|name)|envKeys$)/iu.test(
    key,
  );
}

function isValidAuthor(value: unknown): boolean {
  return (
    isNonEmptyString(value) ||
    (isRecord(value) && isNonEmptyString(value['name']))
  );
}

function isPathWithin(relativePath: string, directoryPath: string): boolean {
  return (
    relativePath === directoryPath ||
    relativePath.startsWith(`${directoryPath}/`)
  );
}

function toAbsolutePackagePath(root: string, relativePath: string): string {
  return relativePath === '' ? root : join(root, ...relativePath.split('/'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
