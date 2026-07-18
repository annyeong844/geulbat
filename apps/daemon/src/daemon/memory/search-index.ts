import { basename, extname } from 'node:path';
import { resolveSourceDirectoryTarget } from '../files/file-platform.js';
import type { MemoryIndexScope, MemoryIndexStore } from './build-index.js';
import type { MemoryChunkRecord } from './types.js';

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
  scope: MemoryIndexScope,
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
    scope.sourceRoot,
    args.pathPrefix,
  );
  const maxResults = normalizeMaxResults(args.maxResults);
  const loweredQuery = query.toLocaleLowerCase();

  const memoryIndex = options.memoryIndex;
  const { manifest, records } = await memoryIndex.loadMemoryIndex(
    scope.stateRoot,
  );
  if (manifest.sourceDirectory !== scope.sourceRoot) {
    throw Object.assign(
      new Error('memory index not ready for the current working directory'),
      { code: 'index_not_ready' },
    );
  }
  const snapshot = await memoryIndex.computeCurrentSourceSnapshot(
    scope.sourceRoot,
  );
  const stale =
    snapshot.sourceIndexVersionToken !== manifest.sourceIndexVersionToken;

  const matches: Array<{ record: MemoryChunkRecord; titleHit: boolean }> = [];
  for (const record of records) {
    if (!matchesPathPrefix(record, pathPrefix)) {
      continue;
    }

    const titleLower = record.title.toLocaleLowerCase();
    const titleHit = titleLower.includes(loweredQuery);
    if (
      !titleHit &&
      !record.searchText.toLocaleLowerCase().includes(loweredQuery)
    ) {
      continue;
    }

    matches.push({ record, titleHit });
  }

  matches.sort((a, b) => {
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
    truncated: maxResults !== undefined && matches.length > maxResults,
    results: (maxResults === undefined
      ? matches
      : matches.slice(0, maxResults)
    ).map(({ record }) => toSearchResult(record)),
  };
}

async function normalizeOptionalPathPrefix(
  sourceRoot: string,
  value: string | undefined,
): Promise<string | undefined> {
  if (value == null) {
    return undefined;
  }
  if (String(value).trim() === '') {
    throw Object.assign(new Error('pathPrefix must not be empty.'), {
      code: 'invalid_args',
    });
  }
  const normalizedTarget = await resolveSourceDirectoryTarget(
    sourceRoot,
    String(value),
  );
  return normalizedTarget.relativePath === '.'
    ? undefined
    : normalizedTarget.relativePath;
}

function normalizeMaxResults(value: number | undefined): number | undefined {
  if (value == null) {
    return undefined;
  }
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 1) {
    throw Object.assign(new Error('maxResults must be a positive integer.'), {
      code: 'invalid_args',
    });
  }
  return numeric;
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
