import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { sha256StableJson } from '@geulbat/content-identity/stable-json';
import type { ToolLibraryProjectionImportableModule } from '@geulbat/tool-library/projection-codec';
import {
  buildToolLibraryProjectionFiles,
  buildToolLibraryProjectionImportableModules,
  TOOL_LIBRARY_PROJECTION_GENERATOR_VERSION,
} from '@geulbat/tool-library/projection-generator';
import {
  getToolLibraryProjectionManifest,
  getToolLibraryProjectionPin,
  projectionDirectoryNameForHash,
} from '@geulbat/tool-library/projection-manifest';
import type { ToolLibraryProjectionGeneratedTool } from '@geulbat/tool-library/projection-descriptor';
import { isRecord } from '../runtime-json.js';
import {
  resolveToolLibraryProjectionFilePath,
  threadProjectionDirectoryName,
} from './tool-library-projection-path.js';
import type {
  BuildToolLibraryProjectionArgs,
  ToolLibraryProjection,
  ToolLibraryProjectionFailureDiagnostics,
  ToolLibraryProjectionFailureResult,
  ToolLibraryProjectionPort,
} from './tool-library-projection-port.js';
import {
  hashableToolLibraryProjectionTool,
  resolveToolLibraryProjectionTools,
} from './tool-library-projection-registry.js';
import type { ToolRegistryStore } from './tool-registry-model.js';
import {
  pruneInvalidToolLibraryProjectionDirectories,
  readExistingPinnedToolLibraryProjection,
  readVerifiedToolLibraryProjectionMount,
  writeToolLibraryProjectionFiles,
  writeToolLibraryProjectionPinFile,
} from './tool-library-projection-store.js';

const SAFE_PROJECTION_ERROR_CODES = new Set([
  'EACCES',
  'EEXIST',
  'EISDIR',
  'ELOOP',
  'EMFILE',
  'ENAMETOOLONG',
  'ENOENT',
  'ENOSPC',
  'ENOTDIR',
  'EPERM',
]);
const SAFE_PROJECTION_ERROR_NAMES = new Set([
  'Error',
  'RangeError',
  'SyntaxError',
  'TypeError',
]);

export type {
  ToolLibraryProjectionIdentity,
  ToolLibraryProjectionImportableModule,
  ToolLibraryProjectionManifest,
  ToolLibraryProjectionMountedModuleRole,
  ToolLibraryProjectionPin,
} from '@geulbat/tool-library/projection-codec';
export type {
  BuildToolLibraryProjectionArgs,
  ToolLibraryProjection,
  ToolLibraryProjectionPort,
} from './tool-library-projection-port.js';

interface CreateToolLibraryProjectionPortArgs {
  registry: Pick<ToolRegistryStore, 'getAllRegisteredToolNames' | 'getTool'>;
  runtimeRootForState(this: void, stateRoot: string): string;
  sdkVersion: string;
  sourceRegistryVersion: string;
  runtimeCompatibilityRange: string;
  modelFacingCatalogRef: string;
  importSpecifier: string;
  projectionPolicy?: {
    policyId: string;
  };
}

type ToolLibraryProjectionCore = Omit<
  ToolLibraryProjection,
  'catalogPath' | 'files' | 'rootPath'
>;

