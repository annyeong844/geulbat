import { createLogger } from '@geulbat/structured-logger/logger';

import { getErrorMessage } from '../utils/error.js';
import {
  commitMemoryEntries,
  isMemoryEntryId,
  readMemoryEntries,
  type MemoryEntry,
  type MemoryEntryDraft,
} from './entries-store.js';
import {
  archiveConsolidatedMemoryNotes,
  listPendingMemoryNotes,
  memoryConsolidationIsDue,
  readLegacyMemorySummary,
  removeLegacyMemorySummary,
  type MemoryNote,
} from './notes-store.js';

const logger = createLogger('memories/consolidate');

const ENTRY_MARKER_PATTERN = /^\[(m-[0-9a-f]{8}|new)\]\s?(.*)$/u;

export interface MemoryConsolidationSummarizer {
  consolidate(input: {
    entries: readonly MemoryEntry[];
    legacySummary: string | undefined;
    notes: readonly MemoryNote[];
    signal?: AbortSignal;
  }): Promise<{ text: string }>;
}

export type ConsolidateMemoryResult =
  | { kind: 'skipped'; reason: 'not_due' | 'already_running' }
  | { kind: 'consolidated'; entryCount: number; consolidatedNoteCount: number }
  | {
      kind: 'failed';
      reason: 'summarizer_failed' | 'no_entries_parsed' | 'commit_rejected';
    };

/**
 * 모델 출력에서 항목을 읽는다. 유지·수정할 항목은 기존 id를 그대로 달고 오고,
 * 새 항목은 `[new]`로 온다. 오지 않은 id는 모델이 버린 항목이다.
 *
 * 모르는 id는 새 항목으로 강등한다. 없는 항목의 측정 이력을 물려주면 사용량이
 * 거짓이 되므로, 이력을 잃는 쪽이 아니라 만들지 않는 쪽으로 실패한다.
 */
export function parseMemoryEntryDrafts(
  text: string,
  knownEntryIds: ReadonlySet<string>,
): readonly MemoryEntryDraft[] {
  const drafts: { id: string | undefined; lines: string[] }[] = [];
  const claimedIds = new Set<string>();
  for (const line of text.split('\n')) {
    const marker = ENTRY_MARKER_PATTERN.exec(line);
    if (marker === null) {
      drafts.at(-1)?.lines.push(line);
      continue;
    }
    const rawId = marker[1]!;
    const reusableId =
      isMemoryEntryId(rawId) &&
      knownEntryIds.has(rawId) &&
      !claimedIds.has(rawId)
        ? rawId
        : undefined;
    if (reusableId !== undefined) {
      claimedIds.add(reusableId);
    }
    drafts.push({ id: reusableId, lines: [marker[2] ?? ''] });
  }
  return drafts
    .map((draft) => ({ id: draft.id, text: draft.lines.join('\n').trim() }))
    .filter((draft) => draft.text !== '');
}

const inFlightByStateRoot = new Set<string>();

export async function consolidateMemory(args: {
  stateRoot: string;
  summarizer: MemoryConsolidationSummarizer;
  signal?: AbortSignal;
}): Promise<ConsolidateMemoryResult> {
  if (inFlightByStateRoot.has(args.stateRoot)) {
    return { kind: 'skipped', reason: 'already_running' };
  }
  inFlightByStateRoot.add(args.stateRoot);
  try {
    const notes = await listPendingMemoryNotes(args.stateRoot);
    if (!memoryConsolidationIsDue(notes.length)) {
      return { kind: 'skipped', reason: 'not_due' };
    }
    const [entries, legacySummary] = await Promise.all([
      readMemoryEntries(args.stateRoot),
      readLegacyMemorySummary(args.stateRoot),
    ]);

    let text: string;
    try {
      ({ text } = await args.summarizer.consolidate({
        entries,
        legacySummary,
        notes,
        ...(args.signal === undefined ? {} : { signal: args.signal }),
      }));
    } catch (error: unknown) {
      logger
        .withContext({ pendingNoteCount: notes.length })
        .warn(
          'memory consolidation model call failed; memory and watermark are unchanged:',
          getErrorMessage(error),
        );
      return { kind: 'failed', reason: 'summarizer_failed' };
    }

    const drafts = parseMemoryEntryDrafts(
      text,
      new Set(entries.map((entry) => entry.id)),
    );
    if (drafts.length === 0) {
      logger
        .withContext({ pendingNoteCount: notes.length })
        .warn(
          'memory consolidation returned no parseable entries; memory and pending notes are unchanged',
        );
      return { kind: 'failed', reason: 'no_entries_parsed' };
    }

    let committed: { entryIds: readonly string[] };
    try {
      committed = await commitMemoryEntries(args.stateRoot, drafts);
    } catch (error: unknown) {
      logger
        .withContext({ pendingNoteCount: notes.length })
        .warn(
          'memory consolidation entries were rejected; the previous memory is kept:',
          getErrorMessage(error),
        );
      return { kind: 'failed', reason: 'commit_rejected' };
    }

    const archived = await archiveConsolidatedMemoryNotes(
      args.stateRoot,
      notes,
    );
    if (legacySummary !== undefined) {
      await removeLegacyMemorySummary(args.stateRoot);
    }

    logger
      .withContext({
        entryCount: committed.entryIds.length,
        droppedEntryCount: entries.filter(
          (entry) => !committed.entryIds.includes(entry.id),
        ).length,
        consolidatedNoteCount: notes.length,
        archivedNoteCount: archived.archivedCount,
      })
      .info('memory consolidated into durable entries');
    return {
      kind: 'consolidated',
      entryCount: committed.entryIds.length,
      consolidatedNoteCount: notes.length,
    };
  } finally {
    inFlightByStateRoot.delete(args.stateRoot);
  }
}
