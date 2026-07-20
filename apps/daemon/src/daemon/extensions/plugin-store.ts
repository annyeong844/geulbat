import type {
  InstalledPluginView,
  PluginInstallRequest,
  PluginMarketplaceInstallationSourceView,
} from '@geulbat/protocol/plugins';
import { isPluginInstallRequest } from '@geulbat/protocol/plugins';
import { isPluginRecord as isRecord } from './plugin-value-guards.js';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, posix, win32 } from 'node:path';

import type { ComputerFileScope } from '../files/computer-file-scope.js';
import {
  checkNoSymlinkPathSegments,
  isSameOrDescendantPath,
} from '../files/normalize-path.js';
import { writeTextFileAtomically } from '../utils/atomic-file.js';
import {
  inspectPluginPackage,
  readPluginPackageFile,
  stagePluginPackage,
  type InspectedPluginPackage,
} from './plugin-package-admission.js';
import type {
  InspectedPluginMcpServer,
  PluginMcpStdioConfig,
} from './plugin-package-mcp-inspection.js';
import { PluginPackageAdmissionError } from './plugin-package-admission-contract.js';
import {
  CONTENT_DIGEST_PATTERN,
  INSTALLATION_ID_PATTERN,
  REGISTRY_SCHEMA_VERSION,
  hasOnlyKeys,
  readPersistedRegistry,
  serializePluginRegistry,
  type PersistedPluginRegistry,
} from './plugin-registry-codec.js';
import {
  PluginStoreError,
  safeErrorMessage,
  safeStorageError,
} from './plugin-store-contract.js';
import { createPluginRegistrationStateOwner } from './plugin-store-state.js';
import {
  assertManagedDirectory,
  assertManagedDirectoryIdentity,
  assertManagedRootIdentities,
  assertSameManagedDirectoryObject,
  captureManagedDirectoryIdentity,
  captureManagedRootIdentities,
  ensureManagedDirectory,
  lstatIfExists,
  reconcileManagedStore,
  type ManagedDirectoryIdentity,
  type ManagedRootIdentities,
} from './plugin-managed-directory.js';
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

interface PluginBundledMcpLaunch extends PluginBundledMcpServerSnapshot {
  absoluteCwd: string;
}

export function createPluginStore(args: {
  homeStateRoot: string;
}): PluginStore {
  const extensionsRoot = join(args.homeStateRoot, 'extensions');
  const pluginsRoot = join(extensionsRoot, 'plugins');
  const stagingRoot = join(extensionsRoot, '.staging');
  const registryPath = join(extensionsRoot, 'registry.json');
  let managedRootIdentities: ManagedRootIdentities | undefined;
  const state = createPluginRegistrationStateOwner({
    persistRegistry: (plugins, objectIds) => persist(plugins, objectIds),
  });

  async function persist(
    plugins: InstalledPluginView[],
    objectIds: ReadonlyMap<string, string>,
  ): Promise<void> {
    const registry = serializePluginRegistry(plugins, objectIds);
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

  function packageRootFor(plugin: InstalledPluginView): string {
    return join(pluginsRoot, state.packageObjectIdFor(plugin), 'package');
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
    state.requireInitialized();
    const plugins = state
      .plugins()
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
    const plugin = state.getPlugin(parsed.installationId);
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
    state.requireInitialized();
    const plugins = state
      .plugins()
      .sort((left, right) =>
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
    state.requireInitialized();
    assertPluginMcpLaunchRequest(request);
    const plugin = state.getPlugin(request.installationId);
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
    if (!isSameOrDescendantPath(canonicalPackageRoot, absoluteCwd)) {
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
      await state.commitInstalled(plugin, packageObjectId);
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
      await state.serialize(async () => {
        if (state.isInitialized()) {
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
            state.markInitialized();
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
          state.restoreLoaded(normalizedPlugins, normalizedObjectIds);
          state.markInitialized();
        } catch (error: unknown) {
          state.resetOnInitializationFailure();
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
      state.requireInitialized();
      return state
        .plugins()
        .sort((left, right) =>
          left.displayName.localeCompare(right.displayName),
        );
    },

    async listPluginSkills(options) {
      return state.serialize(() =>
        listPluginSkillsOperation(options?.includeDisabled ?? false),
      );
    },

    async listSupportedBundledMcpServers() {
      return state.serialize(listSupportedBundledMcpServersOperation);
    },

    async resolveBundledMcpServerLaunch(request) {
      return state.serialize(() =>
        resolveBundledMcpServerLaunchOperation(request),
      );
    },

    async readEnabledSkillFile(logicalPath) {
      return state.serialize(async (): Promise<PluginSkillFile> => {
        state.requireInitialized();
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
      return state.serialize(async (): Promise<PluginSkillDirectory> => {
        state.requireInitialized();
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
      return state.serialize(async () => {
        state.requireInitialized();
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
      return state.serialize(async () => {
        state.requireInitialized();
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
          state
            .plugins()
            .some(
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
      return state.serialize(async () => {
        state.requireInitialized();
        const current = state.getPlugin(installationId);
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
        await state.commitUpdated(updated);
        return updated;
      });
    },

    async uninstall(installationId) {
      await state.serialize(async () => {
        state.requireInitialized();
        const current = state.getPlugin(installationId);
        if (!current) {
          throw new PluginStoreError(
            'not_found',
            `plugin installation was not found: ${installationId}`,
          );
        }
        await assertManagedRootsUnchanged();
        const installationRoot = join(
          pluginsRoot,
          state.packageObjectIdFor(current),
        );
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
          await state.commitUpdated(disabled);
        }

        await state.commitRemoved(installationId);
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
      isSameOrDescendantPath(canonicalSourceRoot, canonicalHomeRoot) ||
      isSameOrDescendantPath(canonicalHomeRoot, canonicalSourceRoot)
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
