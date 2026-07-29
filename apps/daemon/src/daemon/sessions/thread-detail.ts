import { stat } from 'node:fs/promises';

import {
  isRunModelId,
  resolveRunModelDescriptor,
  type RunModelId,
} from '@geulbat/protocol/run-contract';
import {
  createSessionArtifactRefKey as createArtifactRefKey,
  readSessionActiveArtifactRefFromMetadata as readActiveArtifactRefFromMetadata,
  readSessionArtifactRefsFromMetadata as readArtifactRefsFromMetadata,
  type ThreadArtifactVersion,
  type ThreadDetailResponse,
  type ThreadId,
  type ThreadMessage,
  type ThreadMessagePageResponse,
  type ThreadOpenResponse,
  type ThreadRunPreferences,
} from './contract.js';
import { createLogger } from '@geulbat/structured-logger/logger';

import { loadAllThreadArtifactVersions } from './artifact-store.js';
import { artifactStoreFilePath, threadFilePath } from './paths.js';
import {
  readProviderRoundHistory,
  type ProviderRoundJournalRecord,
} from './provider-round-journal.js';
import { readTranscriptEntries } from './transcript-log.js';
import { loadThreadIndex } from './threads-index.js';
import {
  createRunCheckpointStore,
  type RunCheckpoint,
} from './run-checkpoint-store.js';
import { isRecord } from '../runtime-json.js';
import { isNotFoundError } from '../utils/error.js';

const logger = createLogger('thread-detail');

interface ThreadDetailDiagnostics {
  unlinkedPersistedArtifactCount: number;
  missingLinkedArtifactCount: number;
}

export async function loadThreadDetailSnapshot(args: {
  workspaceRoot: string;
  threadId: ThreadId;
  includeActiveRunCommentary?: boolean;
}): Promise<ThreadDetailResponse> {
  const [messages, artifacts, snapshotVersion, checkpoint, providerRounds] =
    await Promise.all([
      readTranscriptEntries(args.workspaceRoot, args.threadId),
      loadAllThreadArtifactVersions(args.workspaceRoot, args.threadId),
      resolveThreadSnapshotVersion(args),
      createRunCheckpointStore({
        stateRoot: args.workspaceRoot,
      }).readThread(args.threadId),
      readProviderRoundHistory(args.workspaceRoot, args.threadId),
    ]);
  const activeModelId = resolveThreadActiveModelId(
    messages,
    checkpoint,
    providerRounds,
  );
  const runPreferences = resolveThreadRunPreferences(checkpoint);
  const diagnostics = collectThreadDetailDiagnostics(messages, artifacts);
  emitThreadDetailDiagnostics(args.threadId, diagnostics);
  const publicMessages = projectThreadPublicMessages(
    messages,
    providerRounds,
    checkpoint,
    args.includeActiveRunCommentary === true,
  );

  return {
    threadId: args.threadId,
    snapshotVersion,
    ...(activeModelId === undefined ? {} : { activeModelId }),
    ...(runPreferences === undefined ? {} : { runPreferences }),
    messages: publicMessages,
    artifacts,
    ...(diagnostics ? { diagnostics } : {}),
  };
}

export async function loadThreadOpenSnapshot(args: {
  workspaceRoot: string;
  threadId: ThreadId;
}): Promise<ThreadOpenResponse> {
  const { messages, ...detail } = await loadThreadDetailSnapshot(args);
  const messagePage = selectThreadMessagePage({
    threadId: args.threadId,
    messages,
  });
  if (messagePage === null) {
    throw new Error('latest thread message page could not be selected');
  }
  return { ...detail, messagePage };
}

export async function loadThreadMessagePage(args: {
  workspaceRoot: string;
  threadId: ThreadId;
  beforeEntryId: string;
}): Promise<ThreadMessagePageResponse | null> {
  const [messages, checkpoint, providerRounds] = await Promise.all([
    readTranscriptEntries(args.workspaceRoot, args.threadId),
    createRunCheckpointStore({
      stateRoot: args.workspaceRoot,
    }).readThread(args.threadId),
    readProviderRoundHistory(args.workspaceRoot, args.threadId),
  ]);
  return selectThreadMessagePage({
    threadId: args.threadId,
    messages: projectThreadPublicMessages(
      messages,
      providerRounds,
      checkpoint,
      false,
    ),
    beforeEntryId: args.beforeEntryId,
  });
}

