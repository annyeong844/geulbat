import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { sha256StableJson } from '@geulbat/content-identity/stable-json';
import {
  createToolLibraryProjectionBundle,
  parseToolLibraryProjectionBundle,
  serializeToolLibraryProjectionBundle,
  type ToolLibraryProjectionIdentity,
  type ToolLibraryProjectionImportableModule,
  type ToolLibraryProjectionPin,
} from '@geulbat/tool-library/projection-codec';
import {
  validateToolCapabilityPolicy,
  type ToolCapabilityPolicy,
} from '@geulbat/tool-library/tool-capability-policy';
import {
  buildToolLibraryProjectionFiles,
  buildToolLibraryProjectionImportableModules,
  TOOL_LIBRARY_PROJECTION_GENERATOR_VERSION,
} from '@geulbat/tool-library/projection-generator';
import {
  getToolLibraryProjectionIdentity,
  getToolLibraryProjectionManifest,
  getToolLibraryProjectionPin,
  projectionDirectoryNameForHash,
} from '@geulbat/tool-library/projection-manifest';
import type { ToolLibraryProjectionGeneratedTool } from '@geulbat/tool-library/projection-descriptor';
import { isRecord } from '../runtime-json.js';
import { getErrorCode } from '../utils/error.js';
import {
  resolveToolLibraryProjectionFilePath,
  threadProjectionDirectoryName,
  toolLibraryProjectionContentRootPath,
} from './tool-library-projection-path.js';
import type {
  BuildToolLibraryProjectionArgs,
  ToolLibraryProjection,
  ToolLibraryProjectionFailureDiagnostics,
  ToolLibraryProjectionFailureResult,
  ToolLibraryProjectionTransferPort,
  RehydrateToolLibraryProjectionMountResult,
} from './tool-library-projection-port.js';
import {
  hashableToolLibraryProjectionTool,
  resolveToolLibraryProjectionTools,
} from './tool-library-projection-registry.js';
import {
  isPtcExecuteCodeCallbackToolMetaAllowed,
  isPtcExecuteCodeDelegatedApprovalCallbackToolMetaAllowed,
  isPtcExecuteCodeWriteCallbackToolMetaAllowed,
} from './builtin/ptc-callback-tool-surface.js';
import type { ToolRegistryStore } from './tool-registry-model.js';
import {
  migrateLegacyToolLibraryProjectionContent,
  pruneInvalidToolLibraryProjectionDirectories,
  readExistingPinnedToolLibraryProjection,
  readVerifiedToolLibraryProjectionMount,
  toolLibraryProjectionContentPathForDirectory,
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
  ToolLibraryProjectionTransferPort,
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
): ToolLibraryProjectionTransferPort {
  return {
    async resolveProjection(resolveArgs) {
      try {
        if (
          resolveArgs.allowedRegistryNames !== undefined &&
          resolveArgs.toolCapabilityPolicy !== undefined
        ) {
          throw new Error(
            'allowedRegistryNames and toolCapabilityPolicy cannot be supplied together',
          );
        }
        const toolCapabilityPolicy =
          resolveArgs.toolCapabilityPolicy === undefined
            ? undefined
            : validateToolCapabilityPolicy(resolveArgs.toolCapabilityPolicy);
        if (toolCapabilityPolicy !== undefined) {
          for (const name of toolCapabilityPolicy.callbackRegistryNames) {
            const tool = args.registry.getTool(name);
            if (tool === undefined) {
              throw new Error(
                `Tool capability policy includes an unknown callback tool: ${name}`,
              );
            }
            const readCallbackAllowed = isPtcExecuteCodeCallbackToolMetaAllowed(
              name,
              tool,
            );
            const delegatedApprovalCallbackAllowed =
              isPtcExecuteCodeDelegatedApprovalCallbackToolMetaAllowed(
                name,
                tool,
              );
            const writeCallbackAllowed =
              toolCapabilityPolicy.writeCallbackEnabled &&
              isPtcExecuteCodeWriteCallbackToolMetaAllowed(name, tool);
            if (
              !readCallbackAllowed &&
              !delegatedApprovalCallbackAllowed &&
              !writeCallbackAllowed
            ) {
              throw new Error(
                `Tool capability policy includes a callback tool outside the callable surface: ${name}`,
              );
            }
          }
        }
        const requestedRegistryNames =
          toolCapabilityPolicy?.callbackRegistryNames ??
          resolveArgs.allowedRegistryNames ??
          args.registry.getAllRegisteredToolNames();
        const allowedRegistryNames =
          args.projectionPolicy === undefined ||
          toolCapabilityPolicy !== undefined
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
          toolCapabilityPolicy?.toolCapabilityPolicyId ??
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
        const contentRootPath =
          toolLibraryProjectionContentRootPath(runtimeRootPath);
        // 구 레이아웃(thread 안 콘텐츠)을 공유 위치로 옮긴 뒤 해석한다. 이후 pin은
        // 위치를 바꾸지 않아도 같은 이름으로 공유 콘텐츠를 가리킨다.
        await migrateLegacyToolLibraryProjectionContent({
          contentRootPath,
          threadProjectionRootPath,
        });
        const rootPath = toolLibraryProjectionContentPathForDirectory({
          contentRootPath,
          projectionDirectory: projectionDirectoryNameForHash(
            projectionCore.sdkProjectionHash,
          ),
        });
        const projection = materializeToolLibraryProjection({
          core: projectionCore,
          rootPath,
          catalogPath: join(rootPath, 'catalog.js'),
        });
        const existing = await readExistingPinnedToolLibraryProjection({
          contentRootPath,
          threadProjectionRootPath,
          importSpecifier: args.importSpecifier,
        });
        if (existing.kind === 'present') {
          const requestedPolicyDiffersFromPin =
            toolCapabilityPolicy !== undefined &&
            (existing.pin.policyId !==
              toolCapabilityPolicy.toolCapabilityPolicyId ||
              existing.pin.allowedRegistryNames.length !==
                toolCapabilityPolicy.callbackRegistryNames.length ||
              existing.pin.allowedRegistryNames.some(
                (name, index) =>
                  name !== toolCapabilityPolicy.callbackRegistryNames[index],
              ));
          if (
            requestedPolicyDiffersFromPin &&
            !isLegacyProjectionPolicyTransition({
              pinnedProjection: existing.pin,
              requestedPolicy: toolCapabilityPolicy,
              legacyPolicyId: args.projectionPolicy?.policyId,
            })
          ) {
            return {
              ok: false,
              reason: 'projection_failed',
              message:
                'Pinned tool library projection does not match the requested tool capability policy',
            };
          }
          if (requestedPolicyDiffersFromPin) {
            return await writeAndVerifyToolLibraryProjection({
              projection,
              contentRootPath,
              threadProjectionRootPath,
              importSpecifier: args.importSpecifier,
            });
          }
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
            const refreshedRootPath =
              toolLibraryProjectionContentPathForDirectory({
                contentRootPath,
                projectionDirectory: projectionDirectoryNameForHash(
                  pinnedProjection.sdkProjectionHash,
                ),
              });
            return await writeAndVerifyToolLibraryProjection({
              projection: materializeToolLibraryProjection({
                core: pinnedProjectionCore,
                rootPath: refreshedRootPath,
                catalogPath: join(refreshedRootPath, 'catalog.js'),
              }),
              contentRootPath,
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
          const pruneResults = await Promise.all(
            [contentRootPath, threadProjectionRootPath].map(
              async (pruneRootPath) =>
                await pruneInvalidToolLibraryProjectionDirectories({
                  threadProjectionRootPath: pruneRootPath,
                  retainedProjectionDirectories: [
                    existing.pin.projectionDirectory,
                  ],
                }),
            ),
          );
          const pruneResult = {
            removedDirectories: pruneResults.flatMap(
              (result) => result.removedDirectories,
            ),
            failedDirectories: pruneResults.flatMap(
              (result) => result.failedDirectories,
            ),
          };
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
        if (existing.kind === 'content_missing') {
          // 콘텐츠는 pin에서 다시 만들 수 있는 파생물이다. 현재 레지스트리 기준으로
          // 만들면 pin 정체성이 조용히 바뀌므로 반드시 pin 기준으로 재생성한다.
          const pinnedRootPath = toolLibraryProjectionContentPathForDirectory({
            contentRootPath,
            projectionDirectory: existing.pin.projectionDirectory,
          });
          return await writeAndVerifyToolLibraryProjection({
            projection: materializeToolLibraryProjection({
              core: buildToolLibraryProjectionCore({
                registry: args.registry,
                allowedRegistryNames: existing.pin.allowedRegistryNames,
                sdkVersion: existing.pin.sdkVersion,
                sourceRegistryVersion: existing.pin.sourceRegistryVersion,
                policyId: existing.pin.policyId,
                runtimeCompatibilityRange:
                  existing.pin.runtimeCompatibilityRange,
                modelFacingCatalogRef: existing.pin.modelFacingCatalogRef,
                importSpecifier: existing.pin.importSpecifier,
              }),
              rootPath: pinnedRootPath,
              catalogPath: join(pinnedRootPath, 'catalog.js'),
            }),
            contentRootPath,
            threadProjectionRootPath,
            importSpecifier: args.importSpecifier,
          });
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
          contentRootPath,
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
      return await rehydrateToolLibraryProjectionMount(args, resolveArgs);
    },
    async exportProjectionBundle(resolveArgs) {
      try {
        let expectedIdentity = resolveArgs.expectedIdentity;
        if (expectedIdentity === undefined) {
          const existing = await readExistingPinnedToolLibraryProjection({
            contentRootPath: contentRootPathFor({
              runtimeRootForState: args.runtimeRootForState,
              stateRoot: resolveArgs.stateRoot,
            }),
            threadProjectionRootPath: threadProjectionRootPathFor({
              runtimeRootForState: args.runtimeRootForState,
              stateRoot: resolveArgs.stateRoot,
              threadId: resolveArgs.threadId,
            }),
            importSpecifier: args.importSpecifier,
          });
          if (existing.kind === 'missing') {
            return {
              ok: false,
              reason: 'projection_failed',
              message: 'Tool library projection pin is unavailable for export',
            };
          }
          if (existing.kind === 'failed') {
            return {
              ok: false,
              reason: 'projection_failed',
              message: existing.message,
            };
          }
          expectedIdentity = getToolLibraryProjectionIdentity(existing.pin);
        }
        const projectionResult = await rehydrateToolLibraryProjectionMount(
          args,
          {
            ...resolveArgs,
            expectedIdentity,
          },
        );
        if (!projectionResult.ok) {
          return projectionResult;
        }
        const bundle = createToolLibraryProjectionBundle({
          manifest: getToolLibraryProjectionManifest(
            projectionResult.projection,
          ),
          files: projectionResult.projection.files,
        });
        return {
          ok: true,
          bundleId: bundle.bundleId,
          identity: getToolLibraryProjectionIdentity(bundle.manifest),
          serializedBundle: serializeToolLibraryProjectionBundle(bundle),
        };
      } catch (error) {
        return toolLibraryProjectionFailure({
          message: 'Tool library projection bundle export failed',
          error,
        });
      }
    },
    async importProjectionBundle(resolveArgs) {
      try {
        const bundle = parseToolLibraryProjectionBundle(
          resolveArgs.serializedBundle,
        );
        const threadProjectionRootPath = threadProjectionRootPathFor({
          runtimeRootForState: args.runtimeRootForState,
          stateRoot: resolveArgs.stateRoot,
          threadId: resolveArgs.threadId,
        });
        const contentRootPath = contentRootPathFor({
          runtimeRootForState: args.runtimeRootForState,
          stateRoot: resolveArgs.stateRoot,
        });
        await migrateLegacyToolLibraryProjectionContent({
          contentRootPath,
          threadProjectionRootPath,
        });
        const rootPath = toolLibraryProjectionContentPathForDirectory({
          contentRootPath,
          projectionDirectory: projectionDirectoryNameForHash(
            bundle.manifest.sdkProjectionHash,
          ),
        });
        const projection = buildToolLibraryProjection({
          registry: args.registry,
          allowedRegistryNames: bundle.manifest.allowedRegistryNames,
          sdkVersion: args.sdkVersion,
          sourceRegistryVersion: args.sourceRegistryVersion,
          policyId: bundle.manifest.policyId,
          runtimeCompatibilityRange: args.runtimeCompatibilityRange,
          rootPath,
          catalogPath: join(rootPath, bundle.manifest.catalogModule),
          modelFacingCatalogRef: args.modelFacingCatalogRef,
          importSpecifier: args.importSpecifier,
        });
        const expectedBundle = createToolLibraryProjectionBundle({
          manifest: getToolLibraryProjectionManifest(projection),
          files: projection.files,
        });
        if (
          serializeToolLibraryProjectionBundle(expectedBundle) !==
          serializeToolLibraryProjectionBundle(bundle)
        ) {
          return {
            ok: false,
            reason: 'projection_failed',
            message:
              'Tool library projection bundle does not match the destination executable registry',
          };
        }
        const existing = await readExistingPinnedToolLibraryProjection({
          contentRootPath,
          threadProjectionRootPath,
          importSpecifier: args.importSpecifier,
        });
        if (existing.kind === 'present') {
          const existingIdentity = getToolLibraryProjectionIdentity(
            existing.manifest,
          );
          const expectedIdentity = getToolLibraryProjectionIdentity(
            bundle.manifest,
          );
          if (
            existingIdentity.sdkVersion !== expectedIdentity.sdkVersion ||
            existingIdentity.sdkProjectionHash !==
              expectedIdentity.sdkProjectionHash ||
            existingIdentity.policyId !== expectedIdentity.policyId
          ) {
            return {
              ok: false,
              reason: 'projection_failed',
              message:
                'Existing tool library projection pin does not match the imported bundle',
            };
          }
          return await rehydrateToolLibraryProjectionMount(args, {
            stateRoot: resolveArgs.stateRoot,
            threadId: resolveArgs.threadId,
            expectedIdentity,
          });
        }
        if (existing.kind === 'failed') {
          return {
            ok: false,
            reason: 'projection_failed',
            message: existing.message,
          };
        }

        try {
          const threadRootStats = await lstat(threadProjectionRootPath);
          if (
            threadRootStats.isSymbolicLink() ||
            !threadRootStats.isDirectory()
          ) {
            return {
              ok: false,
              reason: 'projection_failed',
              message:
                'Tool library projection bundle destination root is not a regular directory',
            };
          }
        } catch (error) {
          const code = getErrorCode(error);
          if (code !== 'ENOENT' && code !== 'ENOTDIR') {
            throw error;
          }
        }
        try {
          await lstat(rootPath);
          if (!(await projectionFilesMatchGeneratedSource(projection))) {
            return {
              ok: false,
              reason: 'projection_failed',
              message:
                'Tool library projection bundle destination is already occupied',
            };
          }
        } catch (error) {
          const code = getErrorCode(error);
          if (code !== 'ENOENT' && code !== 'ENOTDIR') {
            throw error;
          }
        }
        const written = await writeAndVerifyToolLibraryProjection({
          projection,
          contentRootPath,
          threadProjectionRootPath,
          importSpecifier: args.importSpecifier,
        });
        if (!written.ok) {
          return written;
        }
        return await rehydrateToolLibraryProjectionMount(args, {
          stateRoot: resolveArgs.stateRoot,
          threadId: resolveArgs.threadId,
          expectedIdentity: getToolLibraryProjectionIdentity(bundle.manifest),
        });
      } catch (error) {
        return toolLibraryProjectionFailure({
          message: 'Tool library projection bundle import failed',
          error,
        });
      }
    },
  };
}

async function rehydrateToolLibraryProjectionMount(
  args: CreateToolLibraryProjectionPortArgs,
  resolveArgs: {
    stateRoot: string;
    threadId: string;
    expectedIdentity: ToolLibraryProjectionIdentity;
  },
): Promise<RehydrateToolLibraryProjectionMountResult> {
  try {
    const mountResult = await readVerifiedToolLibraryProjectionMount({
      contentRootPath: contentRootPathFor({
        runtimeRootForState: args.runtimeRootForState,
        stateRoot: resolveArgs.stateRoot,
      }),
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
    if (projection.sdkProjectionHash !== mountResult.pin.sdkProjectionHash) {
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
}

function isLegacyProjectionPolicyTransition(args: {
  pinnedProjection: ToolLibraryProjectionPin;
  requestedPolicy: ToolCapabilityPolicy | undefined;
  legacyPolicyId: string | undefined;
}): boolean {
  const requestedPolicy = args.requestedPolicy;
  if (
    requestedPolicy === undefined ||
    args.legacyPolicyId === undefined ||
    args.pinnedProjection.policyId !== args.legacyPolicyId ||
    args.pinnedProjection.allowedRegistryNames.length !==
      requestedPolicy.callbackRegistryNames.length
  ) {
    return false;
  }
  return args.pinnedProjection.allowedRegistryNames.every(
    (name, index) => name === requestedPolicy.callbackRegistryNames[index],
  );
}

async function writeAndVerifyToolLibraryProjection(args: {
  projection: ToolLibraryProjection;
  contentRootPath: string;
  threadProjectionRootPath: string;
  importSpecifier: string;
}) {
  const pin = getToolLibraryProjectionPin(args.projection);
  // 공유 콘텐츠는 digest로 주소가 정해지므로 이미 있으면 내용이 같다. 다시 쓰면
  // 같은 바이트를 덮어쓰는 낭비이고, 동시에 materialize하는 다른 스레드가 부분
  // 기록 상태를 관찰할 수 있다.
  const alreadyMaterialized = await projectionFilesMatchGeneratedSource(
    args.projection,
  ).catch(() => false);
  const written = alreadyMaterialized
    ? { rootPath: args.projection.rootPath, writtenFiles: [] as string[] }
    : await writeToolLibraryProjectionFiles(args.projection);
  await writeToolLibraryProjectionPinFile({
    threadProjectionRootPath: args.threadProjectionRootPath,
    pin,
  });
  const mountResult = await readVerifiedToolLibraryProjectionMount({
    contentRootPath: args.contentRootPath,
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
  // prune은 manifest를 읽을 수 없는 디렉터리만 제거하므로, 다른 스레드가 참조하는
  // 정상 공유 콘텐츠는 건드리지 않는다. 콘텐츠가 공유 위치로 옮겨졌으니 그쪽과
  // 구 레이아웃이 남을 수 있는 thread 디렉터리를 모두 훑는다.
  const pruneResults = await Promise.all(
    [args.contentRootPath, args.threadProjectionRootPath].map(
      async (threadProjectionRootPath) =>
        await pruneInvalidToolLibraryProjectionDirectories({
          threadProjectionRootPath,
          retainedProjectionDirectories: [pin.projectionDirectory],
        }),
    ),
  );
  const prunedProjectionDirectories = pruneResults.flatMap(
    (result) => result.removedDirectories,
  );
  const projectionPruneFailedDirectories = pruneResults.flatMap(
    (result) => result.failedDirectories,
  );
  return {
    ok: true as const,
    mount: mountResult.mount,
    pin: mountResult.pin,
    prunedProjectionDirectories,
    projectionPruneFailedDirectories,
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

function contentRootPathFor(args: {
  runtimeRootForState(stateRoot: string): string;
  stateRoot: string;
}): string {
  return toolLibraryProjectionContentRootPath(
    args.runtimeRootForState(args.stateRoot),
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
