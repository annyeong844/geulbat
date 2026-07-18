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
  type ProviderTransitionCompactionEntryData,
} from '../contract.js';
import type { HistoryItem } from '../../llm/provider/wire/types.js';
import {
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

type CompactThreadContextNativeResult =
  | { kind: 'transcript_empty' }
  | {
      kind: 'stale_snapshot';
      expectedLastEntryId: string;
      actualLastEntryId: string | null;
    }
  | {
      kind: 'compacted';
      checkpoint: CompactionTranscriptEntry;
    };

interface ProviderTransitionContextSummary {
  summary: string;
  inputTokens?: number;
}

interface ProviderTransitionContextSummarizer {
  summarizeContext(request: {
    coveredThroughEntryId: string;
    signal?: AbortSignal;
  }): Promise<ProviderTransitionContextSummary>;
}

type CompactThreadContextForProviderTransitionResult =
  | { kind: 'transcript_empty' }
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

  const summary = await args.summarizer.summarizeContext({
    coveredThroughEntryId: snapshotLastEntry.entryId,
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
    coveredThroughEntryId: snapshotLastEntry.entryId,
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
  tokensBefore: number;
  contextWindow: number;
  thresholdTokens: number;
  compactHistory: () => Promise<{
    output: ProviderNativeCompactionOutputItem[];
  }>;
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

  const compacted = await args.compactHistory();
  const compactionData = {
    kind: 'provider_native' as const,
    providerId: args.providerId,
    model: args.model,
    output: compacted.output,
    tokensBefore: args.tokensBefore,
    contextWindow: args.contextWindow,
    thresholdTokens: args.thresholdTokens,
  };
  if (!isAgentProviderNativeCompactionEntryData(compactionData)) {
    throw new Error('provider-native compaction output is invalid');
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
  args.history.splice(0, args.history.length, {
    kind: 'provider_native_compaction',
    providerId: appended.compactionData.providerId,
    model: appended.compactionData.model,
    output: appended.compactionData.output,
  });
  return { kind: 'compacted', checkpoint: appended };
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
  const summaryValidation = validateSummary(summary, prepared);
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

function validateSummary(
  summary: ContextCompactionSummary,
  prepared: PreparedContextCompaction,
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
  if (summary.summaryTokens > prepared.budgetProfile.summaryBudgetTokens) {
    return { kind: 'summary_invalid', reason: 'summary_exceeds_budget' };
  }

  const compactedRequestTokens =
    prepared.budgetProfile.requestOverheadTokens +
    summary.summaryTokens +
    prepared.retainedTokens;
  if (
    !Number.isSafeInteger(compactedRequestTokens) ||
    compactedRequestTokens > prepared.budgetProfile.thresholdTokens
  ) {
    return {
      kind: 'summary_invalid',
      reason: 'compacted_request_exceeds_threshold',
    };
  }
  return undefined;
}
