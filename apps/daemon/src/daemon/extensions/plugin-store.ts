import type {
  InstalledPluginView,
  PluginInstallRequest,
  PluginMarketplaceInstallationSourceView,
} from '@geulbat/protocol/plugins';
import {
  isInstalledPluginView,
  isPluginInstallRequest,
} from '@geulbat/protocol/plugins';
import { randomUUID } from 'node:crypto';
import {
  constants,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { isAbsolute, join, posix, win32 } from 'node:path';

import type { ComputerFileScope } from '../files/computer-file-scope.js';
import {
  checkNoSymlinkPathSegments,
  isPathInsideWorkspaceBoundary,
} from '../files/normalize-path.js';
import { writeTextFileAtomically } from '../utils/atomic-file.js';
import { getErrorCode } from '../utils/error.js';
import {
  PluginPackageAdmissionError,
  inspectPluginPackage,
  readPluginPackageFile,
  stagePluginPackage,
  type InspectedPluginPackage,
  type InspectedPluginMcpServer,
  type PluginMcpStdioConfig,
} from './plugin-package-admission.js';
import {
  buildPluginSkillDirectoryEntries,
  buildPluginSkillCatalogEntry,
  digestPluginSkillFile,
  parsePluginSkillLogicalPath,
  pluginSkillId,
  type InspectedPluginSkill,
  type PluginSkillCatalogEntry,
  type PluginSkillDirectory,
  type PluginSkillFile,
  type PluginSkillInventory,
  type PluginSkillRuntime,
} from './plugin-skill-runtime.js';

const REGISTRY_SCHEMA_VERSION = 4 as const;
const LEGACY_REGISTRY_SCHEMA_VERSION = 1 as const;
const SKILL_RUNTIME_REGISTRY_SCHEMA_VERSION = 2 as const;
const MCP_RUNTIME_REGISTRY_SCHEMA_VERSION = 3 as const;
const INSTALLATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTENT_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

interface PersistedPluginRegistry {
  schemaVersion:
    | typeof LEGACY_REGISTRY_SCHEMA_VERSION
    | typeof SKILL_RUNTIME_REGISTRY_SCHEMA_VERSION
    | typeof MCP_RUNTIME_REGISTRY_SCHEMA_VERSION
    | typeof REGISTRY_SCHEMA_VERSION;
  plugins: PersistedPluginRecord[];
}

interface PersistedPluginRecord {
  view: InstalledPluginView;
  packageObjectId: string;
}

interface ManagedDirectoryIdentity {
  canonicalPath: string;
  device: bigint;
  inode: bigint;
  birthtimeNs: bigint;
}

interface ManagedRootIdentities {
  extensions: ManagedDirectoryIdentity;
  plugins: ManagedDirectoryIdentity;
  staging: ManagedDirectoryIdentity;
}

export interface PluginStore extends PluginSkillRuntime {
  initialize(): Promise<void>;
  listPlugins(): InstalledPluginView[];
  installPlugin(
    request: PluginInstallRequest,
    computerFileScope: ComputerFileScope | undefined,
  ): Promise<InstalledPluginView>;
  installMarketplacePlugin(
    candidate: PluginMarketplaceInstallCandidate,
  ): Promise<InstalledPluginView>;
  setEnabled(
    installationId: string,
    enabled: boolean,
  ): Promise<InstalledPluginView>;
  listSupportedBundledMcpServers(): Promise<PluginBundledMcpServerSnapshot[]>;
  resolveBundledMcpServerLaunch(
    request: PluginBundledMcpLaunchRequest,
  ): Promise<PluginBundledMcpLaunch>;
  uninstall(installationId: string): Promise<void>;
}

export interface PluginMarketplaceInstallCandidate {
  sourceRoot: string;
  expectedContentDigest: string;
  source: PluginMarketplaceInstallationSourceView;
}

export interface PluginBundledMcpServerSnapshot {
  installationId: string;
  pluginName: string;
  pluginDisplayName: string;
  pluginVersion: string;
  pluginContentDigest: string;
  pluginEnabled: boolean;
  pluginServerName: string;
  sourcePath: string;
  config: PluginMcpStdioConfig;
}

export interface PluginBundledMcpLaunchRequest {
  installationId: string;
  pluginContentDigest: string;
  pluginServerName: string;
}

export interface PluginBundledMcpLaunch extends PluginBundledMcpServerSnapshot {
  absoluteCwd: string;
}

export type PluginStoreErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'conflict'
  | 'corrupt_registry';

export class PluginStoreError extends Error {
  constructor(
    readonly code: PluginStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PluginStoreError';
  }
}

export function createPluginStore(args: {
  homeStateRoot: string;
}): PluginStore {
  const extensionsRoot = join(args.homeStateRoot, 'extensions');
  const pluginsRoot = join(extensionsRoot, 'plugins');
  const stagingRoot = join(extensionsRoot, '.staging');
  const registryPath = join(extensionsRoot, 'registry.json');
  const registrations = new Map<string, InstalledPluginView>();
  const packageObjectIds = new Map<string, string>();
  let initialized = false;
  let managedRootIdentities: ManagedRootIdentities | undefined;
  let mutationTail: Promise<void> = Promise.resolve();

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function assertInitialized(): void {
    if (!initialized) {
      throw new Error('plugin store is not initialized');
    }
  }

  async function persist(
    plugins: InstalledPluginView[],
    objectIds: ReadonlyMap<string, string> = packageObjectIds,
  ): Promise<void> {
    const registry: PersistedPluginRegistry = {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      plugins: plugins.map((plugin) => {
        const packageObjectId = objectIds.get(plugin.installationId);
        if (!packageObjectId) {
          throw new PluginStoreError(
            'corrupt_registry',
            'plugin package object identity is missing',
          );
        }
        return { view: plugin, packageObjectId };
      }),
    };
    try {
      await assertManagedRootsUnchanged();
      await writeTextFileAtomically(
        registryPath,
        `${JSON.stringify(registry, null, 2)}\n`,
        { mode: 0o600 },
      );
    } catch (error: unknown) {
      throw safeStorageError('plugin registry update failed', error);
    }
  }

  async function establishManagedRoots(): Promise<void> {
    if (managedRootIdentities) {
      await assertManagedRootsUnchanged();
      return;
    }
    await ensureManagedDirectory(extensionsRoot, 'extensions root');
    await ensureManagedDirectory(pluginsRoot, 'plugins root');
    await ensureManagedDirectory(stagingRoot, 'plugin staging root');
    managedRootIdentities = await captureManagedRootIdentities({
      extensionsRoot,
      pluginsRoot,
      stagingRoot,
    });
  }

  async function assertManagedRootsUnchanged(): Promise<void> {
    if (!managedRootIdentities) {
      throw new PluginStoreError(
        'corrupt_registry',
        'plugin managed roots have not been established',
      );
    }
    await assertManagedRootIdentities(
      {
        extensionsRoot,
        pluginsRoot,
        stagingRoot,
      },
      managedRootIdentities,
    );
  }

  function packageObjectIdFor(plugin: InstalledPluginView): string {
    const packageObjectId = packageObjectIds.get(plugin.installationId);
    if (!packageObjectId) {
      throw new PluginStoreError(
        'corrupt_registry',
        'plugin package object identity is missing',
      );
    }
    return packageObjectId;
  }

  function packageRootFor(plugin: InstalledPluginView): string {
    return join(pluginsRoot, packageObjectIdFor(plugin), 'package');
  }

  async function inspectRegisteredPackage(
    plugin: InstalledPluginView,
  ): Promise<InspectedPluginPackage> {
    const inspected = await inspectPluginPackage(packageRootFor(plugin));
    assertPersistedPackageMatches(plugin, inspected, false);
    return inspected;
  }

  async function listPluginSkillsOperation(
    includeDisabled: boolean,
  ): Promise<PluginSkillInventory> {
    assertInitialized();
    const plugins = [...registrations.values()]
      .filter((plugin) => includeDisabled || plugin.enabled)
      .sort((left, right) =>
        left.installationId.localeCompare(right.installationId),
      );
    if (plugins.length === 0) {
      return { skills: [], diagnostics: [] };
    }

    await assertManagedRootsUnchanged();
    const skills: PluginSkillCatalogEntry[] = [];
    const diagnostics: PluginSkillInventory['diagnostics'] = [];
    for (const plugin of plugins) {
      try {
        const inspected = await inspectRegisteredPackage(plugin);
        skills.push(
          ...inspected.skills.map((skill) =>
            buildPluginSkillCatalogEntry({
              sourcePlugin: pluginSkillSource(plugin),
              skill,
              enabled: plugin.enabled,
            }),
          ),
        );
      } catch (error: unknown) {
        if (
          error instanceof PluginPackageAdmissionError ||
          error instanceof PluginStoreError
        ) {
          diagnostics.push({
            pluginInstallationId: plugin.installationId,
            pluginName: plugin.name,
            code: 'managed-package-invalid',
            message:
              'managed plugin package is missing, invalid, or inconsistent',
          });
          continue;
        }
        throw error;
      }
    }
    await assertManagedRootsUnchanged();
    skills.sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.sourcePlugin.name.localeCompare(right.sourcePlugin.name) ||
        left.skillRef.localeCompare(right.skillRef),
    );
    return { skills, diagnostics };
  }

  async function resolveEnabledSkillTarget(logicalPath: string): Promise<{
    plugin: InstalledPluginView;
    inspected: InspectedPluginPackage;
    skill: InspectedPluginSkill;
    catalogEntry: PluginSkillCatalogEntry;
    relativePath: string;
  }> {
    const parsed = parsePluginSkillLogicalPath(logicalPath);
    if (parsed === null) {
      throw new PluginStoreError(
        'invalid_request',
        'plugin skill reference is invalid',
      );
    }
    const plugin = registrations.get(parsed.installationId);
    if (!plugin?.enabled) {
      throw new PluginStoreError(
        'not_found',
        'enabled plugin skill was not found',
      );
    }
    await assertManagedRootsUnchanged();
    const inspected = await inspectRegisteredPackage(plugin);
    const skill = inspected.skills.find(
      (candidate) => pluginSkillId(candidate.entryPath) === parsed.skillId,
    );
    if (!skill) {
      throw new PluginStoreError(
        'not_found',
        'enabled plugin skill was not found',
      );
    }
    return {
      plugin,
      inspected,
      skill,
      catalogEntry: buildPluginSkillCatalogEntry({
        sourcePlugin: pluginSkillSource(plugin),
        skill,
        enabled: true,
      }),
      relativePath: parsed.relativePath,
    };
  }

  async function listSupportedBundledMcpServersOperation(): Promise<
    PluginBundledMcpServerSnapshot[]
  > {
    assertInitialized();
    const plugins = [...registrations.values()].sort((left, right) =>
      left.installationId.localeCompare(right.installationId),
    );
    if (plugins.length === 0) {
      return [];
    }

    await assertManagedRootsUnchanged();
    const servers: PluginBundledMcpServerSnapshot[] = [];
    for (const plugin of plugins) {
      const inspected = await inspectRegisteredPackage(plugin);
      servers.push(
        ...inspected.mcpServers
          .filter(isRunnablePluginMcpServer)
          .map((server) => pluginMcpServerSnapshot(plugin, server)),
      );
    }
    await assertManagedRootsUnchanged();
    return servers.sort(
      (left, right) =>
        left.pluginDisplayName.localeCompare(right.pluginDisplayName) ||
        left.pluginName.localeCompare(right.pluginName) ||
        left.pluginServerName.localeCompare(right.pluginServerName) ||
        left.installationId.localeCompare(right.installationId),
    );
  }

  async function resolveBundledMcpServerLaunchOperation(
    request: PluginBundledMcpLaunchRequest,
  ): Promise<PluginBundledMcpLaunch> {
    assertInitialized();
    assertPluginMcpLaunchRequest(request);
    const plugin = registrations.get(request.installationId);
    if (!plugin?.enabled) {
      throw new PluginStoreError(
        'not_found',
        'enabled bundled plugin MCP server was not found',
      );
    }
    if (plugin.contentDigest !== request.pluginContentDigest) {
      throw new PluginStoreError(
        'conflict',
        'bundled plugin MCP launch identity is stale',
      );
    }

    await assertManagedRootsUnchanged();
    const inspected = await inspectRegisteredPackage(plugin);
    const server = inspected.mcpServers.find(
      (candidate) =>
        candidate.name === request.pluginServerName &&
        isRunnablePluginMcpServer(candidate),
    );
    if (!server || !isRunnablePluginMcpServer(server)) {
      throw new PluginStoreError(
        'not_found',
        'enabled bundled plugin MCP server was not found',
      );
    }

    const packageRoot = packageRootFor(plugin);
    const canonicalPackageRoot = await realpath(packageRoot);
    const absoluteCwd = await realpath(
      server.config.relativeCwd === '.'
        ? packageRoot
        : join(
            packageRoot,
            ...server.config.relativeCwd.split('/').filter(Boolean),
          ),
    );
    if (!isPathInsideWorkspaceBoundary(canonicalPackageRoot, absoluteCwd)) {
      throw new PluginStoreError(
        'corrupt_registry',
        'bundled plugin MCP cwd escaped its managed package',
      );
    }
    await assertManagedRootsUnchanged();
    return {
      ...pluginMcpServerSnapshot(plugin, server),
      absoluteCwd,
    };
  }

  async function installPackageFromSource(args: {
    sourceRoot: string;
    source:
      | { kind: 'local-directory' }
      | {
          kind: 'marketplace';
          provenance: PluginMarketplaceInstallationSourceView;
          expectedContentDigest: string;
        };
  }): Promise<InstalledPluginView> {
    const installationId = randomUUID();
    const packageObjectId = randomUUID();
    const stageInstallationRoot = join(stagingRoot, packageObjectId);
    const stagePackageRoot = join(stageInstallationRoot, 'package');
    const finalInstallationRoot = join(pluginsRoot, packageObjectId);
    let movedToFinal = false;
    let managedRootsAdmitted = false;
    let stagedInstallationIdentity: ManagedDirectoryIdentity | undefined;

    try {
      await establishManagedRoots();
      managedRootsAdmitted = true;
      await mkdir(stagePackageRoot, { recursive: true, mode: 0o700 });
      await assertManagedRootsUnchanged();
      stagedInstallationIdentity = await captureManagedDirectoryIdentity(
        stageInstallationRoot,
        'plugin staging installation',
      );
      const inspected = await stagePluginPackage({
        sourceRoot: args.sourceRoot,
        destinationRoot: stagePackageRoot,
      });
      if (
        args.source.kind === 'marketplace' &&
        inspected.contentDigest !== args.source.expectedContentDigest
      ) {
        throw new PluginStoreError(
          'conflict',
          'marketplace plugin bytes changed after catalog selection',
        );
      }
      await assertManagedRootsUnchanged();
      await assertManagedDirectoryIdentity(
        stageInstallationRoot,
        'plugin staging installation',
        stagedInstallationIdentity,
      );
      const now = new Date().toISOString();
      const plugin: InstalledPluginView = {
        installationId,
        name: inspected.manifest.name,
        displayName: inspected.manifest.displayName,
        version: inspected.manifest.version,
        description: inspected.manifest.description,
        enabled: false,
        contentDigest: inspected.contentDigest,
        sourceKind: args.source.kind,
        ...(args.source.kind === 'marketplace'
          ? { marketplaceSource: args.source.provenance }
          : {}),
        installedAt: now,
        updatedAt: now,
        capabilities: inspected.capabilities,
      };

      await rename(stageInstallationRoot, finalInstallationRoot);
      movedToFinal = true;
      await assertManagedRootsUnchanged();
      const finalInstallationIdentity = await captureManagedDirectoryIdentity(
        finalInstallationRoot,
        'managed plugin installation',
      );
      assertSameManagedDirectoryObject(
        stagedInstallationIdentity,
        finalInstallationIdentity,
        'managed plugin installation',
      );
      stagedInstallationIdentity = finalInstallationIdentity;
      await assertManagedDirectoryIdentity(
        finalInstallationRoot,
        'managed plugin installation',
        finalInstallationIdentity,
      );
      const finalInspected = await inspectPluginPackage(
        join(finalInstallationRoot, 'package'),
      );
      assertPersistedPackageMatches(plugin, finalInspected, false);
      await assertManagedRootsUnchanged();
      const nextObjectIds = new Map(packageObjectIds);
      nextObjectIds.set(installationId, packageObjectId);
      await persist([...registrations.values(), plugin], nextObjectIds);
      packageObjectIds.set(installationId, packageObjectId);
      registrations.set(installationId, plugin);
      return plugin;
    } catch (error: unknown) {
      if (managedRootsAdmitted && stagedInstallationIdentity) {
        try {
          await assertManagedRootsUnchanged();
          const cleanupRoot = movedToFinal
            ? finalInstallationRoot
            : stageInstallationRoot;
          await assertManagedDirectoryIdentity(
            cleanupRoot,
            movedToFinal
              ? 'managed plugin installation'
              : 'plugin staging installation',
            stagedInstallationIdentity,
          );
          await rm(cleanupRoot, { recursive: true, force: true });
        } catch (cleanupError: unknown) {
          throw safeStorageError(
            'plugin installation failed and managed staging cleanup also failed',
            cleanupError,
          );
        }
      }
      if (error instanceof PluginStoreError) {
        throw error;
      }
      if (error instanceof PluginPackageAdmissionError) {
        throw new PluginStoreError('invalid_request', error.message);
      }
      throw safeStorageError('plugin installation failed', error);
    }
  }

  return {
    async initialize() {
      await serialize(async () => {
        if (initialized) {
          return;
        }
        try {
          await mkdir(args.homeStateRoot, { recursive: true, mode: 0o700 });
          await realpath(args.homeStateRoot);
          const existingExtensionsRoot = await lstatIfExists(extensionsRoot);
          if (existingExtensionsRoot) {
            assertManagedDirectory(existingExtensionsRoot, 'extensions root');
          }
          const persistedRegistry = await readPersistedRegistry(registryPath);
          if (!persistedRegistry && !existingExtensionsRoot) {
            initialized = true;
            return;
          }
          const registry: PersistedPluginRegistry = persistedRegistry ?? {
            schemaVersion: REGISTRY_SCHEMA_VERSION,
            plugins: [],
          };
          await reconcileManagedStore({
            extensionsRoot,
            pluginsRoot,
            stagingRoot,
            registeredIds: new Set(
              registry.plugins.map((plugin) => plugin.packageObjectId),
            ),
          });
          managedRootIdentities = await captureManagedRootIdentities({
            extensionsRoot,
            pluginsRoot,
            stagingRoot,
          });

          const allowCapabilityStatusMigration =
            registry.schemaVersion !== REGISTRY_SCHEMA_VERSION;
          const normalizedPlugins: InstalledPluginView[] = [];
          const normalizedObjectIds = new Map<string, string>();
          let registryMigrationRequired = allowCapabilityStatusMigration;
          for (const record of registry.plugins) {
            const plugin = record.view;
            const inspected = await inspectPluginPackage(
              join(pluginsRoot, record.packageObjectId, 'package'),
            );
            assertPersistedPackageMatches(
              plugin,
              inspected,
              allowCapabilityStatusMigration,
            );
            const normalizedPlugin = {
              ...plugin,
              capabilities: inspected.capabilities,
            };
            registryMigrationRequired ||=
              JSON.stringify(plugin.capabilities) !==
              JSON.stringify(normalizedPlugin.capabilities);
            normalizedPlugins.push(normalizedPlugin);
            normalizedObjectIds.set(
              plugin.installationId,
              record.packageObjectId,
            );
          }
          if (registryMigrationRequired) {
            await persist(normalizedPlugins, normalizedObjectIds);
          }
          for (const plugin of normalizedPlugins) {
            registrations.set(plugin.installationId, plugin);
            packageObjectIds.set(
              plugin.installationId,
              normalizedObjectIds.get(plugin.installationId) ??
                plugin.installationId,
            );
          }
          initialized = true;
        } catch (error: unknown) {
          registrations.clear();
          packageObjectIds.clear();
          if (error instanceof PluginStoreError) {
            throw error;
          }
          if (error instanceof PluginPackageAdmissionError) {
            throw new PluginStoreError(
              'corrupt_registry',
              'managed plugin package is missing, invalid, or inconsistent',
            );
          }
          throw new PluginStoreError(
            'corrupt_registry',
            safeErrorMessage('plugin store initialization failed', error),
          );
        }
      });
    },

    listPlugins() {
      assertInitialized();
      return [...registrations.values()].sort((left, right) =>
        left.displayName.localeCompare(right.displayName),
      );
    },

    async listPluginSkills(options) {
      return serialize(() =>
        listPluginSkillsOperation(options?.includeDisabled ?? false),
      );
    },

    async listSupportedBundledMcpServers() {
      return serialize(listSupportedBundledMcpServersOperation);
    },

    async resolveBundledMcpServerLaunch(request) {
      return serialize(() => resolveBundledMcpServerLaunchOperation(request));
    },

    async readEnabledSkillFile(logicalPath) {
      return serialize(async (): Promise<PluginSkillFile> => {
        assertInitialized();
        const target = await resolveEnabledSkillTarget(logicalPath);
        if (target.relativePath === '') {
          throw new PluginStoreError(
            'not_found',
            'plugin skill reference names a directory, not a file',
          );
        }
        const packageRelativePath =
          target.relativePath === 'SKILL.md'
            ? target.skill.entryPath
            : posix.join(target.skill.directoryPath, target.relativePath);
        if (
          packageRelativePath !== target.skill.entryPath &&
          !target.skill.resourcePaths.includes(packageRelativePath)
        ) {
          throw new PluginStoreError(
            'not_found',
            'plugin skill resource was not found',
          );
        }
        const content = await readPluginPackageFile({
          packageRoot: packageRootFor(target.plugin),
          relativePath: packageRelativePath,
        });
        const after = await inspectRegisteredPackage(target.plugin);
        const afterSkill = after.skills.find(
          (candidate) =>
            pluginSkillId(candidate.entryPath) ===
            pluginSkillId(target.skill.entryPath),
        );
        if (
          !afterSkill ||
          afterSkill.documentDigest !== target.skill.documentDigest
        ) {
          throw new PluginStoreError(
            'corrupt_registry',
            'managed plugin skill changed while it was being read',
          );
        }
        await assertManagedRootsUnchanged();
        let text: string;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(content);
        } catch {
          throw new PluginStoreError(
            'invalid_request',
            'plugin skill resource is not valid UTF-8 text',
          );
        }
        return {
          logicalPath,
          content: text,
          contentDigest: digestPluginSkillFile(content),
          skill: target.catalogEntry,
          packageRelativePath,
        };
      });
    },

    async listEnabledSkillDirectory(logicalPath, recursive) {
      return serialize(async (): Promise<PluginSkillDirectory> => {
        assertInitialized();
        const target = await resolveEnabledSkillTarget(logicalPath);
        const files = [
          'SKILL.md',
          ...target.skill.resourcePaths.map((resourcePath) =>
            posix.relative(target.skill.directoryPath, resourcePath),
          ),
        ];
        const entries = buildPluginSkillDirectoryEntries({
          skillRootRef: target.catalogEntry.skillRootRef,
          directoryPath: target.relativePath,
          files,
          recursive,
        });
        if (entries === null) {
          throw new PluginStoreError(
            'not_found',
            'plugin skill directory was not found',
          );
        }
        await assertManagedRootsUnchanged();
        return {
          logicalPath,
          entries,
          skill: target.catalogEntry,
        };
      });
    },

    async installPlugin(request, computerFileScope) {
      return serialize(async () => {
        assertInitialized();
        if (!isPluginInstallRequest(request)) {
          throw new PluginStoreError(
            'invalid_request',
            'plugin source must be a portable computer-relative directory path',
          );
        }
        const sourceRoot = await resolvePluginSource(
          request,
          computerFileScope,
        );
        await assertSourceDisjointFromHome(sourceRoot, args.homeStateRoot);
        return installPackageFromSource({
          sourceRoot,
          source: { kind: 'local-directory' },
        });
      });
    },

    async installMarketplacePlugin(candidate) {
      return serialize(async () => {
        assertInitialized();
        if (
          !CONTENT_DIGEST_PATTERN.test(candidate.expectedContentDigest) ||
          candidate.sourceRoot.trim().length === 0
        ) {
          throw new PluginStoreError(
            'invalid_request',
            'marketplace plugin candidate is invalid',
          );
        }
        if (
          [...registrations.values()].some(
            (plugin) =>
              plugin.marketplaceSource?.marketplaceId ===
                candidate.source.marketplaceId &&
              plugin.marketplaceSource.entryId === candidate.source.entryId,
          )
        ) {
          throw new PluginStoreError(
            'conflict',
            'marketplace plugin is already installed',
          );
        }
        return installPackageFromSource({
          sourceRoot: candidate.sourceRoot,
          source: {
            kind: 'marketplace',
            provenance: candidate.source,
            expectedContentDigest: candidate.expectedContentDigest,
          },
        });
      });
    },

    async setEnabled(installationId, enabled) {
      return serialize(async () => {
        assertInitialized();
        const current = registrations.get(installationId);
        if (!current) {
          throw new PluginStoreError(
            'not_found',
            `plugin installation was not found: ${installationId}`,
          );
        }
        await assertManagedRootsUnchanged();
        if (enabled) {
          const inspected = await inspectPluginPackage(packageRootFor(current));
          assertPersistedPackageMatches(current, inspected, false);
          await assertManagedRootsUnchanged();
        }
        if (current.enabled === enabled) {
          return current;
        }
        const updated: InstalledPluginView = {
          ...current,
          enabled,
          updatedAt: new Date().toISOString(),
        };
        const next = [...registrations.values()].map((plugin) =>
          plugin.installationId === installationId ? updated : plugin,
        );
        await persist(next);
        registrations.set(installationId, updated);
        return updated;
      });
    },

    async uninstall(installationId) {
      await serialize(async () => {
        assertInitialized();
        const current = registrations.get(installationId);
        if (!current) {
          throw new PluginStoreError(
            'not_found',
            `plugin installation was not found: ${installationId}`,
          );
        }
        await assertManagedRootsUnchanged();
        const installationRoot = join(pluginsRoot, packageObjectIdFor(current));
        const installationIdentity = await captureManagedDirectoryIdentity(
          installationRoot,
          'managed plugin installation',
        );

        if (current.enabled) {
          const disabled: InstalledPluginView = {
            ...current,
            enabled: false,
            updatedAt: new Date().toISOString(),
          };
          await persist(
            [...registrations.values()].map((plugin) =>
              plugin.installationId === installationId ? disabled : plugin,
            ),
          );
          registrations.set(installationId, disabled);
        }

        const remaining = [...registrations.values()].filter(
          (plugin) => plugin.installationId !== installationId,
        );
        await persist(remaining);
        registrations.delete(installationId);
        packageObjectIds.delete(installationId);
        try {
          await assertManagedRootsUnchanged();
          await assertManagedDirectoryIdentity(
            installationRoot,
            'managed plugin installation',
            installationIdentity,
          );
          await rm(installationRoot, {
            recursive: true,
            force: true,
          });
        } catch (error: unknown) {
          throw safeStorageError(
            'plugin registry was removed but managed bytes cleanup failed',
            error,
          );
        }
      });
    },
  };
}

