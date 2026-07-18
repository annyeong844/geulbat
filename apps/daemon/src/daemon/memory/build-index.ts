import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve, win32 } from 'node:path';
import { isPlainRecord, tryDecodeJson } from '../runtime-json.js';

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
import {
  isPathInsideComputerFileScope,
  resolveDerivedArtifactTarget,
} from '../files/file-platform.js';
import {
  GEULBAT_MEMORY_INDEX_RECORDS_PATH,
  GEULBAT_MEMORY_MANIFEST_PATH,
} from '../files/geulbat-internal-paths.js';
import { getErrorCode } from '../utils/error.js';
import { memoize } from '../utils/memoize.js';

const MANIFEST_RELATIVE = GEULBAT_MEMORY_MANIFEST_PATH;
const MEMORY_RELATIVE = GEULBAT_MEMORY_INDEX_RECORDS_PATH;
const MEMORY_INDEX_PATH = 'memory/all-memory.jsonl';
const WINDOWS_ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\)/u;

interface MemoryIndexStoreDeps {
  buildSourceSnapshot?: (sourceRoot: string) => Promise<SourceSnapshot>;
  createGenerationId?: () => string;
  writeIndexGeneration?: (
    stateRoot: string,
    manifest: MemoryManifest,
    records: MemoryChunkRecord[],
  ) => Promise<void>;
  readTextFile?: (path: string, encoding: 'utf8') => Promise<string>;
}

export interface MemoryIndexScope {
  stateRoot: string;
  sourceRoot: string;
}

export interface MemoryIndexStore {
  refreshMemoryIndex(scope: MemoryIndexScope): Promise<BuildMemoryIndexResult>;
  computeCurrentSourceSnapshot(
    sourceRoot: string,
  ): Promise<{ sourceIndexVersionToken: string }>;
  loadMemoryIndex(stateRoot: string): Promise<LoadedMemoryIndex>;
}

export function resolveMemoryIndexScope(args: {
  stateRoot?: string;
  computerFileRoot?: string;
  workingDirectory?: string;
}): MemoryIndexScope {
  const stateRoot = resolveRequiredAbsoluteRoot(
    args.stateRoot,
    'memory index Home state storage is unavailable',
    'execution_failed',
  );
  const computerFileRoot = resolveRequiredAbsoluteRoot(
    args.computerFileRoot,
    'memory index Computer file scope is unavailable',
    'access_denied',
  );
  if (args.workingDirectory === undefined) {
    throw createScopeError(
      'memory index working directory is unavailable',
      'access_denied',
    );
  }

  const pathModule = WINDOWS_ABSOLUTE_PATH.test(computerFileRoot)
    ? win32
    : undefined;
  const workingDirectoryIsAbsolute = pathModule
    ? pathModule.isAbsolute(args.workingDirectory)
    : isAbsolute(args.workingDirectory) ||
      win32.isAbsolute(args.workingDirectory);
  if (workingDirectoryIsAbsolute) {
    throw createScopeError(
      'memory index working directory must be relative to the Computer file scope',
      'access_denied',
    );
  }

  const sourceRoot = pathModule
    ? pathModule.resolve(computerFileRoot, args.workingDirectory || '.')
    : resolve(computerFileRoot, args.workingDirectory || '.');
  if (!isPathInsideComputerFileScope(computerFileRoot, sourceRoot)) {
    throw createScopeError(
      'memory index working directory escapes the Computer file scope',
      'access_denied',
    );
  }

  return { stateRoot, sourceRoot };
}

export function createMemoryIndexStore(
  deps?: MemoryIndexStoreDeps,
): MemoryIndexStore {
  const inFlightBuilds = new Map<
    string,
    { sourceRoot: string; promise: Promise<BuildMemoryIndexResult> }
  >();
  const buildSourceSnapshotFn =
    deps?.buildSourceSnapshot ?? buildSourceSnapshot;
  const createGenerationIdFn = deps?.createGenerationId ?? createGenerationId;
  const writeIndexGenerationFn =
    deps?.writeIndexGeneration ?? writeIndexGeneration;
  const readTextFile = deps?.readTextFile ?? readFile;
  const loadMemoryIndexFromCache = memoize((stateRoot: string) =>
    loadMemoryIndexFromDisk(stateRoot, readTextFile),
  );

  return {
    async refreshMemoryIndex(scope) {
      while (true) {
        const existing = inFlightBuilds.get(scope.stateRoot);
        if (!existing) {
          break;
        }
        if (existing.sourceRoot === scope.sourceRoot) {
          return existing.promise;
        }
        await existing.promise;
      }

      const promise = buildMemoryIndex(
        scope,
        buildSourceSnapshotFn,
        createGenerationIdFn,
        writeIndexGenerationFn,
      ).then((result) => {
        loadMemoryIndexFromCache.cache.delete(scope.stateRoot);
        return result;
      });
      const entry = { sourceRoot: scope.sourceRoot, promise };
      inFlightBuilds.set(scope.stateRoot, entry);
      try {
        return await promise;
      } finally {
        if (inFlightBuilds.get(scope.stateRoot) === entry) {
          inFlightBuilds.delete(scope.stateRoot);
        }
      }
    },
    async computeCurrentSourceSnapshot(sourceRoot) {
      const snapshot = await buildSourceSnapshotFn(sourceRoot);
      return { sourceIndexVersionToken: snapshot.sourceIndexVersionToken };
    },
    async loadMemoryIndex(stateRoot) {
      return loadMemoryIndexFromCache(stateRoot);
    },
  };
}

