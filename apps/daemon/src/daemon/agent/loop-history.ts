import type {
  HistoryItem,
  HistoryUserAttachment,
  FunctionCall,
} from '../llm/index.js';
import type { ProviderReplayScopeId } from '../runtime-contracts.js';
import type { ProviderRequestOptions } from '../llm/provider/provider-options.js';
import { ProviderReplayScopeMismatchError } from '../llm/provider/provider-replay-scope.js';
import { createLogger } from '@geulbat/shared-utils/logger';
import {
  appendTranscriptEntry,
  readTranscriptEntries,
} from '../sessions/transcript-log.js';
import {
  collectTranscriptArtifactRefs,
  loadThreadArtifactVersionsByRefs,
} from '../sessions/artifact-store.js';
import { readRunAttachment } from '../sessions/run-attachment-store.js';
import type { PendingInterject } from '../sessions/active-run-interject-buffer.js';
import type { TranscriptEntry } from '../sessions/transcript-log.js';
import {
  readProviderRoundHistory,
  type ProviderRoundJournalRecord,
} from '../sessions/provider-round-journal.js';
import { isRecord, tryParseJsonRecord } from '../runtime-json.js';
import {
  assertAgentRunId,
  assertAgentThreadId,
  createAgentArtifactRefKey as createArtifactRefKey,
  type ThreadArtifactVersion,
} from './contract.js';
import { buildHistoryFromTranscript } from './history/build-history-from-transcript.js';
import {
  buildCompactionAwareHistory,
  getActiveTranscriptEntries,
} from './memory/compaction-rebuild.js';

export type ProviderHistoryTarget = Pick<
  ProviderRequestOptions,
  'providerId' | 'model'
> & { replayScopeId?: ProviderReplayScopeId };

const logger = createLogger('agent/loop-history');

interface LoadInitialHistoryArgs {
  workspaceRoot: string;
  threadId: string;
  prompt: string;
  providerTarget: ProviderHistoryTarget;
}

export interface AgentLoopHistoryPort {
  loadInitialHistory(args: LoadInitialHistoryArgs): Promise<HistoryItem[]>;
}

export function createAgentLoopHistoryPort(): AgentLoopHistoryPort {
  return {
    async loadInitialHistory(args) {
      return await loadInitialHistory(
        args.workspaceRoot,
        args.threadId,
        args.prompt,
        args.providerTarget,
      );
    },
  };
}

export async function loadInitialHistory(
  workspaceRoot: string,
  threadId: string,
  prompt: string,
  providerTarget?: ProviderHistoryTarget,
): Promise<HistoryItem[]> {
  const history = await loadExistingHistory(
    workspaceRoot,
    threadId,
    providerTarget,
  );
  const lastItem = history.at(-1);
  if (lastItem?.kind !== 'user' || lastItem.text !== prompt) {
    history.push({ kind: 'user', text: prompt });
  }
  return history;
}

export async function loadExistingHistory(
  workspaceRoot: string,
  threadId: string,
  providerTarget?: ProviderHistoryTarget,
): Promise<HistoryItem[]> {
  const transcriptEntries = await readTranscriptEntries(
    workspaceRoot,
    threadId,
  );
  const artifactVersions = await loadThreadArtifactVersionsByRefs(
    workspaceRoot,
    threadId,
    collectTranscriptArtifactRefs(transcriptEntries),
  );
  const artifactVersionsByRef = new Map(
    artifactVersions.map(
      (artifact) =>
        [
          createArtifactRefKey({
            artifactId: artifact.artifactId,
            version: artifact.version,
          }),
          artifact,
        ] as const,
    ),
  );
  const attachmentsById = await loadTranscriptAttachmentContents(
    workspaceRoot,
    threadId,
    transcriptEntries,
  );
  const providerRounds = await readProviderRoundHistory(
    workspaceRoot,
    assertAgentThreadId(threadId),
  );
  const activeHistoryOverride =
    providerRounds.length === 0
      ? undefined
      : buildProviderRoundAwareActiveHistory({
          transcriptEntries,
          threadId,
          providerRounds,
          ...(providerTarget === undefined ? {} : { providerTarget }),
          artifactVersionsByRef,
          attachmentsById,
        });
  return buildCompactionAwareHistory(
    transcriptEntries,
    threadId,
    artifactVersionsByRef,
    attachmentsById,
    activeHistoryOverride,
    providerTarget?.replayScopeId,
  );
}

