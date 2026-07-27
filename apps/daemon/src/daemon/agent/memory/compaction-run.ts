import {
  appendTranscriptEntry,
  CompareAndAppendMismatchError,
  readTranscriptEntries,
  type TranscriptEntry,
} from '../../sessions/transcript-log.js';
import {
  isAgentProviderNativeCompactionEntryData,
  isAgentProviderTransitionCompactionEntryData,
  type BudgetProfile,
  type ProviderNativeCompactionOutputItem,
  type ProviderNativeCompactionEvidencePage,
  type ProviderNativeCompactionEvidenceRef,
  type ProviderTransitionCompactionEntryData,
} from '../contract.js';
import type { ProviderReplayScopeId } from '../../runtime-contracts.js';
import type {
  HistoryItem,
  ProviderUsageTelemetry,
} from '../../llm/provider/wire/types.js';
import { measureResponseWireInputBytes } from '../../llm/provider/transport/responses-wire-input.js';
import { isRecord, tryParseJsonRecord } from '../../runtime-json.js';
import {
  buildContextSummaryHistoryItem,
  CompactionTokenCountError,
  getActiveTranscriptEntries,
  prepareContextCompaction,
  type ContextCompactionTokenCounter,
  type PrepareContextCompactionResult,
} from './compaction-rebuild.js';

type PreparedContextCompaction = Extract<
  PrepareContextCompactionResult,
  { kind: 'prepared' }
>;
type CompactionTranscriptEntry = Extract<
  TranscriptEntry,
  { role: 'compaction' }
>;
interface ContextCompactionSummaryRequest {
  previousSummary?: string;
  historyPrefix: readonly TranscriptEntry[];
  summaryBudgetTokens: number;
  signal?: AbortSignal;
}

interface ContextCompactionSummary {
  summary: string;
  shortSummary: string;
  summaryTokens: number;
}

export interface ContextCompactionSummarizer {
  summarizeContext(
    request: ContextCompactionSummaryRequest,
  ): Promise<ContextCompactionSummary>;
}

interface ContextHistoryCompactionSummaryRequest {
  historyPrefix: readonly HistoryItem[];
  summaryBudgetTokens: number;
  signal?: AbortSignal;
}

export interface ContextHistoryCompactionSummarizer {
  summarizeContext(
    request: ContextHistoryCompactionSummaryRequest,
  ): Promise<ContextCompactionSummary>;
}

export interface ContextHistoryCompactionTokenCounter {
  countHistoryTokens(history: readonly HistoryItem[]): number;
}

type CompactThreadContextResult =
  | Exclude<PrepareContextCompactionResult, PreparedContextCompaction>
  | {
      kind: 'summary_invalid';
      reason:
        | 'summary_empty'
        | 'short_summary_empty'
        | 'summary_token_count_not_positive_safe_integer'
        | 'summary_exceeds_budget'
        | 'compacted_request_exceeds_threshold';
    }
  | {
      kind: 'stale_snapshot';
      expectedLastEntryId: string;
      actualLastEntryId: string | null;
    }
  | {
      kind: 'compacted';
      checkpoint: CompactionTranscriptEntry;
      prefixTokens: number;
      retainedTokens: number;
      summaryTokens: number;
    };

type CompactThreadContextSummaryResult =
  | { kind: 'transcript_empty' }
  | { kind: 'no_summarizable_prefix' }
  | { kind: 'tail_exceeds_budget' }
  | Extract<CompactThreadContextResult, { kind: 'summary_invalid' }>
  | Extract<CompactThreadContextResult, { kind: 'stale_snapshot' }>
  | {
      kind: 'compacted';
      checkpoint: CompactionTranscriptEntry;
      providerRoundAnchorEntryId: string;
      retainedTokens: number;
      summaryTokens: number;
    };

type CompactThreadContextNativeResult =
  | { kind: 'transcript_empty' }
  | { kind: 'no_summarizable_prefix' }
  | { kind: 'no_material_growth' }
  | {
      kind: 'evidence_recovery_failed';
      reason:
        | 'snapshot_unavailable'
        | 'selection_unavailable'
        | 'invalid_page'
        | 'resolver_failed';
      outputRef?: string;
    }
  | { kind: 'history_invalid'; phase: 'before' | 'after' }
  | { kind: 'provider_output_invalid' }
  | {
      kind: 'ineffective';
      attemptKey: string;
      historyBytesBefore: number;
      historyBytesAfter: number;
    }
  | { kind: 'repeated_ineffective'; attemptKey: string }
  | {
      kind: 'stale_snapshot';
      expectedLastEntryId: string;
      actualLastEntryId: string | null;
    }
  | {
      kind: 'compacted';
      checkpoint: CompactionTranscriptEntry;
      providerRoundAnchorEntryId: string;
      attemptKey: string;
      historyBytesBefore: number;
      historyBytesAfter: number;
      providerUsageTelemetry?: ProviderUsageTelemetry;
    };

