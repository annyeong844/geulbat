import { isPlainRecord } from '../runtime-json.js';
import {
  isSessionThreadId as isThreadId,
  type ThreadSummary,
} from './contract.js';
import { readFile } from 'node:fs/promises';
import { indexFilePath } from './paths.js';
import { hasErrorCode } from '../utils/error.js';
import { writeTextFileAtomically } from '../utils/atomic-file.js';
import { createKeyedSerialRunner } from '../utils/keyed-serial.js';
import { createLogger } from '@geulbat/structured-logger/logger';

const logger = createLogger('threads-index');

type ThreadIndexEntryParseReason =
  | 'entry_not_object'
  | 'invalid_thread_id'
  | 'legacy_project_id'
  | 'invalid_title'
  | 'invalid_last_updated'
  | 'invalid_message_count'
  | 'invalid_entry';

interface SkippedThreadIndexEntryDiagnostic {
  entryIndex: number;
  reasonCode: ThreadIndexEntryParseReason;
}

export function createThreadIndexStore(
  options: {
    runMutationSerial?: <T>(
      key: string,
      operation: () => Promise<T>,
    ) => Promise<T>;
  } = {},
): {
  loadThreadIndex(workspaceRoot: string): Promise<ThreadSummary[]>;
  saveThreadIndex(
    workspaceRoot: string,
    entries: ThreadSummary[],
  ): Promise<void>;
  upsertThreadSummary(
    workspaceRoot: string,
    summary: ThreadSummary,
  ): Promise<void>;
  removeThreadSummary(
    workspaceRoot: string,
    threadId: string,
  ): Promise<boolean>;
} {
  const runMutationSerial =
    options.runMutationSerial ?? createKeyedSerialRunner();

  async function loadThreadIndexForStore(
    workspaceRoot: string,
  ): Promise<ThreadSummary[]> {
    const filePath = indexFilePath(workspaceRoot);
    try {
      const raw = await readFile(filePath, 'utf8');
      const data: unknown = JSON.parse(raw);
      return parseThreadIndexEntries(data);
    } catch (err: unknown) {
      if (hasErrorCode(err, 'ENOENT')) {
        return [];
      }
      throw err;
    }
  }

  async function saveThreadIndexForStore(
    workspaceRoot: string,
    entries: ThreadSummary[],
  ): Promise<void> {
    const filePath = indexFilePath(workspaceRoot);
    await writeTextFileAtomically(
      filePath,
      JSON.stringify(entries, null, 2) + '\n',
    );
  }

  async function mutateThreadIndex<T>(
    workspaceRoot: string,
    mutate: (entries: ThreadSummary[]) => Promise<T>,
  ): Promise<T> {
    const filePath = indexFilePath(workspaceRoot);
    return runMutationSerial(filePath, async () => {
      const entries = await loadThreadIndexForStore(workspaceRoot);
      return mutate(entries);
    });
  }

  return {
    loadThreadIndex: loadThreadIndexForStore,
    saveThreadIndex: saveThreadIndexForStore,
    async upsertThreadSummary(workspaceRoot, summary) {
      await mutateThreadIndex(workspaceRoot, async (entries) => {
        const idx = entries.findIndex(
          (entry) => entry.threadId === summary.threadId,
        );
        if (idx >= 0) {
          entries[idx] = summary;
        } else {
          entries.push(summary);
        }
        await saveThreadIndexForStore(workspaceRoot, entries);
      });
    },
    async removeThreadSummary(workspaceRoot, threadId) {
      return mutateThreadIndex(workspaceRoot, async (entries) => {
        const nextEntries = entries.filter(
          (entry) => entry.threadId !== threadId,
        );
        if (nextEntries.length === entries.length) {
          return false;
        }
        await saveThreadIndexForStore(workspaceRoot, nextEntries);
        return true;
      });
    },
  };
}

const defaultThreadIndexStore = createThreadIndexStore();

export async function loadThreadIndex(
  workspaceRoot: string,
): Promise<ThreadSummary[]> {
  return defaultThreadIndexStore.loadThreadIndex(workspaceRoot);
}

export async function upsertThreadSummary(
  workspaceRoot: string,
  summary: ThreadSummary,
): Promise<void> {
  await defaultThreadIndexStore.upsertThreadSummary(workspaceRoot, summary);
}

export async function removeThreadSummary(
  workspaceRoot: string,
  threadId: string,
): Promise<boolean> {
  return defaultThreadIndexStore.removeThreadSummary(workspaceRoot, threadId);
}

function parseThreadIndexEntries(value: unknown): ThreadSummary[] {
  if (!Array.isArray(value)) {
    throw new Error('invalid thread index');
  }

  const entries: ThreadSummary[] = [];
  const skippedEntries: SkippedThreadIndexEntryDiagnostic[] = [];
  for (const [entryIndex, entry] of value.entries()) {
    try {
      entries.push(parseThreadSummaryEntry(entry));
    } catch (error: unknown) {
      skippedEntries.push({
        entryIndex,
        reasonCode: readThreadIndexEntryParseReason(error),
      });
    }
  }
  if (skippedEntries.length > 0) {
    logger
      .withContext({
        skippedEntryDiagnostics:
          formatSkippedThreadIndexEntryDiagnostics(skippedEntries),
        skippedEntryCount: skippedEntries.length,
      })
      .warn(
        `Skipped ${skippedEntries.length} malformed thread index entr${skippedEntries.length === 1 ? 'y' : 'ies'}.`,
      );
  }
  return entries;
}

function parseThreadSummaryEntry(value: unknown): ThreadSummary {
  if (!isPlainRecord(value)) {
    throw new ThreadIndexEntryParseError('entry_not_object');
  }

  const record = value;
  const threadId = parseThreadId(record.threadId);
  if ('projectId' in record) {
    throw new ThreadIndexEntryParseError('legacy_project_id');
  }
  const title = parseOptionalString(record.title);
  const lastUpdated = parseRequiredString(record.lastUpdated);
  const messageCount = parseNonNegativeInteger(record.messageCount);

  return {
    threadId,
    lastUpdated,
    messageCount,
    ...(title !== undefined ? { title } : {}),
  };
}

function parseThreadId(value: unknown): ThreadSummary['threadId'] {
  if (typeof value === 'string' && isThreadId(value)) {
    return value;
  }
  throw new ThreadIndexEntryParseError('invalid_thread_id');
}

function parseRequiredString(value: unknown): string {
  if (typeof value === 'string' && value.trim() !== '') {
    return value;
  }
  throw new ThreadIndexEntryParseError('invalid_last_updated');
}

function parseOptionalString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  throw new ThreadIndexEntryParseError('invalid_title');
}

function parseNonNegativeInteger(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  throw new ThreadIndexEntryParseError('invalid_message_count');
}

class ThreadIndexEntryParseError extends Error {
  constructor(readonly reasonCode: ThreadIndexEntryParseReason) {
    super('invalid thread index entry');
  }
}

function readThreadIndexEntryParseReason(
  error: unknown,
): ThreadIndexEntryParseReason {
  return error instanceof ThreadIndexEntryParseError
    ? error.reasonCode
    : 'invalid_entry';
}

function formatSkippedThreadIndexEntryDiagnostics(
  diagnostics: readonly SkippedThreadIndexEntryDiagnostic[],
): string {
  return diagnostics
    .map((diagnostic) => `${diagnostic.entryIndex}:${diagnostic.reasonCode}`)
    .join(',');
}
