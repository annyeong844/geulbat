import type {
  InstalledPluginView,
  PluginMarketplaceInstallationSourceView,
} from '@geulbat/protocol/plugins';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  inspectPluginPackage,
  stagePluginPackage,
  type InspectedPluginPackage,
} from './plugin-package-admission.js';
import { PluginPackageAdmissionError } from './plugin-package-admission-contract.js';
import {
  assertManagedDirectoryIdentity,
  assertSameManagedDirectoryObject,
  captureManagedDirectoryIdentity,
  type ManagedDirectoryIdentity,
} from './plugin-managed-directory.js';
import { PluginStoreError, safeStorageError } from './plugin-store-contract.js';

type PluginPackageInstallationSource =
  | { kind: 'local-directory' }
  | {
      kind: 'marketplace';
      provenance: PluginMarketplaceInstallationSourceView;
      expectedContentDigest: string;
    };

export function createPluginPackageInstaller(deps: {
  pluginsRoot: string;
  stagingRoot: string;
  establishManagedRoots: () => Promise<void>;
  assertManagedRootsUnchanged: () => Promise<void>;
  assertPersistedPackageMatches: (
    plugin: InstalledPluginView,
    inspected: InspectedPluginPackage,
    allowCapabilityStatusMigration: boolean,
  ) => void;
  commitInstalled: (
    plugin: InstalledPluginView,
    packageObjectId: string,
  ) => Promise<void>;
}) {
  return async function installPackageFromSource(args: {
    sourceRoot: string;
    source: PluginPackageInstallationSource;
  }): Promise<InstalledPluginView> {
    const installationId = randomUUID();
    const packageObjectId = randomUUID();
    const stageInstallationRoot = join(deps.stagingRoot, packageObjectId);
    const stagePackageRoot = join(stageInstallationRoot, 'package');
    const finalInstallationRoot = join(deps.pluginsRoot, packageObjectId);
    let movedToFinal = false;
    let managedRootsAdmitted = false;
    let stagedInstallationIdentity: ManagedDirectoryIdentity | undefined;

    try {
      await deps.establishManagedRoots();
      managedRootsAdmitted = true;
      await mkdir(stagePackageRoot, { recursive: true, mode: 0o700 });
      await deps.assertManagedRootsUnchanged();
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
      await deps.assertManagedRootsUnchanged();
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
      await deps.assertManagedRootsUnchanged();
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
      deps.assertPersistedPackageMatches(plugin, finalInspected, false);
      await deps.assertManagedRootsUnchanged();
      await deps.commitInstalled(plugin, packageObjectId);
      return plugin;
    } catch (error: unknown) {
      if (managedRootsAdmitted && stagedInstallationIdentity) {
        try {
          await deps.assertManagedRootsUnchanged();
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
  };
}