interface ProviderNativeCompactionExpandedEvidencePage extends ProviderNativeCompactionEvidencePage {
  limit: number;
  content: string;
}

interface ProviderNativeCompactionEvidenceTarget {
  callId: string;
  toolName: string;
  arguments: string;
}

type ProviderNativeCompactionEvidenceSelection =
  | { kind: 'selected'; evidence: ProviderNativeCompactionEvidenceRef }
  | {
      kind: 'failed';
      reason:
        | 'target_call_not_found'
        | 'target_call_ambiguous'
        | 'target_call_identity_mismatch'
        | 'target_evidence_not_found'
        | 'target_evidence_ambiguous'
        | 'target_evidence_identity_mismatch';
    };

type ProviderNativeCompactionEvidenceResolution =
  | { kind: 'none' }
  | {
      kind: 'expanded';
      pages: readonly ProviderNativeCompactionExpandedEvidencePage[];
    }
  | {
      kind: 'failed';
      reason: 'snapshot_unavailable' | 'selection_unavailable';
      outputRef?: string;
    };

interface ProviderTransitionContextSummary {
  summary: string;
  inputTokens?: number;
}

interface ProviderTransitionContextSummarizer {
  summarizeContext(request: {
    coveredThroughEntryId: string;
    firstKeptEntryId?: string;
    signal?: AbortSignal;
  }): Promise<ProviderTransitionContextSummary>;
}

type CompactThreadContextForProviderTransitionResult =
  | { kind: 'transcript_empty' }
  | { kind: 'no_summarizable_prefix' }
  | {
      kind: 'summary_invalid';
      reason: 'summary_empty' | 'input_tokens_invalid';
    }
  | {
      kind: 'stale_snapshot';
      expectedLastEntryId: string;
      actualLastEntryId: string | null;
    }
  | {
      kind: 'compacted';
      checkpoint: CompactionTranscriptEntry;
    };

export async function compactThreadContextForProviderTransition(args: {
  workspaceRoot: string;
  threadId: string;
  sourceProviderId: ProviderTransitionCompactionEntryData['sourceProviderId'];
  sourceModel: string;
  targetProviderId: ProviderTransitionCompactionEntryData['targetProviderId'];
  targetModel: string;
  summarizer: ProviderTransitionContextSummarizer;
  signal?: AbortSignal;
  now?: () => Date;
}): Promise<CompactThreadContextForProviderTransitionResult> {
  const entries = await readTranscriptEntries(
    args.workspaceRoot,
    args.threadId,
  );
  const snapshotLastEntry = entries[entries.length - 1];
  if (snapshotLastEntry === undefined) {
    return { kind: 'transcript_empty' };
  }

  const active = getActiveTranscriptEntries(entries, args.threadId);
  let firstKeptEntry: TranscriptEntry | undefined;
  for (let index = active.activeEntries.length - 1; index >= 0; index -= 1) {
    const entry = active.activeEntries[index];
    if (entry?.role === 'user') {
      firstKeptEntry = entry;
      break;
    }
  }
  const firstKeptIndex =
    firstKeptEntry === undefined
      ? -1
      : entries.findIndex((entry) => entry.entryId === firstKeptEntry.entryId);
  const coveredEntry =
    firstKeptIndex > 0 ? entries[firstKeptIndex - 1] : snapshotLastEntry;
  if (firstKeptEntry !== undefined && firstKeptIndex <= 0) {
    return { kind: 'no_summarizable_prefix' };
  }
  if (coveredEntry === undefined) {
    throw new Error('provider-transition covered entry is unavailable');
  }

  const summary = await args.summarizer.summarizeContext({
    coveredThroughEntryId: coveredEntry.entryId,
    ...(firstKeptEntry === undefined
      ? {}
      : { firstKeptEntryId: firstKeptEntry.entryId }),
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  });
  if (summary.summary.trim() === '') {
    return { kind: 'summary_invalid', reason: 'summary_empty' };
  }
  if (
    summary.inputTokens !== undefined &&
    (!Number.isSafeInteger(summary.inputTokens) || summary.inputTokens < 0)
  ) {
    return { kind: 'summary_invalid', reason: 'input_tokens_invalid' };
  }

  const compactionData: ProviderTransitionCompactionEntryData = {
    kind: 'provider_transition',
    sourceProviderId: args.sourceProviderId,
    sourceModel: args.sourceModel,
    targetProviderId: args.targetProviderId,
    targetModel: args.targetModel,
    summary: summary.summary,
    coveredThroughEntryId: coveredEntry.entryId,
    ...(firstKeptEntry === undefined
      ? {}
      : { firstKeptEntryId: firstKeptEntry.entryId }),
    ...(summary.inputTokens === undefined
      ? {}
      : { inputTokens: summary.inputTokens }),
  };
  if (!isAgentProviderTransitionCompactionEntryData(compactionData)) {
    throw new Error('provider-transition compaction data is invalid');
  }

  let appended: TranscriptEntry;
  try {
    appended = await appendTranscriptEntry(
      args.workspaceRoot,
      args.threadId,
      {
        role: 'compaction',
        content: '',
        timestamp: (args.now?.() ?? new Date()).toISOString(),
        compactionData,
      },
      { expectedLastEntryId: snapshotLastEntry.entryId },
    );
  } catch (error: unknown) {
    if (error instanceof CompareAndAppendMismatchError) {
      return {
        kind: 'stale_snapshot',
        expectedLastEntryId: error.expectedLastEntryId,
        actualLastEntryId: error.actualLastEntryId,
      };
    }
    throw error;
  }

  const appendedCompactionData = appended.compactionData;
  if (
    appended.role !== 'compaction' ||
    !isAgentProviderTransitionCompactionEntryData(appendedCompactionData)
  ) {
    throw new Error(
      'provider-transition compaction append returned an invalid checkpoint',
    );
  }
  return {
    kind: 'compacted',
    checkpoint: { ...appended, compactionData: appendedCompactionData },
  };
}

