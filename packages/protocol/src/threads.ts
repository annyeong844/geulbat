import {
  isProjectId,
  isThreadId,
  type ProjectId,
  type ThreadId,
} from './ids.js';
import { isRecord } from './runtime-utils.js';
import {
  isThreadArtifactVersion,
  type ThreadArtifactVersion,
} from './artifacts.js';
import {
  isThreadMessageMetadata,
  type ThreadMessageMetadata,
} from './thread-metadata.js';

export const THREAD_MESSAGE_ROLES = [
  'user',
  'assistant',
  'tool_call',
  'tool_result',
  'compaction',
] as const;

export type ThreadMessageRole = (typeof THREAD_MESSAGE_ROLES)[number];

export function isThreadMessageRole(
  value: unknown,
): value is ThreadMessageRole {
  return (
    typeof value === 'string' &&
    (THREAD_MESSAGE_ROLES as readonly string[]).includes(value)
  );
}

export interface ThreadSummary {
  threadId: ThreadId;
  projectId: ProjectId;
  title?: string;
  lastUpdated: string;
  messageCount: number;
}

export interface ThreadListResponse {
  threads: ThreadSummary[];
}

export interface ThreadDetailDiagnostics {
  unlinkedPersistedArtifactCount: number;
  missingLinkedArtifactCount: number;
}

export interface ThreadDetailResponse {
  threadId: ThreadId;
  projectId: ProjectId;
  snapshotVersion: string;
  messages: ThreadMessage[];
  artifacts?: ThreadArtifactVersion[];
  diagnostics?: ThreadDetailDiagnostics;
}

export interface ThreadDeleteResponse {
  ok: true;
  threadId: ThreadId;
  projectId: ProjectId;
}

export interface FileOps {
  readFiles: string[];
  modifiedFiles: string[];
  createdFiles?: string[];
  deletedFiles?: string[];
  renamedFiles?: Array<{ from: string; to: string }>;
}

export interface BudgetProfile {
  model: string;
  contextWindow: number;
  reserveTokens: number;
  thresholdTokens: number;
  keepRecentTokens: number;
  summaryBudgetTokens: number;
  requestOverheadTokens: number;
  requestProfileHash: string;
  compactionVersion: number;
}

export interface CompactionEntryData {
  summary: string;
  shortSummary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  budgetProfile: BudgetProfile;
  fileOps?: FileOps;
}

interface ThreadMessageBase {
  entryId: string;
  content: string;
  timestamp: string;
  metadata?: ThreadMessageMetadata;
}

export type CompactionThreadMessage = ThreadMessageBase & {
  role: 'compaction';
  compactionData: CompactionEntryData;
};

export type NonCompactionThreadMessage = ThreadMessageBase & {
  role: Exclude<ThreadMessageRole, 'compaction'>;
  compactionData?: never;
};

export type ThreadMessage =
  | CompactionThreadMessage
  | NonCompactionThreadMessage;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

type OptionalEntryId<T extends { entryId: string }> = T extends unknown
  ? DistributiveOmit<T, 'entryId'> & { entryId?: string }
  : never;

export type ThreadMessageInput = OptionalEntryId<ThreadMessage>;

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRenamedFileOp(
  value: unknown,
): value is { from: string; to: string } {
  return (
    isRecord(value) &&
    typeof value.from === 'string' &&
    typeof value.to === 'string'
  );
}

function isFileOps(value: unknown): value is FileOps {
  return (
    isRecord(value) &&
    isStringArray(value.readFiles) &&
    isStringArray(value.modifiedFiles) &&
    (value.createdFiles === undefined || isStringArray(value.createdFiles)) &&
    (value.deletedFiles === undefined || isStringArray(value.deletedFiles)) &&
    (value.renamedFiles === undefined ||
      (Array.isArray(value.renamedFiles) &&
        value.renamedFiles.every(isRenamedFileOp)))
  );
}