export function selectThreadMessagePage(args: {
  threadId: ThreadId;
  messages: ThreadDetailResponse['messages'];
  beforeEntryId?: string;
}): ThreadMessagePageResponse | null {
  const end =
    args.beforeEntryId === undefined
      ? args.messages.length
      : args.messages.findIndex(
          (message) => message.entryId === args.beforeEntryId,
        );
  if (end < 0) {
    return null;
  }
  if (end === 0) {
    return {
      threadId: args.threadId,
      messages: [],
      olderBeforeEntryId: null,
    };
  }

  // 한 페이지는 숫자 cap이 아니라 완전한 사용자 턴이다. 현재 prefix의
  // 마지막 user부터 바로 다음 user 직전까지가 한 페이지이며, user가 없는
  // legacy prefix는 그 prefix 전체를 하나의 완전한 페이지로 취급한다.
  let start = 0;
  for (let index = end - 1; index >= 0; index -= 1) {
    if (args.messages[index]?.role === 'user') {
      start = index;
      break;
    }
  }
  const messages = args.messages.slice(start, end);
  return {
    threadId: args.threadId,
    messages,
    olderBeforeEntryId: start === 0 ? null : (messages[0]?.entryId ?? null),
  };
}

function projectThreadPublicMessages(
  messages: readonly ThreadMessage[],
  providerRounds: readonly ProviderRoundJournalRecord[],
  checkpoint: RunCheckpoint | null,
  includeActiveRunCommentary: boolean,
): ThreadDetailResponse['messages'] {
  return projectProviderCommentaryMessages(
    messages,
    providerRounds,
    includeActiveRunCommentary
      ? undefined
      : checkpoint?.status === 'running'
        ? checkpoint.runId
        : undefined,
  ).filter(
    (message): message is ThreadDetailResponse['messages'][number] =>
      message.role !== 'compaction',
  );
}

function resolveThreadRunPreferences(
  checkpoint: RunCheckpoint | null,
): ThreadRunPreferences | undefined {
  if (checkpoint === null) {
    return undefined;
  }
  const request = checkpoint.request;
  return {
    workingDirectory: request.workingDirectory,
    permissionMode: request.permissionMode,
    ...(request.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: request.reasoningEffort }),
    ...(request.serviceTier === undefined
      ? {}
      : { serviceTier: request.serviceTier }),
    ...(request.subagentModelRouting === undefined
      ? {}
      : { subagentModelRouting: request.subagentModelRouting }),
  };
}

function projectProviderCommentaryMessages(
  messages: readonly ThreadMessage[],
  providerRounds: readonly ProviderRoundJournalRecord[],
  activeRunId: string | undefined,
): ThreadMessage[] {
  const persistedCommentaryRunIds = new Set(
    messages.flatMap((message) =>
      message.role === 'assistant' &&
      message.metadata?.phase === 'commentary' &&
      message.metadata.sourceRunId !== undefined
        ? [message.metadata.sourceRunId]
        : [],
    ),
  );
  const messageEntryIds = new Set(messages.map((message) => message.entryId));
  const projectedBeforeFirst: ThreadMessage[] = [];
  const projectedByAnchor = new Map<string, ThreadMessage[]>();

  for (const record of providerRounds) {
    if (
      record.runId === activeRunId ||
      persistedCommentaryRunIds.has(record.runId)
    ) {
      continue;
    }
    const projected = record.items.flatMap((item, itemIndex) => {
      const text = readProviderCommentaryText(item);
      if (text === undefined) {
        return [];
      }
      return [
        {
          entryId: `${record.threadId}:provider-commentary:${record.runId}:${record.round}:${itemIndex}`,
          role: 'assistant' as const,
          content: text,
          timestamp: record.createdAt,
          metadata: {
            phase: 'commentary' as const,
            sourceRunId: record.runId,
          },
        },
      ];
    });
    if (projected.length === 0) {
      continue;
    }
    const anchor = record.precedingTranscriptEntryId;
    if (anchor === null) {
      if (messages.length === 0) {
        projectedBeforeFirst.push(...projected);
      }
      continue;
    }
    if (!messageEntryIds.has(anchor)) {
      continue;
    }
    const existing = projectedByAnchor.get(anchor);
    if (existing === undefined) {
      projectedByAnchor.set(anchor, projected);
    } else {
      existing.push(...projected);
    }
  }

  const result = [...projectedBeforeFirst];
  for (const message of messages) {
    result.push(message);
    result.push(...(projectedByAnchor.get(message.entryId) ?? []));
  }
  return result;
}