interface RunnablePluginMcpServer extends InspectedPluginMcpServer {
  supportStatus: 'supported';
  config: PluginMcpStdioConfig;
}

function isRunnablePluginMcpServer(
  server: InspectedPluginMcpServer,
): server is RunnablePluginMcpServer {
  return server.supportStatus === 'supported' && server.config !== undefined;
}

function pluginMcpServerSnapshot(
  plugin: InstalledPluginView,
  server: RunnablePluginMcpServer,
): PluginBundledMcpServerSnapshot {
  return {
    installationId: plugin.installationId,
    pluginName: plugin.name,
    pluginDisplayName: plugin.displayName,
    pluginVersion: plugin.version,
    pluginContentDigest: plugin.contentDigest,
    pluginEnabled: plugin.enabled,
    pluginServerName: server.name,
    sourcePath: server.sourcePath,
    config: {
      ...server.config,
      args: [...server.config.args],
      envKeys: [...server.config.envKeys],
    },
  };
}

function assertPluginMcpLaunchRequest(
  request: PluginBundledMcpLaunchRequest,
): void {
  if (
    !isRecord(request) ||
    !hasOnlyKeys(request, [
      'installationId',
      'pluginContentDigest',
      'pluginServerName',
    ]) ||
    typeof request['installationId'] !== 'string' ||
    !INSTALLATION_ID_PATTERN.test(request['installationId']) ||
    typeof request['pluginContentDigest'] !== 'string' ||
    !CONTENT_DIGEST_PATTERN.test(request['pluginContentDigest']) ||
    typeof request['pluginServerName'] !== 'string' ||
    request['pluginServerName'].trim() !== request['pluginServerName'] ||
    request['pluginServerName'].length === 0
  ) {
    throw new PluginStoreError(
      'invalid_request',
      'bundled plugin MCP launch identity is invalid',
    );
  }
}

