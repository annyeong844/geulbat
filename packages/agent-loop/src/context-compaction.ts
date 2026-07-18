export interface ContextCompactionCheckpoint<TCheckpoint> {
  firstKeptEntryId: string;
  value: TCheckpoint;
}

export interface ContextCompactionBoundaryEntry<TCheckpoint> {
  entryId: string;
  checkpoint?: ContextCompactionCheckpoint<TCheckpoint>;
}

export type InvalidContextCompactionBoundaryReason =
  | 'missing_first_kept_entry'
  | 'duplicate_first_kept_entry'
  | 'first_kept_entry_is_checkpoint'
  | 'first_kept_entry_after_checkpoint';

interface InvalidContextCompactionBoundary {
  kind: 'invalid';
  reason: InvalidContextCompactionBoundaryReason;
  checkpointEntryId: string;
  firstKeptEntryId: string;
}

export type ActiveContextBoundaryResolution<TCheckpoint> =
  | { kind: 'uncompacted' }
  | {
      kind: 'resolved';
      checkpointEntryId: string;
      checkpointIndex: number;
      firstKeptIndex: number;
      checkpoint: TCheckpoint;
    }
  | InvalidContextCompactionBoundary;

export interface ContextCompactionBudget {
  contextWindow: number;
  reserveTokens: number;
  thresholdTokens: number;
  keepRecentTokens: number;
  summaryBudgetTokens: number;
  requestOverheadTokens: number;
}

export type ContextCompactionTriggerBudget = Pick<
  ContextCompactionBudget,
  'contextWindow' | 'reserveTokens' | 'thresholdTokens'
>;

export type InvalidContextCompactionBudgetReason =
  | 'token_value_not_safe_integer'
  | 'required_token_value_not_positive'
  | 'threshold_and_reserve_exceed_context_window'
  | 'compacted_request_exceeds_threshold';

export type ContextCompactionBudgetValidation =
  | { kind: 'valid' }
  | {
      kind: 'invalid';
      reason: InvalidContextCompactionBudgetReason;
      field?: keyof ContextCompactionBudget;
    };

export type ContextCompactionTriggerEvaluation =
  | { kind: 'under_threshold' }
  | { kind: 'threshold_reached' }
  | {
      kind: 'invalid';
      reason:
        | InvalidContextCompactionBudgetReason
        | 'current_request_tokens_not_safe_integer';
      field?: keyof ContextCompactionBudget;
    };

export interface ContextCompactionSelectionItem {
  tokenCount: number;
  canStartRetainedTail: boolean;
}

export type ContextCompactionPrefixSelection =
  | { kind: 'no_summarizable_prefix' }
  | { kind: 'tail_exceeds_budget' }
  | {
      kind: 'selected';
      firstKeptIndex: number;
      prefixTokens: number;
      retainedTokens: number;
    }
  | {
      kind: 'invalid';
      reason: 'item_token_count_not_safe_integer' | 'token_count_overflow';
      itemIndex?: number;
    };

export function validateContextCompactionBudget(
  budget: ContextCompactionBudget,
): ContextCompactionBudgetValidation {
  for (const field of contextCompactionBudgetFields) {
    if (!isNonNegativeSafeInteger(budget[field])) {
      return {
        kind: 'invalid',
        reason: 'token_value_not_safe_integer',
        field,
      };
    }
  }

  for (const field of positiveContextCompactionBudgetFields) {
    if (budget[field] === 0) {
      return {
        kind: 'invalid',
        reason: 'required_token_value_not_positive',
        field,
      };
    }
  }

  const thresholdAndReserve = addSafeIntegers(
    budget.thresholdTokens,
    budget.reserveTokens,
  );
  if (
    thresholdAndReserve === undefined ||
    thresholdAndReserve > budget.contextWindow
  ) {
    return {
      kind: 'invalid',
      reason: 'threshold_and_reserve_exceed_context_window',
    };
  }

  const compactedRequestTokens = addSafeIntegers(
    budget.requestOverheadTokens,
    budget.summaryBudgetTokens,
    budget.keepRecentTokens,
  );
  if (
    compactedRequestTokens === undefined ||
    compactedRequestTokens > budget.thresholdTokens
  ) {
    return {
      kind: 'invalid',
      reason: 'compacted_request_exceeds_threshold',
    };
  }

  return { kind: 'valid' };
}

