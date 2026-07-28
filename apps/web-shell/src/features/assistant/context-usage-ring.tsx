import type { ContextUsageUpdatedEventPayload } from '@geulbat/protocol/run-events';
import type { RunModelId } from '@geulbat/protocol/run-contract';

const CONTEXT_TOKEN_FORMATTER = new Intl.NumberFormat('ko-KR');
// 표시 전용 경고 문턱 — 컴팩션 트리거(thresholdTokens=100%)에 가까워지면
// 링 색으로만 미리 알린다. 동작(컴팩션 시점)에는 관여하지 않는다.
const CONTEXT_NEARING_DISPLAY_PERCENT = 80;
const CONTEXT_PERCENT_FORMATTER = new Intl.NumberFormat('ko-KR', {
  maximumFractionDigits: 1,
});

export function ContextUsageRing(props: {
  contextUsage: ContextUsageUpdatedEventPayload | null;
  modelId: RunModelId;
}) {
  const snapshot =
    props.contextUsage?.modelId === props.modelId ? props.contextUsage : null;
  const knownSnapshot =
    snapshot !== null && snapshot.quality !== 'unknown' ? snapshot : null;
  const measuredProgress =
    knownSnapshot?.state === 'measured'
      ? Math.min(
          100,
          (knownSnapshot.inputTokens / knownSnapshot.thresholdTokens) * 100,
        )
      : 0;
  const tooltip = formatContextUsageSummary(props.contextUsage, props.modelId);

  return (
    <span
      className="context-usage-ring"
      role="img"
      tabIndex={0}
      aria-label={tooltip}
      title={tooltip}
      data-tooltip={tooltip}
      data-state={snapshot?.state ?? 'unknown'}
      data-quality={
        snapshot?.quality ?? (snapshot === null ? 'unknown' : 'exact')
      }
      data-percentage={CONTEXT_PERCENT_FORMATTER.format(measuredProgress)}
      data-nearing={
        measuredProgress >= CONTEXT_NEARING_DISPLAY_PERCENT ? 'true' : undefined
      }
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

export function formatContextUsageSummary(
  contextUsage: ContextUsageUpdatedEventPayload | null,
  modelId: RunModelId,
): string {
  const snapshot = contextUsage?.modelId === modelId ? contextUsage : null;
  const progress =
    snapshot === null || snapshot.quality === 'unknown'
      ? 0
      : Math.min(100, (snapshot.inputTokens / snapshot.thresholdTokens) * 100);
  return formatContextUsageTooltip(snapshot, progress);
}

function formatContextUsageTooltip(
  snapshot: ContextUsageUpdatedEventPayload | null,
  progress: number,
): string {
  if (snapshot === null) {
    return '컨텍스트 0%';
  }
  if (snapshot.quality === 'unknown') {
    return '컨텍스트 사용량 측정 대기 중';
  }

  const percentage = CONTEXT_PERCENT_FORMATTER.format(progress);
  const tokens = `${CONTEXT_TOKEN_FORMATTER.format(snapshot.inputTokens)} / ${CONTEXT_TOKEN_FORMATTER.format(snapshot.thresholdTokens)} 토큰`;
  if (snapshot.state === 'compacted') {
    const commitProvenance =
      snapshot.compactionEntryId === undefined
        ? ''
        : ` · 히스토리 ${CONTEXT_TOKEN_FORMATTER.format(snapshot.historyBytesBefore)} → ${CONTEXT_TOKEN_FORMATTER.format(snapshot.historyBytesAfter)} 바이트 · 체크포인트 ${snapshot.compactionEntryId}`;
    return `컨텍스트 압축 완료 · 직전 ${percentage}% (${tokens})${commitProvenance}`;
  }
  if (snapshot.quality === 'estimated') {
    return `컨텍스트 추정 ${percentage}% (${tokens})`;
  }
  return `컨텍스트 ${percentage}% (${tokens})`;
}
