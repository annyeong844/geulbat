import * as path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { getErrorCode } from '../utils/error.js';

type PathModule = Pick<
  typeof path,
  'normalize' | 'parse' | 'relative' | 'resolve' | 'sep'
>;

const WINDOWS_ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\)/;

/** Normalize a host path without treating its coordinate base as a sandbox. */
export function normalizePath(
  workspaceRoot: string,
  inputPath: string,
): string {
  const pathModule = getPathModule(workspaceRoot, inputPath);
  const resolvedWorkspaceRoot = pathModule.resolve(workspaceRoot);
  const resolvedTarget = pathModule.resolve(resolvedWorkspaceRoot, inputPath);
  return pathModule
    .relative(resolvedWorkspaceRoot, resolvedTarget)
    .split(pathModule.sep)
    .join('/');
}

function toWorkspaceDisplayPath(
  workspaceRoot: string,
  absolutePath: string,
): string {
  const pathModule = getPathModule(workspaceRoot, absolutePath);
  const rel = pathModule.relative(workspaceRoot, absolutePath);
  if (!rel || rel === '') {
    return '.';
  }
  return rel.split(pathModule.sep).join('/');
}

/**
 * Reject a path for operations that require a symlink-free route. The base is
 * only a coordinate origin; parent segments may walk to any OS-accessible
 * location.
 *
 * - existing leaf symlink: rejected
 * - existing parent symlink: rejected
 * - missing leaf: allowed when `allowMissingLeaf` is true, as long as every
 *   existing ancestor on the resolved route is a real directory path
 */
export async function checkNoSymlinkPathSegments(
  workspaceRoot: string,
  absolutePath: string,
  options?: { allowMissingLeaf?: boolean },
): Promise<string> {
  const { allowMissingLeaf = false } = options ?? {};
  const pathModule = getPathModule(workspaceRoot, absolutePath);
  const relativePath = normalizePath(workspaceRoot, absolutePath);
  const segments = relativePath.split('/').filter(Boolean);

  let currentPath = await realpath(workspaceRoot);

  for (let i = 0; i < segments.length; i += 1) {
    const nextPath = pathModule.resolve(currentPath, segments[i]!);

    try {
      const stats = await lstat(nextPath);
      if (stats.isSymbolicLink()) {
        throw new PathEscapeError(
          toWorkspaceDisplayPath(workspaceRoot, nextPath),
        );
      }
    } catch (error: unknown) {
      const code = getErrorCode(error);
      if (code === 'ENOENT') {
        if (allowMissingLeaf) {
          // Create-like paths may legitimately introduce the missing tail.
          return pathModule.resolve(currentPath, ...segments.slice(i));
        }
        throw new PathNotFoundError(
          toWorkspaceDisplayPath(workspaceRoot, nextPath),
        );
      }
      throw error;
    }

    currentPath = await realpath(nextPath);
  }

  return currentPath;
}

export class PathNotFoundError extends Error {
  code = 'not_found' as const;
  path: string;

  constructor(path: string) {
    super(`path not found: ${path}`);
    this.name = 'PathNotFoundError';
    this.path = path;
  }
}

export class PathEscapeError extends Error {
  code = 'path_out_of_computer_scope' as const;

  constructor(path: string) {
    super(`path is not allowed for this operation: ${path}`);
    this.name = 'PathEscapeError';
  }
}

function getPathModule(...pathsToInspect: string[]): PathModule {
  return pathsToInspect.some((value) => WINDOWS_ABSOLUTE_PATH.test(value))
    ? path.win32
    : path;
}

function normalizeBoundaryPath(
  inputPath: string,
  pathModule: PathModule,
): string {
  let normalized = pathModule.normalize(inputPath);
  const root = pathModule.parse(normalized).root;
  while (
    normalized.length > root.length &&
    normalized.endsWith(pathModule.sep)
  ) {
    normalized = normalized.slice(0, -1);
  }
  if (pathModule.sep === '\\') {
    return normalized.replace(/\//g, '\\').toLowerCase();
  }
  return normalized;
}

export function isSameOrDescendantPath(
  ancestorPath: string,
  targetPath: string,
): boolean {
  const pathModule = getPathModule(ancestorPath, targetPath);
  const normalizedAncestor = normalizeBoundaryPath(
    pathModule.resolve(ancestorPath),
    pathModule,
  );
  const normalizedTarget = normalizeBoundaryPath(
    pathModule.resolve(targetPath),
    pathModule,
  );
  const ancestorPrefix = normalizedAncestor.endsWith(pathModule.sep)
    ? normalizedAncestor
    : normalizedAncestor + pathModule.sep;
  return (
    normalizedTarget === normalizedAncestor ||
    normalizedTarget.startsWith(ancestorPrefix)
  );
}