export async function compactThreadContextNative(args: {
  workspaceRoot: string;
  threadId: string;
  history: HistoryItem[];
  providerId: string;
  model: string;
  providerReplayScopeId?: ProviderReplayScopeId;
  tokensBefore: number;
  contextWindow: number;
  thresholdTokens: number;
  blockedAttemptKey?: string;
  resolveEvidencePages?: (args: {
    evidence: readonly ProviderNativeCompactionEvidenceRef[];
    historyPrefix: readonly HistoryItem[];
    retainedHistory: readonly HistoryItem[];
    selectEvidence: (
      target: ProviderNativeCompactionEvidenceTarget,
    ) => ProviderNativeCompactionEvidenceSelection;
    signal?: AbortSignal;
  }) => Promise<ProviderNativeCompactionEvidenceResolution>;
  compactHistory: (args: {
    historyPrefix: readonly HistoryItem[];
    evidence: readonly ProviderNativeCompactionEvidenceRef[];
    expandedEvidencePages: readonly ProviderNativeCompactionExpandedEvidencePage[];
  }) => Promise<{
    output: ProviderNativeCompactionOutputItem[];
    providerReplayScopeId: ProviderReplayScopeId;
    providerUsageTelemetry?: ProviderUsageTelemetry;
  }>;
  measureHistoryBytes?: (
    history: HistoryItem[],
    target: {
      providerId: string;
      model: string;
      providerReplayScopeId?: ProviderReplayScopeId;
    },
  ) => number;
  signal?: AbortSignal;
  now?: () => Date;
}): Promise<CompactThreadContextNativeResult> {
  const entries = await readTranscriptEntries(
    args.workspaceRoot,
    args.threadId,
  );
  const snapshotLastEntry = entries[entries.length - 1];
  if (snapshotLastEntry === undefined) {
    return { kind: 'transcript_empty' };
  }

  const prepared = prepareProviderNativeCompaction({
    entries,
    threadId: args.threadId,
    history: args.history,
    providerId: args.providerId,
    model: args.model,
    contextWindow: args.contextWindow,
    thresholdTokens: args.thresholdTokens,
  });
  if (prepared.kind !== 'prepared') {
    return prepared;
  }

  const measureHistoryBytes =
    args.measureHistoryBytes ??
    ((
      history: HistoryItem[],
      target: {
        providerId: string;
        model: string;
        providerReplayScopeId?: ProviderReplayScopeId;
      },
    ) => measureResponseWireInputBytes(history, target));
  let historyBytesBefore: number;
  try {
    historyBytesBefore = measureHistoryBytes(args.history, {
      providerId: args.providerId,
      model: args.model,
      ...(args.providerReplayScopeId === undefined
        ? {}
        : { providerReplayScopeId: args.providerReplayScopeId }),
    });
  } catch {
    return { kind: 'history_invalid', phase: 'before' };
  }
  const attemptKey = buildProviderNativeCompactionAttemptKey({
    providerId: args.providerId,
    model: args.model,
    contextWindow: args.contextWindow,
    thresholdTokens: args.thresholdTokens,
    firstKeptEntryId: prepared.firstKeptEntryId,
    snapshotLastEntryId: prepared.snapshotLastEntryId,
    historyBytesBefore,
  });
  if (args.blockedAttemptKey === attemptKey) {
    return { kind: 'repeated_ineffective', attemptKey };
  }

  let expandedEvidencePages: readonly ProviderNativeCompactionExpandedEvidencePage[] =
    [];
  if (args.resolveEvidencePages !== undefined) {
    let resolution: ProviderNativeCompactionEvidenceResolution;
    try {
      resolution = await args.resolveEvidencePages({
        evidence: prepared.evidence,
        historyPrefix: prepared.historyPrefix,
        retainedHistory: prepared.retainedHistory,
        selectEvidence: (target) =>
          selectProviderNativeCompactionEvidenceRef({
            evidence: prepared.evidence,
            historyPrefix: prepared.historyPrefix,
            target,
          }),
        ...(args.signal === undefined ? {} : { signal: args.signal }),
      });
    } catch {
      return { kind: 'evidence_recovery_failed', reason: 'resolver_failed' };
    }
    if (resolution.kind === 'failed') {
      return {
        kind: 'evidence_recovery_failed',
        reason: resolution.reason,
        ...(resolution.outputRef === undefined
          ? {}
          : { outputRef: resolution.outputRef }),
      };
    }
    if (resolution.kind === 'expanded') {
      if (
        !areProviderNativeCompactionEvidencePagesValid(
          resolution.pages,
          prepared.evidence,
        )
      ) {
        return { kind: 'evidence_recovery_failed', reason: 'invalid_page' };
      }
      expandedEvidencePages = resolution.pages;
    }
  }

  const compacted = await args.compactHistory({
    historyPrefix: prepared.historyPrefix,
    evidence: prepared.evidence,
    expandedEvidencePages,
  });
  const compactedHistory: HistoryItem[] = [
    {
      kind: 'provider_native_compaction',
      providerId: args.providerId,
      model: args.model,
      providerReplayScopeId: compacted.providerReplayScopeId,
      output: compacted.output,
    },
    ...prepared.retainedHistory,
  ];
  let historyBytesAfter: number;
  try {
    historyBytesAfter = measureHistoryBytes(compactedHistory, {
      providerId: args.providerId,
      model: args.model,
      providerReplayScopeId: compacted.providerReplayScopeId,
    });
  } catch {
    return { kind: 'history_invalid', phase: 'after' };
  }
  if (historyBytesAfter >= historyBytesBefore) {
    return {
      kind: 'ineffective',
      attemptKey,
      historyBytesBefore,
      historyBytesAfter,
    };
  }

  const compactionData = {
    kind: 'provider_native' as const,
    providerId: args.providerId,
    model: args.model,
    replayScopeId: compacted.providerReplayScopeId,
    output: compacted.output,
    tokensBefore: args.tokensBefore,
    contextWindow: args.contextWindow,
    thresholdTokens: args.thresholdTokens,
    firstKeptEntryId: prepared.firstKeptEntryId,
    coveredThroughEntryId: prepared.coveredThroughEntryId,
    historyBytesBefore,
    historyBytesAfter,
    evidence: prepared.evidence,
    expandedEvidencePages: expandedEvidencePages.map((page) => ({
      outputRef: page.outputRef,
      offset: page.offset,
      endOffset: page.endOffset,
      totalChars: page.totalChars,
    })),
  };
  if (!isAgentProviderNativeCompactionEntryData(compactionData)) {
    return { kind: 'provider_output_invalid' };
  }

  let appended: TranscriptEntry;
  try {
    appended = await appendTranscriptEntry(
      args.workspaceRoot,
      args.threadId,
      {
        role: 'compaction',
        content: '',
        timestamp: (args.now?.() ?? new Date()).toISOString(),
        compactionData,
      },
      { expectedLastEntryId: snapshotLastEntry.entryId },
    );
  } catch (error: unknown) {
    if (error instanceof CompareAndAppendMismatchError) {
      return {
        kind: 'stale_snapshot',
        expectedLastEntryId: error.expectedLastEntryId,
        actualLastEntryId: error.actualLastEntryId,
      };
    }
    throw error;
  }

  if (
    appended.role !== 'compaction' ||
    !isAgentProviderNativeCompactionEntryData(appended.compactionData)
  ) {
    throw new Error(
      'provider-native compaction append returned an invalid checkpoint',
    );
  }
  args.history.splice(0, args.history.length, ...compactedHistory);
  return {
    kind: 'compacted',
    checkpoint: appended,
    providerRoundAnchorEntryId: prepared.snapshotLastEntryId,
    attemptKey,
    historyBytesBefore,
    historyBytesAfter,
    ...(compacted.providerUsageTelemetry === undefined
      ? {}
      : { providerUsageTelemetry: compacted.providerUsageTelemetry }),
  };
}