export function createToolLibraryProjectionPort(
  args: CreateToolLibraryProjectionPortArgs,
): ToolLibraryProjectionPort {
  return {
    async resolveProjection(resolveArgs) {
      try {
        const requestedRegistryNames =
          resolveArgs.allowedRegistryNames ??
          args.registry.getAllRegisteredToolNames();
        const allowedRegistryNames =
          args.projectionPolicy === undefined
            ? requestedRegistryNames
            : requestedRegistryNames.filter((name) => {
                const tool = args.registry.getTool(name);
                if (tool === undefined) {
                  return true;
                }
                const exposure = tool.exposure;
                return (
                  exposure?.sdkVisible === true &&
                  exposure.inCellCallable &&
                  !exposure.directOnly
                );
              });
        const policyId =
          args.projectionPolicy?.policyId ??
          (resolveArgs.allowedRegistryNames === undefined
            ? 'registry_default'
            : 'registry_allow_list');
        const projectionCore = buildToolLibraryProjectionCore({
          registry: args.registry,
          allowedRegistryNames,
          sdkVersion: args.sdkVersion,
          sourceRegistryVersion: args.sourceRegistryVersion,
          policyId,
          runtimeCompatibilityRange: args.runtimeCompatibilityRange,
          modelFacingCatalogRef: args.modelFacingCatalogRef,
          importSpecifier: args.importSpecifier,
        });
        const runtimeRootPath = args.runtimeRootForState(resolveArgs.stateRoot);
        const threadProjectionRootPath = join(
          runtimeRootPath,
          threadProjectionDirectoryName(resolveArgs.threadId),
        );
        const rootPath = join(
          threadProjectionRootPath,
          projectionDirectoryNameForHash(projectionCore.sdkProjectionHash),
        );
        const projection = materializeToolLibraryProjection({
          core: projectionCore,
          rootPath,
          catalogPath: join(rootPath, 'catalog.js'),
        });
        const existing = await readExistingPinnedToolLibraryProjection({
          threadProjectionRootPath,
          importSpecifier: args.importSpecifier,
        });
        if (existing.kind === 'present') {
          const pinnedProjectionCore = buildToolLibraryProjectionCore({
            registry: args.registry,
            allowedRegistryNames: existing.pin.allowedRegistryNames,
            sdkVersion: existing.pin.sdkVersion,
            sourceRegistryVersion: existing.pin.sourceRegistryVersion,
            policyId: existing.pin.policyId,
            runtimeCompatibilityRange: existing.pin.runtimeCompatibilityRange,
            modelFacingCatalogRef: existing.pin.modelFacingCatalogRef,
            importSpecifier: existing.pin.importSpecifier,
          });
          const pinnedProjection = materializeToolLibraryProjection({
            core: pinnedProjectionCore,
            rootPath: existing.mount.projectionRootPath,
            catalogPath: existing.mount.catalogModulePath,
          });
          if (
            pinnedProjection.sdkProjectionHash !==
            existing.pin.sdkProjectionHash
          ) {
            const refreshedRootPath = join(
              threadProjectionRootPath,
              projectionDirectoryNameForHash(
                pinnedProjection.sdkProjectionHash,
              ),
            );
            return await writeAndVerifyToolLibraryProjection({
              projection: materializeToolLibraryProjection({
                core: pinnedProjectionCore,
                rootPath: refreshedRootPath,
                catalogPath: join(refreshedRootPath, 'catalog.js'),
              }),
              threadProjectionRootPath,
              importSpecifier: args.importSpecifier,
            });
          }
          if (!(await projectionFilesMatchGeneratedSource(pinnedProjection))) {
            return {
              ok: false,
              reason: 'projection_failed',
              message:
                'Pinned tool library projection no longer matches its generated source',
            };
          }
          const pruneResult =
            await pruneInvalidToolLibraryProjectionDirectories({
              threadProjectionRootPath,
              retainedProjectionDirectories: [existing.pin.projectionDirectory],
            });
          return {
            ok: true,
            mount: existing.mount,
            pin: existing.pin,
            prunedProjectionDirectories: pruneResult.removedDirectories,
            projectionPruneFailedDirectories: pruneResult.failedDirectories,
            projection: pinnedProjection,
            writtenFiles: [],
          };
        }
        if (existing.kind === 'failed') {
          return {
            ok: false,
            reason: 'projection_failed',
            message: existing.message,
          };
        }

        return await writeAndVerifyToolLibraryProjection({
          projection,
          threadProjectionRootPath,
          importSpecifier: args.importSpecifier,
        });
      } catch (error) {
        return toolLibraryProjectionFailure({
          message: 'Tool library projection failed',
          error,
        });
      }
    },
    async rehydrateProjectionMount(resolveArgs) {
      try {
        const mountResult = await readVerifiedToolLibraryProjectionMount({
          threadProjectionRootPath: threadProjectionRootPathFor({
            runtimeRootForState: args.runtimeRootForState,
            stateRoot: resolveArgs.stateRoot,
            threadId: resolveArgs.threadId,
          }),
          expectedIdentity: resolveArgs.expectedIdentity,
          importSpecifier: args.importSpecifier,
        });
        if (!mountResult.ok) {
          return mountResult;
        }
        const projection = buildToolLibraryProjection({
          registry: args.registry,
          allowedRegistryNames: mountResult.pin.allowedRegistryNames,
          sdkVersion: args.sdkVersion,
          sourceRegistryVersion: args.sourceRegistryVersion,
          policyId: mountResult.pin.policyId,
          runtimeCompatibilityRange: args.runtimeCompatibilityRange,
          rootPath: mountResult.mount.projectionRootPath,
          catalogPath: mountResult.mount.catalogModulePath,
          modelFacingCatalogRef: args.modelFacingCatalogRef,
          importSpecifier: args.importSpecifier,
        });
        if (
          projection.sdkProjectionHash !== mountResult.pin.sdkProjectionHash
        ) {
          return {
            ok: false,
            reason: 'projection_failed',
            message:
              'Tool library projection no longer matches its generated source',
          };
        }
        if (!(await projectionFilesMatchGeneratedSource(projection))) {
          return {
            ok: false,
            reason: 'projection_failed',
            message:
              'Tool library projection files no longer match their generated source',
          };
        }
        return { ...mountResult, projection };
      } catch (error) {
        return toolLibraryProjectionFailure({
          message: 'Tool library projection rehydration failed',
          error,
        });
      }
    },
  };
}

