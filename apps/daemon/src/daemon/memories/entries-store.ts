import { createHash, randomBytes } from 'node:crypto';
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { createLogger } from '@geulbat/structured-logger/logger';

import { getErrorMessage, hasErrorCode } from '../utils/error.js';
import { resolveMemoriesRoot } from './notes-store.js';

const ENTRIES_DIRECTORY_NAME = 'entries';
const USAGE_LOG_FILE_NAME = 'usage.jsonl';
const ENTRY_FILE_EXTENSION = '.md';
const ENTRY_ID_PATTERN = /^m-[0-9a-f]{8}$/u;
const USAGE_OPERATION_ID_PATTERN = /^memory-usage-[0-9a-f]{32}$/u;

const logger = createLogger('memories/entries-store');

export interface MemoryEntry {
  id: string;
  text: string;
  usageCount: number;
  lastUsedAt: string | undefined;
}

export function resolveMemoryEntriesDirectory(stateRoot: string): string {
  return join(resolveMemoriesRoot(stateRoot), ENTRIES_DIRECTORY_NAME);
}

function resolveUsageLogPath(stateRoot: string): string {
  return join(resolveMemoriesRoot(stateRoot), USAGE_LOG_FILE_NAME);
}

export function isMemoryEntryId(value: string): boolean {
  return ENTRY_ID_PATTERN.test(value);
}

function createMemoryEntryId(): string {
  return `m-${randomBytes(4).toString('hex')}`;
}

function createMemoryUsageOperationId(): string {
  return `memory-usage-${randomBytes(16).toString('hex')}`;
}