function prepareProviderNativeCompaction(args: {
  entries: readonly TranscriptEntry[];
  threadId: string;
  history: readonly HistoryItem[];
  providerId: string;
  model: string;
  contextWindow: number;
  thresholdTokens: number;
}):
  | { kind: 'no_summarizable_prefix' }
  | { kind: 'no_material_growth' }
  | { kind: 'history_invalid'; phase: 'before' }
  | {
      kind: 'prepared';
      historyPrefix: HistoryItem[];
      retainedHistory: HistoryItem[];
      firstKeptEntryId: string;
      coveredThroughEntryId: string;
      snapshotLastEntryId: string;
      evidence: ProviderNativeCompactionEvidenceRef[];
    } {
  const snapshotLastEntry = args.entries.at(-1);
  if (snapshotLastEntry === undefined) {
    return { kind: 'no_summarizable_prefix' };
  }
  if (
    snapshotLastEntry.role === 'compaction' &&
    isAgentProviderNativeCompactionEntryData(
      snapshotLastEntry.compactionData,
    ) &&
    snapshotLastEntry.compactionData.providerId === args.providerId &&
    snapshotLastEntry.compactionData.model === args.model &&
    snapshotLastEntry.compactionData.contextWindow === args.contextWindow &&
    snapshotLastEntry.compactionData.thresholdTokens === args.thresholdTokens
  ) {
    return { kind: 'no_material_growth' };
  }
  const active = getActiveTranscriptEntries(args.entries, args.threadId);
  let firstKeptEntry: TranscriptEntry | undefined;
  for (let index = active.activeEntries.length - 1; index >= 0; index -= 1) {
    const candidate = active.activeEntries[index];
    if (candidate?.role === 'user') {
      firstKeptEntry = candidate;
      break;
    }
  }
  if (firstKeptEntry === undefined) {
    return { kind: 'no_summarizable_prefix' };
  }
  const firstKeptMatches = args.entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.entryId === firstKeptEntry.entryId);
  if (firstKeptMatches.length !== 1) {
    return { kind: 'history_invalid', phase: 'before' };
  }
  const firstKeptIndex = firstKeptMatches[0]?.index ?? -1;
  const coveredEntry =
    firstKeptIndex > 0 ? args.entries[firstKeptIndex - 1] : undefined;
  let firstKeptHistoryIndex = -1;
  for (let index = args.history.length - 1; index >= 0; index -= 1) {
    if (args.history[index]?.kind === 'user') {
      firstKeptHistoryIndex = index;
      break;
    }
  }
  if (coveredEntry === undefined || firstKeptHistoryIndex <= 0) {
    return { kind: 'no_summarizable_prefix' };
  }

  const historyPrefix = args.history.slice(0, firstKeptHistoryIndex);
  const retainedHistory = args.history.slice(firstKeptHistoryIndex);
  return {
    kind: 'prepared',
    historyPrefix,
    retainedHistory,
    firstKeptEntryId: firstKeptEntry.entryId,
    coveredThroughEntryId: coveredEntry.entryId,
    snapshotLastEntryId: snapshotLastEntry.entryId,
    evidence: collectProviderNativeCompactionEvidence(historyPrefix),
  };
}

