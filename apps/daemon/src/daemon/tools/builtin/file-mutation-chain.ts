import { mkdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  resolveSourceMutationTarget,
  type SourceMutationTarget,
} from '../../files/file-platform.js';
import {
  readResolvedFile,
  type ReadFileResult,
} from '../../files/read-file.js';
import { runSourceMutationSerial } from '../../files/file-mutation-serial.js';
import {
  saveResolvedFile,
  type SaveFileOptions,
  type SaveFileResult,
} from '../../files/save-file.js';
import { hasErrorCode } from '../../utils/error.js';
import {
  AlreadyExistsWriteTargetError,
  FileAccessError,
  MissingWriteTargetError,
  StaleWriteError,
} from '../../files/file-domain-error.js';
import type { FileStateCache } from '../../utils/file-state-cache.js';

type PreparedPathKind = 'file' | 'directory';

interface PreparedMutatingFilePath {
  resolvedPath: SourceMutationTarget;
  exists: boolean;
  pathKind?: PreparedPathKind;
}

interface PreparedPatchFile {
  resolvedPath: SourceMutationTarget;
  fileResult: ReadFileResult;
}

interface PreparedResolvedPath {
  resolvedPath: SourceMutationTarget;
  pathKind?: PreparedPathKind;
}

interface PreparedRelocationPaths {
  sourcePath: SourceMutationTarget;
  sourceKind: 'file' | 'directory';
  destinationPath: SourceMutationTarget;
  destinationExists: boolean;
}

interface FileMutationCacheContext {
  fileStateCache?: FileStateCache;
}

// Prepared filesystem state is advisory; commit paths must re-check it because
// approval/preparation and commit can be separated by concurrent file changes.
export async function prepareMutatingFilePath(
  workspaceRoot: string,
  inputPath: string,
  options?: { allowMissingLeaf?: boolean },
): Promise<PreparedMutatingFilePath> {
  const resolvedPath = await resolveSourceMutationTarget(
    workspaceRoot,
    inputPath,
    options?.allowMissingLeaf !== undefined
      ? {
          allowMissingLeaf: options.allowMissingLeaf,
        }
      : undefined,
  );
  const pathKind = await getExistingPathKind(resolvedPath.absolutePath);
  return {
    resolvedPath,
    exists: pathKind !== undefined,
    ...(pathKind !== undefined ? { pathKind } : {}),
  };
}

export async function preparePatchFile(
  workspaceRoot: string,
  inputPath: string,
  context?: FileMutationCacheContext,
): Promise<PreparedPatchFile> {
  const resolvedPath = await resolveSourceMutationTarget(
    workspaceRoot,
    inputPath,
  );
  const fileResult = await readResolvedFile(
    resolvedPath,
    context?.fileStateCache
      ? { fileStateCache: context.fileStateCache }
      : undefined,
  );
  return { resolvedPath, fileResult };
}

export async function prepareResolvedMutatingPath(
  workspaceRoot: string,
  inputPath: string,
  options?: { allowMissingLeaf?: boolean },
): Promise<PreparedResolvedPath> {
  const resolvedPath = await resolveSourceMutationTarget(
    workspaceRoot,
    inputPath,
    options?.allowMissingLeaf !== undefined
      ? {
          allowMissingLeaf: options.allowMissingLeaf,
        }
      : undefined,
  );
  const pathKind = await getExistingPathKind(resolvedPath.absolutePath);
  return {
    resolvedPath,
    ...(pathKind !== undefined ? { pathKind } : {}),
  };
}

export async function prepareRelocationPaths(
  workspaceRoot: string,
  inputPath: string,
  destination: string,
): Promise<PreparedRelocationPaths> {
  const sourcePath = await resolveSourceMutationTarget(
    workspaceRoot,
    inputPath,
  );
  const sourceStats = await stat(sourcePath.absolutePath);
  const destinationPath = await resolveSourceMutationTarget(
    workspaceRoot,
    destination,
    {
      allowMissingLeaf: true,
    },
  );

  return {
    sourcePath,
    sourceKind: sourceStats.isDirectory() ? 'directory' : 'file',
    destinationPath,
    destinationExists:
      sourcePath.absolutePath !== destinationPath.absolutePath &&
      (await pathExists(destinationPath.absolutePath)),
  };
}

export async function persistPreparedFile(
  prepared: Pick<PreparedMutatingFilePath | PreparedPatchFile, 'resolvedPath'>,
  content: string,
  versionToken: string,
  options?: SaveFileOptions,
  context?: FileMutationCacheContext,
): Promise<SaveFileResult> {
  let result;
  try {
    result = await saveResolvedFile(
      prepared.resolvedPath,
      content,
      versionToken,
      options,
    );
  } catch (error: unknown) {
    if (versionToken.trim().length === 0) {
      if (
        error instanceof StaleWriteError ||
        hasErrorCode(error, 'EEXIST') ||
        hasErrorCode(error, 'ENOTDIR')
      ) {
        throw new AlreadyExistsWriteTargetError(
          prepared.resolvedPath.relativePath,
        );
      }
    }
    throw error;
  }
  invalidateResolvedPath(context?.fileStateCache, prepared.resolvedPath);
  return result;
}

