import type { ToolSdkJsonValue } from './contracts.js';

export interface ReadFileInput {
  path: string;
  offset?: number;
  limit: number;
}

export interface ReadFileOutput {
  path: string;
  content: string;
  versionToken: string;
  totalLines: number;
  pageLimit: number;
  startLine: number;
  endLine: number;
  hasMore: boolean;
  nextOffset: number | null;
}

export interface ListFilesInput {
  path?: string;
  recursive?: boolean;
  maxDepth?: number;
  excludeNames?: string[];
  entryTypes?: Array<'file' | 'directory'>;
}

export interface ListFilesEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
}

export interface ListFilesOutput {
  path: string;
  total: number;
  entries: ListFilesEntry[];
}

export type SearchFilesType = 'content' | 'filename';
export type SearchFilesConsistency = 'filesystem_snapshot' | 'eventual_index';
export type SearchFilesTotalRelation = 'exact' | 'lower_bound';

export interface SearchFilesInput {
  pattern: string;
  path?: string;
  type?: SearchFilesType;
  include?: string;
  maxResults?: number;
  consistency?: SearchFilesConsistency;
}

export interface SearchFilesMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchFilesOutput {
  path: string;
  type: SearchFilesType;
  consistency: SearchFilesConsistency;
  total: number;
  totalRelation: SearchFilesTotalRelation;
  truncated: boolean;
  results: SearchFilesMatch[];
}

type FileInputResult<Input> =
  | { ok: true; value: Input }
  | { ok: false; message: string };

export function readReadFileInput(
  value: unknown,
): FileInputResult<ReadFileInput> {
  if (!isRecord(value)) {
    return { ok: false, message: 'input must be an object' };
  }
  const path = value['path'];
  const limit = value['limit'];
  const offset = value['offset'];
  if (typeof path !== 'string' || path.trim().length === 0) {
    return { ok: false, message: 'path must be a non-empty string' };
  }
  if (!isPositiveSafeInteger(limit)) {
    return { ok: false, message: 'limit must be a positive safe integer' };
  }
  if (offset !== undefined && !isNonNegativeSafeInteger(offset)) {
    return {
      ok: false,
      message: 'offset must be a non-negative safe integer',
    };
  }
  return {
    ok: true,
    value: offset === undefined ? { path, limit } : { path, limit, offset },
  };
}

export function encodeReadFileInput(
  input: ReadFileInput,
): Record<string, ToolSdkJsonValue> {
  return input.offset === undefined
    ? { path: input.path, limit: input.limit }
    : { path: input.path, limit: input.limit, offset: input.offset };
}

export function parseReadFileOutput(
  value: unknown,
  requestedLimit: number,
): ReadFileOutput | null {
  if (!isRecord(value)) {
    return null;
  }
  const path = value['path'];
  const content = value['content'];
  const versionToken = value['versionToken'];
  const totalLines = value['totalLines'];
  const pageLimit = value['pageLimit'];
  const startLine = value['startLine'];
  const endLine = value['endLine'];
  const hasMore = value['hasMore'];
  const nextOffset = value['nextOffset'];
  if (
    typeof path !== 'string' ||
    typeof content !== 'string' ||
    typeof versionToken !== 'string' ||
    !isNonNegativeSafeInteger(totalLines) ||
    !isPositiveSafeInteger(pageLimit) ||
    pageLimit !== requestedLimit ||
    !isPositiveSafeInteger(startLine) ||
    !isNonNegativeSafeInteger(endLine) ||
    typeof hasMore !== 'boolean' ||
    (nextOffset !== null && !isNonNegativeSafeInteger(nextOffset)) ||
    (hasMore && nextOffset === null) ||
    (!hasMore && nextOffset !== null)
  ) {
    return null;
  }
  return {
    path,
    content,
    versionToken,
    totalLines,
    pageLimit,
    startLine,
    endLine,
    hasMore,
    nextOffset,
  };
}

