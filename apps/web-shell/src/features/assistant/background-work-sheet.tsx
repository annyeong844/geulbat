import type { RunTranscriptEntry } from '../../lib/run-transcript-entry.js';
import { RunTranscriptEntryBlock } from './assistant-transcript-entry-blocks.js';

type SubagentActivityEntry = Extract<
  RunTranscriptEntry,
  { kind: 'subagent_activity' }
>;

// 백그라운드 작업 시트 — 흩어진 서브에이전트 활동을 한 오버레이에 모아
// 상태 도트·카운트와 함께 보여준다 (디자인개편 참조안 이미지 8·9).
// 개별 행은 기존 보조 작업 카드(트랜스크립트 보기 포함)를 그대로 쓴다.
export function BackgroundWorkSheet(props: {
  entries: SubagentActivityEntry[];
  onClose: () => void;
  onOpenChildSession?: Parameters<
    typeof RunTranscriptEntryBlock
  >[0]['onOpenChildSession'];
}) {
  const { entries, onClose, onOpenChildSession } = props;
  const runningCount = entries.filter(
    (entry) => entry.state === 'spawned' || entry.state === 'approval_required',
  ).length;
  const completedCount = entries.filter(
    (entry) => entry.state === 'completed',
  ).length;
  const troubledCount = entries.length - runningCount - completedCount;

  return (
    <div
      className="child-session-overlay"
      role="dialog"
      aria-label="백그라운드 작업"
    >
      <div
        className="child-session-backdrop"
        aria-hidden="true"
        onClick={onClose}
      />
      <div className="child-session-panel background-work-panel">
        <div className="child-session-header">
          <div>
            <div className="child-session-title">백그라운드 작업</div>
            <div className="child-session-meta">
              {`실행 중 ${runningCount} · 완료 ${completedCount}`}
              {troubledCount > 0 ? ` · 실패/취소 ${troubledCount}` : ''}
            </div>
          </div>
          <span className="subagent-progress-dots" aria-hidden="true">
            {entries.map((entry) => (
              <span
                key={entry.childRunId}
                className={`subagent-progress-dot ${entry.state}`}
              />
            ))}
          </span>
          <button
            type="button"
            className="child-session-close"
            aria-label="백그라운드 작업 시트 닫기"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="child-session-body background-work-body">
          {entries.length === 0 ? (
            <div className="child-session-notice">
              아직 백그라운드 작업이 없습니다.
            </div>
          ) : (
            entries.map((entry) => (
              <RunTranscriptEntryBlock
                key={entry.childRunId}
                entry={entry}
                {...(onOpenChildSession !== undefined
                  ? { onOpenChildSession }
                  : {})}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