async function assertSourceDisjointFromHome(
  sourceRoot: string,
  homeStateRoot: string,
): Promise<void> {
  try {
    const canonicalSourceRoot = await realpath(sourceRoot);
    const canonicalHomeRoot = await realpath(homeStateRoot);
    if (
      isPathInsideWorkspaceBoundary(canonicalSourceRoot, canonicalHomeRoot) ||
      isPathInsideWorkspaceBoundary(canonicalHomeRoot, canonicalSourceRoot)
    ) {
      throw new PluginStoreError(
        'invalid_request',
        'plugin source and Home state trees must be disjoint',
      );
    }
  } catch (error: unknown) {
    if (error instanceof PluginStoreError) {
      throw error;
    }
    throw new PluginStoreError(
      'corrupt_registry',
      safeErrorMessage('plugin Home boundary could not be verified', error),
    );
  }
}

async function resolvePluginSource(
  request: PluginInstallRequest,
  computerFileScope: ComputerFileScope | undefined,
): Promise<string> {
  if (!computerFileScope) {
    throw new PluginStoreError(
      'invalid_request',
      'computer file access is unavailable',
    );
  }
  const relativePath = normalizePortableRelativePath(request.path);
  const requestedPath = join(
    computerFileScope.root,
    ...relativePath.split('/').filter(Boolean),
  );
  try {
    const canonicalPath = await checkNoSymlinkPathSegments(
      computerFileScope.root,
      requestedPath,
    );
    const stats = await lstat(canonicalPath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new PluginStoreError(
        'invalid_request',
        'plugin source must be a regular directory',
      );
    }
    return canonicalPath;
  } catch (error: unknown) {
    if (error instanceof PluginStoreError) {
      throw error;
    }
    throw new PluginStoreError(
      'invalid_request',
      'plugin source is unavailable or outside ComputerFileScope',
    );
  }
}

