import { isRunId, isThreadId, type RunId, type ThreadId } from './ids.js';
import {
  isProviderReplayScopeId,
  type ProviderReplayScopeId,
} from './provider-auth.js';
import { isPermissionMode, type PermissionMode } from './run-approval.js';
import {
  isRunModelId,
  isRunProviderId,
  isRunReasoningEffort,
  isRunServiceTier,
  isRunSubagentModelRouting,
  type RunModelId,
  type RunProviderId,
  type RunReasoningEffort,
  type RunServiceTier,
  type RunSubagentModelRouting,
} from './run-contract.js';
import { isCanonicalIsoTimestamp, isRecord } from './wire-value-guards.js';
import { isJsonValue, type JsonValue } from './runtime-persistence.js';
import {
  isThreadArtifactVersion,
  type ThreadArtifactVersion,
} from './artifacts.js';
import {
  isThreadMessageMetadata,
  type ThreadMessageMetadata,
} from './thread-metadata.js';
import {
  isAgentChildTerminalReason,
  isAgentChildTerminalState,
  isSubagentResultReport,
  type AgentChildTerminalReason,
  type AgentChildTerminalState,
  type SubagentResultReport,
} from './subagent-terminal.js';
import {
  isRunUsageTotals,
  isSubagentCapabilities,
  isSubagentRuntimeDiagnostics,
  isSubagentToolSurfaceProfile,
  isSubagentType,
  type RunUsageTotals,
  type SubagentCapability,
  type SubagentRuntimeDiagnostics,
  type SubagentToolSurfaceProfile,
  type SubagentType,
} from './run-runtime-status.js';

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
  // 목록 상단 고정 — 세션 목록 UI 전용 표시 상태
  pinned?: boolean;
}

export interface ThreadListResponse {
  threads: ThreadSummary[];
}

interface ThreadDetailDiagnostics {
  unlinkedPersistedArtifactCount: number;
  missingLinkedArtifactCount: number;
}

export interface ThreadSubagentTerminalOutcome {
  deliveryId: string;
  resultRef?: string;
  resultDigest?: `sha256:${string}`;
  resultReport?: SubagentResultReport;
  parentRunId: RunId;
  childRunId: RunId;
  childThreadId?: ThreadId;
  subagentType: SubagentType;
  capabilities?: readonly SubagentCapability[];
  toolSurface?: SubagentToolSurfaceProfile;
  runtime?: SubagentRuntimeDiagnostics;
  terminalState: AgentChildTerminalState;
  reason?: AgentChildTerminalReason;
  result: string;
  completedAt: string;
  elapsedMs?: number;
  usage?: RunUsageTotals;
  modelId?: string;
  reasoningEffort?: RunReasoningEffort;
}

export interface ThreadRunPreferences {
  workingDirectory: string;
  permissionMode?: PermissionMode;
  reasoningEffort?: RunReasoningEffort;
  serviceTier?: RunServiceTier;
  subagentModelRouting?: RunSubagentModelRouting;
}

export interface ThreadDetailResponse {
  threadId: ThreadId;
  snapshotVersion: string;
  activeModelId?: RunModelId;
  runPreferences?: ThreadRunPreferences;
  messages: NonCompactionThreadMessage[];
  artifacts?: ThreadArtifactVersion[];
  diagnostics?: ThreadDetailDiagnostics;
  subagentTerminalOutcomes?: ThreadSubagentTerminalOutcome[];
}

export interface ThreadDeleteResponse {
  ok: true;
  threadId: ThreadId;
}

// PATCH /api/threads/:threadId — 세션 목록에 표시되는 제목만 바꾼다
export interface ThreadRenameResponse {
  ok: true;
  threadId: ThreadId;
  title: string;
}

// POST /api/threads/:threadId/branch — 원 스레드 prefix를 복제한 새 스레드
export interface ThreadBranchResponse {
  ok: true;
  threadId: ThreadId;
  sourceThreadId: ThreadId;
  copiedMessageCount: number;
}

export const THREAD_ARCHIVE_MEDIA_TYPE =
  'application/vnd.geulbat.thread-archive';