function readProviderCommentaryText(item: unknown): string | undefined {
  if (
    !isRecord(item) ||
    item['type'] !== 'message' ||
    item['phase'] !== 'commentary' ||
    !Array.isArray(item['content'])
  ) {
    return undefined;
  }
  let text = '';
  for (const part of item['content']) {
    if (
      isRecord(part) &&
      part['type'] === 'output_text' &&
      typeof part['text'] === 'string'
    ) {
      text += part['text'];
    }
  }
  return text.trim() === '' ? undefined : text;
}

interface ThreadActiveModelCandidate {
  modelId: RunModelId;
  selectedAt: string;
}

function resolveThreadActiveModelId(
  messages: readonly ThreadMessage[],
  checkpoint: RunCheckpoint | null,
  providerRounds: readonly ProviderRoundJournalRecord[],
): RunModelId | undefined {
  const candidates: ThreadActiveModelCandidate[] = [];
  const providerModel = checkpoint?.request.providerModel;
  if (checkpoint !== null && providerModel !== undefined) {
    appendThreadActiveModelCandidate(
      candidates,
      providerModel.providerId,
      providerModel.model,
      checkpoint.createdAt,
    );
  }

  let latestCompactionIndex = -1;
  const transcriptIndexById = new Map<string, number>();
  messages.forEach((message, index) => {
    transcriptIndexById.set(message.entryId, index);
    if (message.role !== 'compaction') {
      return;
    }
    latestCompactionIndex = index;
    const data = message.compactionData;
    if (!('kind' in data)) {
      return;
    }
    if (data.kind === 'provider_native') {
      appendThreadActiveModelCandidate(
        candidates,
        data.providerId,
        data.model,
        message.timestamp,
      );
      return;
    }
    appendThreadActiveModelCandidate(
      candidates,
      data.targetProviderId,
      data.targetModel,
      message.timestamp,
    );
  });

  const latestCompactionEntryId =
    latestCompactionIndex < 0
      ? undefined
      : messages[latestCompactionIndex]?.entryId;
  for (const record of providerRounds) {
    const anchor = record.precedingTranscriptEntryId;
    const anchorIndex =
      anchor === null ? undefined : transcriptIndexById.get(anchor);
    const reachable =
      anchor === latestCompactionEntryId ||
      (anchor === null
        ? latestCompactionIndex < 0
        : anchorIndex !== undefined && anchorIndex > latestCompactionIndex);
    if (!reachable) {
      continue;
    }
    appendThreadActiveModelCandidate(
      candidates,
      record.providerId,
      record.model,
      record.createdAt,
    );
  }

  let latest: ThreadActiveModelCandidate | undefined;
  for (const candidate of candidates) {
    if (
      latest === undefined ||
      candidate.selectedAt.localeCompare(latest.selectedAt) >= 0
    ) {
      latest = candidate;
    }
  }
  return latest?.modelId;
}

function appendThreadActiveModelCandidate(
  candidates: ThreadActiveModelCandidate[],
  providerId: string,
  model: string,
  selectedAt: string,
): void {
  if (!isRunModelId(model)) {
    return;
  }
  if (resolveRunModelDescriptor(model).providerId !== providerId) {
    return;
  }
  candidates.push({ modelId: model, selectedAt });
}