async function writeAndVerifyToolLibraryProjection(args: {
  projection: ToolLibraryProjection;
  threadProjectionRootPath: string;
  importSpecifier: string;
}) {
  const pin = getToolLibraryProjectionPin(args.projection);
  const written = await writeToolLibraryProjectionFiles(args.projection);
  await writeToolLibraryProjectionPinFile({
    threadProjectionRootPath: args.threadProjectionRootPath,
    pin,
  });
  const mountResult = await readVerifiedToolLibraryProjectionMount({
    threadProjectionRootPath: args.threadProjectionRootPath,
    expectedPin: pin,
    importSpecifier: args.importSpecifier,
  });
  if (!mountResult.ok) {
    return {
      ok: false as const,
      reason: 'projection_failed' as const,
      message: mountResult.message,
    };
  }
  const pruneResult = await pruneInvalidToolLibraryProjectionDirectories({
    threadProjectionRootPath: args.threadProjectionRootPath,
    retainedProjectionDirectories: [pin.projectionDirectory],
  });
  return {
    ok: true as const,
    mount: mountResult.mount,
    pin: mountResult.pin,
    prunedProjectionDirectories: pruneResult.removedDirectories,
    projectionPruneFailedDirectories: pruneResult.failedDirectories,
    projection: args.projection,
    writtenFiles: written.writtenFiles,
  };
}

async function projectionFilesMatchGeneratedSource(
  projection: ToolLibraryProjection,
): Promise<boolean> {
  const rootStats = await lstat(projection.rootPath);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    return false;
  }
  const observedPaths: string[] = [];
  const observedDirectoryPaths: string[] = [];
  const pendingDirectories = [projection.rootPath];
  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();
    if (directory === undefined) {
      return false;
    }
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        return false;
      }
      if (entry.isDirectory()) {
        observedDirectoryPaths.push(
          relative(projection.rootPath, entryPath).replaceAll('\\', '/'),
        );
        pendingDirectories.push(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        return false;
      }
      observedPaths.push(
        relative(projection.rootPath, entryPath).replaceAll('\\', '/'),
      );
    }
  }
  const expectedPaths = projection.files.map((file) => file.path).sort();
  const expectedDirectoryPaths = [
    ...projection.files.reduce((directories, file) => {
      const segments = file.path.split('/');
      for (let index = 1; index < segments.length; index += 1) {
        directories.add(segments.slice(0, index).join('/'));
      }
      return directories;
    }, new Set<string>()),
  ].sort();
  if (
    observedPaths.sort().length !== expectedPaths.length ||
    observedPaths.some((path, index) => path !== expectedPaths[index]) ||
    observedDirectoryPaths.sort().length !== expectedDirectoryPaths.length ||
    observedDirectoryPaths.some(
      (path, index) => path !== expectedDirectoryPaths[index],
    )
  ) {
    return false;
  }
  for (const file of projection.files) {
    const source = await readFile(
      resolveToolLibraryProjectionFilePath(projection.rootPath, file.path),
      'utf8',
    );
    if (source !== file.content) {
      return false;
    }
  }
  return true;
}

function toolLibraryProjectionFailure(args: {
  message: string;
  error: unknown;
}): ToolLibraryProjectionFailureResult {
  const diagnostics = projectionFailureDiagnostics(args.error);
  return {
    ok: false,
    reason: 'projection_failed',
    message: args.message,
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
}

function projectionFailureDiagnostics(
  error: unknown,
): ToolLibraryProjectionFailureDiagnostics | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  const diagnostics: ToolLibraryProjectionFailureDiagnostics = {};
  if (
    typeof error.code === 'string' &&
    SAFE_PROJECTION_ERROR_CODES.has(error.code)
  ) {
    diagnostics.errorCode = error.code;
  }
  if (
    typeof error.name === 'string' &&
    SAFE_PROJECTION_ERROR_NAMES.has(error.name)
  ) {
    diagnostics.errorName = error.name;
  }
  return diagnostics.errorCode === undefined &&
    diagnostics.errorName === undefined
    ? undefined
    : diagnostics;
}

