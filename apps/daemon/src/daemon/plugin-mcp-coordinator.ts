import type { InstalledPluginView } from '@geulbat/protocol/plugins';

import type {
  GlobalMcpRuntime,
  PluginMcpServerBinding,
} from './mcp/global-mcp-runtime.js';
import {
  PluginStoreError,
  type PluginBundledMcpLaunchRequest,
  type PluginBundledMcpServerSnapshot,
  type PluginStore,
} from './extensions/plugin-store.js';

/**
 * Coordinates plugin package mutations with the existing global MCP owner.
 * Package bytes remain owned by PluginStore; MCP processes and tool
 * projections remain owned by GlobalMcpRuntime.
 */
export function createMcpCoordinatedPluginStore(args: {
  pluginStore: PluginStore;
  globalMcp: GlobalMcpRuntime;
}): PluginStore {
  let initialized = false;
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
      throw new Error('plugin MCP coordinator is not initialized');
    }
  }

  async function snapshotBindings(): Promise<PluginMcpServerBinding[]> {
    const snapshots = await args.pluginStore.listSupportedBundledMcpServers();
    return snapshots.map((snapshot) =>
      bindingFromSnapshot(args.pluginStore, snapshot),
    );
  }

  async function reconcileFromStore(): Promise<void> {
    await args.globalMcp.reconcilePluginServers(await snapshotBindings());
  }

  async function recoverOrThrow(
    message: string,
    primaryError: unknown,
    recovery: () => Promise<void>,
  ): Promise<never> {
    try {
      await recovery();
    } catch (recoveryError: unknown) {
      throw new AggregateError([primaryError, recoveryError], message);
    }
    throw primaryError;
  }

  async function attemptRecoverySteps(
    message: string,
    steps: readonly (() => Promise<void>)[],
  ): Promise<void> {
    const failures: unknown[] = [];
    for (const step of steps) {
      try {
        await step();
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, message);
    }
  }

  return {
    async initialize() {
      await serialize(async () => {
        if (initialized) {
          return;
        }
        await args.pluginStore.initialize();
        await args.globalMcp.initialize(await snapshotBindings());
        initialized = true;
      });
    },

    listPlugins() {
      assertInitialized();
      return args.pluginStore.listPlugins();
    },

    async listPluginSkills(options) {
      assertInitialized();
      return args.pluginStore.listPluginSkills(options);
    },

    async readEnabledSkillFile(logicalPath) {
      assertInitialized();
      return args.pluginStore.readEnabledSkillFile(logicalPath);
    },

    async listEnabledSkillDirectory(logicalPath, recursive) {
      assertInitialized();
      return args.pluginStore.listEnabledSkillDirectory(logicalPath, recursive);
    },

    async listSupportedBundledMcpServers() {
      assertInitialized();
      return args.pluginStore.listSupportedBundledMcpServers();
    },

    async resolveBundledMcpServerLaunch(request) {
      assertInitialized();
      return args.pluginStore.resolveBundledMcpServerLaunch(request);
    },

    async installPlugin(request, computerFileScope) {
      return serialize(async () => {
        assertInitialized();
        const installed = await args.pluginStore.installPlugin(
          request,
          computerFileScope,
        );
        try {
          await reconcileFromStore();
          return installed;
        } catch (error: unknown) {
          return recoverOrThrow(
            'plugin install failed and its MCP registration could not be rolled back cleanly',
            error,
            () =>
              attemptRecoverySteps('plugin install rollback failed', [
                () => args.pluginStore.uninstall(installed.installationId),
                reconcileFromStore,
              ]),
          );
        }
      });
    },

    async installMarketplacePlugin(candidate) {
      return serialize(async () => {
        assertInitialized();
        const installed =
          await args.pluginStore.installMarketplacePlugin(candidate);
        try {
          await reconcileFromStore();
          return installed;
        } catch (error: unknown) {
          return recoverOrThrow(
            'marketplace plugin install failed and its MCP registration could not be rolled back cleanly',
            error,
            () =>
              attemptRecoverySteps(
                'marketplace plugin install rollback failed',
                [
                  () => args.pluginStore.uninstall(installed.installationId),
                  reconcileFromStore,
                ],
              ),
          );
        }
      });
    },

    async setEnabled(installationId, enabled) {
      return serialize(async () => {
        assertInitialized();
        const previous = findPlugin(
          args.pluginStore.listPlugins(),
          installationId,
        );
        if (previous.enabled === enabled) {
          return previous;
        }

        if (!enabled) {
          await args.globalMcp.suspendPluginServers(installationId);
        }

        let updated: InstalledPluginView;
        try {
          updated = await args.pluginStore.setEnabled(installationId, enabled);
        } catch (error: unknown) {
          return recoverOrThrow(
            'plugin enablement update failed and its MCP eligibility could not be restored cleanly',
            error,
            reconcileFromStore,
          );
        }

        try {
          await reconcileFromStore();
          return updated;
        } catch (error: unknown) {
          return recoverOrThrow(
            'plugin enablement update failed and could not be rolled back cleanly',
            error,
            () =>
              attemptRecoverySteps('plugin enablement rollback failed', [
                async () => {
                  await args.pluginStore.setEnabled(
                    installationId,
                    previous.enabled,
                  );
                },
                reconcileFromStore,
              ]),
          );
        }
      });
    },

    async uninstall(installationId) {
      await serialize(async () => {
        assertInitialized();
        findPlugin(args.pluginStore.listPlugins(), installationId);
        await args.globalMcp.suspendPluginServers(installationId);
        try {
          await args.pluginStore.uninstall(installationId);
        } catch (error: unknown) {
          return recoverOrThrow(
            'plugin uninstall failed and its MCP registrations could not be reconciled cleanly',
            error,
            reconcileFromStore,
          );
        }
        try {
          await args.globalMcp.removePluginServers(installationId);
        } catch (error: unknown) {
          return recoverOrThrow(
            'plugin package was removed but its MCP registrations could not be reconciled cleanly',
            error,
            reconcileFromStore,
          );
        }
      });
    },
  };
}

