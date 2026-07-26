import { randomBytes } from 'node:crypto';
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

/**
 * 사용량은 append-only 로그로 쌓는다. 여러 런이 동시에 같은 항목을 인용해도
 * read-modify-write 경합으로 카운트가 사라지지 않는다. 집계는 읽을 때 한다.
 */
export async function recordMemoryEntryUsage(
  stateRoot: string,
  entryIds: readonly string[],
): Promise<{ recorded: readonly string[]; unknown: readonly string[] }> {
  const known = new Set(await listMemoryEntryIds(stateRoot));
  const recorded: string[] = [];
  const unknown: string[] = [];
  for (const entryId of new Set(entryIds)) {
    if (known.has(entryId)) {
      recorded.push(entryId);
    } else {
      unknown.push(entryId);
    }
  }
  if (recorded.length === 0) {
    return { recorded, unknown };
  }
  const at = new Date().toISOString();
  await mkdir(resolveMemoriesRoot(stateRoot), { recursive: true });
  await appendFile(
    resolveUsageLogPath(stateRoot),
    `${recorded.map((entryId) => JSON.stringify({ entryId, at })).join('\n')}\n`,
    'utf8',
  );
  return { recorded, unknown };
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
  for (const line of raw.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // 잘린 마지막 줄은 다음 append가 이어 쓰지 않는다. 한 줄을 버릴 뿐
      // 나머지 측정을 잃지 않는다.
      continue;
    }
    const record = parsed as { entryId?: unknown; at?: unknown };
    if (typeof record.entryId !== 'string' || typeof record.at !== 'string') {
      continue;
    }
    const current = aggregates.get(record.entryId);
    aggregates.set(record.entryId, {
      usageCount: (current?.usageCount ?? 0) + 1,
      lastUsedAt:
        current?.lastUsedAt !== undefined && current.lastUsedAt > record.at
          ? current.lastUsedAt
          : record.at,
    });
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
  const retained = raw
    .split('\n')
    .filter((line) => {
      if (line.trim() === '') {
        return false;
      }
      try {
        const record = JSON.parse(line) as { entryId?: unknown };
        return (
          typeof record.entryId === 'string' && keptIds.has(record.entryId)
        );
      } catch {
        return false;
      }
    })
    .join('\n');
  const temporaryPath = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(
    temporaryPath,
    retained === '' ? '' : `${retained}\n`,
    'utf8',
  );
  await rename(temporaryPath, path);
}