function threadProjectionRootPathFor(args: {
  runtimeRootForState(stateRoot: string): string;
  stateRoot: string;
  threadId: string;
}): string {
  return join(
    args.runtimeRootForState(args.stateRoot),
    threadProjectionDirectoryName(args.threadId),
  );
}

export function buildToolLibraryProjection(
  args: BuildToolLibraryProjectionArgs,
): ToolLibraryProjection {
  return materializeToolLibraryProjection({
    core: buildToolLibraryProjectionCore(args),
    rootPath: args.rootPath,
    catalogPath: args.catalogPath,
  });
}

function buildToolLibraryProjectionCore(
  args: Omit<BuildToolLibraryProjectionArgs, 'catalogPath' | 'rootPath'>,
): ToolLibraryProjectionCore {
  const tools = resolveToolLibraryProjectionTools(args);
  const allowedPublicNames = tools.map((tool) => tool.publicName);
  const allowedRegistryNames = tools.map((tool) => tool.registryName);
  const allowedCallbackNames = tools.map((tool) => tool.callbackName);
  const importableModules = buildToolLibraryProjectionImportableModules({
    importSpecifier: args.importSpecifier,
    tools,
  });
  const hash = computeToolLibraryProjectionHash({
    sdkVersion: args.sdkVersion,
    sourceRegistryVersion: args.sourceRegistryVersion,
    policyId: args.policyId,
    runtimeCompatibilityRange: args.runtimeCompatibilityRange,
    modelFacingCatalogRef: args.modelFacingCatalogRef,
    importSpecifier: args.importSpecifier,
    allowedPublicNames,
    allowedRegistryNames,
    allowedCallbackNames,
    importableModules,
    tools,
  });

  return {
    sdkVersion: args.sdkVersion,
    sdkProjectionHash: hash,
    sourceRegistryVersion: args.sourceRegistryVersion,
    policyId: args.policyId,
    runtimeCompatibilityRange: args.runtimeCompatibilityRange,
    modelFacingCatalogRef: args.modelFacingCatalogRef,
    importSpecifier: args.importSpecifier,
    allowedPublicNames,
    allowedRegistryNames,
    allowedCallbackNames,
    importableModules,
    tools,
  };
}

function materializeToolLibraryProjection(args: {
  core: ToolLibraryProjectionCore;
  rootPath: string;
  catalogPath: string;
}): ToolLibraryProjection {
  const projectionManifest = getToolLibraryProjectionManifest(args.core);
  return {
    rootPath: args.rootPath,
    catalogPath: args.catalogPath,
    ...args.core,
    files: buildToolLibraryProjectionFiles({
      projectionManifest,
      tools: args.core.tools,
    }),
  };
}

function computeToolLibraryProjectionHash(args: {
  sdkVersion: string;
  sourceRegistryVersion: string;
  policyId: string;
  runtimeCompatibilityRange: string;
  modelFacingCatalogRef: string;
  importSpecifier: string;
  allowedPublicNames: readonly string[];
  allowedRegistryNames: readonly string[];
  allowedCallbackNames: readonly string[];
  importableModules: readonly ToolLibraryProjectionImportableModule[];
  tools: readonly ToolLibraryProjectionGeneratedTool[];
}): `sha256:${string}` {
  return `sha256:${sha256StableJson(
    {
      generatorVersion: TOOL_LIBRARY_PROJECTION_GENERATOR_VERSION,
      sdkVersion: args.sdkVersion,
      sourceRegistryVersion: args.sourceRegistryVersion,
      policyId: args.policyId,
      runtimeCompatibilityRange: args.runtimeCompatibilityRange,
      modelFacingCatalogRef: args.modelFacingCatalogRef,
      importSpecifier: args.importSpecifier,
      allowedPublicNames: args.allowedPublicNames,
      allowedRegistryNames: args.allowedRegistryNames,
      allowedCallbackNames: args.allowedCallbackNames,
      importableModules: args.importableModules,
      tools: args.tools.map(hashableToolLibraryProjectionTool),
    },
    { omitUndefinedObjectKeys: true },
  )}`;
}
