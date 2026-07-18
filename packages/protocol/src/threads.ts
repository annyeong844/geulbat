import { isThreadId, type ThreadId } from './ids.js';
import {
  isProviderAuthProviderId,
  type ProviderAuthProviderId,
} from './provider-auth.js';
import {
  isRunModelId,
  isRunReasoningEffort,
  type RunModelId,
  type RunReasoningEffort,
} from './run-contract.js';
import { isRecord } from './runtime-utils.js';
import { isJsonValue, type JsonValue } from './runtime-persistence.js';
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

function isThreadMessageRole(value: unknown): value is ThreadMessageRole {
  return (
    typeof value === 'string' &&
    (THREAD_MESSAGE_ROLES as readonly string[]).includes(value)
  );
}

export interface ThreadSummary {
  threadId: ThreadId;
  title?: string;
  lastUpdated: string;
  messageCount: number;
}

export interface ThreadListResponse {
  threads: ThreadSummary[];
}

interface ThreadDetailDiagnostics {
  unlinkedPersistedArtifactCount: number;
  missingLinkedArtifactCount: number;
}

export interface ThreadDetailResponse {
  threadId: ThreadId;
  snapshotVersion: string;
  messages: NonCompactionThreadMessage[];
  artifacts?: ThreadArtifactVersion[];
  diagnostics?: ThreadDetailDiagnostics;
}

export interface ThreadDeleteResponse {
  ok: true;
  threadId: ThreadId;
}

// POST /api/threads/:threadId/branch — 원 스레드 prefix를 복제한 새 스레드
export interface ThreadBranchResponse {
  ok: true;
  threadId: ThreadId;
  sourceThreadId: ThreadId;
  copiedMessageCount: number;
}

export interface PrepareProviderTransitionRequest {
  sourceModelId: RunModelId;
  targetModelId: RunModelId;
  reasoningEffort: RunReasoningEffort;
}

interface PrepareProviderTransitionResponseBase {
  ok: true;
  threadId: ThreadId;
  sourceModelId: RunModelId;
  targetModelId: RunModelId;
}

export type PrepareProviderTransitionResponse =
  | (PrepareProviderTransitionResponseBase & { status: 'not_needed' })
  | (PrepareProviderTransitionResponseBase & {
      status: 'compacted';
      compactionEntryId: string;
    });

