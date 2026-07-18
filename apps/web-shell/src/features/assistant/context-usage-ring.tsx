import type { ContextUsageUpdatedEventPayload } from '@geulbat/protocol/run-events';
import type { RunModelId } from '@geulbat/protocol/run-contract';

const CONTEXT_TOKEN_FORMATTER = new Intl.NumberFormat('ko-KR');
const CONTEXT_PERCENT_FORMATTER = new Intl.NumberFormat('ko-KR', {
  maximumFractionDigits: 1,
});

export function ContextUsageRing(props: {
  contextUsage: ContextUsageUpdatedEventPayload | null;
  modelId: RunModelId;
}) {
  const snapshot =
    props.contextUsage?.modelId === props.modelId ? props.contextUsage : null;
  const measuredProgress =
    snapshot?.state === 'measured'
      ? Math.min(100, (snapshot.inputTokens / snapshot.thresholdTokens) * 100)
      : 0;
  const previousProgress =
    snapshot === null
      ? 0
      : Math.min(100, (snapshot.inputTokens / snapshot.thresholdTokens) * 100);
  const tooltip = formatContextUsageTooltip(snapshot, previousProgress);

  return (
    <span
      className="context-usage-ring"
      role="img"
      tabIndex={0}
      aria-label={tooltip}
      title={tooltip}
      data-tooltip={tooltip}
      data-state={snapshot?.state ?? 'unknown'}
      data-percentage={CONTEXT_PERCENT_FORMATTER.format(measuredProgress)}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle
          className="context-usage-ring-track"
          cx="12"
          cy="12"
          r="9"
          pathLength="100"
        />
        <circle
          className="context-usage-ring-value"
          cx="12"
          cy="12"
          r="9"
          pathLength="100"
          strokeDasharray="100"
          strokeDashoffset={100 - measuredProgress}
        />
      </svg>
    </span>
  );
}

function formatContextUsageTooltip(
  snapshot: ContextUsageUpdatedEventPayload | null,
  progress: number,
): string {
  if (snapshot === null) {
    return '컨텍스트 0%';
  }

  const percentage = CONTEXT_PERCENT_FORMATTER.format(progress);
  const tokens = `${CONTEXT_TOKEN_FORMATTER.format(snapshot.inputTokens)} / ${CONTEXT_TOKEN_FORMATTER.format(snapshot.thresholdTokens)} 토큰`;
  if (snapshot.state === 'compacted') {
    return `컨텍스트 압축 완료 · 직전 ${percentage}% (${tokens})`;
  }
  return `컨텍스트 ${percentage}% (${tokens})`;
}