function normalizePortableRelativePath(inputPath: string): string {
  if (
    inputPath.length === 0 ||
    inputPath.includes('\0') ||
    isAbsolute(inputPath) ||
    win32.isAbsolute(inputPath) ||
    /^[A-Za-z]:/u.test(inputPath)
  ) {
    throw new PluginStoreError(
      'invalid_request',
      'plugin source path is not portable',
    );
  }
  const normalizedSeparators = inputPath.replaceAll('\\', '/');
  const segments = normalizedSeparators.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new PluginStoreError(
      'invalid_request',
      'plugin source path contains parent traversal',
    );
  }
  const normalized = posix.normalize(normalizedSeparators);
  if (
    normalized === '' ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new PluginStoreError(
      'invalid_request',
      'plugin source path is not portable',
    );
  }
  return normalized;
}

async function captureManagedRootIdentities(args: {
  extensionsRoot: string;
  pluginsRoot: string;
  stagingRoot: string;
}): Promise<ManagedRootIdentities> {
  return {
    extensions: await captureManagedDirectoryIdentity(
      args.extensionsRoot,
      'extensions root',
    ),
    plugins: await captureManagedDirectoryIdentity(
      args.pluginsRoot,
      'plugins root',
    ),
    staging: await captureManagedDirectoryIdentity(
      args.stagingRoot,
      'plugin staging root',
    ),
  };
}

