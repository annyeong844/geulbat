import { readFile } from 'node:fs/promises';
import { isPlainRecord, tryDecodeJson } from '@geulbat/protocol/runtime-utils';

import { createChunkRecords } from './chunk-file.js';
import { buildSourceSnapshot, type SourceSnapshot } from './source-snapshot.js';
import {
  createGenerationId,
  writeIndexGeneration,
} from './index-generation.js';
import type {
  BuildMemoryIndexResult,
  LoadedMemoryIndex,
  MemoryChunkRecord,
  MemoryManifest,
  MemoryManifestFile,
} from './types.js';
import { resolveDerivedArtifactTarget } from '../files/file-platform.js';
import {
  GEULBAT_MEMORY_INDEX_RECORDS_PATH,
  GEULBAT_MEMORY_MANIFEST_PATH,
} from '../files/geulbat-internal-paths.js';
import { getErrorCode } from '../utils/error.js';
import { memoize } from '../utils/memoize.js';

const MANIFEST_RELATIVE = GEULBAT_MEMORY_MANIFEST_PATH;
const MEMORY_RELATIVE = GEULBAT_MEMORY_INDEX_RECORDS_PATH;
const MEMORY_INDEX_PATH = 'memory/all-memory.jsonl';
const MAX_TOTAL_CHUNKS = 10_000;

interface MemoryIndexStoreDeps {
  buildSourceSnapshot?: (workspaceRoot: string) => Promise<SourceSnapshot>;
  createGenerationId?: () => string;
  writeIndexGeneration?: (
    workspaceRoot: string,
    manifest: MemoryManifest,
    records: MemoryChunkRecord[],
  ) => Promise<void>;
  readTextFile?: (path: string, encoding: 'utf8') => Promise<string>;
}

export interface MemoryIndexStore {
  refreshMemoryIndex(
    workspaceRoot: string,
    projectId?: string,
  ): Promise<BuildMemoryIndexResult>;
  computeCurrentSourceSnapshot(
    workspaceRoot: string,
  ): Promise<{ sourceIndexVersionToken: string }>;
  loadMemoryIndex(workspaceRoot: string): Promise<LoadedMemoryIndex>;
}

export function createMemoryIndexStore(
  deps?: MemoryIndexStoreDeps,
): MemoryIndexStore {
  const inFlightBuilds = new Map<string, Promise<BuildMemoryIndexResult>>();
  const buildSourceSnapshotFn =
    deps?.buildSourceSnapshot ?? buildSourceSnapshot;
  const createGenerationIdFn = deps?.createGenerationId ?? createGenerationId;
  const writeIndexGenerationFn =
    deps?.writeIndexGeneration ?? writeIndexGeneration;
  const readTextFile = deps?.readTextFile ?? readFile;
  const loadMemoryIndexFromCache = memoize((workspaceRoot: string) =>
    loadMemoryIndexFromDisk(workspaceRoot, readTextFile),
  );

  return {
    async refreshMemoryIndex(workspaceRoot, projectId = 'workspace') {
      const existing = inFlightBuilds.get(workspaceRoot);
      if (existing) {
        return existing;
      }

      const promise = buildMemoryIndex(
        workspaceRoot,
        projectId,
        buildSourceSnapshotFn,
        createGenerationIdFn,
        writeIndexGenerationFn,
      )
        .then((result) => {
          loadMemoryIndexFromCache.cache.delete(workspaceRoot);
          return result;
        })
        .finally(() => {
          inFlightBuilds.delete(workspaceRoot);
        });
      inFlightBuilds.set(workspaceRoot, promise);
      return promise;
    },
    async computeCurrentSourceSnapshot(workspaceRoot) {
      const snapshot = await buildSourceSnapshotFn(workspaceRoot);
      return { sourceIndexVersionToken: snapshot.sourceIndexVersionToken };
    },
    async loadMemoryIndex(workspaceRoot) {
      return loadMemoryIndexFromCache(workspaceRoot);
    },
  };
}

async function buildMemoryIndex(
  workspaceRoot: string,
  projectId: string,
  buildSourceSnapshotFn: (workspaceRoot: string) => Promise<SourceSnapshot>,
  createGenerationIdFn: () => string,
  writeIndexGenerationFn: (
    workspaceRoot: string,
    manifest: MemoryManifest,
    records: MemoryChunkRecord[],
  ) => Promise<void>,
): Promise<BuildMemoryIndexResult> {
  const sourceSnapshot = await buildSourceSnapshotFn(workspaceRoot);
  const generatedAt = new Date().toISOString();
  const generationId = createGenerationIdFn();
  const { manifestFiles, records } =
    collectManifestFilesAndRecords(sourceSnapshot);

  const manifest: MemoryManifest = {
    version: 1,
    generationId,
    generatedAt,
    sourceProjectId: projectId,
    sourceIndexVersionToken: sourceSnapshot.sourceIndexVersionToken,
    files: manifestFiles,
  };

  await writeIndexGenerationFn(workspaceRoot, manifest, records);

  return {
    generationId,
    generatedAt,
    fileCount: manifest.files.length,
    chunkCount: records.length,
    manifestPath: MANIFEST_RELATIVE,
    memoryPath: MEMORY_RELATIVE,
  };
}

async function loadMemoryIndexFromDisk(
  workspaceRoot: string,
  readTextFile: (path: string, encoding: 'utf8') => Promise<string>,
): Promise<LoadedMemoryIndex> {
  const { manifestRaw, memoryRaw } = await readMemoryIndexFiles(
    workspaceRoot,
    readTextFile,
  );

  const manifestResult = tryDecodeJson(manifestRaw, parseMemoryManifest);
  if (!manifestResult.ok) {
    throw Object.assign(new Error('invalid memory manifest'), {
      code: 'execution_failed',
    });
  }
  const manifest = manifestResult.value;
  const records = parseMemoryChunkRecords(memoryRaw);

  return { manifest, records };
}

