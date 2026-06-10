import { tryParseJsonWithGuard } from '@geulbat/protocol/runtime-utils';
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { threadFilePath } from './paths.js';
import { isThreadMessage } from '@geulbat/protocol/threads';
import type { ThreadMessage } from '@geulbat/protocol/threads';
import { hasErrorCode } from '../utils/error.js';
import { createKeyedSerialRunner } from '../utils/keyed-serial.js';
import { writeTextFileAtomically } from '../utils/atomic-file.js';

export type TranscriptEntry = ThreadMessage;
const runTranscriptAppendSerial = createKeyedSerialRunner();
const transcriptEntryCache = new Map<string, TranscriptEntryCacheEntry>();
const MAX_TRANSCRIPT_ENTRY_CACHE_ENTRIES = 128;
let transcriptEntryParseCountForTests = 0;

export class TranscriptCorruptionError extends Error {
  readonly code = 'transcript_corrupt';
  readonly threadId: string;
  readonly lineNumber: number;

  constructor(threadId: string, lineNumber: number) {
    super(`transcript ${threadId} has malformed entry at line ${lineNumber}`);
    this.name = 'TranscriptCorruptionError';
    this.threadId = threadId;
    this.lineNumber = lineNumber;
  }
}

interface TranscriptEntryCacheEntry {
  entries: TranscriptEntry[];
  mtimeMs: number;
  size: number;
}

function setTranscriptEntryCacheEntry(
  filePath: string,
  entry: TranscriptEntryCacheEntry,
): void {
  transcriptEntryCache.delete(filePath);
  transcriptEntryCache.set(filePath, entry);
  while (transcriptEntryCache.size > MAX_TRANSCRIPT_ENTRY_CACHE_ENTRIES) {
    const oldestKey = transcriptEntryCache.keys().next().value;
    if (typeof oldestKey !== 'string') {
      return;
    }
    transcriptEntryCache.delete(oldestKey);
  }
}

function readCachedTranscriptEntryCacheEntry(
  filePath: string,
): TranscriptEntryCacheEntry | null {
  const cached = transcriptEntryCache.get(filePath);
  if (!cached) {
    return null;
  }
  transcriptEntryCache.delete(filePath);
  transcriptEntryCache.set(filePath, cached);
  return cached;
}

export async function appendTranscriptEntry(
  workspaceRoot: string,
  threadId: string,
  entry: TranscriptEntry,
): Promise<void> {
  const filePath = threadFilePath(workspaceRoot, threadId);
  await runTranscriptAppendSerial(filePath, async () => {
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, JSON.stringify(entry) + '\n', 'utf8');
    const cached = transcriptEntryCache.get(filePath);
    if (!cached) {
      return;
    }
    const snapshot = await stat(filePath);
    setTranscriptEntryCacheEntry(filePath, {
      entries: [...cached.entries, entry],
      mtimeMs: snapshot.mtimeMs,
      size: snapshot.size,
    });
  });
}

export async function readTranscriptEntries(
  workspaceRoot: string,
  threadId: string,
): Promise<TranscriptEntry[]> {
  const filePath = threadFilePath(workspaceRoot, threadId);
  let snapshot: Awaited<ReturnType<typeof stat>>;
  try {
    snapshot = await stat(filePath);
  } catch (err: unknown) {
    if (hasErrorCode(err, 'ENOENT')) {
      transcriptEntryCache.delete(filePath);
      return [];
    }
    throw err;
  }

  const cached = readCachedTranscriptEntryCacheEntry(filePath);
  if (
    cached &&
    cached.mtimeMs === snapshot.mtimeMs &&
    cached.size === snapshot.size
  ) {
    return [...cached.entries];
  }

  const raw = await readFile(filePath, 'utf8');
  const entries = parseTranscriptEntries(raw, threadId);
  setTranscriptEntryCacheEntry(filePath, {
    entries,
    mtimeMs: snapshot.mtimeMs,
    size: snapshot.size,
  });
  return [...entries];
}

export async function replaceTranscriptEntries(
  workspaceRoot: string,
  threadId: string,
  entries: readonly TranscriptEntry[],
): Promise<void> {
  const filePath = threadFilePath(workspaceRoot, threadId);
  await runTranscriptAppendSerial(filePath, async () => {
    await mkdir(dirname(filePath), { recursive: true });
    const body =
      entries.map((entry) => JSON.stringify(entry)).join('\n') +
      (entries.length > 0 ? '\n' : '');
    await writeTextFileAtomically(filePath, body);
    const snapshot = await stat(filePath);
    setTranscriptEntryCacheEntry(filePath, {
      entries: [...entries],
      mtimeMs: snapshot.mtimeMs,
      size: snapshot.size,
    });
  });
}

export function clearTranscriptEntryCacheForThread(
  workspaceRoot: string,
  threadId: string,
): void {
  transcriptEntryCache.delete(threadFilePath(workspaceRoot, threadId));
}

function parseTranscriptEntries(
  raw: string,
  threadId: string,
): TranscriptEntry[] {
  transcriptEntryParseCountForTests += 1;
  const entries: TranscriptEntry[] = [];
  for (const [lineIndex, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    const parsed = tryParseJsonWithGuard(line, isThreadMessage);
    if (!parsed.ok) {
      throw new TranscriptCorruptionError(threadId, lineIndex + 1);
    }
    entries.push(parsed.value);
  }
  return entries;
}

export function isTranscriptCorruptionError(
  error: unknown,
): error is TranscriptCorruptionError {
  return error instanceof TranscriptCorruptionError;
}

export function resetTranscriptEntryCacheForTests(): void {
  transcriptEntryCache.clear();
  transcriptEntryParseCountForTests = 0;
}

export function getTranscriptEntryParseCountForTests(): number {
  return transcriptEntryParseCountForTests;
}

export function getTranscriptEntryCacheSizeForTests(): number {
  return transcriptEntryCache.size;
}

export function hasTranscriptEntryCacheForTests(
  workspaceRoot: string,
  threadId: string,
): boolean {
  return transcriptEntryCache.has(threadFilePath(workspaceRoot, threadId));
}

export function getTranscriptEntryCacheLimitForTests(): number {
  return MAX_TRANSCRIPT_ENTRY_CACHE_ENTRIES;
}