export interface ThreadArchiveImportResponse {
  ok: true;
  threadId: ThreadId;
  archiveId: `sha256:${string}`;
  importedMessageCount: number;
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

export interface ProviderNativeCompactionEvidenceRef {
  callId: string;
  toolName: string;
  outcome: 'success' | 'failure' | 'unknown';
  fullOutputBytes: number;
  outputRef: string;
}

export interface ProviderNativeCompactionEvidencePage {
  outputRef: string;
  offset: number;
  endOffset: number;
  totalChars: number;
}

export interface ProviderNativeCompactionEntryData {
  kind: 'provider_native';
  providerId: string;
  model: string;
  replayScopeId?: ProviderReplayScopeId;
  output: ProviderNativeCompactionOutputItem[];
  tokensBefore: number;
  contextWindow: number;
  thresholdTokens: number;
  firstKeptEntryId?: string;
  coveredThroughEntryId?: string;
  historyBytesBefore?: number;
  historyBytesAfter?: number;
  evidence?: ProviderNativeCompactionEvidenceRef[];
  expandedEvidencePages?: ProviderNativeCompactionEvidencePage[];
}

export interface ProviderTransitionCompactionEntryData {
  kind: 'provider_transition';
  sourceProviderId: RunProviderId;
  sourceModel: string;
  targetProviderId: RunProviderId;
  targetModel: string;
  summary: string;
  coveredThroughEntryId: string;
  firstKeptEntryId?: string;
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
    isRunProviderId(value.sourceProviderId) &&
    typeof value.sourceModel === 'string' &&
    value.sourceModel.trim() !== '' &&
    isRunProviderId(value.targetProviderId) &&
    value.targetProviderId !== value.sourceProviderId &&
    typeof value.targetModel === 'string' &&
    value.targetModel.trim() !== '' &&
    typeof value.summary === 'string' &&
    value.summary.trim() !== '' &&
    typeof value.coveredThroughEntryId === 'string' &&
    value.coveredThroughEntryId.trim() !== '' &&
    (value.firstKeptEntryId === undefined ||
      (typeof value.firstKeptEntryId === 'string' &&
        value.firstKeptEntryId.trim() !== '')) &&
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
  const firstKeptEntryId = value.firstKeptEntryId;
  const coveredThroughEntryId = value.coveredThroughEntryId;
  const historyBytesBefore = value.historyBytesBefore;
  const historyBytesAfter = value.historyBytesAfter;
  const hasLegacyBoundary =
    firstKeptEntryId === undefined && coveredThroughEntryId === undefined;
  const hasRetainedTailBoundary =
    typeof firstKeptEntryId === 'string' &&
    firstKeptEntryId.trim() !== '' &&
    typeof coveredThroughEntryId === 'string' &&
    coveredThroughEntryId.trim() !== '';
  const hasNoHistoryByteMeasurement =
    historyBytesBefore === undefined && historyBytesAfter === undefined;
  const hasUsefulHistoryByteMeasurement =
    typeof historyBytesBefore === 'number' &&
    Number.isSafeInteger(historyBytesBefore) &&
    historyBytesBefore > 0 &&
    typeof historyBytesAfter === 'number' &&
    Number.isSafeInteger(historyBytesAfter) &&
    historyBytesAfter >= 0 &&
    historyBytesAfter < historyBytesBefore;
  return (
    value.kind === 'provider_native' &&
    typeof value.providerId === 'string' &&
    value.providerId.trim() !== '' &&
    typeof value.model === 'string' &&
    value.model.trim() !== '' &&
    (value.replayScopeId === undefined ||
      isProviderReplayScopeId(value.replayScopeId)) &&
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
    thresholdTokens <= contextWindow &&
    (hasLegacyBoundary || hasRetainedTailBoundary) &&
    (hasNoHistoryByteMeasurement || hasUsefulHistoryByteMeasurement) &&
    (value.evidence === undefined ||
      (Array.isArray(value.evidence) &&
        value.evidence.every(isProviderNativeCompactionEvidenceRef))) &&
    (value.expandedEvidencePages === undefined ||
      (Array.isArray(value.expandedEvidencePages) &&
        value.expandedEvidencePages.every(
          isProviderNativeCompactionEvidencePage,
        )))
  );
}

function isProviderNativeCompactionEvidenceRef(
  value: unknown,
): value is ProviderNativeCompactionEvidenceRef {
  return (
    isRecord(value) &&
    typeof value.callId === 'string' &&
    value.callId.trim() !== '' &&
    typeof value.toolName === 'string' &&
    value.toolName.trim() !== '' &&
    (value.outcome === 'success' ||
      value.outcome === 'failure' ||
      value.outcome === 'unknown') &&
    typeof value.fullOutputBytes === 'number' &&
    Number.isSafeInteger(value.fullOutputBytes) &&
    value.fullOutputBytes >= 0 &&
    typeof value.outputRef === 'string' &&
    (value.outputRef.startsWith('tool-output:') ||
      value.outputRef.startsWith('command-output:'))
  );
}

function isProviderNativeCompactionEvidencePage(
  value: unknown,
): value is ProviderNativeCompactionEvidencePage {
  return (
    isRecord(value) &&
    typeof value.outputRef === 'string' &&
    value.outputRef.startsWith('tool-output:') &&
    typeof value.offset === 'number' &&
    Number.isSafeInteger(value.offset) &&
    value.offset >= 0 &&
    typeof value.endOffset === 'number' &&
    Number.isSafeInteger(value.endOffset) &&
    value.endOffset >= value.offset &&
    typeof value.totalChars === 'number' &&
    Number.isSafeInteger(value.totalChars) &&
    value.totalChars >= value.endOffset
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
    Number.isFinite(value.messageCount) &&
    (value.pinned === undefined || typeof value.pinned === 'boolean')
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

export function isThreadSubagentTerminalOutcome(
  value: unknown,
): value is ThreadSubagentTerminalOutcome {
  if (
    !isRecord(value) ||
    typeof value.deliveryId !== 'string' ||
    value.deliveryId.trim() === '' ||
    (value.resultRef !== undefined &&
      (typeof value.resultRef !== 'string' || value.resultRef.trim() === '')) ||
    (value.resultDigest !== undefined &&
      (typeof value.resultDigest !== 'string' ||
        !/^sha256:[a-f0-9]{64}$/u.test(value.resultDigest))) ||
    (value.resultReport !== undefined &&
      (!isSubagentResultReport(value.resultReport) ||
        value.resultReport.sourceResultRef !== value.resultRef ||
        value.resultReport.sourceResultDigest !== value.resultDigest)) ||
    typeof value.parentRunId !== 'string' ||
    !isRunId(value.parentRunId) ||
    typeof value.childRunId !== 'string' ||
    !isRunId(value.childRunId) ||
    (value.childThreadId !== undefined &&
      (typeof value.childThreadId !== 'string' ||
        !isThreadId(value.childThreadId))) ||
    !isSubagentType(value.subagentType) ||
    !isAgentChildTerminalState(value.terminalState) ||
    (value.reason !== undefined && !isAgentChildTerminalReason(value.reason)) ||
    typeof value.result !== 'string' ||
    !isCanonicalIsoTimestamp(value.completedAt) ||
    (value.elapsedMs !== undefined &&
      (typeof value.elapsedMs !== 'number' ||
        !Number.isFinite(value.elapsedMs))) ||
    (value.modelId !== undefined && typeof value.modelId !== 'string') ||
    (value.reasoningEffort !== undefined &&
      !isRunReasoningEffort(value.reasoningEffort)) ||
    (value.usage !== undefined && !isRunUsageTotals(value.usage)) ||
    (value.runtime !== undefined &&
      !isSubagentRuntimeDiagnostics(value.runtime))
  ) {
    return false;
  }
  if (value.capabilities === undefined && value.toolSurface === undefined) {
    return true;
  }
  if (
    !isSubagentCapabilities(value.capabilities) ||
    !isSubagentToolSurfaceProfile(value.toolSurface)
  ) {
    return false;
  }
  if (value.subagentType === 'worker') {
    return value.capabilities.length === 0 && value.toolSurface === 'worker';
  }
  return value.capabilities.includes('ptc')
    ? value.toolSurface === 'explorer_ptc'
    : value.toolSurface === 'explorer';
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
    (value.activeModelId === undefined || isRunModelId(value.activeModelId)) &&
    (value.runPreferences === undefined ||
      isThreadRunPreferences(value.runPreferences)) &&
    Array.isArray(value.messages) &&
    value.messages.every(
      (message) => isThreadMessage(message) && message.role !== 'compaction',
    ) &&
    (value.diagnostics === undefined ||
      isThreadDetailDiagnostics(value.diagnostics)) &&
    (value.artifacts === undefined ||
      (Array.isArray(value.artifacts) &&
        value.artifacts.every(isThreadArtifactVersion))) &&
    (value.subagentTerminalOutcomes === undefined ||
      (Array.isArray(value.subagentTerminalOutcomes) &&
        value.subagentTerminalOutcomes.every(isThreadSubagentTerminalOutcome)))
  );
}

function isThreadRunPreferences(value: unknown): value is ThreadRunPreferences {
  return (
    isRecord(value) &&
    typeof value.workingDirectory === 'string' &&
    (value.permissionMode === undefined ||
      isPermissionMode(value.permissionMode)) &&
    (value.reasoningEffort === undefined ||
      isRunReasoningEffort(value.reasoningEffort)) &&
    (value.serviceTier === undefined || isRunServiceTier(value.serviceTier)) &&
    (value.subagentModelRouting === undefined ||
      isRunSubagentModelRouting(value.subagentModelRouting))
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

export function isThreadRenameResponse(
  value: unknown,
): value is ThreadRenameResponse {
  return (
    isRecord(value) &&
    value.ok === true &&
    typeof value.threadId === 'string' &&
    isThreadId(value.threadId) &&
    typeof value.title === 'string'
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

export function isThreadArchiveImportResponse(
  value: unknown,
): value is ThreadArchiveImportResponse {
  return (
    isRecord(value) &&
    value.ok === true &&
    typeof value.threadId === 'string' &&
    isThreadId(value.threadId) &&
    typeof value.archiveId === 'string' &&
    /^sha256:[0-9a-f]{64}$/u.test(value.archiveId) &&
    typeof value.importedMessageCount === 'number' &&
    Number.isSafeInteger(value.importedMessageCount) &&
    value.importedMessageCount >= 0
  );
}