function collectManifestFilesAndRecords(sourceSnapshot: SourceSnapshot): {
  manifestFiles: MemoryManifestFile[];
  records: MemoryChunkRecord[];
} {
  const manifestFiles: MemoryManifestFile[] = [];
  const records: MemoryChunkRecord[] = [];

  for (const file of sourceSnapshot.files) {
    const fileRecords = createChunkRecords(
      file,
      MAX_TOTAL_CHUNKS - records.length,
    );
    records.push(...fileRecords);
    manifestFiles.push({
      path: file.path,
      sourceVersionToken: file.sourceVersionToken,
      indexPath: MEMORY_INDEX_PATH,
      chunkCount: fileRecords.length,
      updatedAt: file.updatedAt,
    });

    if (records.length >= MAX_TOTAL_CHUNKS) {
      break;
    }
  }

  return { manifestFiles, records };
}

async function readMemoryIndexFiles(
  workspaceRoot: string,
  readTextFile: (path: string, encoding: 'utf8') => Promise<string>,
): Promise<{ manifestRaw: string; memoryRaw: string }> {
  const [manifestTarget, memoryTarget] = await Promise.all([
    resolveDerivedArtifactTarget(
      workspaceRoot,
      'memory_index',
      'index/manifest.json',
      { mode: 'read', allowMissingLeaf: true },
    ),
    resolveDerivedArtifactTarget(
      workspaceRoot,
      'memory_index',
      'index/memory/all-memory.jsonl',
      { mode: 'read', allowMissingLeaf: true },
    ),
  ]);

  try {
    const [manifestRaw, memoryRaw] = await Promise.all([
      readTextFile(manifestTarget.absolutePath, 'utf8'),
      readTextFile(memoryTarget.absolutePath, 'utf8'),
    ]);
    return { manifestRaw, memoryRaw };
  } catch (error: unknown) {
    const code = getErrorCode(error);
    if (code === 'ENOENT') {
      throw Object.assign(new Error('memory index not ready'), {
        code: 'index_not_ready',
      });
    }
    throw error;
  }
}

function parseMemoryChunkRecords(memoryRaw: string): MemoryChunkRecord[] {
  const records: MemoryChunkRecord[] = [];
  for (const line of memoryRaw.split('\n')) {
    if (!line.trim()) continue;
    const parsedRecord = tryDecodeJson(line, parseMemoryChunkRecord);
    if (!parsedRecord.ok) {
      throw Object.assign(new Error('invalid memory index jsonl'), {
        code: 'execution_failed',
      });
    }
    records.push(parsedRecord.value);
  }
  return records;
}

function parseMemoryManifest(value: unknown): MemoryManifest {
  if (!isPlainRecord(value)) {
    throw new Error('invalid memory manifest');
  }

  const record = value;
  if (record.version !== 1) {
    throw new Error('invalid memory manifest');
  }
  if (
    typeof record.generationId !== 'string' ||
    typeof record.generatedAt !== 'string' ||
    typeof record.sourceProjectId !== 'string' ||
    typeof record.sourceIndexVersionToken !== 'string' ||
    !Array.isArray(record.files)
  ) {
    throw new Error('invalid memory manifest');
  }

  return {
    version: 1,
    generationId: record.generationId,
    generatedAt: record.generatedAt,
    sourceProjectId: record.sourceProjectId,
    sourceIndexVersionToken: record.sourceIndexVersionToken,
    files: record.files.map(parseMemoryManifestFile),
  };
}

function parseMemoryManifestFile(value: unknown): MemoryManifestFile {
  if (!isPlainRecord(value)) {
    throw new Error('invalid memory manifest');
  }
  const record = value;
  if (
    typeof record.path !== 'string' ||
    typeof record.sourceVersionToken !== 'string' ||
    typeof record.indexPath !== 'string' ||
    typeof record.updatedAt !== 'string' ||
    typeof record.chunkCount !== 'number' ||
    !Number.isInteger(record.chunkCount) ||
    record.chunkCount < 0
  ) {
    throw new Error('invalid memory manifest');
  }
  return {
    path: record.path,
    sourceVersionToken: record.sourceVersionToken,
    indexPath: record.indexPath,
    chunkCount: record.chunkCount,
    updatedAt: record.updatedAt,
  };
}

function parseMemoryChunkRecord(value: unknown): MemoryChunkRecord {
  if (!isPlainRecord(value)) {
    throw new Error('invalid memory index jsonl');
  }
  const record = value;
  if (
    typeof record.chunkId !== 'string' ||
    typeof record.path !== 'string' ||
    typeof record.sourceVersionToken !== 'string' ||
    typeof record.title !== 'string' ||
    typeof record.excerpt !== 'string' ||
    typeof record.searchText !== 'string' ||
    typeof record.lineStart !== 'number' ||
    !Number.isInteger(record.lineStart) ||
    record.lineStart < 1 ||
    typeof record.lineEnd !== 'number' ||
    !Number.isInteger(record.lineEnd) ||
    record.lineEnd < record.lineStart
  ) {
    throw new Error('invalid memory index jsonl');
  }
  return {
    chunkId: record.chunkId,
    path: record.path,
    sourceVersionToken: record.sourceVersionToken,
    title: record.title,
    lineStart: record.lineStart,
    lineEnd: record.lineEnd,
    excerpt: record.excerpt,
    searchText: record.searchText,
  };
}
