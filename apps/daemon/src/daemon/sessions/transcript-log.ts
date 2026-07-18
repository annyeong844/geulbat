import { randomUUID } from 'node:crypto';
import { sha256StableJson } from '@geulbat/shared-utils/stable-json';
import { createLogger } from '@geulbat/shared-utils/logger';
import { isRecord, tryParseJson } from '../runtime-json.js';
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { threadFilePath } from './paths.js';
import {
  isSessionThreadMessage as isThreadMessage,
  type ThreadMessage,
  type ThreadMessageInput,
} from './contract.js';
import { hasErrorCode } from '../utils/error.js';
import { createKeyedSerialRunner } from '../utils/keyed-serial.js';
import { writeTextFileAtomically } from '../utils/atomic-file.js';
import { pruneUnreferencedThreadToolOutputs } from '../files/tool-output-store.js';

export type TranscriptEntry = ThreadMessage;
const logger = createLogger('transcript-log');
const runTranscriptAppendSerial = createKeyedSerialRunner();
const transcriptEntryCache = new Map<string, TranscriptEntryCacheEntry>();
const MAX_TRANSCRIPT_ENTRY_CACHE_ENTRIES = 128;
let transcriptEntryParseCountForTests = 0;

class TranscriptCorruptionError extends Error {
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

export class CompareAndAppendMismatchError extends Error {
  readonly code = 'compare_and_append_mismatch';
  readonly threadId: string;
  readonly expectedLastEntryId: string;
  readonly actualLastEntryId: string | null;

