import type { RunUsageTotals } from '../contract.js';
import type { ProviderUsageTelemetry } from '../../llm/index.js';

// Aggregated provider token usage for one run. The protocol owns the
// RunUsageTotals shape (it rides on subagent_terminal); this module owns
// folding the optional per-round ProviderUsageTelemetry into it.
export type { RunUsageTotals } from '../contract.js';

export function createRunUsageTotals(): RunUsageTotals {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
}

export function accumulateRunUsageTotals(
  totals: RunUsageTotals,
  telemetry: ProviderUsageTelemetry | undefined,
): RunUsageTotals {
  if (!telemetry) {
    return totals;
  }
  totals.inputTokens += telemetry.inputTokens ?? 0;
  totals.outputTokens += telemetry.outputTokens ?? 0;
  totals.cachedInputTokens += telemetry.cachedInputTokens ?? 0;
  return totals;
}

export function hasRunUsageTotals(totals: RunUsageTotals): boolean {
  return (
    totals.inputTokens > 0 ||
    totals.outputTokens > 0 ||
    totals.cachedInputTokens > 0
  );
}
