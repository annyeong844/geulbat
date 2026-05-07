import * as path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { getErrorCode } from '../utils/error.js';

type PathModule = Pick<
  typeof path,
  'normalize' | 'parse' | 'relative' | 'resolve' | 'sep'
>;

const WINDOWS_ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\)/;

/**
 * Normalize and validate a path within the workspace boundary.
 * Rejects `..` escapes and symlink escapes.
 */
export function normalizePath(
  workspaceRoot: string,
  inputPath: string,
): string {
  const pathModule = getPathModule(workspaceRoot, inputPath);
  const resolvedWorkspaceRoot = pathModule.resolve(workspaceRoot);
  const resolvedTarget = pathModule.resolve(resolvedWorkspaceRoot, inputPath);
  if (!isPathInsideWorkspaceBoundary(resolvedWorkspaceRoot, resolvedTarget)) {
    throw new PathEscapeError(inputPath);
  }
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
 * Check that a resolved path doesn't escape workspace via symlinks.
 * Returns the real path if safe, throws if it escapes.
 */
export async function checkSymlinkEscape(
  workspaceRoot: string,
  absolutePath: string,
): Promise<string> {
  const realRoot = await realpath(workspaceRoot);
  const realTarget = await realpath(absolutePath);
  if (!isPathInsideWorkspaceBoundary(realRoot, realTarget)) {
    throw new PathEscapeError(
      toWorkspaceDisplayPath(workspaceRoot, absolutePath),
    );
  }
  return realTarget;
}

/**
 * Reject mutating paths when any existing segment under workspace is a symlink.
 * This is stricter than read-time escape checks and intentionally fail-closed.
 *
 * - existing leaf symlink: rejected
 * - existing parent symlink: rejected
 * - missing leaf: allowed when `allowMissingLeaf` is true, as long as every
 *   existing ancestor beneath workspaceRoot is a real directory path
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
  const realRoot = await realpath(workspaceRoot);

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

    const realCurrent = await realpath(nextPath);
    if (!isPathInsideWorkspaceBoundary(realRoot, realCurrent)) {
      throw new PathEscapeError(
        toWorkspaceDisplayPath(workspaceRoot, nextPath),
      );
    }
    currentPath = realCurrent;
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
  code = 'path_out_of_workspace' as const;

  constructor(path: string) {
    super(`path escapes workspace: ${path}`);
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

export function isPathInsideWorkspaceBoundary(
  workspaceRoot: string,
  targetPath: string,
): boolean {
  const pathModule = getPathModule(workspaceRoot, targetPath);
  const normalizedWorkspaceRoot = normalizeBoundaryPath(
    pathModule.resolve(workspaceRoot),
    pathModule,
  );
  const normalizedTarget = normalizeBoundaryPath(
    pathModule.resolve(targetPath),
    pathModule,
  );
  return (
    normalizedTarget === normalizedWorkspaceRoot ||
    normalizedTarget.startsWith(normalizedWorkspaceRoot + pathModule.sep)
  );
}
