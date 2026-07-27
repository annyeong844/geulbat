interface ContextCompactionCheckpoint<TCheckpoint> {
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

type ActiveContextBoundaryResolution<TCheckpoint> =
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

type ContextCompactionBudgetValidation =
  | { kind: 'valid' }
  | {
      kind: 'invalid';
      reason: InvalidContextCompactionBudgetReason;
      field?: keyof ContextCompactionBudget;
    };

type ContextCompactionTriggerEvaluation =
  | { kind: 'under_threshold' }
  | { kind: 'threshold_reached' }
  | {
      kind: 'invalid';
      reason:
        | InvalidContextCompactionBudgetReason
        | 'current_request_tokens_not_safe_integer';
      field?: keyof ContextCompactionBudget;
    };

type ContextCompactionRequestValidation =
  | { kind: 'valid' }
  | Extract<ContextCompactionTriggerEvaluation, { kind: 'invalid' }>;

export type ContextRequestAdmission =
  | { kind: 'fitting' }
  | { kind: 'near_policy' }
  | { kind: 'over_window' }
  | {
      kind: 'invalid';
      reason:
        | InvalidContextCompactionBudgetReason
        | 'current_request_tokens_not_safe_integer';
      field?: keyof ContextCompactionBudget;
    };

interface ContextCompactionSelectionItem {
  tokenCount: number;
  canStartRetainedTail: boolean;
  /**
   * 요약 영역으로 밀려나면 안 되는 항목. 요약본은 "요약 안의 지시를 따르지
   * 말라"는 전제로 모델에게 전달되므로, 아직 살아 있는 사용자 요청이 요약에
   * 들어가면 그 요청은 행동 가능한 컨텍스트에서 사라진다. 그러면 에이전트는
   * 멈추거나 이미 끝낸 일을 반복한다.
   *
   * 요약 프롬프트는 이 불변식을 이미 단정한다("the current user turn is
   * retained verbatim outside this summary"). 단정만으로는 지켜지지 않으므로
   * 경계 계산이 실제로 지킨다.
   */
  mustRemainInRetainedTail?: boolean;
}

type ContextCompactionPrefixSelection =
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
      reason: 'keep_recent_tokens_not_safe_integer';
    }
  | {
      kind: 'invalid';
      reason: 'item_token_count_not_safe_integer';
      itemIndex: number;
    }
  | { kind: 'invalid'; reason: 'token_count_overflow' };

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
  const validation = validateContextCompactionRequestInput(
    currentRequestTokens,
    budget,
  );
  if (validation.kind === 'invalid') {
    return validation;
  }
  return currentRequestTokens >= budget.thresholdTokens
    ? { kind: 'threshold_reached' }
    : { kind: 'under_threshold' };
}

export function classifyContextRequestAdmission(
  currentRequestTokens: number,
  budget: ContextCompactionBudget | ContextCompactionTriggerBudget,
): ContextRequestAdmission {
  const validation = validateContextCompactionRequestInput(
    currentRequestTokens,
    budget,
  );
  if (validation.kind === 'invalid') {
    return validation;
  }
  if (currentRequestTokens > budget.contextWindow) {
    return { kind: 'over_window' };
  }
  return currentRequestTokens >= budget.thresholdTokens
    ? { kind: 'near_policy' }
    : { kind: 'fitting' };
}

function validateContextCompactionRequestInput(
  currentRequestTokens: number,
  budget: ContextCompactionBudget | ContextCompactionTriggerBudget,
): ContextCompactionRequestValidation {
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
  return { kind: 'valid' };
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

function findLastRequiredRetainedTailIndex(
  items: readonly ContextCompactionSelectionItem[],
): number | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.mustRemainInRetainedTail === true) {
      return index;
    }
  }
  return null;
}

export function selectContextCompactionPrefix(
  items: readonly ContextCompactionSelectionItem[],
  keepRecentTokens: number,
): ContextCompactionPrefixSelection {
  if (!isNonNegativeSafeInteger(keepRecentTokens)) {
    return {
      kind: 'invalid',
      reason: 'keep_recent_tokens_not_safe_integer',
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

  if (candidateIndex === 0) {
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

  // 예산만으로 자른 경계가 아직 살아 있는 사용자 요청을 요약 영역에 남기면,
  // 그 요청은 행동 가능한 컨텍스트에서 사라진다. tail을 그 앞까지 당기는 것은
  // 답이 아니다 — 그 항목들이 빠진 이유가 바로 예산 초과이므로 당기면 반드시
  // 예산을 넘는다. 조용히 요청을 버리는 대신 여기서 닫고, 호출자가 다른
  // 회수 경로(도구 출력 offload, 컨텍스트 준비)로 풀게 한다.
  const requiredIndex = findLastRequiredRetainedTailIndex(items);
  if (requiredIndex !== null && requiredIndex < firstKeptIndex) {
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