export async function commitPreparedRelocation(
  prepared: PreparedRelocationPaths,
  context?: FileMutationCacheContext,
): Promise<{ from: string; to: string }> {
  return runSourceMutationSerial(
    [
      prepared.sourcePath.canonicalAbsolutePath,
      prepared.destinationPath.canonicalAbsolutePath,
    ],
    async () => {
      const sourceStats = await stat(prepared.sourcePath.absolutePath).catch(
        (error: unknown) => {
          if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) {
            throw new MissingWriteTargetError(
              prepared.sourcePath.relativePath,
              {
                cause: error,
              },
            );
          }
          throw error;
        },
      );
      const currentSourceKind = sourceStats.isDirectory()
        ? 'directory'
        : 'file';
      if (currentSourceKind !== prepared.sourceKind) {
        throw new FileAccessError(
          'conflict',
          `source changed before relocation: ${prepared.sourcePath.relativePath}`,
          prepared.sourcePath.relativePath,
        );
      }

      if (
        prepared.sourcePath.canonicalAbsolutePath !==
          prepared.destinationPath.canonicalAbsolutePath &&
        (await pathExists(prepared.destinationPath.absolutePath))
      ) {
        throw new AlreadyExistsWriteTargetError(
          prepared.destinationPath.relativePath,
        );
      }

      try {
        await mkdir(dirname(prepared.destinationPath.absolutePath), {
          recursive: true,
        });
      } catch (error: unknown) {
        if (hasErrorCode(error, 'EEXIST') || hasErrorCode(error, 'ENOTDIR')) {
          throw new AlreadyExistsWriteTargetError(
            prepared.destinationPath.relativePath,
          );
        }
        throw error;
      }

      try {
        await rename(
          prepared.sourcePath.absolutePath,
          prepared.destinationPath.absolutePath,
        );
      } catch (error: unknown) {
        if (hasErrorCode(error, 'ENOENT')) {
          throw new MissingWriteTargetError(prepared.sourcePath.relativePath, {
            cause: error,
          });
        }
        if (hasErrorCode(error, 'EEXIST') || hasErrorCode(error, 'ENOTDIR')) {
          throw new AlreadyExistsWriteTargetError(
            prepared.destinationPath.relativePath,
          );
        }
        throw error;
      }
      const result = {
        from: prepared.sourcePath.relativePath,
        to: prepared.destinationPath.relativePath,
      };
      invalidateResolvedPath(context?.fileStateCache, prepared.sourcePath);
      invalidateResolvedPath(context?.fileStateCache, prepared.destinationPath);
      return result;
    },
  );
}

export async function commitPreparedDeletion(
  prepared: PreparedResolvedPath,
  context?: FileMutationCacheContext,
): Promise<{ path: string }> {
  return runSourceMutationSerial(
    prepared.resolvedPath.canonicalAbsolutePath,
    async () => {
      let stats;
      try {
        stats = await stat(prepared.resolvedPath.absolutePath);
      } catch (error: unknown) {
        if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) {
          throw new MissingWriteTargetError(
            prepared.resolvedPath.relativePath,
            {
              cause: error,
            },
          );
        }
        throw error;
      }

      const currentPathKind: PreparedPathKind = stats.isDirectory()
        ? 'directory'
        : 'file';
      if (
        prepared.pathKind !== undefined &&
        currentPathKind !== prepared.pathKind
      ) {
        throw new FileAccessError(
          'conflict',
          `target changed before deletion: ${prepared.resolvedPath.relativePath}`,
          prepared.resolvedPath.relativePath,
        );
      }

      try {
        if (stats.isDirectory()) {
          await rm(prepared.resolvedPath.absolutePath, { recursive: true });
        } else {
          await unlink(prepared.resolvedPath.absolutePath);
        }
      } catch (error: unknown) {
        if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) {
          throw new MissingWriteTargetError(
            prepared.resolvedPath.relativePath,
            {
              cause: error,
            },
          );
        }
        throw error;
      }

      const result = {
        path: prepared.resolvedPath.relativePath,
      };
      invalidateResolvedPath(context?.fileStateCache, prepared.resolvedPath);
      return result;
    },
  );
}

export async function commitPreparedDirectoryCreation(
  prepared: PreparedResolvedPath,
  context?: FileMutationCacheContext,
): Promise<{ path: string }> {
  return runSourceMutationSerial(
    prepared.resolvedPath.canonicalAbsolutePath,
    async () => {
      if (await pathExists(prepared.resolvedPath.absolutePath)) {
        throw new AlreadyExistsWriteTargetError(
          prepared.resolvedPath.relativePath,
        );
      }

      try {
        await mkdir(prepared.resolvedPath.absolutePath, { recursive: true });
      } catch (error: unknown) {
        if (hasErrorCode(error, 'EEXIST') || hasErrorCode(error, 'ENOTDIR')) {
          throw new AlreadyExistsWriteTargetError(
            prepared.resolvedPath.relativePath,
          );
        }
        throw error;
      }
      const result = {
        path: prepared.resolvedPath.relativePath,
      };
      invalidateResolvedPath(context?.fileStateCache, prepared.resolvedPath);
      return result;
    },
  );
}

async function pathExists(path: string): Promise<boolean> {
  return (await getExistingPathKind(path)) !== undefined;
}

async function getExistingPathKind(
  path: string,
): Promise<PreparedPathKind | undefined> {
  try {
    const stats = await stat(path);
    return stats.isDirectory() ? 'directory' : 'file';
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) {
      return undefined;
    }
    throw error;
  }
}

function invalidateResolvedPath(
  fileStateCache: FileStateCache | undefined,
  resolvedPath: Pick<SourceMutationTarget, 'canonicalAbsolutePath'>,
): void {
  fileStateCache?.invalidateCacheKey(resolvedPath.canonicalAbsolutePath);
}