export function readListFilesInput(
  value: unknown,
): FileInputResult<ListFilesInput> {
  if (!isRecord(value)) {
    return { ok: false, message: 'input must be an object' };
  }
  const path = value['path'];
  const recursive = value['recursive'];
  const maxDepth = value['maxDepth'];
  const excludeNames = value['excludeNames'];
  const entryTypes = value['entryTypes'];
  let decodedExcludeNames: string[] | undefined;
  let decodedEntryTypes: Array<'file' | 'directory'> | undefined;
  if (
    path !== undefined &&
    (typeof path !== 'string' || path.trim().length === 0)
  ) {
    return { ok: false, message: 'path must be a non-empty string' };
  }
  if (recursive !== undefined && typeof recursive !== 'boolean') {
    return { ok: false, message: 'recursive must be a boolean' };
  }
  if (maxDepth !== undefined && !isPositiveSafeInteger(maxDepth)) {
    return { ok: false, message: 'maxDepth must be a positive integer' };
  }
  if (maxDepth !== undefined && recursive !== true) {
    return { ok: false, message: 'maxDepth requires recursive to be true' };
  }
  if (excludeNames !== undefined) {
    if (!Array.isArray(excludeNames)) {
      return {
        ok: false,
        message: 'excludeNames must be an array of non-empty strings',
      };
    }
    decodedExcludeNames = [];
    for (const entry of excludeNames as unknown[]) {
      if (typeof entry !== 'string' || entry.trim().length === 0) {
        return {
          ok: false,
          message: 'excludeNames must be an array of non-empty strings',
        };
      }
      decodedExcludeNames.push(entry);
    }
  }
  if (entryTypes !== undefined) {
    if (!Array.isArray(entryTypes) || entryTypes.length === 0) {
      return {
        ok: false,
        message:
          'entryTypes must be a non-empty array containing file or directory',
      };
    }
    decodedEntryTypes = [];
    for (const entry of entryTypes as unknown[]) {
      if (entry !== 'file' && entry !== 'directory') {
        return {
          ok: false,
          message:
            'entryTypes must be a non-empty array containing file or directory',
        };
      }
      decodedEntryTypes.push(entry);
    }
  }
  return {
    ok: true,
    value: {
      ...(path === undefined ? {} : { path }),
      ...(recursive === undefined ? {} : { recursive }),
      ...(maxDepth === undefined ? {} : { maxDepth }),
      ...(decodedExcludeNames === undefined
        ? {}
        : { excludeNames: decodedExcludeNames }),
      ...(decodedEntryTypes === undefined
        ? {}
        : { entryTypes: decodedEntryTypes }),
    },
  };
}

export function encodeListFilesInput(
  input: ListFilesInput,
): Record<string, ToolSdkJsonValue> {
  return {
    path: input.path ?? '.',
    recursive: input.recursive ?? false,
    ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
    ...(input.excludeNames === undefined
      ? {}
      : { excludeNames: [...input.excludeNames] }),
    ...(input.entryTypes === undefined
      ? {}
      : { entryTypes: [...input.entryTypes] }),
  };
}

export function parseListFilesOutput(value: unknown): ListFilesOutput | null {
  if (!isRecord(value)) {
    return null;
  }
  const path = value['path'];
  const total = value['total'];
  const rawEntries = value['entries'];
  if (
    typeof path !== 'string' ||
    !isNonNegativeSafeInteger(total) ||
    !Array.isArray(rawEntries) ||
    rawEntries.length !== total
  ) {
    return null;
  }
  const entries: ListFilesEntry[] = [];
  for (const rawEntry of rawEntries) {
    if (!isRecord(rawEntry)) {
      return null;
    }
    const name = rawEntry['name'];
    const entryPath = rawEntry['path'];
    const type = rawEntry['type'];
    if (
      typeof name !== 'string' ||
      typeof entryPath !== 'string' ||
      (type !== 'file' && type !== 'directory')
    ) {
      return null;
    }
    entries.push({ name, path: entryPath, type });
  }
  return { path, total, entries };
}