function isBudgetProfile(value: unknown): value is BudgetProfile {
  return (
    isRecord(value) &&
    typeof value.model === 'string' &&
    isFiniteNumber(value.contextWindow) &&
    isFiniteNumber(value.reserveTokens) &&
    isFiniteNumber(value.thresholdTokens) &&
    isFiniteNumber(value.keepRecentTokens) &&
    isFiniteNumber(value.summaryBudgetTokens) &&
    isFiniteNumber(value.requestOverheadTokens) &&
    typeof value.requestProfileHash === 'string' &&
    isFiniteNumber(value.compactionVersion)
  );
}

export function isCompactionEntryData(
  value: unknown,
): value is CompactionEntryData {
  return (
    isRecord(value) &&
    typeof value.summary === 'string' &&
    typeof value.shortSummary === 'string' &&
    typeof value.firstKeptEntryId === 'string' &&
    isFiniteNumber(value.tokensBefore) &&
    isBudgetProfile(value.budgetProfile) &&
    (value.fileOps === undefined || isFileOps(value.fileOps))
  );
}

export function isThreadMessage(value: unknown): value is ThreadMessage {
  if (
    !isRecord(value) ||
    typeof value.entryId !== 'string' ||
    value.entryId.trim() === '' ||
    !isThreadMessageRole(value.role) ||
    typeof value.content !== 'string' ||
    typeof value.timestamp !== 'string' ||
    (value.metadata !== undefined && !isThreadMessageMetadata(value.metadata))
  ) {
    return false;
  }
  if (value.role === 'compaction') {
    return isCompactionEntryData(value.compactionData);
  }
  return value.compactionData === undefined;
}

export function isThreadSummary(value: unknown): value is ThreadSummary {
  return (
    isRecord(value) &&
    typeof value.threadId === 'string' &&
    isThreadId(value.threadId) &&
    typeof value.projectId === 'string' &&
    isProjectId(value.projectId) &&
    (value.title === undefined || typeof value.title === 'string') &&
    typeof value.lastUpdated === 'string' &&
    typeof value.messageCount === 'number' &&
    Number.isFinite(value.messageCount)
  );
}

export function isThreadListResponse(
  value: unknown,
): value is ThreadListResponse {
  return (
    isRecord(value) &&
    Array.isArray(value.threads) &&
    value.threads.every(isThreadSummary)
  );
}

export function isThreadDetailDiagnostics(
  value: unknown,
): value is ThreadDetailDiagnostics {
  return (
    isRecord(value) &&
    typeof value.unlinkedPersistedArtifactCount === 'number' &&
    Number.isInteger(value.unlinkedPersistedArtifactCount) &&
    value.unlinkedPersistedArtifactCount >= 0 &&
    typeof value.missingLinkedArtifactCount === 'number' &&
    Number.isInteger(value.missingLinkedArtifactCount) &&
    value.missingLinkedArtifactCount >= 0
  );
}

export function isThreadDetailResponse(
  value: unknown,
): value is ThreadDetailResponse {
  return (
    isRecord(value) &&
    typeof value.threadId === 'string' &&
    isThreadId(value.threadId) &&
    typeof value.projectId === 'string' &&
    isProjectId(value.projectId) &&
    typeof value.snapshotVersion === 'string' &&
    value.snapshotVersion.trim() !== '' &&
    Array.isArray(value.messages) &&
    value.messages.every(isThreadMessage) &&
    (value.diagnostics === undefined ||
      isThreadDetailDiagnostics(value.diagnostics)) &&
    (value.artifacts === undefined ||
      (Array.isArray(value.artifacts) &&
        value.artifacts.every(isThreadArtifactVersion)))
  );
}

export function isThreadDeleteResponse(
  value: unknown,
): value is ThreadDeleteResponse {
  return (
    isRecord(value) &&
    value.ok === true &&
    typeof value.threadId === 'string' &&
    isThreadId(value.threadId) &&
    typeof value.projectId === 'string' &&
    isProjectId(value.projectId)
  );
}
