import fs from 'node:fs/promises';
import { getErrorCode } from './error.js';

const DEFAULT_MAX_FILE_STATE_CACHE_ENTRIES = 100;
const DEFAULT_MAX_FILE_STATE_CACHE_BYTES = 25 * 1024 * 1024;

type FileStateCacheFs = Pick<typeof fs, 'realpath' | 'stat'>;

interface FileStateCacheEntry {
  content: string;
  mtime: number;
  sizeBytes: number;
}

interface FileStateCacheStats {
  entryCount: number;
  totalBytes: number;
  maxEntries: number;
  maxTotalBytes: number;
}

export interface FileStateCache {
  read(
    path: string,
    loadContent: (canonicalAbsolutePath: string) => Promise<string>,
  ): Promise<string>;
  invalidatePath(path: string): Promise<void>;
  invalidateCacheKey(canonicalAbsolutePath: string): void;
  clear(): void;
  getStats(): FileStateCacheStats;
}

interface FileStateCacheOptions {
  maxEntries?: number;
  maxTotalBytes?: number;
  fs?: FileStateCacheFs;
}

export function createFileStateCache(
  options: FileStateCacheOptions = {},
): FileStateCache {
  const cacheFs = options.fs ?? fs;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_FILE_STATE_CACHE_ENTRIES;
  const maxTotalBytes =
    options.maxTotalBytes ?? DEFAULT_MAX_FILE_STATE_CACHE_BYTES;
  const entries = new Map<string, FileStateCacheEntry>();
  let totalBytes = 0;

  function deleteCacheKey(canonicalAbsolutePath: string): void {
    const existing = entries.get(canonicalAbsolutePath);
    if (!existing) {
      return;
    }
    entries.delete(canonicalAbsolutePath);
    totalBytes -= existing.sizeBytes;
  }

  function touchCacheKey(
    canonicalAbsolutePath: string,
    entry: FileStateCacheEntry,
  ): void {
    entries.delete(canonicalAbsolutePath);
    entries.set(canonicalAbsolutePath, entry);
  }

  function evictOverflow(): void {
    while (
      entries.size > maxEntries ||
      (entries.size > 0 && totalBytes > maxTotalBytes)
    ) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) {
        return;
      }
      deleteCacheKey(oldestKey);
    }
  }

  function storeEntry(
    canonicalAbsolutePath: string,
    content: string,
    mtime: number,
  ): void {
    const sizeBytes = Buffer.byteLength(content);
    if (maxEntries < 1 || maxTotalBytes < 1 || sizeBytes > maxTotalBytes) {
      deleteCacheKey(canonicalAbsolutePath);
      return;
    }

    deleteCacheKey(canonicalAbsolutePath);
    entries.set(canonicalAbsolutePath, {
      content,
      mtime,
      sizeBytes,
    });
    totalBytes += sizeBytes;
    evictOverflow();
  }

  return {
    async read(path, loadContent) {
      const canonicalAbsolutePath = await cacheFs.realpath(path);
      const currentStat = await cacheFs.stat(canonicalAbsolutePath);
      const cached = entries.get(canonicalAbsolutePath);
      if (cached && cached.mtime === currentStat.mtimeMs) {
        touchCacheKey(canonicalAbsolutePath, cached);
        return cached.content;
      }

      const content = await loadContent(canonicalAbsolutePath);
      storeEntry(canonicalAbsolutePath, content, currentStat.mtimeMs);
      return content;
    },
    async invalidatePath(path) {
      try {
        deleteCacheKey(await cacheFs.realpath(path));
      } catch (error: unknown) {
        const code = getErrorCode(error);
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          // Missing paths were never readable cache keys for this primitive.
          return;
        }
        throw error;
      }
    },
    invalidateCacheKey: deleteCacheKey,
    clear() {
      entries.clear();
      totalBytes = 0;
    },
    getStats() {
      return {
        entryCount: entries.size,
        totalBytes,
        maxEntries,
        maxTotalBytes,
      };
    },
  };
}