function bindingFromSnapshot(
  pluginStore: PluginStore,
  snapshot: PluginBundledMcpServerSnapshot,
): PluginMcpServerBinding {
  const launchRequest: PluginBundledMcpLaunchRequest = {
    installationId: snapshot.installationId,
    pluginContentDigest: snapshot.pluginContentDigest,
    pluginServerName: snapshot.pluginServerName,
  };
  return {
    name: `${snapshot.pluginDisplayName} · ${snapshot.pluginServerName}`,
    pluginEnabled: snapshot.pluginEnabled,
    source: {
      kind: 'plugin',
      installationId: snapshot.installationId,
      name: snapshot.pluginName,
      displayName: snapshot.pluginDisplayName,
      version: snapshot.pluginVersion,
      contentDigest: snapshot.pluginContentDigest,
      serverName: snapshot.pluginServerName,
    },
    transport: {
      kind: 'stdio',
      command: snapshot.config.command,
      args: [...snapshot.config.args],
      envKeys: [...snapshot.config.envKeys],
      ...(snapshot.config.connectionTimeoutMs === undefined
        ? {}
        : { connectionTimeoutMs: snapshot.config.connectionTimeoutMs }),
      ...(snapshot.config.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: snapshot.config.requestTimeoutMs }),
    },
    async resolveLaunch() {
      const launch =
        await pluginStore.resolveBundledMcpServerLaunch(launchRequest);
      return { cwd: launch.absoluteCwd };
    },
  };
}

function findPlugin(
  plugins: readonly InstalledPluginView[],
  installationId: string,
): InstalledPluginView {
  const plugin = plugins.find(
    (candidate) => candidate.installationId === installationId,
  );
  if (!plugin) {
    throw new PluginStoreError(
      'not_found',
      `plugin installation is not registered: ${installationId}`,
    );
  }
  return plugin;
}