async function assertManagedRootIdentities(
  paths: {
    extensionsRoot: string;
    pluginsRoot: string;
    stagingRoot: string;
  },
  expected: ManagedRootIdentities,
): Promise<void> {
  await assertManagedDirectoryIdentity(
    paths.extensionsRoot,
    'extensions root',
    expected.extensions,
  );
  await assertManagedDirectoryIdentity(
    paths.pluginsRoot,
    'plugins root',
    expected.plugins,
  );
  await assertManagedDirectoryIdentity(
    paths.stagingRoot,
    'plugin staging root',
    expected.staging,
  );
}

async function captureManagedDirectoryIdentity(
  path: string,
  label: string,
): Promise<ManagedDirectoryIdentity> {
  try {
    const stats = await lstat(path, { bigint: true });
    assertManagedDirectory(stats, label);
    return {
      canonicalPath: await realpath(path),
      device: stats.dev,
      inode: stats.ino,
      birthtimeNs: stats.birthtimeNs,
    };
  } catch (error: unknown) {
    if (error instanceof PluginStoreError) {
      throw error;
    }
    throw new PluginStoreError(
      'corrupt_registry',
      safeErrorMessage(`${label} identity could not be verified`, error),
    );
  }
}

async function assertManagedDirectoryIdentity(
  path: string,
  label: string,
  expected: ManagedDirectoryIdentity,
): Promise<void> {
  const current = await captureManagedDirectoryIdentity(path, label);
  if (
    current.canonicalPath !== expected.canonicalPath ||
    current.device !== expected.device ||
    current.inode !== expected.inode ||
    current.birthtimeNs !== expected.birthtimeNs
  ) {
    throw new PluginStoreError(
      'corrupt_registry',
      `${label} changed after plugin store initialization`,
    );
  }
}

