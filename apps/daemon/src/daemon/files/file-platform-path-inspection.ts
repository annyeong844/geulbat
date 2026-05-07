import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import {
  PathEscapeError,
  PathNotFoundError,
  checkSymlinkEscape,
  isPathInsideWorkspaceBoundary,
  normalizePath,
} from './normalize-path.js';
import { isReservedPath } from './reserved-paths.js';
import { FileAccessError } from './file-domain-error.js';
import type { InspectedCanonicalWorkspacePath } from './file-platform-target-types.js';
import { getErrorCode } from '../utils/error.js';

export async function resolveCanonicalReadPath(
  workspaceRoot: string,
  relativePath: string,
): Promise<{
  workspaceCanonicalRoot: string;
  canonicalAbsolutePath: string;
}> {
  const workspaceCanonicalRoot = await realpath(workspaceRoot);
  const requestedAbsolutePath = toCanonicalWorkspacePath(
    workspaceCanonicalRoot,
    relativePath,
  );
  const canonicalAbsolutePath = await checkSymlinkEscape(
    workspaceRoot,
    requestedAbsolutePath,
  );

  return {
    workspaceCanonicalRoot,
    canonicalAbsolutePath,
  };
}

export async function resolveCanonicalDirectoryPath(
  workspaceRoot: string,
  relativePath: string,
): Promise<{
  workspaceCanonicalRoot: string;
  canonicalAbsolutePath: string;
  exists: boolean;
}> {
  const workspaceCanonicalRoot = await realpath(workspaceRoot);
  const requestedAbsolutePath = toCanonicalWorkspacePath(
    workspaceCanonicalRoot,
    relativePath,
  );

  let canonicalAbsolutePath = requestedAbsolutePath;
  let exists = true;
  try {
    canonicalAbsolutePath = await checkSymlinkEscape(
      workspaceRoot,
      requestedAbsolutePath,
    );
  } catch (error: unknown) {
    const code = getErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      exists = false;
    } else {
      throw error;
    }
  }

  return {
    workspaceCanonicalRoot,
    canonicalAbsolutePath,
    exists,
  };
}

export function normalizeSourceRelativePath(
  workspaceRoot: string,
  inputPath: string,
): string {
  const relativePath = toDisplayRelativePath(
    normalizePath(workspaceRoot, inputPath),
  );
  if (isReservedPath(relativePath)) {
    throw FileAccessError.reservedPath(relativePath);
  }
  return relativePath;
}

export function normalizeInternalRelativePath(
  workspaceRoot: string,
  inputPath: string,
): string {
  return toDisplayRelativePath(normalizePath(workspaceRoot, inputPath));
}

function toCanonicalWorkspacePath(
  workspaceCanonicalRoot: string,
  relativePath: string,
): string {
  if (relativePath === '.' || relativePath === '') {
    return workspaceCanonicalRoot;
  }
  return join(workspaceCanonicalRoot, ...relativePath.split('/'));
}

export async function inspectCanonicalWorkspacePath(
  workspaceRoot: string,
  relativePath: string,
  options?: {
    allowMissingLeaf?: boolean;
    allowMissingWorkspaceRoot?: boolean;
  },
): Promise<InspectedCanonicalWorkspacePath> {
  let workspaceCanonicalRoot: string;
  try {
    workspaceCanonicalRoot = await realpath(workspaceRoot);
  } catch (error: unknown) {
    const code = getErrorCode(error);
    if (
      options?.allowMissingWorkspaceRoot &&
      (code === 'ENOENT' || code === 'ENOTDIR')
    ) {
      workspaceCanonicalRoot = workspaceRoot;
    } else {
      throw error;
    }
  }
  const segments =
    relativePath === '.' ? [] : relativePath.split('/').filter(Boolean);
  let currentCanonicalPath = workspaceCanonicalRoot;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const nextPath = join(currentCanonicalPath, segment);

    try {
      const stats = await lstat(nextPath);
      if (stats.isSymbolicLink()) {
        throw new PathEscapeError(segments.slice(0, index + 1).join('/'));
      }
    } catch (error: unknown) {
      const code = getErrorCode(error);
      if (code === 'ENOENT') {
        if (options?.allowMissingLeaf) {
          const missingTailSegments = segments.slice(index);
          return {
            workspaceCanonicalRoot,
            canonicalAbsolutePath: join(
              currentCanonicalPath,
              ...missingTailSegments,
            ),
            existingCanonicalAncestor: currentCanonicalPath,
            missingTailSegments,
          };
        }
        throw new PathNotFoundError(segments.slice(0, index + 1).join('/'));
      }
      if (code === 'ENOTDIR') {
        if (options?.allowMissingLeaf) {
          const missingTailSegments = segments.slice(index);
          return {
            workspaceCanonicalRoot,
            canonicalAbsolutePath: join(
              currentCanonicalPath,
              ...missingTailSegments,
            ),
            existingCanonicalAncestor: currentCanonicalPath,
            missingTailSegments,
          };
        }
        throw new PathNotFoundError(segments.slice(0, index + 1).join('/'));
      }
      throw error;
    }

    const realCurrentPath = await realpath(nextPath);
    if (
      !isPathInsideWorkspaceBoundary(workspaceCanonicalRoot, realCurrentPath)
    ) {
      throw new PathEscapeError(segments.slice(0, index + 1).join('/'));
    }
    currentCanonicalPath = realCurrentPath;
  }

  return {
    workspaceCanonicalRoot,
    canonicalAbsolutePath: currentCanonicalPath,
    existingCanonicalAncestor: currentCanonicalPath,
    missingTailSegments: [],
  };
}

function toDisplayRelativePath(relativePath: string): string {
  return relativePath === '' ? '.' : relativePath;
}
