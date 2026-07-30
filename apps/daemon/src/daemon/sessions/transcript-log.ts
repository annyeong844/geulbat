import { randomUUID } from 'node:crypto';
import { sha256StableJson } from '@geulbat/content-identity/stable-json';
import { createLogger } from '@geulbat/structured-logger/logger';
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
import {
  collectUnreferencedHostCommandOutputs,
  pruneUnreferencedThreadHostCommandOutputs,
} from '../host-command-output-store.js';
import {
  releaseClaimedOutputRefs,
  resolvePreservedHostCommandRefs,
} from '../../command-host/reachability.js';

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
  options: {
    expectedLastEntryId?: string;
    ifAbsentEntryId?: string;
  } = {},
): Promise<TranscriptEntry> {
  const appended = await appendTranscriptEntriesInternal(
    workspaceRoot,
    threadId,
    [entry],
    options,
  );
  return appended[0]!;
}

export async function appendTranscriptEntryOnce(
  workspaceRoot: string,
  threadId: string,
  entry: ThreadMessageInput & { entryId: string },
): Promise<TranscriptEntry> {
  const appended = await appendTranscriptEntriesInternal(
    workspaceRoot,
    threadId,
    [entry],
    { ifAbsentEntryId: entry.entryId },
  );
  return appended[0]!;
}

export async function appendTranscriptEntries(
  workspaceRoot: string,
  threadId: string,
  entries: readonly ThreadMessageInput[],
): Promise<TranscriptEntry[]> {
  return await appendTranscriptEntriesInternal(
    workspaceRoot,
    threadId,
    entries,
    {},
  );
}