async function buildMemoryIndex(
  scope: MemoryIndexScope,
  buildSourceSnapshotFn: (sourceRoot: string) => Promise<SourceSnapshot>,
  createGenerationIdFn: () => string,
  writeIndexGenerationFn: (
    stateRoot: string,
    manifest: MemoryManifest,
    records: MemoryChunkRecord[],
  ) => Promise<void>,
): Promise<BuildMemoryIndexResult> {
  const sourceSnapshot = await buildSourceSnapshotFn(scope.sourceRoot);
  const generatedAt = new Date().toISOString();
  const generationId = createGenerationIdFn();
  const { manifestFiles, records } =
    collectManifestFilesAndRecords(sourceSnapshot);

  const manifest: MemoryManifest = {
    version: 2,
    generationId,
    generatedAt,
    sourceDirectory: scope.sourceRoot,
    sourceIndexVersionToken: sourceSnapshot.sourceIndexVersionToken,
    files: manifestFiles,
  };

  await writeIndexGenerationFn(scope.stateRoot, manifest, records);

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
  stateRoot: string,
  readTextFile: (path: string, encoding: 'utf8') => Promise<string>,
): Promise<LoadedMemoryIndex> {
  const { manifestRaw, memoryRaw } = await readMemoryIndexFiles(
    stateRoot,
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
    const fileRecords = createChunkRecords(file);
    records.push(...fileRecords);
    manifestFiles.push({
      path: file.path,
      sourceVersionToken: file.sourceVersionToken,
      indexPath: MEMORY_INDEX_PATH,
      chunkCount: fileRecords.length,
      updatedAt: file.updatedAt,
    });
  }

  return { manifestFiles, records };
}

async function readMemoryIndexFiles(
  stateRoot: string,
  readTextFile: (path: string, encoding: 'utf8') => Promise<string>,
): Promise<{ manifestRaw: string; memoryRaw: string }> {
  const [manifestTarget, memoryTarget] = await Promise.all([
    resolveDerivedArtifactTarget(
      stateRoot,
      'memory_index',
      'index/manifest.json',
      { mode: 'read', allowMissingLeaf: true },
    ),
    resolveDerivedArtifactTarget(
      stateRoot,
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
    if (!line.trim()) {
      continue;
    }
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
  if (record.version !== 2) {
    throw new Error('invalid memory manifest');
  }
  if (
    typeof record.generationId !== 'string' ||
    typeof record.generatedAt !== 'string' ||
    typeof record.sourceDirectory !== 'string' ||
    typeof record.sourceIndexVersionToken !== 'string' ||
    !Array.isArray(record.files)
  ) {
    throw new Error('invalid memory manifest');
  }

  return {
    version: 2,
    generationId: record.generationId,
    generatedAt: record.generatedAt,
    sourceDirectory: record.sourceDirectory,
    sourceIndexVersionToken: record.sourceIndexVersionToken,
    files: record.files.map(parseMemoryManifestFile),
  };
}

function resolveRequiredAbsoluteRoot(
  value: string | undefined,
  message: string,
  code: 'access_denied' | 'execution_failed',
): string {
  if (!value?.trim()) {
    throw createScopeError(message, code);
  }
  if (WINDOWS_ABSOLUTE_PATH.test(value)) {
    return win32.resolve(value);
  }
  if (!isAbsolute(value)) {
    throw createScopeError(message, code);
  }
  return resolve(value);
}

function createScopeError(
  message: string,
  code: 'access_denied' | 'execution_failed',
): Error & { code: 'access_denied' | 'execution_failed' } {
  return Object.assign(new Error(message), { code });
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
