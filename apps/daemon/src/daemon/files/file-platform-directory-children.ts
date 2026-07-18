import type { Dirent } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

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
    const resolvedChild = await resolveEnumeratedChild(
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
  parentCanonicalPath: string,
  relativePath: string,
  entry: Dirent,
): Promise<EnumeratedCanonicalChild | null> {
  const fullPath = join(parentCanonicalPath, entry.name);

  if (entry.isSymbolicLink()) {
    try {
      const realTarget = await realpath(fullPath);
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
    return {
      name: entry.name,
      relativePath,
      // The parent is already canonical and Dirent proved this child is not a
      // symlink. Joining the name therefore preserves the canonical target
      // without another realpath syscall per directory entry.
      canonicalAbsolutePath: fullPath,
      type: 'directory',
      viaSymlink: false,
    };
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
