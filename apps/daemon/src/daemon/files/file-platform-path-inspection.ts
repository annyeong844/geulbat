import { lstat, realpath } from 'node:fs/promises';
import { join, parse, relative, resolve, sep } from 'node:path';

import {
  PathEscapeError,
  PathNotFoundError,
  normalizePath,
} from './normalize-path.js';
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
  const canonicalAbsolutePath = await realpath(requestedAbsolutePath);
  normalizeSourceRelativePath(workspaceCanonicalRoot, canonicalAbsolutePath);

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
    canonicalAbsolutePath = await realpath(requestedAbsolutePath);
    normalizeSourceRelativePath(workspaceCanonicalRoot, canonicalAbsolutePath);
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
  return toDisplayRelativePath(normalizePath(workspaceRoot, inputPath));
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
  return resolve(workspaceCanonicalRoot, relativePath);
}

export async function inspectCanonicalWorkspacePath(
  workspaceRoot: string,
  relativePath: string,
  options?: {
    allowMissingLeaf?: boolean;
    allowMissingWorkspaceRoot?: boolean;
    rejectSymlinks?: boolean;
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
  const requestedAbsolutePath = toCanonicalWorkspacePath(
    workspaceCanonicalRoot,
    relativePath,
  );
  const filesystemRoot = parse(requestedAbsolutePath).root;
  const segments = relative(filesystemRoot, requestedAbsolutePath)
    .split(sep)
    .filter(Boolean);
  let currentCanonicalPath = await realpath(filesystemRoot);

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const nextPath = join(currentCanonicalPath, segment);

    try {
      const stats = await lstat(nextPath);
      if (stats.isSymbolicLink() && options?.rejectSymlinks !== false) {
        throw new PathEscapeError(segments.slice(0, index + 1).join('/'));
      }
      currentCanonicalPath = await realpath(nextPath);
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