export function evaluateContextCompactionTrigger(
  currentRequestTokens: number,
  budget: ContextCompactionBudget | ContextCompactionTriggerBudget,
): ContextCompactionTriggerEvaluation {
  const validation = isContextCompactionBudget(budget)
    ? validateContextCompactionBudget(budget)
    : validateContextCompactionTriggerBudget(budget);
  if (validation.kind === 'invalid') {
    return validation;
  }
  if (!isNonNegativeSafeInteger(currentRequestTokens)) {
    return {
      kind: 'invalid',
      reason: 'current_request_tokens_not_safe_integer',
    };
  }
  return currentRequestTokens >= budget.thresholdTokens
    ? { kind: 'threshold_reached' }
    : { kind: 'under_threshold' };
}

function validateContextCompactionTriggerBudget(
  budget: ContextCompactionTriggerBudget,
): ContextCompactionBudgetValidation {
  for (const field of contextCompactionTriggerBudgetFields) {
    if (!isNonNegativeSafeInteger(budget[field])) {
      return {
        kind: 'invalid',
        reason: 'token_value_not_safe_integer',
        field,
      };
    }
  }
  if (budget.contextWindow === 0 || budget.thresholdTokens === 0) {
    return {
      kind: 'invalid',
      reason: 'required_token_value_not_positive',
      field: budget.contextWindow === 0 ? 'contextWindow' : 'thresholdTokens',
    };
  }

  const thresholdAndReserve = addSafeIntegers(
    budget.thresholdTokens,
    budget.reserveTokens,
  );
  return thresholdAndReserve === undefined ||
    thresholdAndReserve > budget.contextWindow
    ? {
        kind: 'invalid',
        reason: 'threshold_and_reserve_exceed_context_window',
      }
    : { kind: 'valid' };
}

function isContextCompactionBudget(
  budget: ContextCompactionBudget | ContextCompactionTriggerBudget,
): budget is ContextCompactionBudget {
  return (
    'keepRecentTokens' in budget &&
    'summaryBudgetTokens' in budget &&
    'requestOverheadTokens' in budget
  );
}

export function selectContextCompactionPrefix(
  items: readonly ContextCompactionSelectionItem[],
  keepRecentTokens: number,
): ContextCompactionPrefixSelection {
  if (!isNonNegativeSafeInteger(keepRecentTokens)) {
    return {
      kind: 'invalid',
      reason: 'item_token_count_not_safe_integer',
    };
  }

  let totalTokens = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item === undefined || !isNonNegativeSafeInteger(item.tokenCount)) {
      return {
        kind: 'invalid',
        reason: 'item_token_count_not_safe_integer',
        itemIndex: index,
      };
    }
    const nextTotal = addSafeIntegers(totalTokens, item.tokenCount);
    if (nextTotal === undefined) {
      return { kind: 'invalid', reason: 'token_count_overflow' };
    }
    totalTokens = nextTotal;
  }

  let candidateIndex = items.length;
  let retainedTokens = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item === undefined) {
      return {
        kind: 'invalid',
        reason: 'item_token_count_not_safe_integer',
        itemIndex: index,
      };
    }
    const nextRetained = addSafeIntegers(retainedTokens, item.tokenCount);
    if (nextRetained === undefined) {
      return { kind: 'invalid', reason: 'token_count_overflow' };
    }
    if (nextRetained > keepRecentTokens) {
      candidateIndex = index + 1;
      break;
    }
    candidateIndex = index;
    retainedTokens = nextRetained;
  }

  if (candidateIndex === 0 || items.length === 0) {
    return { kind: 'no_summarizable_prefix' };
  }
  if (candidateIndex === items.length) {
    return { kind: 'tail_exceeds_budget' };
  }

  let firstKeptIndex = candidateIndex;
  while (firstKeptIndex > 0) {
    const item = items[firstKeptIndex];
    if (item?.canStartRetainedTail === true) {
      break;
    }
    firstKeptIndex -= 1;
  }
  if (firstKeptIndex === 0) {
    return { kind: 'tail_exceeds_budget' };
  }

  retainedTokens = 0;
  for (let index = firstKeptIndex; index < items.length; index += 1) {
    const item = items[index];
    if (item === undefined) {
      return {
        kind: 'invalid',
        reason: 'item_token_count_not_safe_integer',
        itemIndex: index,
      };
    }
    const nextRetained = addSafeIntegers(retainedTokens, item.tokenCount);
    if (nextRetained === undefined) {
      return { kind: 'invalid', reason: 'token_count_overflow' };
    }
    retainedTokens = nextRetained;
  }
  if (retainedTokens > keepRecentTokens) {
    return { kind: 'tail_exceeds_budget' };
  }

  return {
    kind: 'selected',
    firstKeptIndex,
    prefixTokens: totalTokens - retainedTokens,
    retainedTokens,
  };
}

