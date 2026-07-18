import test from 'node:test';
import assert from 'node:assert/strict';

import {
  accumulateRunUsageTotals,
  createRunUsageTotals,
  hasRunUsageTotals,
} from './run-usage-totals.js';

void test('accumulateRunUsageTotals folds partial telemetry across rounds', () => {
  const totals = createRunUsageTotals();

  accumulateRunUsageTotals(totals, { inputTokens: 100, cachedInputTokens: 40 });
  accumulateRunUsageTotals(totals, { outputTokens: 25 });
  accumulateRunUsageTotals(totals, undefined);
  accumulateRunUsageTotals(totals, {
    inputTokens: 10,
    outputTokens: 5,
    cachedInputTokens: 2,
  });

  assert.deepEqual(totals, {
    inputTokens: 110,
    outputTokens: 30,
    cachedInputTokens: 42,
  });
});

void test('hasRunUsageTotals distinguishes empty totals from observed usage', () => {
  const totals = createRunUsageTotals();
  assert.equal(hasRunUsageTotals(totals), false);

  accumulateRunUsageTotals(totals, { outputTokens: 1 });
  assert.equal(hasRunUsageTotals(totals), true);
});