function collectProviderNativeCompactionEvidence(
  historyPrefix: readonly HistoryItem[],
): ProviderNativeCompactionEvidenceRef[] {
  const toolNamesByCallId = new Map<string, string>();
  const seenOutputRefs = new Set<string>();
  const evidence: ProviderNativeCompactionEvidenceRef[] = [];

  for (const item of historyPrefix) {
    const call = readProviderNativeCompactionCallIdentity(item);
    if (
      call !== null &&
      typeof call.toolName === 'string' &&
      call.toolName.trim() !== ''
    ) {
      toolNamesByCallId.set(call.callId, call.toolName);
      continue;
    }
    if (item.kind !== 'function_call_output') {
      continue;
    }
    const parsed = tryParseJsonRecord(item.output);
    if (!parsed.ok) {
      continue;
    }
    const outputEvidence = readProviderNativeCompactionOutputEvidence(
      parsed.value,
    );
    const projectedToolName = parsed.value.tool;
    if (
      outputEvidence === null ||
      seenOutputRefs.has(outputEvidence.outputRef)
    ) {
      continue;
    }
    const toolName =
      typeof projectedToolName === 'string' && projectedToolName.trim() !== ''
        ? projectedToolName
        : toolNamesByCallId.get(item.callId);
    if (toolName === undefined) {
      continue;
    }
    const projectedOutcome = parsed.value.ok;
    const outcome =
      projectedOutcome === true
        ? ('success' as const)
        : projectedOutcome === false
          ? ('failure' as const)
          : ('unknown' as const);
    seenOutputRefs.add(outputEvidence.outputRef);
    evidence.push({
      callId: item.callId,
      toolName,
      outcome,
      fullOutputBytes: outputEvidence.fullOutputBytes,
      outputRef: outputEvidence.outputRef,
    });
  }

  return evidence;
}