function buildProviderRoundAwareActiveHistory(args: {
  transcriptEntries: TranscriptEntry[];
  threadId: string;
  providerRounds: ProviderRoundJournalRecord[];
  providerTarget?: ProviderHistoryTarget;
  artifactVersionsByRef: ReadonlyMap<string, ThreadArtifactVersion>;
  attachmentsById: ReadonlyMap<string, HistoryUserAttachment>;
}): HistoryItem[] {
  const active = getActiveTranscriptEntries(
    args.transcriptEntries,
    args.threadId,
  );
  const transcriptIndexById = new Map(
    args.transcriptEntries.map(
      (entry, index) => [entry.entryId, index] as const,
    ),
  );
  const latestCompactionIndex =
    active.latestCompactionEntryId === undefined
      ? -1
      : (transcriptIndexById.get(active.latestCompactionEntryId) ?? -1);
  const reachableProviderRounds = args.providerRounds.filter((record) => {
    const anchor = record.precedingTranscriptEntryId;
    if (anchor === null) {
      if (latestCompactionIndex >= 0) {
        return false;
      }
      if (args.transcriptEntries.length > 0) {
        throw new Error('provider round history has no transcript anchor');
      }
      return true;
    }
    if (anchor === active.latestCompactionEntryId) {
      return true;
    }
    const anchorIndex = transcriptIndexById.get(anchor);
    if (anchorIndex === undefined) {
      // Regenerate keeps the journal append-only while replacing the active
      // transcript tail. A record whose anchor is no longer reachable belongs
      // to that superseded tail and is intentionally excluded from replay.
      logger.warn('provider round is unreachable from active transcript:', {
        threadId: args.threadId,
        runId: record.runId,
        round: record.round,
        anchor,
      });
      return false;
    }
    return anchorIndex > latestCompactionIndex;
  });

  if (reachableProviderRounds.length === 0) {
    return buildHistoryFromTranscript(
      active.activeEntries,
      args.artifactVersionsByRef,
      args.attachmentsById,
    );
  }
  if (args.providerTarget === undefined) {
    throw new Error('provider round history target is required');
  }
  for (const record of reachableProviderRounds) {
    if (
      record.providerId !== args.providerTarget.providerId ||
      record.model !== args.providerTarget.model
    ) {
      throw new Error(
        `provider round history is incompatible with ${args.providerTarget.providerId}/${args.providerTarget.model}`,
      );
    }
  }
  if (args.providerTarget.replayScopeId !== undefined) {
    for (const record of reachableProviderRounds) {
      if (record.replayScopeId !== args.providerTarget.replayScopeId) {
        throw new ProviderReplayScopeMismatchError();
      }
    }
  }
  const activeProviderRounds = reachableProviderRounds;

  const coveredFunctionCallIds = new Set<string>();
  const providerMessageRunIds = new Set<string>();
  const recordsByAnchor = new Map<
    string | null,
    ProviderRoundJournalRecord[]
  >();
  for (const record of activeProviderRounds) {
    const anchored = recordsByAnchor.get(record.precedingTranscriptEntryId);
    if (anchored === undefined) {
      recordsByAnchor.set(record.precedingTranscriptEntryId, [record]);
    } else {
      anchored.push(record);
    }
    for (const item of record.items) {
      if (!isRecord(item)) {
        continue;
      }
      if (item['type'] === 'function_call') {
        const callId = readString(item['call_id']);
        if (callId !== undefined) {
          coveredFunctionCallIds.add(callId);
        }
      }
      if (item['type'] === 'message') {
        providerMessageRunIds.add(record.runId);
      }
    }
  }

  const history: HistoryItem[] = [];
  appendProviderRounds(
    history,
    recordsByAnchor.get(active.latestCompactionEntryId ?? null) ?? [],
  );
  let segmentStart = 0;
  for (let index = 0; index < active.activeEntries.length; index += 1) {
    const entry = active.activeEntries[index];
    if (entry === undefined) {
      continue;
    }
    const anchored = recordsByAnchor.get(entry.entryId);
    if (anchored === undefined) {
      continue;
    }
    appendTranscriptHistorySegment(
      history,
      active.activeEntries.slice(segmentStart, index + 1),
      coveredFunctionCallIds,
      providerMessageRunIds,
      args.artifactVersionsByRef,
      args.attachmentsById,
    );
    appendProviderRounds(history, anchored);
    segmentStart = index + 1;
  }
  appendTranscriptHistorySegment(
    history,
    active.activeEntries.slice(segmentStart),
    coveredFunctionCallIds,
    providerMessageRunIds,
    args.artifactVersionsByRef,
    args.attachmentsById,
  );
  return history;
}

