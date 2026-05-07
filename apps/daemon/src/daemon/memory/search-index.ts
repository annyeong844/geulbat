import { basename, extname } from 'node:path';
import { resolveSourceDirectoryTarget } from '../files/file-platform.js';
import type { MemoryIndexStore } from './build-index.js';
import type { MemoryChunkRecord } from './types.js';

const DEFAULT_MAX_RESULTS = 10;
const MAX_MAX_RESULTS = 50;

interface SearchMemoryIndexResult {
  ok: true;
  generationId: string;
  indexGeneratedAt: string;
  sourceIndexVersionToken: string;
  stale: boolean;
  total: number;
  truncated: boolean;
  results: Array<{
    chunkId: string;
    path: string;
    sourceVersionToken: string;
    title: string;
    lineStart: number;
    lineEnd: number;
    excerpt: string;
  }>;
}

export async function searchMemoryIndex(
  workspaceRoot: string,
  args: {
    query: string;
    pathPrefix?: string;
    maxResults?: number;
  },
  options: {
    memoryIndex: Pick<
      MemoryIndexStore,
      'computeCurrentSourceSnapshot' | 'loadMemoryIndex'
    >;
  },
): Promise<SearchMemoryIndexResult> {
  const query = String(args.query ?? '').trim();
  if (!query) {
    throw Object.assign(new Error('query must be a non-empty string.'), {
      code: 'invalid_args',
    });
  }

  const pathPrefix = await normalizeOptionalPathPrefix(
    workspaceRoot,
    args.pathPrefix,
  );
  const maxResults = normalizeMaxResults(args.maxResults);
  const loweredQuery = query.toLocaleLowerCase();

  const memoryIndex = options.memoryIndex;
  const { manifest, records } =
    await memoryIndex.loadMemoryIndex(workspaceRoot);
  const snapshot =
    await memoryIndex.computeCurrentSourceSnapshot(workspaceRoot);
  const stale =
    snapshot.sourceIndexVersionToken !== manifest.sourceIndexVersionToken;

  const matches = records
    .filter((record) => matchesPathPrefix(record, pathPrefix))
    .filter(
      (record) =>
        record.title.toLocaleLowerCase().includes(loweredQuery) ||
        record.searchText.toLocaleLowerCase().includes(loweredQuery),
    )
    .map((record) => ({
      record,
      titleHit: record.title.toLocaleLowerCase().includes(loweredQuery),
    }))
    .sort((a, b) => {
      if (a.titleHit !== b.titleHit) {
        return a.titleHit ? -1 : 1;
      }
      return (
        a.record.path.localeCompare(b.record.path) ||
        a.record.lineStart - b.record.lineStart
      );
    });

  return {
    ok: true,
    generationId: manifest.generationId,
    indexGeneratedAt: manifest.generatedAt,
    sourceIndexVersionToken: manifest.sourceIndexVersionToken,
    stale,
    total: matches.length,
    truncated: matches.length > maxResults,
    results: matches
      .slice(0, maxResults)
      .map(({ record }) => toSearchResult(record)),
  };
}

async function normalizeOptionalPathPrefix(
  workspaceRoot: string,
  value: string | undefined,
): Promise<string | undefined> {
  if (value == null || String(value).trim() === '') {
    return undefined;
  }
  const normalizedTarget = await resolveSourceDirectoryTarget(
    workspaceRoot,
    String(value),
  );
  return normalizedTarget.relativePath === '.'
    ? undefined
    : normalizedTarget.relativePath;
}

function normalizeMaxResults(value: number | undefined): number {
  if (value == null) {
    return DEFAULT_MAX_RESULTS;
  }
  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric) || numeric < 1) {
    throw Object.assign(new Error('maxResults must be a positive integer.'), {
      code: 'invalid_args',
    });
  }
  return Math.min(numeric, MAX_MAX_RESULTS);
}

function matchesPathPrefix(
  record: MemoryChunkRecord,
  pathPrefix: string | undefined,
): boolean {
  if (!pathPrefix) {
    return true;
  }
  return record.path === pathPrefix || record.path.startsWith(`${pathPrefix}/`);
}

function toSearchResult(record: MemoryChunkRecord) {
  return {
    chunkId: record.chunkId,
    path: record.path,
    sourceVersionToken: record.sourceVersionToken,
    title: record.title || deriveFallbackTitle(record.path),
    lineStart: record.lineStart,
    lineEnd: record.lineEnd,
    excerpt: record.excerpt,
  };
}

function deriveFallbackTitle(relativePath: string): string {
  const fileName = basename(relativePath);
  const ext = extname(fileName);
  return ext ? fileName.slice(0, -ext.length) : fileName;
}