function readProviderNativeCompactionOutputEvidence(
  output: Record<string, unknown>,
): { outputRef: string; fullOutputBytes: number } | null {
  if (
    typeof output.outputRef === 'string' &&
    output.outputRef.startsWith('tool-output:') &&
    isNonNegativeSafeInteger(output.fullOutputBytes)
  ) {
    return {
      outputRef: output.outputRef,
      fullOutputBytes: output.fullOutputBytes,
    };
  }
  const commandOutput =
    typeof output.outputRef === 'string' &&
    output.outputRef.startsWith('command-output:')
      ? output
      : isRecord(output.snapshot) &&
          typeof output.snapshot.outputRef === 'string' &&
          output.snapshot.outputRef.startsWith('command-output:')
        ? output.snapshot
        : null;
  const commandOutputRef = commandOutput?.outputRef;
  if (
    commandOutput === null ||
    typeof commandOutputRef !== 'string' ||
    !isNonNegativeSafeInteger(commandOutput.stdoutBytes) ||
    !isNonNegativeSafeInteger(commandOutput.stderrBytes)
  ) {
    return null;
  }
  const fullOutputBytes = commandOutput.stdoutBytes + commandOutput.stderrBytes;
  return Number.isSafeInteger(fullOutputBytes)
    ? {
        outputRef: commandOutputRef,
        fullOutputBytes,
      }
    : null;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readProviderNativeCompactionCallIdentity(item: HistoryItem): {
  callId: string;
  toolName: unknown;
  arguments: unknown;
} | null {
  if (item.kind === 'function_call') {
    return {
      callId: item.callId,
      toolName: item.name,
      arguments: item.arguments,
    };
  }
  if (
    item.kind !== 'backend_item' ||
    !isRecord(item.data) ||
    item.data['type'] !== 'function_call' ||
    typeof item.data['call_id'] !== 'string'
  ) {
    return null;
  }
  return {
    callId: item.data['call_id'],
    toolName: item.data['name'],
    arguments: item.data['arguments'],
  };
}

function selectProviderNativeCompactionEvidenceRef(args: {
  evidence: readonly ProviderNativeCompactionEvidenceRef[];
  historyPrefix: readonly HistoryItem[];
  target: ProviderNativeCompactionEvidenceTarget;
}): ProviderNativeCompactionEvidenceSelection {
  const matchingCalls = args.historyPrefix
    .map(readProviderNativeCompactionCallIdentity)
    .filter((call) => call?.callId === args.target.callId);
  if (matchingCalls.length === 0) {
    return { kind: 'failed', reason: 'target_call_not_found' };
  }
  if (matchingCalls.length !== 1) {
    return { kind: 'failed', reason: 'target_call_ambiguous' };
  }
  const matchingCall = matchingCalls[0];
  if (
    matchingCall?.toolName !== args.target.toolName ||
    matchingCall.arguments !== args.target.arguments
  ) {
    return { kind: 'failed', reason: 'target_call_identity_mismatch' };
  }

  const matchingEvidence = args.evidence.filter(
    (item) => item.callId === args.target.callId,
  );
  if (matchingEvidence.length === 0) {
    return { kind: 'failed', reason: 'target_evidence_not_found' };
  }
  if (matchingEvidence.length !== 1) {
    return { kind: 'failed', reason: 'target_evidence_ambiguous' };
  }
  const selected = matchingEvidence[0];
  if (selected?.toolName !== args.target.toolName) {
    return { kind: 'failed', reason: 'target_evidence_identity_mismatch' };
  }
  return { kind: 'selected', evidence: selected };
}

function areProviderNativeCompactionEvidencePagesValid(
  pages: readonly ProviderNativeCompactionExpandedEvidencePage[],
  evidence: readonly ProviderNativeCompactionEvidenceRef[],
): boolean {
  const knownOutputRefs = new Set(evidence.map((item) => item.outputRef));
  const seenPages = new Set<string>();
  for (const page of pages) {
    const pageKey = `${page.outputRef}\0${String(page.offset)}\0${String(page.endOffset)}`;
    if (
      !knownOutputRefs.has(page.outputRef) ||
      seenPages.has(pageKey) ||
      !Number.isSafeInteger(page.offset) ||
      page.offset < 0 ||
      !Number.isSafeInteger(page.limit) ||
      page.limit <= 0 ||
      !Number.isSafeInteger(page.endOffset) ||
      page.endOffset < page.offset ||
      page.endOffset > page.offset + page.limit ||
      !Number.isSafeInteger(page.totalChars) ||
      page.totalChars < page.endOffset ||
      page.content.length !== page.endOffset - page.offset
    ) {
      return false;
    }
    seenPages.add(pageKey);
  }
  return true;
}

function buildProviderNativeCompactionAttemptKey(args: {
  providerId: string;
  model: string;
  contextWindow: number;
  thresholdTokens: number;
  firstKeptEntryId: string;
  snapshotLastEntryId: string;
  historyBytesBefore: number;
}): string {
  return [
    args.providerId,
    args.model,
    String(args.contextWindow),
    String(args.thresholdTokens),
    args.firstKeptEntryId,
    args.snapshotLastEntryId,
    String(args.historyBytesBefore),
  ].join('\0');
}

export async function compactThreadContext(args: {
  workspaceRoot: string;
  threadId: string;
  currentRequestTokens: number;
  budgetProfile: BudgetProfile;
  tokenCounter: ContextCompactionTokenCounter;
  summarizer: ContextCompactionSummarizer;
  forced: boolean;
  signal?: AbortSignal;
  now?: () => Date;
}): Promise<CompactThreadContextResult> {
  const entries = await readTranscriptEntries(
    args.workspaceRoot,
    args.threadId,
  );
  const prepared = prepareContextCompaction({
    entries,
    threadId: args.threadId,
    currentRequestTokens: args.currentRequestTokens,
    budgetProfile: args.budgetProfile,
    tokenCounter: args.tokenCounter,
    forced: args.forced,
  });
  if (prepared.kind !== 'prepared') {
    return prepared;
  }

  const summary = await args.summarizer.summarizeContext({
    ...(prepared.previousSummary === undefined
      ? {}
      : { previousSummary: prepared.previousSummary }),
    historyPrefix: prepared.historyPrefix,
    summaryBudgetTokens: prepared.budgetProfile.summaryBudgetTokens,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  });
  const summaryValidation = validateSummary(
    summary,
    prepared.budgetProfile,
    prepared.retainedTokens,
  );
  if (summaryValidation !== undefined) {
    return summaryValidation;
  }

  let appended: TranscriptEntry;
  try {
    appended = await appendTranscriptEntry(
      args.workspaceRoot,
      args.threadId,
      {
        role: 'compaction',
        content: '',
        timestamp: (args.now?.() ?? new Date()).toISOString(),
        compactionData: {
          summary: summary.summary,
          shortSummary: summary.shortSummary,
          firstKeptEntryId: prepared.firstKeptEntryId,
          tokensBefore: prepared.tokensBefore,
          budgetProfile: prepared.budgetProfile,
        },
      },
      { expectedLastEntryId: prepared.snapshotLastEntryId },
    );
  } catch (error: unknown) {
    if (error instanceof CompareAndAppendMismatchError) {
      return {
        kind: 'stale_snapshot',
        expectedLastEntryId: error.expectedLastEntryId,
        actualLastEntryId: error.actualLastEntryId,
      };
    }
    throw error;
  }

  if (appended.role !== 'compaction') {
    throw new Error('compaction append returned a non-compaction entry');
  }
  return {
    kind: 'compacted',
    checkpoint: appended,
    prefixTokens: prepared.prefixTokens,
    retainedTokens: prepared.retainedTokens,
    summaryTokens: summary.summaryTokens,
  };
}

export async function compactThreadContextSummary(args: {
  workspaceRoot: string;
  threadId: string;
  history: readonly HistoryItem[];
  currentRequestTokens: number;
  budgetProfile: BudgetProfile;
  tokenCounter: ContextHistoryCompactionTokenCounter;
  summarizer: ContextHistoryCompactionSummarizer;
  signal?: AbortSignal;
  now?: () => Date;
}): Promise<CompactThreadContextSummaryResult> {
  const entries = await readTranscriptEntries(
    args.workspaceRoot,
    args.threadId,
  );
  const snapshotLastEntry = entries.at(-1);
  if (snapshotLastEntry === undefined) {
    return { kind: 'transcript_empty' };
  }
  const active = getActiveTranscriptEntries(entries, args.threadId);
  let firstKeptEntry: TranscriptEntry | undefined;
  for (let index = active.activeEntries.length - 1; index >= 0; index -= 1) {
    const entry = active.activeEntries[index];
    if (entry?.role === 'user') {
      firstKeptEntry = entry;
      break;
    }
  }
  let firstKeptHistoryIndex = -1;
  for (let index = args.history.length - 1; index >= 0; index -= 1) {
    if (args.history[index]?.kind === 'user') {
      firstKeptHistoryIndex = index;
      break;
    }
  }
  if (firstKeptEntry === undefined || firstKeptHistoryIndex <= 0) {
    return { kind: 'no_summarizable_prefix' };
  }

  const historyPrefix = args.history.slice(0, firstKeptHistoryIndex);
  const retainedHistory = args.history.slice(firstKeptHistoryIndex);
  const retainedTokens = args.tokenCounter.countHistoryTokens(retainedHistory);
  if (!Number.isSafeInteger(retainedTokens) || retainedTokens < 0) {
    throw new CompactionTokenCountError('retained_history', retainedTokens);
  }
  if (retainedTokens > args.budgetProfile.keepRecentTokens) {
    return { kind: 'tail_exceeds_budget' };
  }

  const summary = await args.summarizer.summarizeContext({
    historyPrefix,
    summaryBudgetTokens: args.budgetProfile.summaryBudgetTokens,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  });
  const compactedHistoryTokens = args.tokenCounter.countHistoryTokens([
    buildContextSummaryHistoryItem(summary.summary),
    ...retainedHistory,
  ]);
  if (
    !Number.isSafeInteger(compactedHistoryTokens) ||
    compactedHistoryTokens < 0
  ) {
    throw new CompactionTokenCountError(
      'compacted_history',
      compactedHistoryTokens,
    );
  }
  const summaryValidation = validateSummary(
    summary,
    args.budgetProfile,
    retainedTokens,
    compactedHistoryTokens,
  );
  if (summaryValidation !== undefined) {
    return summaryValidation;
  }

  let appended: TranscriptEntry;
  try {
    appended = await appendTranscriptEntry(
      args.workspaceRoot,
      args.threadId,
      {
        role: 'compaction',
        content: '',
        timestamp: (args.now?.() ?? new Date()).toISOString(),
        compactionData: {
          summary: summary.summary,
          shortSummary: summary.shortSummary,
          firstKeptEntryId: firstKeptEntry.entryId,
          tokensBefore: args.currentRequestTokens,
          budgetProfile: args.budgetProfile,
        },
      },
      { expectedLastEntryId: snapshotLastEntry.entryId },
    );
  } catch (error: unknown) {
    if (error instanceof CompareAndAppendMismatchError) {
      return {
        kind: 'stale_snapshot',
        expectedLastEntryId: error.expectedLastEntryId,
        actualLastEntryId: error.actualLastEntryId,
      };
    }
    throw error;
  }
  if (appended.role !== 'compaction') {
    throw new Error('compaction append returned a non-compaction entry');
  }
  return {
    kind: 'compacted',
    checkpoint: appended,
    providerRoundAnchorEntryId: snapshotLastEntry.entryId,
    retainedTokens,
    summaryTokens: summary.summaryTokens,
  };
}

function validateSummary(
  summary: ContextCompactionSummary,
  budgetProfile: BudgetProfile,
  retainedTokens: number,
  compactedHistoryTokens?: number,
):
  | Extract<CompactThreadContextResult, { kind: 'summary_invalid' }>
  | undefined {
  if (summary.summary.trim() === '') {
    return { kind: 'summary_invalid', reason: 'summary_empty' };
  }
  if (summary.shortSummary.trim() === '') {
    return { kind: 'summary_invalid', reason: 'short_summary_empty' };
  }
  if (
    !Number.isSafeInteger(summary.summaryTokens) ||
    summary.summaryTokens <= 0
  ) {
    return {
      kind: 'summary_invalid',
      reason: 'summary_token_count_not_positive_safe_integer',
    };
  }
  if (summary.summaryTokens > budgetProfile.summaryBudgetTokens) {
    return { kind: 'summary_invalid', reason: 'summary_exceeds_budget' };
  }

  const compactedRequestTokens =
    budgetProfile.requestOverheadTokens +
    Math.max(
      summary.summaryTokens + retainedTokens,
      compactedHistoryTokens ?? 0,
    );
  if (
    !Number.isSafeInteger(compactedRequestTokens) ||
    compactedRequestTokens > budgetProfile.thresholdTokens
  ) {
    return {
      kind: 'summary_invalid',
      reason: 'compacted_request_exceeds_threshold',
    };
  }
  return undefined;
}