interface FileOps {
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

export interface SummaryCompactionEntryData {
  summary: string;
  shortSummary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  budgetProfile: BudgetProfile;
  fileOps?: FileOps;
}

export type ProviderNativeCompactionOutputItem = Record<string, JsonValue>;

export interface ProviderNativeCompactionEntryData {
  kind: 'provider_native';
  providerId: string;
  model: string;
  output: ProviderNativeCompactionOutputItem[];
  tokensBefore: number;
  contextWindow: number;
  thresholdTokens: number;
}

export interface ProviderTransitionCompactionEntryData {
  kind: 'provider_transition';
  sourceProviderId: ProviderAuthProviderId;
  sourceModel: string;
  targetProviderId: ProviderAuthProviderId;
  targetModel: string;
  summary: string;
  coveredThroughEntryId: string;
  inputTokens?: number;
}

type CompactionEntryData =
  | SummaryCompactionEntryData
  | ProviderNativeCompactionEntryData
  | ProviderTransitionCompactionEntryData;

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

type NonCompactionThreadMessage = ThreadMessageBase & {
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
  if (
    isProviderNativeCompactionEntryData(value) ||
    isProviderTransitionCompactionEntryData(value)
  ) {
    return true;
  }
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

export function isProviderTransitionCompactionEntryData(
  value: unknown,
): value is ProviderTransitionCompactionEntryData {
  if (!isRecord(value)) {
    return false;
  }
  const inputTokens = value.inputTokens;
  return (
    value.kind === 'provider_transition' &&
    isProviderAuthProviderId(value.sourceProviderId) &&
    typeof value.sourceModel === 'string' &&
    value.sourceModel.trim() !== '' &&
    isProviderAuthProviderId(value.targetProviderId) &&
    value.targetProviderId !== value.sourceProviderId &&
    typeof value.targetModel === 'string' &&
    value.targetModel.trim() !== '' &&
    typeof value.summary === 'string' &&
    value.summary.trim() !== '' &&
    typeof value.coveredThroughEntryId === 'string' &&
    value.coveredThroughEntryId.trim() !== '' &&
    (inputTokens === undefined ||
      (typeof inputTokens === 'number' &&
        Number.isSafeInteger(inputTokens) &&
        inputTokens >= 0))
  );
}

export function isProviderNativeCompactionEntryData(
  value: unknown,
): value is ProviderNativeCompactionEntryData {
  if (!isRecord(value)) {
    return false;
  }
  const tokensBefore = value.tokensBefore;
  const contextWindow = value.contextWindow;
  const thresholdTokens = value.thresholdTokens;
  return (
    value.kind === 'provider_native' &&
    typeof value.providerId === 'string' &&
    value.providerId.trim() !== '' &&
    typeof value.model === 'string' &&
    value.model.trim() !== '' &&
    Array.isArray(value.output) &&
    value.output.length > 0 &&
    value.output.every((item) => isRecord(item) && isJsonValue(item)) &&
    value.output.some(
      (item) =>
        (item['type'] === 'compaction' ||
          item['type'] === 'compaction_summary') &&
        typeof item['encrypted_content'] === 'string' &&
        item['encrypted_content'].trim() !== '',
    ) &&
    typeof tokensBefore === 'number' &&
    Number.isSafeInteger(tokensBefore) &&
    tokensBefore >= 0 &&
    typeof contextWindow === 'number' &&
    Number.isSafeInteger(contextWindow) &&
    contextWindow > 0 &&
    typeof thresholdTokens === 'number' &&
    Number.isSafeInteger(thresholdTokens) &&
    thresholdTokens > 0 &&
    thresholdTokens <= contextWindow
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

export function isPrepareProviderTransitionRequest(
  value: unknown,
): value is PrepareProviderTransitionRequest {
  return (
    isRecord(value) &&
    isRunModelId(value.sourceModelId) &&
    isRunModelId(value.targetModelId) &&
    isRunReasoningEffort(value.reasoningEffort)
  );
}

export function isPrepareProviderTransitionResponse(
  value: unknown,
): value is PrepareProviderTransitionResponse {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    typeof value.threadId !== 'string' ||
    !isThreadId(value.threadId) ||
    !isRunModelId(value.sourceModelId) ||
    !isRunModelId(value.targetModelId)
  ) {
    return false;
  }
  if (value.status === 'not_needed') {
    return value.compactionEntryId === undefined;
  }
  return (
    value.status === 'compacted' &&
    typeof value.compactionEntryId === 'string' &&
    value.compactionEntryId.trim() !== ''
  );
}

export function isThreadSummary(value: unknown): value is ThreadSummary {
  return (
    isRecord(value) &&
    typeof value.threadId === 'string' &&
    isThreadId(value.threadId) &&
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
    typeof value.snapshotVersion === 'string' &&
    value.snapshotVersion.trim() !== '' &&
    Array.isArray(value.messages) &&
    value.messages.every(
      (message) => isThreadMessage(message) && message.role !== 'compaction',
    ) &&
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
    isThreadId(value.threadId)
  );
}

export function isThreadBranchResponse(
  value: unknown,
): value is ThreadBranchResponse {
  return (
    isRecord(value) &&
    value.ok === true &&
    typeof value.threadId === 'string' &&
    isThreadId(value.threadId) &&
    typeof value.sourceThreadId === 'string' &&
    isThreadId(value.sourceThreadId) &&
    typeof value.copiedMessageCount === 'number' &&
    Number.isSafeInteger(value.copiedMessageCount) &&
    value.copiedMessageCount >= 0
  );
}
