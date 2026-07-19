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
  if (
    path !== undefined &&
    (typeof path !== 'string' || path.trim().length === 0)
  ) {
    return { ok: false, message: 'path must be a non-empty string' };
  }
  if (recursive !== undefined && typeof recursive !== 'boolean') {
    return { ok: false, message: 'recursive must be a boolean' };
  }
  return {
    ok: true,
    value: {
      ...(path === undefined ? {} : { path }),
      ...(recursive === undefined ? {} : { recursive }),
    },
  };
}

export function encodeListFilesInput(
  input: ListFilesInput,
): Record<string, ToolSdkJsonValue> {
  return {
    path: input.path ?? '.',
    recursive: input.recursive ?? false,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value > 0;
}