function buildMemoryUsageEntryIdsDigest(entryIds: readonly string[]): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(entryIds))
    .digest('hex')}`;
}

export type PreparedMemoryEntryUsage = {
  schemaVersion: 1;
  operationId: string;
  at: string;
  requested: string[];
  recorded: string[];
  unknown: string[];
  recordedDigest: string;
};

type MemoryUsageRecord =
  | { kind: 'legacy'; entryId: string; at: string }
  | {
      kind: 'operation';
      operationId: string;
      at: string;
      entryIds: string[];
      recordedDigest: string;
    };

function parseMemoryUsageRecord(line: string): MemoryUsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  if (!('at' in parsed) || typeof parsed.at !== 'string') {
    return null;
  }
  if ('entryId' in parsed && typeof parsed.entryId === 'string') {
    return { kind: 'legacy', entryId: parsed.entryId, at: parsed.at };
  }
  if (
    !('operationId' in parsed) ||
    typeof parsed.operationId !== 'string' ||
    !('entryIds' in parsed) ||
    !Array.isArray(parsed.entryIds) ||
    !parsed.entryIds.every((entryId) => typeof entryId === 'string') ||
    !('recordedDigest' in parsed) ||
    typeof parsed.recordedDigest !== 'string'
  ) {
    return null;
  }
  return {
    kind: 'operation',
    operationId: parsed.operationId,
    at: parsed.at,
    entryIds: parsed.entryIds,
    recordedDigest: parsed.recordedDigest,
  };
}

function assertPreparedMemoryEntryUsage(
  prepared: PreparedMemoryEntryUsage,
): void {
  const requested = [...new Set(prepared.requested)];
  const partition = new Set([...prepared.recorded, ...prepared.unknown]);
  if (
    prepared.schemaVersion !== 1 ||
    !USAGE_OPERATION_ID_PATTERN.test(prepared.operationId) ||
    !Number.isFinite(Date.parse(prepared.at)) ||
    requested.length !== prepared.requested.length ||
    partition.size !== prepared.requested.length ||
    prepared.requested.some((entryId) => !partition.has(entryId)) ||
    prepared.recorded.some((entryId) => prepared.unknown.includes(entryId)) ||
    prepared.recordedDigest !==
      buildMemoryUsageEntryIdsDigest(prepared.recorded)
  ) {
    throw Object.assign(new Error('memory usage recovery state is invalid.'), {
      code: 'persistence_unavailable',
    });
  }
}

export async function prepareMemoryEntryUsage(
  stateRoot: string,
  entryIds: readonly string[],
): Promise<PreparedMemoryEntryUsage> {
  const known = new Set(await listMemoryEntryIds(stateRoot));
  const requested = [...new Set(entryIds)];
  const recorded: string[] = [];
  const unknown: string[] = [];
  for (const entryId of requested) {
    if (known.has(entryId)) {
      recorded.push(entryId);
    } else {
      unknown.push(entryId);
    }
  }
  return {
    schemaVersion: 1,
    operationId: createMemoryUsageOperationId(),
    at: new Date().toISOString(),
    requested,
    recorded,
    unknown,
    recordedDigest: buildMemoryUsageEntryIdsDigest(recorded),
  };
}

export async function recordPreparedMemoryEntryUsage(
  stateRoot: string,
  prepared: PreparedMemoryEntryUsage,
): Promise<{ recorded: readonly string[]; unknown: readonly string[] }> {
  assertPreparedMemoryEntryUsage(prepared);
  const path = resolveUsageLogPath(stateRoot);
  let raw = '';
  try {
    raw = await readFile(path, 'utf8');
  } catch (error: unknown) {
    if (!hasErrorCode(error, 'ENOENT') && !hasErrorCode(error, 'ENOTDIR')) {
      throw error;
    }
  }
  let matchingOperationFound = false;
  for (const line of raw.split('\n')) {
    const record = parseMemoryUsageRecord(line);
    if (
      record?.kind !== 'operation' ||
      record.operationId !== prepared.operationId
    ) {
      continue;
    }
    if (
      record.at !== prepared.at ||
      record.recordedDigest !== prepared.recordedDigest
    ) {
      throw Object.assign(
        new Error('memory usage recovery identity conflicts with its event.'),
        { code: 'persistence_unavailable' },
      );
    }
    matchingOperationFound = true;
  }
  if (!matchingOperationFound) {
    await mkdir(resolveMemoriesRoot(stateRoot), { recursive: true });
    await appendFile(
      path,
      `\n${JSON.stringify({
        operationId: prepared.operationId,
        at: prepared.at,
        entryIds: prepared.recorded,
        recordedDigest: prepared.recordedDigest,
      })}\n`,
      'utf8',
    );
  }
  return { recorded: prepared.recorded, unknown: prepared.unknown };
}

/**
 * 사용량은 invocation event를 append-only 로그로 쌓는다. 여러 런이 동시에 같은
 * 항목을 인용해도 read-modify-write 경합으로 카운트가 사라지지 않고, 같은
 * operation replay는 집계에서 한 번만 센다.
 */
export async function recordMemoryEntryUsage(
  stateRoot: string,
  entryIds: readonly string[],
): Promise<{ recorded: readonly string[]; unknown: readonly string[] }> {
  return await recordPreparedMemoryEntryUsage(
    stateRoot,
    await prepareMemoryEntryUsage(stateRoot, entryIds),
  );
}

interface UsageAggregate {
  usageCount: number;
  lastUsedAt: string | undefined;
}

async function readUsageAggregates(
  stateRoot: string,
): Promise<Map<string, UsageAggregate>> {
  const path = resolveUsageLogPath(stateRoot);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) {
      return new Map();
    }
    logger
      .withContext({ path })
      .warn(
        'memory usage log is unreadable; entries are reported as unused:',
        getErrorMessage(error),
      );
    return new Map();
  }

  const aggregates = new Map<string, UsageAggregate>();
  const seenOperationIds = new Set<string>();
  for (const line of raw.split('\n')) {
    const record = parseMemoryUsageRecord(line);
    if (record === null) {
      continue;
    }
    if (record.kind === 'operation') {
      if (seenOperationIds.has(record.operationId)) {
        continue;
      }
      seenOperationIds.add(record.operationId);
    }
    const entryIds =
      record.kind === 'legacy' ? [record.entryId] : new Set(record.entryIds);
    for (const entryId of entryIds) {
      const current = aggregates.get(entryId);
      aggregates.set(entryId, {
        usageCount: (current?.usageCount ?? 0) + 1,
        lastUsedAt:
          current?.lastUsedAt !== undefined && current.lastUsedAt > record.at
            ? current.lastUsedAt
            : record.at,
      });
    }
  }
  return aggregates;
}

async function listMemoryEntryIds(
  stateRoot: string,
): Promise<readonly string[]> {
  const directory = resolveMemoryEntriesDirectory(stateRoot);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) {
      return [];
    }
    logger
      .withContext({ directory })
      .warn(
        'memory entries directory is unreadable; no memory is carried:',
        getErrorMessage(error),
      );
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(ENTRY_FILE_EXTENSION))
    .map((entry) => entry.slice(0, -ENTRY_FILE_EXTENSION.length))
    .filter((entryId) => isMemoryEntryId(entryId))
    .sort();
}

export async function readMemoryEntries(
  stateRoot: string,
): Promise<readonly MemoryEntry[]> {
  const [entryIds, usage] = await Promise.all([
    listMemoryEntryIds(stateRoot),
    readUsageAggregates(stateRoot),
  ]);
  const directory = resolveMemoryEntriesDirectory(stateRoot);
  const entries: MemoryEntry[] = [];
  for (const id of entryIds) {
    const path = join(directory, `${id}${ENTRY_FILE_EXTENSION}`);
    let text: string;
    try {
      text = (await readFile(path, 'utf8')).trim();
    } catch (error: unknown) {
      logger
        .withContext({ path })
        .warn(
          'memory entry is unreadable; it is left out:',
          getErrorMessage(error),
        );
      continue;
    }
    if (text === '') {
      continue;
    }
    const aggregate = usage.get(id);
    entries.push({
      id,
      text,
      usageCount: aggregate?.usageCount ?? 0,
      lastUsedAt: aggregate?.lastUsedAt,
    });
  }
  return entries;
}

export interface MemoryEntryDraft {
  /** 기존 항목을 유지·수정할 때의 id. 새 항목이면 undefined. */
  id: string | undefined;
  text: string;
}

/**
 * 통합 결과를 항목 집합으로 확정한다. 살아남지 않은 항목은 파일과 사용량
 * 기록에서 함께 제거되고, 유지된 항목은 id가 그대로여서 측정이 이어진다.
 */
export async function commitMemoryEntries(
  stateRoot: string,
  drafts: readonly MemoryEntryDraft[],
): Promise<{ entryIds: readonly string[] }> {
  const usable = drafts.filter((draft) => draft.text.trim() !== '');
  if (usable.length === 0) {
    throw Object.assign(
      new Error('refusing to replace memory with an empty entry set.'),
      { code: 'invalid_args' },
    );
  }

  const existing = new Set(await listMemoryEntryIds(stateRoot));
  const directory = resolveMemoryEntriesDirectory(stateRoot);
  await mkdir(directory, { recursive: true });

  const keptIds = new Set<string>();
  for (const draft of usable) {
    const reuseId =
      draft.id !== undefined &&
      existing.has(draft.id) &&
      !keptIds.has(draft.id);
    const id = reuseId ? draft.id! : createMemoryEntryId();
    keptIds.add(id);
    const path = join(directory, `${id}${ENTRY_FILE_EXTENSION}`);
    const temporaryPath = `${path}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temporaryPath, `${draft.text.trim()}\n`, 'utf8');
    await rename(temporaryPath, path);
  }

  for (const id of existing) {
    if (!keptIds.has(id)) {
      await rm(join(directory, `${id}${ENTRY_FILE_EXTENSION}`), {
        force: true,
      });
    }
  }

  await pruneUsageLog(stateRoot, keptIds);
  return { entryIds: [...keptIds].sort() };
}

async function pruneUsageLog(
  stateRoot: string,
  keptIds: ReadonlySet<string>,
): Promise<void> {
  const path = resolveUsageLogPath(stateRoot);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) {
      return;
    }
    throw error;
  }
  const retained: string[] = [];
  const seenOperationIds = new Set<string>();
  for (const line of raw.split('\n')) {
    const record = parseMemoryUsageRecord(line);
    if (record === null) {
      continue;
    }
    if (record.kind === 'legacy') {
      if (keptIds.has(record.entryId)) {
        retained.push(
          JSON.stringify({ entryId: record.entryId, at: record.at }),
        );
      }
      continue;
    }
    if (seenOperationIds.has(record.operationId)) {
      continue;
    }
    seenOperationIds.add(record.operationId);
    retained.push(
      JSON.stringify({
        operationId: record.operationId,
        at: record.at,
        entryIds: record.entryIds.filter((entryId) => keptIds.has(entryId)),
        recordedDigest: record.recordedDigest,
      }),
    );
  }
  const temporaryPath = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(
    temporaryPath,
    retained.length === 0 ? '' : `${retained.join('\n')}\n`,
    'utf8',
  );
  await rename(temporaryPath, path);
}
