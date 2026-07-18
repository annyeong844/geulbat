import { useEffect, useRef, useState } from 'react';

import type { RunUsageTotals } from '@geulbat/protocol/run-events';
import type { RunTranscriptEntry } from '../../lib/run-transcript-entry.js';
import {
  formatElapsedDuration,
  formatRunUsageMeta,
} from './assistant-transcript-entry-blocks.js';

// 실행 중 내내 살아 있는 상태줄 문구 — 15초마다 다음 문구로 순환한다.
const RUN_STATUS_VERBS = [
  '생각 중',
  '궁리 중',
  '조사 중',
  '작성 중',
  '다듬는 중',
  '검토 중',
] as const;

const VERB_ROTATION_MS = 15_000;

// 지금 무엇을 하는지 힌트 — 마지막 활동 엔트리가 실행 중이면 그 이름을,
// 끝났으면 모델 차례이므로 null(기본 문구만)을 돌려준다.
export function resolveRunStatusActivity(
  entries: readonly RunTranscriptEntry[],
): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) {
      continue;
    }
    if (entry.kind === 'tool_activity') {
      return entry.state === 'running' ? `${entry.tool} 실행 중` : null;
    }
    if (entry.kind === 'subagent_activity') {
      return entry.state === 'spawned' || entry.state === 'approval_required'
        ? '보조 작업 진행 중'
        : null;
    }
  }
  return null;
}

// hang처럼 보이지 않게 — 도구 카드가 없거나 모델이 조용히 생각하는 동안에도
// 경과 시간이 계속 오르는 것을 보여준다.
export function RunStatusRow(props: {
  transcriptEntries: readonly RunTranscriptEntry[];
  // 있으면 런 누적 총입력과 그 안의 캐시 부분집합을 명시한다.
  usageTotals?: RunUsageTotals | null;
}) {
  const startedAtMsRef = useRef(Date.now());
  const [nowMs, setNowMs] = useState(() => startedAtMsRef.current);

  useEffect(() => {
    // 브라우저에서만 tick — node 테스트 러너에서는 활성 타이머가 프로세스
    // 종료를 막는다(테스트는 초기 렌더만 단언한다).
    if (typeof window === 'undefined') {
      return undefined;
    }
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const elapsedMs = Math.max(0, nowMs - startedAtMsRef.current);
  const verb =
    RUN_STATUS_VERBS[
      Math.floor(elapsedMs / VERB_ROTATION_MS) % RUN_STATUS_VERBS.length
    ] ?? RUN_STATUS_VERBS[0];
  const activity = resolveRunStatusActivity(props.transcriptEntries);
  const usage = props.usageTotals ?? null;
  const usageLabel = usage !== null ? ` · ${formatRunUsageMeta(usage)}` : '';

  return (
    <div className="run-status-row" role="status" aria-live="off">
      <span className="run-status-glyph" aria-hidden="true">
        ✻
      </span>
      <span>
        {verb}… ({formatElapsedDuration(elapsedMs)}
        {activity ? ` · ${activity}` : ''}
        {usageLabel})
      </span>
    </div>
  );
}