async function resolveThreadSnapshotVersion(args: {
  workspaceRoot: string;
  threadId: ThreadId;
}): Promise<string> {
  const entries = await loadThreadIndex(args.workspaceRoot);
  const summary = entries.find((entry) => entry.threadId === args.threadId);
  if (summary) {
    return summary.lastUpdated;
  }

  return resolveThreadSnapshotVersionFromFiles(
    args.workspaceRoot,
    args.threadId,
  );
}

async function resolveThreadSnapshotVersionFromFiles(
  workspaceRoot: string,
  threadId: ThreadId,
): Promise<string> {
  const snapshotCandidates = await Promise.all([
    readFileMtimeIso(threadFilePath(workspaceRoot, threadId)),
    readFileMtimeIso(artifactStoreFilePath(workspaceRoot, threadId)),
  ]);
  let latestTimestamp = '1970-01-01T00:00:00.000Z';
  for (const candidate of snapshotCandidates) {
    if (candidate && candidate.localeCompare(latestTimestamp) > 0) {
      latestTimestamp = candidate;
    }
  }
  return latestTimestamp;
}

async function readFileMtimeIso(filePath: string): Promise<string | null> {
  try {
    return (await stat(filePath)).mtime.toISOString();
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

function collectThreadDetailDiagnostics(
  messages: Array<{
    metadata?: Parameters<typeof readArtifactRefsFromMetadata>[0];
  }>,
  artifacts: ThreadArtifactVersion[],
): ThreadDetailDiagnostics | null {
  const artifactKeys = new Set(
    artifacts.map((artifact) =>
      createArtifactRefKey({
        artifactId: artifact.artifactId,
        version: artifact.version,
      }),
    ),
  );
  const linkedArtifactKeys = new Set<string>();
  const missingLinkedArtifactKeys = new Set<string>();

  for (const message of messages) {
    const activeArtifactRef = readActiveArtifactRefFromMetadata(
      message.metadata,
    );
    if (activeArtifactRef) {
      const activeKey = createArtifactRefKey(activeArtifactRef);
      linkedArtifactKeys.add(activeKey);
      if (!artifactKeys.has(activeKey)) {
        missingLinkedArtifactKeys.add(activeKey);
      }
    }
    for (const ref of readArtifactRefsFromMetadata(message.metadata)) {
      const refKey = createArtifactRefKey(ref);
      linkedArtifactKeys.add(refKey);
      if (!artifactKeys.has(refKey)) {
        missingLinkedArtifactKeys.add(refKey);
      }
    }
  }

  const unlinkedPersistedArtifactCount = artifacts.reduce((count, artifact) => {
    const key = createArtifactRefKey({
      artifactId: artifact.artifactId,
      version: artifact.version,
    });
    return linkedArtifactKeys.has(key) ? count : count + 1;
  }, 0);

  const missingLinkedArtifactCount = missingLinkedArtifactKeys.size;

  if (
    unlinkedPersistedArtifactCount === 0 &&
    missingLinkedArtifactCount === 0
  ) {
    return null;
  }

  return {
    unlinkedPersistedArtifactCount,
    missingLinkedArtifactCount,
  };
}

function emitThreadDetailDiagnostics(
  threadId: ThreadId,
  diagnostics: ThreadDetailDiagnostics | null,
): void {
  if (!diagnostics) {
    return;
  }

  const { unlinkedPersistedArtifactCount, missingLinkedArtifactCount } =
    diagnostics;
  if (unlinkedPersistedArtifactCount > 0) {
    logger.warn(
      `thread ${threadId} has ${unlinkedPersistedArtifactCount} persisted artifact${unlinkedPersistedArtifactCount === 1 ? '' : 's'} without transcript linkage.`,
    );
  }
  if (missingLinkedArtifactCount > 0) {
    logger.warn(
      `thread ${threadId} has ${missingLinkedArtifactCount} transcript artifact linkage${missingLinkedArtifactCount === 1 ? '' : 's'} pointing to missing persisted artifacts.`,
    );
  }
}
