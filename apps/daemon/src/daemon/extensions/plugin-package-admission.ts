import type { PluginCapabilityView } from '@geulbat/protocol/plugins';
import type { Buffer } from 'node:buffer';
import {
  constants,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
} from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

import { getErrorCode } from '../utils/error.js';
import type { InspectedPluginSkill } from './plugin-skill-runtime.js';
import {
  assertNoEmbeddedCredentials,
  PluginPackageAdmissionError,
} from './plugin-package-admission-contract.js';
import {
  normalizeDeclaredPackagePath,
  toAbsolutePackagePath,
} from './plugin-package-paths.js';
import { inventoryCapabilities } from './plugin-package-capability-inventory.js';
import {
  MANIFEST_RELATIVE_PATH,
  readPluginIconPath,
  validateManifest,
} from './plugin-package-manifest.js';
import type { InspectedPluginMcpServer } from './plugin-package-mcp-inspection.js';
import {
  assertDirectoryIdentity,
  assertSupportedPackageEntry,
  digestPackage,
  inspectContainedDirectory,
  inventoryPackageTree,
  isSameOrContainedPath,
  readJsonObject,
  readPackageBuffer,
  registerNormalizedPath,
} from './plugin-package-secure-fs.js';

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
