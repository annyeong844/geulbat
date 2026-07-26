import { isRunId, isThreadId, type RunId, type ThreadId } from './ids.js';
import {
  isProviderReplayScopeId,
  type ProviderReplayScopeId,
} from './provider-auth.js';
import {
  isRunModelId,
  isRunProviderId,
  isRunReasoningEffort,
  type RunModelId,
  type RunProviderId,
  type RunReasoningEffort,
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
  type AgentChildTerminalReason,
  type AgentChildTerminalState,
} from './subagent-terminal.js';
// 값이 아닌 타입만 가져온다 — verbatimModuleSyntax 아래에서는 `import {type X}`도
// 문장이 그대로 방출돼 런타임 간선이 남으므로 `import type`이어야 한다.
import type {
  RunUsageTotals,
  SubagentCapability,
  SubagentRuntimeDiagnostics,
  SubagentToolSurfaceProfile,
  SubagentType,
} from './run-events.js';

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

export interface ThreadDetailResponse {
  threadId: ThreadId;
  snapshotVersion: string;
  activeModelId?: RunModelId;
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

const THREAD_SUBAGENT_TERMINAL_STATES = [
  'completed',
  'failed',
  'cancelled',
] as const;
const THREAD_SUBAGENT_RUNTIME_PHASES = [
  'queued',
  'starting',
  'auth_waiting',
  'provider_waiting',
  'rate_limit_waiting',
  'provider_streaming',
  'tool_running',
  'approval_pending',
] as const;
const THREAD_SUBAGENT_RUNTIME_TOOL_STATES = [
  'running',
  'succeeded',
  'failed',
] as const;

export function isThreadSubagentTerminalOutcome(
  value: unknown,
): value is ThreadSubagentTerminalOutcome {
  if (
    !isRecord(value) ||
    typeof value.deliveryId !== 'string' ||
    value.deliveryId.trim() === '' ||
    (value.resultRef !== undefined &&
      (typeof value.resultRef !== 'string' || value.resultRef.trim() === '')) ||
    typeof value.parentRunId !== 'string' ||
    !isRunId(value.parentRunId) ||
    typeof value.childRunId !== 'string' ||
    !isRunId(value.childRunId) ||
    (value.childThreadId !== undefined &&
      (typeof value.childThreadId !== 'string' ||
        !isThreadId(value.childThreadId))) ||
    (value.subagentType !== 'explorer' && value.subagentType !== 'worker') ||
    !THREAD_SUBAGENT_TERMINAL_STATES.some(
      (state) => state === value.terminalState,
    ) ||
    (value.reason !== undefined && !isAgentChildTerminalReason(value.reason)) ||
    typeof value.result !== 'string' ||
    !isCanonicalIsoTimestamp(value.completedAt) ||
    (value.elapsedMs !== undefined &&
      (typeof value.elapsedMs !== 'number' ||
        !Number.isFinite(value.elapsedMs))) ||
    (value.modelId !== undefined && typeof value.modelId !== 'string') ||
    (value.reasoningEffort !== undefined &&
      !isRunReasoningEffort(value.reasoningEffort)) ||
    !isThreadSubagentUsage(value.usage) ||
    !isThreadSubagentRuntime(value.runtime)
  ) {
    return false;
  }
  if (value.capabilities === undefined && value.toolSurface === undefined) {
    return true;
  }
  if (
    !Array.isArray(value.capabilities) ||
    !value.capabilities.every((capability) => capability === 'ptc') ||
    (value.toolSurface !== 'explorer' &&
      value.toolSurface !== 'explorer_ptc' &&
      value.toolSurface !== 'worker')
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

function isThreadSubagentRuntime(
  value: unknown,
): value is SubagentRuntimeDiagnostics | undefined {
  if (value === undefined) {
    return true;
  }
  if (
    !isRecord(value) ||
    !THREAD_SUBAGENT_RUNTIME_PHASES.some((phase) => phase === value.phase) ||
    !isCanonicalIsoTimestamp(value.observedAt) ||
    typeof value.partialOutputAvailable !== 'boolean' ||
    (value.previousChildRunId !== undefined &&
      (typeof value.previousChildRunId !== 'string' ||
        !isRunId(value.previousChildRunId)))
  ) {
    return false;
  }
  const lastTool = value.lastTool;
  if (lastTool === undefined) {
    return true;
  }
  return (
    isRecord(lastTool) &&
    typeof lastTool.name === 'string' &&
    lastTool.name.trim() !== '' &&
    typeof lastTool.callId === 'string' &&
    lastTool.callId.trim() !== '' &&
    THREAD_SUBAGENT_RUNTIME_TOOL_STATES.some(
      (state) => state === lastTool.state,
    )
  );
}

function isThreadSubagentUsage(
  value: unknown,
): value is RunUsageTotals | undefined {
  return (
    value === undefined ||
    (isRecord(value) &&
      typeof value.inputTokens === 'number' &&
      Number.isFinite(value.inputTokens) &&
      typeof value.outputTokens === 'number' &&
      Number.isFinite(value.outputTokens) &&
      typeof value.cachedInputTokens === 'number' &&
      Number.isFinite(value.cachedInputTokens))
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