function assertSameManagedDirectoryObject(
  before: ManagedDirectoryIdentity,
  after: ManagedDirectoryIdentity,
  label: string,
): void {
  if (
    before.device !== after.device ||
    before.inode !== after.inode ||
    before.birthtimeNs !== after.birthtimeNs
  ) {
    throw new PluginStoreError(
      'corrupt_registry',
      `${label} changed while it was moved into place`,
    );
  }
}

async function readPersistedRegistry(
  registryPath: string,
): Promise<PersistedPluginRegistry | undefined> {
  let expectedStats: Awaited<ReturnType<typeof lstat>>;
  try {
    expectedStats = await lstat(registryPath);
  } catch (error: unknown) {
    if (getErrorCode(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  assertManagedRegularFile(expectedStats, 'plugin registry');

  const registryFile = await open(
    registryPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let raw: string;
  try {
    const openedStats = await registryFile.stat();
    assertManagedRegularFile(openedStats, 'plugin registry');
    if (
      openedStats.dev !== expectedStats.dev ||
      openedStats.ino !== expectedStats.ino
    ) {
      throw new PluginStoreError(
        'corrupt_registry',
        'plugin registry changed while it was being opened',
      );
    }
    raw = await registryFile.readFile('utf8');
  } finally {
    await registryFile.close();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new PluginStoreError(
      'corrupt_registry',
      'plugin registry is not valid JSON',
    );
  }
  if (
    !isRecord(parsed) ||
    !hasOnlyKeys(parsed, ['schemaVersion', 'plugins']) ||
    (parsed['schemaVersion'] !== LEGACY_REGISTRY_SCHEMA_VERSION &&
      parsed['schemaVersion'] !== SKILL_RUNTIME_REGISTRY_SCHEMA_VERSION &&
      parsed['schemaVersion'] !== MCP_RUNTIME_REGISTRY_SCHEMA_VERSION &&
      parsed['schemaVersion'] !== REGISTRY_SCHEMA_VERSION) ||
    !Array.isArray(parsed['plugins'])
  ) {
    throw new PluginStoreError(
      'corrupt_registry',
      'plugin registry has an invalid shape',
    );
  }
  const plugins: PersistedPluginRecord[] =
    parsed['schemaVersion'] === REGISTRY_SCHEMA_VERSION
      ? parsed['plugins'].every(isPersistedPluginRecord)
        ? parsed['plugins']
        : []
      : parsed['plugins'].every(isInstalledPluginView)
        ? parsed['plugins'].map((view) => ({
            view,
            packageObjectId: view.installationId,
          }))
        : [];
  if (plugins.length !== parsed['plugins'].length) {
    throw new PluginStoreError(
      'corrupt_registry',
      'plugin registry has an invalid shape',
    );
  }
  const seenIds = new Set<string>();
  const seenPackageObjectIds = new Set<string>();
  for (const plugin of plugins) {
    if (
      !INSTALLATION_ID_PATTERN.test(plugin.view.installationId) ||
      seenIds.has(plugin.view.installationId) ||
      !INSTALLATION_ID_PATTERN.test(plugin.packageObjectId) ||
      seenPackageObjectIds.has(plugin.packageObjectId)
    ) {
      throw new PluginStoreError(
        'corrupt_registry',
        'plugin registry contains an invalid or duplicate object identity',
      );
    }
    seenIds.add(plugin.view.installationId);
    seenPackageObjectIds.add(plugin.packageObjectId);
  }
  return {
    schemaVersion: parsed['schemaVersion'],
    plugins,
  };
}

async function reconcileManagedStore(args: {
  extensionsRoot: string;
  pluginsRoot: string;
  stagingRoot: string;
  registeredIds: Set<string>;
}): Promise<void> {
  await ensureManagedDirectory(args.extensionsRoot, 'extensions root');
  await ensureManagedDirectory(args.pluginsRoot, 'plugins root');

  const existingStaging = await lstatIfExists(args.stagingRoot);
  if (existingStaging) {
    assertManagedDirectory(existingStaging, 'plugin staging root');
    await rm(args.stagingRoot, { recursive: true, force: true });
  }
  await ensureManagedDirectory(args.stagingRoot, 'plugin staging root');

  const entries = await readdir(args.pluginsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!args.registeredIds.has(entry.name)) {
      await rm(join(args.pluginsRoot, entry.name), {
        recursive: true,
        force: true,
      });
    }
  }
}

async function ensureManagedDirectory(
  path: string,
  label: string,
): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  assertManagedDirectory(await lstat(path), label);
}

async function lstatIfExists(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error: unknown) {
    if (getErrorCode(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function assertManagedDirectory(
  stats: Awaited<ReturnType<typeof lstat>>,
  label: string,
): void {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new PluginStoreError(
      'corrupt_registry',
      `${label} must be a regular daemon-owned directory`,
    );
  }
}

function assertManagedRegularFile(
  stats: Awaited<ReturnType<typeof lstat>>,
  label: string,
): void {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink > 1) {
    throw new PluginStoreError(
      'corrupt_registry',
      `${label} must be a regular daemon-owned file`,
    );
  }
}

function assertPersistedPackageMatches(
  plugin: InstalledPluginView,
  inspected: InspectedPluginPackage,
  allowCapabilityStatusMigration: boolean,
): void {
  const capabilitiesMatch = allowCapabilityStatusMigration
    ? capabilitiesHaveMatchingInventory(
        plugin.capabilities,
        inspected.capabilities,
      )
    : JSON.stringify(plugin.capabilities) ===
      JSON.stringify(inspected.capabilities);
  if (
    plugin.name !== inspected.manifest.name ||
    plugin.displayName !== inspected.manifest.displayName ||
    plugin.version !== inspected.manifest.version ||
    plugin.description !== inspected.manifest.description ||
    plugin.contentDigest !== inspected.contentDigest ||
    !capabilitiesMatch
  ) {
    throw new PluginStoreError(
      'corrupt_registry',
      'managed plugin package does not match its registry record',
    );
  }
}

function capabilitiesHaveMatchingInventory(
  persisted: InstalledPluginView['capabilities'],
  inspected: InstalledPluginView['capabilities'],
): boolean {
  return (
    persisted.length === inspected.length &&
    persisted.every((capability, index) => {
      const current = inspected[index];
      return (
        current !== undefined &&
        capability.kind === current.kind &&
        capability.itemCount === current.itemCount
      );
    })
  );
}

function pluginSkillSource(
  plugin: InstalledPluginView,
): PluginSkillCatalogEntry['sourcePlugin'] {
  return {
    installationId: plugin.installationId,
    name: plugin.name,
    displayName: plugin.displayName,
    version: plugin.version,
    contentDigest: plugin.contentDigest,
  };
}

function isPersistedPluginRecord(
  value: unknown,
): value is PersistedPluginRecord {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['view', 'packageObjectId']) &&
    isInstalledPluginView(value['view']) &&
    typeof value['packageObjectId'] === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function safeStorageError(message: string, error: unknown): Error {
  return new Error(safeErrorMessage(message, error));
}

function safeErrorMessage(message: string, error: unknown): string {
  const errorCode = getErrorCode(error);
  return errorCode ? `${message} (${errorCode})` : message;
}