function appendTranscriptHistorySegment(
  history: HistoryItem[],
  entries: TranscriptEntry[],
  coveredFunctionCallIds: ReadonlySet<string>,
  providerMessageRunIds: ReadonlySet<string>,
  artifactVersionsByRef: ReadonlyMap<string, ThreadArtifactVersion>,
  attachmentsById: ReadonlyMap<string, HistoryUserAttachment>,
): void {
  history.push(
    ...buildHistoryFromTranscript(
      entries.filter((entry) => {
        if (
          entry.role === 'assistant' &&
          entry.metadata?.sourceRunId !== undefined &&
          providerMessageRunIds.has(entry.metadata.sourceRunId)
        ) {
          return false;
        }
        if (entry.role !== 'tool_call') {
          return true;
        }
        const parsed = tryParseJsonRecord(entry.content);
        const callId = parsed.ok
          ? readString(parsed.value['callId'])
          : undefined;
        return callId === undefined || !coveredFunctionCallIds.has(callId);
      }),
      artifactVersionsByRef,
      attachmentsById,
    ),
  );
}

function appendProviderRounds(
  history: HistoryItem[],
  records: readonly ProviderRoundJournalRecord[],
): void {
  for (const record of records) {
    history.push(
      ...record.items.map(
        (data) =>
          ({
            kind: 'backend_item',
            data,
            providerReplayScopeId: record.replayScopeId,
          }) as const,
      ),
    );
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// 트랜스크립트가 참조하는 첨부 바이트를 스토어에서 읽어 모델 입력 형태로
// 준비한다. 유실된 첨부는 건너뛴다 — 히스토리 재구성이 막히면 안 된다.
async function loadTranscriptAttachmentContents(
  workspaceRoot: string,
  threadId: string,
  transcriptEntries: TranscriptEntry[],
): Promise<Map<string, HistoryUserAttachment>> {
  const contents = new Map<string, HistoryUserAttachment>();
  for (const entry of transcriptEntries) {
    if (entry.role !== 'user' || !entry.metadata) {
      continue;
    }
    const metadata = entry.metadata;
    if (!('attachments' in metadata) || !metadata.attachments) {
      continue;
    }
    for (const record of metadata.attachments) {
      const bytes = await readRunAttachment({
        workspaceRoot,
        threadId,
        attachmentId: record.attachmentId,
      });
      if (bytes === null) {
        continue;
      }
      contents.set(
        record.attachmentId,
        record.kind === 'text'
          ? {
              kind: 'text',
              name: record.name,
              text: bytes.toString('utf8'),
            }
          : {
              kind: record.kind,
              name: record.name,
              mimeType: record.mimeType,
              dataBase64: bytes.toString('base64'),
            },
      );
    }
  }
  return contents;
}

export function appendAssistantTextToHistory(
  history: HistoryItem[],
  assistantText: string,
  functionCalls: FunctionCall[],
): void {
  if (!assistantText) {
    return;
  }
  history.push({
    kind: 'assistant',
    phase: functionCalls.length > 0 ? 'commentary' : 'final_answer',
    text: assistantText,
  });
}

export function appendFunctionCallsToHistory(
  history: HistoryItem[],
  functionCalls: FunctionCall[],
): void {
  for (const functionCall of functionCalls) {
    history.push({
      kind: 'function_call',
      id: functionCall.id,
      callId: functionCall.callId,
      name: functionCall.name,
      arguments: functionCall.arguments,
    });
  }
}

export function appendInterjectToHistory(
  history: HistoryItem[],
  interject: PendingInterject,
): void {
  history.push({ kind: 'user', text: interject.text });
}

export async function persistSingleInterjectToTranscript(
  workspaceRoot: string,
  threadId: string,
  runId: string,
  interject: PendingInterject,
): Promise<{ appended: boolean }> {
  const sourceRunId = assertAgentRunId(runId);
  const entries = await readTranscriptEntries(workspaceRoot, threadId);
  const existing = entries.find(
    (entry) =>
      entry.metadata?.source === 'interject' &&
      entry.metadata.sourceRunId === sourceRunId &&
      entry.metadata.receivedSeq === interject.receivedSeq,
  );
  if (existing !== undefined) {
    if (existing.role !== 'user' || existing.content !== interject.text) {
      throw new Error(
        `interject transcript identity conflict: ${sourceRunId}:${interject.receivedSeq}`,
      );
    }
    return { appended: false };
  }
  await appendTranscriptEntry(workspaceRoot, threadId, {
    role: 'user',
    content: interject.text,
    timestamp: new Date().toISOString(),
    metadata: {
      source: 'interject',
      sourceRunId,
      receivedSeq: interject.receivedSeq,
    },
  });
  return { appended: true };
}