export function resolveActiveContextBoundary<TCheckpoint>(
  entries: readonly ContextCompactionBoundaryEntry<TCheckpoint>[],
): ActiveContextBoundaryResolution<TCheckpoint> {
  let checkpointEntry: ContextCompactionBoundaryEntry<TCheckpoint> | undefined;
  let checkpointIndex: number | undefined;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const candidate = entries[index];
    if (candidate?.checkpoint !== undefined) {
      checkpointEntry = candidate;
      checkpointIndex = index;
      break;
    }
  }

  if (
    checkpointEntry?.checkpoint === undefined ||
    checkpointIndex === undefined
  ) {
    return { kind: 'uncompacted' };
  }

  const checkpoint = checkpointEntry.checkpoint;
  let firstKeptEntry: ContextCompactionBoundaryEntry<TCheckpoint> | undefined;
  let firstKeptIndex: number | undefined;
  let matchCount = 0;

  for (let index = 0; index < entries.length; index += 1) {
    const candidate = entries[index];
    if (candidate?.entryId !== checkpoint.firstKeptEntryId) {
      continue;
    }
    matchCount += 1;
    firstKeptEntry = candidate;
    firstKeptIndex = index;
  }

  if (firstKeptEntry === undefined || firstKeptIndex === undefined) {
    return invalidBoundary(
      checkpointEntry.entryId,
      checkpoint.firstKeptEntryId,
      'missing_first_kept_entry',
    );
  }
  if (matchCount > 1) {
    return invalidBoundary(
      checkpointEntry.entryId,
      checkpoint.firstKeptEntryId,
      'duplicate_first_kept_entry',
    );
  }
  if (firstKeptEntry.checkpoint !== undefined) {
    return invalidBoundary(
      checkpointEntry.entryId,
      checkpoint.firstKeptEntryId,
      'first_kept_entry_is_checkpoint',
    );
  }
  if (firstKeptIndex > checkpointIndex) {
    return invalidBoundary(
      checkpointEntry.entryId,
      checkpoint.firstKeptEntryId,
      'first_kept_entry_after_checkpoint',
    );
  }

  return {
    kind: 'resolved',
    checkpointEntryId: checkpointEntry.entryId,
    checkpointIndex,
    firstKeptIndex,
    checkpoint: checkpoint.value,
  };
}

function invalidBoundary(
  checkpointEntryId: string,
  firstKeptEntryId: string,
  reason: InvalidContextCompactionBoundaryReason,
): InvalidContextCompactionBoundary {
  return {
    kind: 'invalid',
    reason,
    checkpointEntryId,
    firstKeptEntryId,
  };
}

const contextCompactionBudgetFields = [
  'contextWindow',
  'reserveTokens',
  'thresholdTokens',
  'keepRecentTokens',
  'summaryBudgetTokens',
  'requestOverheadTokens',
] as const satisfies readonly (keyof ContextCompactionBudget)[];

const contextCompactionTriggerBudgetFields = [
  'contextWindow',
  'reserveTokens',
  'thresholdTokens',
] as const satisfies readonly (keyof ContextCompactionTriggerBudget)[];

const positiveContextCompactionBudgetFields = [
  'contextWindow',
  'thresholdTokens',
  'keepRecentTokens',
  'summaryBudgetTokens',
] as const satisfies readonly (keyof ContextCompactionBudget)[];

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function addSafeIntegers(...values: readonly number[]): number | undefined {
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : undefined;
}