  constructor(args: {
    threadId: string;
    expectedLastEntryId: string;
    actualLastEntryId: string | null;
  }) {
    super(`transcript ${args.threadId} changed before append`);
    this.name = 'CompareAndAppendMismatchError';
    this.threadId = args.threadId;
    this.expectedLastEntryId = args.expectedLastEntryId;
    this.actualLastEntryId = args.actualLastEntryId;
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
  entry: ThreadMessageInput,
  options: { expectedLastEntryId?: string } = {},
): Promise<TranscriptEntry> {
  const filePath = threadFilePath(workspaceRoot, threadId);
  return await runTranscriptAppendSerial(filePath, async () => {
    await mkdir(dirname(filePath), { recursive: true });
    const cached = transcriptEntryCache.get(filePath);
    const cacheMatchesFileBeforeAppend =
      cached === undefined
        ? false
        : await transcriptCacheMatchesCurrentFile(filePath, cached);
    if (options.expectedLastEntryId !== undefined) {
      const currentEntries = await readTranscriptEntriesFromDisk(
        filePath,
        threadId,
      );
      const actualLastEntryId =
        currentEntries.length === 0
          ? null
          : (currentEntries[currentEntries.length - 1]?.entryId ?? null);
      if (actualLastEntryId !== options.expectedLastEntryId) {
        throw new CompareAndAppendMismatchError({
          threadId,
          expectedLastEntryId: options.expectedLastEntryId,
          actualLastEntryId,
        });
      }
    }
    const normalizedEntry = normalizeTranscriptEntryInput(entry);
    await appendFile(filePath, JSON.stringify(normalizedEntry) + '\n', 'utf8');
    if (!cached) {
      return normalizedEntry;
    }
    if (!cacheMatchesFileBeforeAppend) {
      transcriptEntryCache.delete(filePath);
      return normalizedEntry;
    }
    const snapshot = await stat(filePath);
    setTranscriptEntryCacheEntry(filePath, {
      entries: [...cached.entries, normalizedEntry],
      mtimeMs: snapshot.mtimeMs,
      size: snapshot.size,
    });
    return normalizedEntry;
  });
}

async function transcriptCacheMatchesCurrentFile(
  filePath: string,
  cached: TranscriptEntryCacheEntry,
): Promise<boolean> {
  try {
    const snapshot = await stat(filePath);
    return cached.mtimeMs === snapshot.mtimeMs && cached.size === snapshot.size;
  } catch (err: unknown) {
    if (hasErrorCode(err, 'ENOENT')) {
      return false;
    }
    throw err;
  }
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

  const entries = await readTranscriptEntriesFromDisk(filePath, threadId);
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
  entries: readonly ThreadMessageInput[],
): Promise<void> {
  const filePath = threadFilePath(workspaceRoot, threadId);
  await runTranscriptAppendSerial(filePath, async () => {
    await mkdir(dirname(filePath), { recursive: true });
    const cached = transcriptEntryCache.get(filePath);
    const previousEntries =
      cached !== undefined &&
      (await transcriptCacheMatchesCurrentFile(filePath, cached))
        ? cached.entries
        : await readTranscriptEntriesFromDisk(filePath, threadId);
    const normalizedEntries = entries.map(normalizeTranscriptEntryInput);
    const body =
      normalizedEntries.map((entry) => JSON.stringify(entry)).join('\n') +
      (normalizedEntries.length > 0 ? '\n' : '');
    await writeTextFileAtomically(filePath, body);
    const snapshot = await stat(filePath);
    setTranscriptEntryCacheEntry(filePath, {
      entries: [...normalizedEntries],
      mtimeMs: snapshot.mtimeMs,
      size: snapshot.size,
    });
    try {
      await pruneUnreferencedThreadToolOutputs({
        stateRoot: workspaceRoot,
        threadId,
        previousOutputRefs: collectTranscriptToolOutputRefs(previousEntries),
        retainedOutputRefs: collectTranscriptToolOutputRefs(normalizedEntries),
      });
    } catch (error: unknown) {
      logger.warn('failed to prune unreferenced thread tool outputs:', {
        threadId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

function collectTranscriptToolOutputRefs(
  entries: readonly TranscriptEntry[],
): Set<string> {
  const outputRefs = new Set<string>();
  for (const entry of entries) {
    if (entry.role !== 'tool_result') {
      continue;
    }
    const content = tryParseJson(entry.content);
    if (!content.ok || !isRecord(content.value)) {
      continue;
    }
    const rawOutput = content.value.output;
    const output =
      typeof rawOutput === 'string'
        ? tryParseJson(rawOutput)
        : { ok: true, value: rawOutput };
    if (!output.ok || !isRecord(output.value)) {
      continue;
    }
    const outputRef = output.value.outputRef;
    if (typeof outputRef === 'string' && outputRef.startsWith('tool-output:')) {
      outputRefs.add(outputRef);
    }
  }
  return outputRefs;
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
    if (!line.trim()) {
      continue;
    }
    const parsed = tryParseJson(line);
    if (!parsed.ok) {
      throw new TranscriptCorruptionError(threadId, lineIndex + 1);
    }
    const entry = normalizeTranscriptEntry(
      parsed.value,
      threadId,
      lineIndex + 1,
    );
    if (!entry.ok) {
      throw new TranscriptCorruptionError(threadId, lineIndex + 1);
    }
    entries.push(entry.value);
  }
  return entries;
}

async function readTranscriptEntriesFromDisk(
  filePath: string,
  threadId: string,
): Promise<TranscriptEntry[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err: unknown) {
    if (hasErrorCode(err, 'ENOENT')) {
      return [];
    }
    throw err;
  }
  return parseTranscriptEntries(raw, threadId);
}

function normalizeTranscriptEntry(
  value: unknown,
  threadId: string,
  lineNumber: number,
): { ok: true; value: TranscriptEntry } | { ok: false } {
  if (!isRecord(value)) {
    return { ok: false };
  }
  const entryId =
    typeof value.entryId === 'string' && value.entryId.trim() !== ''
      ? value.entryId
      : resolveEntryId(value, threadId, lineNumber);
  const candidate = { ...value, entryId };
  return isThreadMessage(candidate)
    ? { ok: true, value: candidate }
    : { ok: false };
}

function normalizeTranscriptEntryInput(
  entry: ThreadMessageInput,
): TranscriptEntry {
  if (entry.role === 'compaction') {
    return {
      ...entry,
      entryId: entry.entryId ?? randomUUID(),
    };
  }
  return {
    ...entry,
    entryId: entry.entryId ?? randomUUID(),
  };
}

function resolveEntryId(
  entry: Record<string, unknown>,
  threadId: string,
  lineNumber: number,
): string {
  const digest = sha256StableJson(canonicalizeLegacyEntryForId(entry)).slice(
    0,
    16,
  );
  return `${threadId}:${lineNumber}:${digest}`;
}

function canonicalizeLegacyEntryForId(
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const { entryId: _entryId, ...rest } = entry;
  return rest;
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
