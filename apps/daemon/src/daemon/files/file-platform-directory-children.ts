import type { Dirent } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { isPathInsideWorkspaceBoundary } from './normalize-path.js';
import { isReservedPath } from './reserved-paths.js';
import type {
  CanonicalDirectoryTarget,
  EnumeratedCanonicalChild,
} from './file-platform-target-types.js';
import { getErrorCode } from '../utils/error.js';

export async function enumerateCanonicalChildren(
  target: CanonicalDirectoryTarget,
): Promise<EnumeratedCanonicalChild[]> {
  const entries = await readdir(target.canonicalAbsolutePath, {
    withFileTypes: true,
  });
  const children: EnumeratedCanonicalChild[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relativePath =
      target.relativePath === '.'
        ? entry.name
        : `${target.relativePath}/${entry.name}`;
    if (target.kind === 'source' && isReservedPath(relativePath)) {
      continue;
    }

    const resolvedChild = await resolveEnumeratedChild(
      target.workspaceCanonicalRoot,
      target.canonicalAbsolutePath,
      relativePath,
      entry,
    );
    if (!resolvedChild) {
      continue;
    }
    children.push(resolvedChild);
  }

  return children;
}

async function resolveEnumeratedChild(
  workspaceCanonicalRoot: string,
  parentCanonicalPath: string,
  relativePath: string,
  entry: Dirent,
): Promise<EnumeratedCanonicalChild | null> {
  const fullPath = join(parentCanonicalPath, entry.name);

  if (entry.isSymbolicLink()) {
    try {
      const realTarget = await realpath(fullPath);
      if (!isPathInsideWorkspaceBoundary(workspaceCanonicalRoot, realTarget)) {
        return null;
      }
      const stats = await lstat(realTarget);
      if (stats.isDirectory()) {
        return {
          name: entry.name,
          relativePath,
          canonicalAbsolutePath: realTarget,
          type: 'directory',
          viaSymlink: true,
        };
      }
      if (stats.isFile()) {
        return {
          name: entry.name,
          relativePath,
          canonicalAbsolutePath: realTarget,
          type: 'file',
          viaSymlink: true,
        };
      }
      return null;
    } catch (error: unknown) {
      const code = getErrorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return null;
      }
      throw error;
    }
  }

  if (entry.isDirectory()) {
    try {
      const realTarget = await realpath(fullPath);
      if (!isPathInsideWorkspaceBoundary(workspaceCanonicalRoot, realTarget)) {
        return null;
      }
      return {
        name: entry.name,
        relativePath,
        canonicalAbsolutePath: realTarget,
        type: 'directory',
        viaSymlink: false,
      };
    } catch (error: unknown) {
      const code = getErrorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return null;
      }
      throw error;
    }
  }

  if (entry.isFile()) {
    return {
      name: entry.name,
      relativePath,
      canonicalAbsolutePath: fullPath,
      type: 'file',
      viaSymlink: false,
    };
  }

  return null;
}
