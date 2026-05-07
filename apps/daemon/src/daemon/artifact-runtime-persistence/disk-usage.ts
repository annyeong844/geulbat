import { readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { isNotFoundError } from '../utils/error.js';
import { classifyRuntimePersistenceError } from './errors.js';

export async function readRuntimePersistenceTotalBytes(
  storageRoot: string,
): Promise<number> {
  return sumDirectoryBytes(storageRoot);
}

async function sumDirectoryBytes(
  directory: string,
  visitedRealDirectories = new Set<string>(),
): Promise<number> {
  try {
    const realDirectory = await realpath(directory);
    if (visitedRealDirectories.has(realDirectory)) {
      return 0;
    }
    visitedRealDirectories.add(realDirectory);

    const entries = await readdir(realDirectory, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      const fullPath = join(realDirectory, entry.name);
      let stats;
      try {
        stats = await stat(fullPath);
      } catch (error: unknown) {
        if (isNotFoundError(error)) {
          continue;
        }
        throw error;
      }
      if (stats.isDirectory()) {
        total += await sumDirectoryBytes(fullPath, visitedRealDirectories);
        continue;
      }
      if (!stats.isFile()) {
        continue;
      }
      total += stats.size;
    }
    return total;
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return 0;
    }
    throw classifyRuntimePersistenceError(
      'runtime persistence usage scan failed',
      error,
    );
  }
}