export function readSearchFilesInput(
  value: unknown,
): FileInputResult<SearchFilesInput> {
  if (!isRecord(value)) {
    return { ok: false, message: 'input must be an object' };
  }
  const pattern = value['pattern'];
  const path = value['path'];
  const type = value['type'];
  const include = value['include'];
  const maxResults = value['maxResults'];
  const consistency = value['consistency'];
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return { ok: false, message: 'pattern must be a non-empty string' };
  }
  if (
    path !== undefined &&
    (typeof path !== 'string' || path.trim().length === 0)
  ) {
    return { ok: false, message: 'path must be a non-empty string' };
  }
  if (type !== undefined && type !== 'content' && type !== 'filename') {
    return { ok: false, message: 'type must be content or filename' };
  }
  if (include !== undefined && typeof include !== 'string') {
    return { ok: false, message: 'include must be a string' };
  }
  if (maxResults !== undefined && !isPositiveSafeInteger(maxResults)) {
    return {
      ok: false,
      message: 'maxResults must be a positive safe integer',
    };
  }
  if (
    consistency !== undefined &&
    consistency !== 'filesystem_snapshot' &&
    consistency !== 'eventual_index'
  ) {
    return {
      ok: false,
      message: 'consistency must be filesystem_snapshot or eventual_index',
    };
  }

  const normalizedType = type ?? 'content';
  const normalizedConsistency = consistency ?? 'filesystem_snapshot';
  if (normalizedConsistency === 'eventual_index') {
    if (normalizedType !== 'filename') {
      return {
        ok: false,
        message: 'eventual_index is available only for filename search',
      };
    }
    if (maxResults === undefined) {
      return {
        ok: false,
        message: 'eventual_index requires maxResults',
      };
    }
    if (include !== undefined) {
      return {
        ok: false,
        message: 'eventual_index does not accept include',
      };
    }
  }

  return {
    ok: true,
    value: {
      pattern,
      ...(path === undefined ? {} : { path }),
      ...(type === undefined ? {} : { type }),
      ...(include === undefined ? {} : { include }),
      ...(maxResults === undefined ? {} : { maxResults }),
      ...(consistency === undefined ? {} : { consistency }),
    },
  };
}

export function encodeSearchFilesInput(
  input: SearchFilesInput,
): Record<string, ToolSdkJsonValue> {
  return {
    pattern: input.pattern,
    path: input.path ?? '.',
    type: input.type ?? 'content',
    consistency: input.consistency ?? 'filesystem_snapshot',
    ...(input.include === undefined ? {} : { include: input.include }),
    ...(input.maxResults === undefined ? {} : { maxResults: input.maxResults }),
  };
}

export function parseSearchFilesOutput(
  value: unknown,
  input: SearchFilesInput,
): SearchFilesOutput | null {
  if (!isRecord(value)) {
    return null;
  }
  const path = value['path'];
  const type = readSearchFilesType(value['type']);
  const consistency = readSearchFilesConsistency(value['consistency']);
  const total = value['total'];
  const totalRelation = value['totalRelation'];
  const truncated = value['truncated'];
  const rawResults = value['results'];
  const requestedType = input.type ?? 'content';
  const requestedConsistency = input.consistency ?? 'filesystem_snapshot';
  if (
    typeof path !== 'string' ||
    type === null ||
    type !== requestedType ||
    consistency === null ||
    consistency !== requestedConsistency ||
    !isNonNegativeSafeInteger(total) ||
    (totalRelation !== 'exact' && totalRelation !== 'lower_bound') ||
    typeof truncated !== 'boolean' ||
    !Array.isArray(rawResults) ||
    rawResults.length > total ||
    (input.maxResults !== undefined && rawResults.length > input.maxResults) ||
    (truncated && input.maxResults === undefined) ||
    (consistency === 'filesystem_snapshot' && totalRelation !== 'exact') ||
    (consistency === 'eventual_index' && type !== 'filename') ||
    (totalRelation === 'lower_bound' &&
      (consistency !== 'eventual_index' || !truncated)) ||
    (!truncated && rawResults.length !== total) ||
    (truncated && totalRelation === 'exact' && rawResults.length >= total) ||
    (truncated &&
      totalRelation === 'lower_bound' &&
      rawResults.length !== total)
  ) {
    return null;
  }

  const results: SearchFilesMatch[] = [];
  for (const rawResult of rawResults) {
    if (!isRecord(rawResult)) {
      return null;
    }
    const resultPath = rawResult['path'];
    const line = rawResult['line'];
    const text = rawResult['text'];
    if (
      typeof resultPath !== 'string' ||
      !isNonNegativeSafeInteger(line) ||
      typeof text !== 'string' ||
      (type === 'filename' && (line !== 0 || text.length !== 0)) ||
      (type === 'content' && line === 0)
    ) {
      return null;
    }
    results.push({ path: resultPath, line, text });
  }
  return {
    path,
    type,
    consistency,
    total,
    totalRelation,
    truncated,
    results,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value > 0;
}

function readSearchFilesType(value: unknown): SearchFilesType | null {
  return value === 'content' || value === 'filename' ? value : null;
}

function readSearchFilesConsistency(
  value: unknown,
): SearchFilesConsistency | null {
  return value === 'filesystem_snapshot' || value === 'eventual_index'
    ? value
    : null;
}