async function appendTranscriptEntriesInternal(
  workspaceRoot: string,
  threadId: string,
  entries: readonly ThreadMessageInput[],
  options: {
    expectedLastEntryId?: string;
    ifAbsentEntryId?: string;
  },
): Promise<TranscriptEntry[]> {
  if (entries.length === 0) {
    return [];
  }
  const filePath = threadFilePath(workspaceRoot, threadId);
  return await runTranscriptAppendSerial(filePath, async () => {
    const cached = transcriptEntryCache.get(filePath);
    const cacheMatchesFileBeforeAppend =
      cached === undefined
        ? false
        : await transcriptCacheMatchesCurrentFile(filePath, cached);
    if (cached === undefined || !cacheMatchesFileBeforeAppend) {
      await mkdir(dirname(filePath), { recursive: true });
    }
    const normalizedEntries = entries.map(normalizeTranscriptEntryInput);
    if (
      options.expectedLastEntryId !== undefined ||
      options.ifAbsentEntryId !== undefined
    ) {
      const currentEntries = await readTranscriptEntriesFromDisk(
        filePath,
        threadId,
      );
      if (options.ifAbsentEntryId !== undefined) {
        const candidate = normalizedEntries[0];
        if (
          normalizedEntries.length !== 1 ||
          candidate === undefined ||
          candidate.entryId !== options.ifAbsentEntryId
        ) {
          throw new Error('transcript append-once identity is invalid');
        }
        const existing = currentEntries.find(
          (entry) => entry.entryId === options.ifAbsentEntryId,
        );
        if (existing !== undefined) {
          if (sha256StableJson(existing) !== sha256StableJson(candidate)) {
            throw new Error(
              `transcript entry identity conflicts: ${options.ifAbsentEntryId}`,
            );
          }
          return [existing];
        }
      }
      const actualLastEntryId =
        currentEntries.length === 0
          ? null
          : (currentEntries[currentEntries.length - 1]?.entryId ?? null);
      if (
        options.expectedLastEntryId !== undefined &&
        actualLastEntryId !== options.expectedLastEntryId
      ) {
        throw new CompareAndAppendMismatchError({
          threadId,
          expectedLastEntryId: options.expectedLastEntryId,
          actualLastEntryId,
        });
      }
    }
    await appendFile(
      filePath,
      normalizedEntries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
      'utf8',
    );
    if (!cached) {
      return normalizedEntries;
    }
    if (!cacheMatchesFileBeforeAppend) {
      transcriptEntryCache.delete(filePath);
      return normalizedEntries;
    }
    const snapshot = await stat(filePath);
    setTranscriptEntryCacheEntry(filePath, {
      entries: [...cached.entries, ...normalizedEntries],
      mtimeMs: snapshot.mtimeMs,
      size: snapshot.size,
    });
    return normalizedEntries;
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
  return [...(await readCurrentTranscriptEntries(workspaceRoot, threadId))];
}

export async function readLastTranscriptEntryId(
  workspaceRoot: string,
  threadId: string,
): Promise<string | null> {
  const entries = await readCurrentTranscriptEntries(workspaceRoot, threadId);
  return entries.at(-1)?.entryId ?? null;
}

async function readCurrentTranscriptEntries(
  workspaceRoot: string,
  threadId: string,
): Promise<readonly TranscriptEntry[]> {
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
    return cached.entries;
  }

  const entries = await readTranscriptEntriesFromDisk(filePath, threadId);
  setTranscriptEntryCacheEntry(filePath, {
    entries,
    mtimeMs: snapshot.mtimeMs,
    size: snapshot.size,
  });
  return entries;
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
      const previousOutputRefs =
        collectTranscriptDurableOutputRefs(previousEntries);
      const retainedOutputRefs =
        collectTranscriptDurableOutputRefs(normalizedEntries);
      // transcript 기록이 끝났다 — §5.6 in-flight claimed-ref 보존을 해제한다.
      releaseClaimedOutputRefs(retainedOutputRefs.hostCommands);
      await Promise.all([
        pruneUnreferencedThreadToolOutputs({
          stateRoot: workspaceRoot,
          threadId,
          previousOutputRefs: previousOutputRefs.toolOutputs,
          retainedOutputRefs: retainedOutputRefs.toolOutputs,
        }),
        pruneUnreferencedThreadHostCommandOutputs({
          stateRoot: workspaceRoot,
          threadId,
          previousOutputRefs: previousOutputRefs.hostCommands,
          retainedOutputRefs: retainedOutputRefs.hostCommands,
        }),
        collectUnreachableHostCommandOutputs({
          stateRoot: workspaceRoot,
          threadId,
          transcriptRefs: retainedOutputRefs.hostCommands,
        }),
      ]);
    } catch (error: unknown) {
      logger.warn('failed to prune unreferenced thread tool outputs:', {
        threadId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

/**
 * P7.5 §5.6 — transcript·워커 active·데몬 in-flight 어디에도 없는 산출물만
 * 수거한다. 보존 집합을 확정할 수 없으면(워커 hang·프로토콜 불일치) 아무
 * 것도 지우지 않는다.
 */
async function collectUnreachableHostCommandOutputs(args: {
  stateRoot: string;
  threadId: string;
  transcriptRefs: ReadonlySet<string>;
}): Promise<void> {
  const preserved = await resolvePreservedHostCommandRefs({
    stateRoot: args.stateRoot,
    transcriptRefs: args.transcriptRefs,
  });
  if (!preserved.ok) {
    logger.info('host command GC skipped (fail-closed):', {
      threadId: args.threadId,
      reason: preserved.reason,
    });
    return;
  }
  await collectUnreferencedHostCommandOutputs({
    stateRoot: args.stateRoot,
    threadId: args.threadId,
    preservedOutputRefs: preserved.refs,
  });
}

export function collectTranscriptDurableOutputRefs(
  entries: readonly TranscriptEntry[],
): {
  toolOutputs: Set<string>;
  hostCommands: Set<string>;
} {
  const refs = {
    toolOutputs: new Set<string>(),
    hostCommands: new Set<string>(),
  };
  for (const entry of entries) {
    if (
      entry.role === 'compaction' &&
      isRecord(entry.compactionData) &&
      Array.isArray(entry.compactionData.evidence)
    ) {
      for (const item of entry.compactionData.evidence) {
        if (isRecord(item)) {
          collectTranscriptDurableOutputRef(item.outputRef, refs);
        }
      }
    }
    if (
      entry.role === 'compaction' &&
      isRecord(entry.compactionData) &&
      Array.isArray(entry.compactionData.expandedEvidencePages)
    ) {
      for (const page of entry.compactionData.expandedEvidencePages) {
        if (isRecord(page)) {
          collectTranscriptDurableOutputRef(page.outputRef, refs);
        }
      }
    }
    if (entry.role === 'compaction') {
      continue;
    }
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
    collectTranscriptDurableOutputRef(output.value.outputRef, refs);
    if (isRecord(output.value.snapshot)) {
      collectTranscriptDurableOutputRef(output.value.snapshot.outputRef, refs);
    }
  }
  return refs;
}

export function rewriteTranscriptDurableOutputRefs(
  entries: readonly TranscriptEntry[],
  replacements: ReadonlyMap<string, string>,
): TranscriptEntry[] {
  return entries.map((entry) => {
    if (
      entry.role === 'compaction' &&
      'kind' in entry.compactionData &&
      entry.compactionData.kind === 'provider_native'
    ) {
      const evidence = entry.compactionData.evidence?.map((item) => ({
        ...item,
        outputRef: replacements.get(item.outputRef) ?? item.outputRef,
      }));
      const expandedEvidencePages =
        entry.compactionData.expandedEvidencePages?.map((page) => ({
          ...page,
          outputRef: replacements.get(page.outputRef) ?? page.outputRef,
        }));
      return {
        ...entry,
        compactionData: {
          ...entry.compactionData,
          ...(evidence === undefined ? {} : { evidence }),
          ...(expandedEvidencePages === undefined
            ? {}
            : { expandedEvidencePages }),
        },
      };
    }
    if (entry.role !== 'tool_result') {
      return entry;
    }
    const content = rewriteToolResultDurableOutputRefs(
      entry.content,
      replacements,
    );
    return content === entry.content ? entry : { ...entry, content };
  });
}

function rewriteToolResultDurableOutputRefs(
  content: string,
  replacements: ReadonlyMap<string, string>,
): string {
  const envelope = tryParseJson(content);
  if (!envelope.ok || !isRecord(envelope.value)) {
    return content;
  }
  const rawOutput = envelope.value.output;
  const parsedOutput =
    typeof rawOutput === 'string'
      ? tryParseJson(rawOutput)
      : { ok: true, value: rawOutput };
  if (!parsedOutput.ok || !isRecord(parsedOutput.value)) {
    return content;
  }

  const outputRef = replaceDurableOutputRef(
    parsedOutput.value.outputRef,
    replacements,
  );
  const snapshot = isRecord(parsedOutput.value.snapshot)
    ? parsedOutput.value.snapshot
    : undefined;
  const snapshotOutputRef =
    snapshot === undefined
      ? undefined
      : replaceDurableOutputRef(snapshot.outputRef, replacements);
  if (outputRef === undefined && snapshotOutputRef === undefined) {
    return content;
  }
  const rewrittenOutput = {
    ...parsedOutput.value,
    ...(outputRef === undefined ? {} : { outputRef }),
    ...(snapshot === undefined || snapshotOutputRef === undefined
      ? {}
      : { snapshot: { ...snapshot, outputRef: snapshotOutputRef } }),
  };
  const rewrittenEnvelope = {
    ...envelope.value,
    output:
      typeof rawOutput === 'string'
        ? JSON.stringify(rewrittenOutput)
        : rewrittenOutput,
  };
  return JSON.stringify(rewrittenEnvelope);
}

function replaceDurableOutputRef(
  value: unknown,
  replacements: ReadonlyMap<string, string>,
): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const replacement = replacements.get(value);
  return replacement === undefined || replacement === value
    ? undefined
    : replacement;
}

function collectTranscriptDurableOutputRef(
  value: unknown,
  refs: {
    toolOutputs: Set<string>;
    hostCommands: Set<string>;
  },
): void {
  if (typeof value !== 'string') {
    return;
  }
  if (value.startsWith('tool-output:')) {
    refs.toolOutputs.add(value);
  } else if (value.startsWith('command-output:')) {
    refs.hostCommands.add(value);
  }
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
