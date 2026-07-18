import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateContextCompactionTrigger,
  resolveActiveContextBoundary,
  selectContextCompactionPrefix,
  validateContextCompactionBudget,
  type ContextCompactionBudget,
  type ContextCompactionTriggerBudget,
} from './context-compaction.js';

const TEST_BUDGET: ContextCompactionBudget = {
  contextWindow: 100,
  reserveTokens: 10,
  thresholdTokens: 90,
  keepRecentTokens: 50,
  summaryBudgetTokens: 20,
  requestOverheadTokens: 10,
};

void test('uncompacted history has no active boundary', () => {
  assert.deepEqual(
    resolveActiveContextBoundary<string>([
      { entryId: 'entry-1' },
      { entryId: 'entry-2' },
    ]),
    { kind: 'uncompacted' },
  );
});

void test('resolves the retained tail before its append-only checkpoint', () => {
  const result = resolveActiveContextBoundary<string>([
    { entryId: 'old' },
    { entryId: 'keep' },
    {
      entryId: 'checkpoint',
      checkpoint: { firstKeptEntryId: 'keep', value: 'summary' },
    },
    { entryId: 'later' },
  ]);

  assert.deepEqual(result, {
    kind: 'resolved',
    checkpointEntryId: 'checkpoint',
    checkpointIndex: 2,
    firstKeptIndex: 1,
    checkpoint: 'summary',
  });
});

void test('the latest checkpoint owns the active boundary', () => {
  const result = resolveActiveContextBoundary<string>([
    { entryId: 'old' },
    { entryId: 'first-keep' },
    {
      entryId: 'first-checkpoint',
      checkpoint: { firstKeptEntryId: 'first-keep', value: 'first' },
    },
    { entryId: 'second-keep' },
    {
      entryId: 'second-checkpoint',
      checkpoint: { firstKeptEntryId: 'second-keep', value: 'second' },
    },
    { entryId: 'latest' },
  ]);

  assert.deepEqual(result, {
    kind: 'resolved',
    checkpointEntryId: 'second-checkpoint',
    checkpointIndex: 4,
    firstKeptIndex: 3,
    checkpoint: 'second',
  });
});

void test('a missing retained-tail boundary fails closed', () => {
  const result = resolveActiveContextBoundary<string>([
    {
      entryId: 'checkpoint',
      checkpoint: { firstKeptEntryId: 'missing', value: 'summary' },
    },
  ]);

  assert.deepEqual(result, {
    kind: 'invalid',
    reason: 'missing_first_kept_entry',
    checkpointEntryId: 'checkpoint',
    firstKeptEntryId: 'missing',
  });
});

void test('duplicate retained-tail ids fail closed', () => {
  const result = resolveActiveContextBoundary<string>([
    { entryId: 'keep' },
    { entryId: 'keep' },
    {
      entryId: 'checkpoint',
      checkpoint: { firstKeptEntryId: 'keep', value: 'summary' },
    },
  ]);

  assert.equal(result.kind, 'invalid');
  if (result.kind === 'invalid') {
    assert.equal(result.reason, 'duplicate_first_kept_entry');
  }
});

void test('a checkpoint cannot be the retained-tail boundary', () => {
  const result = resolveActiveContextBoundary<string>([
    {
      entryId: 'first-checkpoint',
      checkpoint: { firstKeptEntryId: 'old', value: 'first' },
    },
    {
      entryId: 'latest-checkpoint',
      checkpoint: { firstKeptEntryId: 'first-checkpoint', value: 'second' },
    },
  ]);

  assert.equal(result.kind, 'invalid');
  if (result.kind === 'invalid') {
    assert.equal(result.reason, 'first_kept_entry_is_checkpoint');
  }
});

void test('a retained-tail boundary after its checkpoint fails closed', () => {
  const result = resolveActiveContextBoundary<string>([
    {
      entryId: 'checkpoint',
      checkpoint: { firstKeptEntryId: 'later', value: 'summary' },
    },
    { entryId: 'later' },
  ]);

  assert.equal(result.kind, 'invalid');
  if (result.kind === 'invalid') {
    assert.equal(result.reason, 'first_kept_entry_after_checkpoint');
  }
});

void test('an explicit compaction budget must fit both threshold and context', () => {
  assert.deepEqual(validateContextCompactionBudget(TEST_BUDGET), {
    kind: 'valid',
  });
  assert.deepEqual(
    validateContextCompactionBudget({
      ...TEST_BUDGET,
      keepRecentTokens: TEST_BUDGET.thresholdTokens,
    }),
    { kind: 'invalid', reason: 'compacted_request_exceeds_threshold' },
  );
  assert.deepEqual(
    validateContextCompactionBudget({
      ...TEST_BUDGET,
      reserveTokens: TEST_BUDGET.contextWindow,
    }),
    {
      kind: 'invalid',
      reason: 'threshold_and_reserve_exceed_context_window',
    },
  );
});

void test('the trigger uses only the host-supplied request count and threshold', () => {
  assert.deepEqual(evaluateContextCompactionTrigger(89, TEST_BUDGET), {
    kind: 'under_threshold',
  });
  assert.deepEqual(evaluateContextCompactionTrigger(90, TEST_BUDGET), {
    kind: 'threshold_reached',
  });

  const nativeBudget: ContextCompactionTriggerBudget = {
    contextWindow: TEST_BUDGET.contextWindow,
    reserveTokens: TEST_BUDGET.reserveTokens,
    thresholdTokens: TEST_BUDGET.thresholdTokens,
  };
  assert.deepEqual(evaluateContextCompactionTrigger(90, nativeBudget), {
    kind: 'threshold_reached',
  });
});

void test('prefix selection keeps the newest items within the explicit budget', () => {
  assert.deepEqual(
    selectContextCompactionPrefix(
      [
        { tokenCount: 40, canStartRetainedTail: true },
        { tokenCount: 30, canStartRetainedTail: true },
        { tokenCount: 20, canStartRetainedTail: true },
      ],
      50,
    ),
    {
      kind: 'selected',
      firstKeptIndex: 1,
      prefixTokens: 40,
      retainedTokens: 50,
    },
  );
});

void test('an atomic retained unit is never split to make the numbers fit', () => {
  assert.deepEqual(
    selectContextCompactionPrefix(
      [
        { tokenCount: 40, canStartRetainedTail: true },
        { tokenCount: 30, canStartRetainedTail: true },
        { tokenCount: 20, canStartRetainedTail: false },
        { tokenCount: 20, canStartRetainedTail: false },
      ],
      50,
    ),
    { kind: 'tail_exceeds_budget' },
  );
});

void test('unsafe host token counts fail closed', () => {
  assert.deepEqual(
    selectContextCompactionPrefix(
      [{ tokenCount: Number.NaN, canStartRetainedTail: true }],
      TEST_BUDGET.keepRecentTokens,
    ),
    {
      kind: 'invalid',
      reason: 'item_token_count_not_safe_integer',
      itemIndex: 0,
    },
  );
});
