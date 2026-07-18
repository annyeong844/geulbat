import type { RunUsageTotals } from '@geulbat/protocol/run-events';
import type { RunTranscriptEntry } from '../../lib/run-transcript-entry.js';
import { buildApprovalSummary } from '../../lib/approvals/approval-summary.js';
import { TranscriptTextMessage } from './assistant-transcript-message.js';
import { assistantStyles } from './assistant-styles.js';
import { formatSubagentModelMeta } from './model-copy.js';
import { AskUserCard } from './ask-user/ask-user-card.js';
import {
  ASK_USER_TOOL_NAME,
  readAskUserCardViewFromToolArgs,
} from './ask-user/ask-user-card-view.js';
import {
  VisualizeStreamingWidget,
  VisualizeWidget,
  type WidgetToolRequestHandler,
} from './visualize/visualize-widget.js';
import {
  readVisualizeWidgetViewFromToolArgs,
  VISUALIZE_TOOL_NAME,
} from './visualize/visualize-widget-view.js';

export type { WidgetToolRequestHandler };

/**
 * tool_call / tool_result — 작가-facing 한 표현 (§3.3.2 #5):
 * 한 줄 요약 + 클릭 expand. raw JSON 노출은 본 phase 밖 dev surface owner.
 */
export function RunTranscriptEntryBlock(props: {
  entry: RunTranscriptEntry;
  onOpenChildSession?: (
    entry: Extract<RunTranscriptEntry, { kind: 'subagent_activity' }> & {
      childThreadId: string;
    },
  ) => void;
  // visualize 위젯의 sendPrompt를 기존 전송 경로로 번역하는 콜백
  onWidgetPrompt?: (prompt: string) => Promise<void> | void;
  // ask_user 카드 답변 — 사용자 선택이므로 아티팩트 귀속 없이 전송한다
  onAskUserAnswer?: (prompt: string) => Promise<void> | void;
  // 위젯 발 도구 호출(run.tool) 번역 콜백
  onWidgetToolRequest?: WidgetToolRequestHandler;
}) {
  const {
    entry,
    onOpenChildSession,
    onWidgetPrompt,
    onAskUserAnswer,
    onWidgetToolRequest,
  } = props;

  switch (entry.kind) {
    case 'assistant_text':
      return (
        <div style={assistantStyles.commentaryBlock}>
          <pre style={assistantStyles.messageText}>{entry.text}</pre>
        </div>
      );
    case 'user_text':
      // 소비된 스티어 — 실제 사용자 말풍선으로 합류
      return <TranscriptTextMessage messageRole="user" content={entry.text} />;
    case 'tool_activity': {
      // 실데이터 스트리밍 중인 visualize — 코드가 도착하는 대로 그린다
      if (entry.tool === VISUALIZE_TOOL_NAME && entry.argsText !== undefined) {
        return (
          <div className="transcript-message from-assistant">
            <VisualizeStreamingWidget argsText={entry.argsText} />
          </div>
        );
      }
      // visualize 호출은 상태 행 대신 위젯 자체를 인라인으로 그린다
      if (entry.tool === VISUALIZE_TOOL_NAME && entry.args !== undefined) {
        const widgetView = readVisualizeWidgetViewFromToolArgs(entry.args);
        if (widgetView !== null) {
          return (
            <div className="transcript-message from-assistant">
              <VisualizeWidget
                view={widgetView}
                {...(onWidgetPrompt !== undefined ? { onWidgetPrompt } : {})}
                {...(onWidgetToolRequest !== undefined
                  ? { onWidgetToolRequest }
                  : {})}
              />
            </div>
          );
        }
      }
      // ask_user 호출은 선택지 카드로 — 옵션 클릭이 답장이 된다
      if (entry.tool === ASK_USER_TOOL_NAME && entry.args !== undefined) {
        const cardView = readAskUserCardViewFromToolArgs(entry.args);
        if (cardView !== null) {
          return (
            <div className="transcript-message from-assistant">
              <AskUserCard
                view={cardView}
                {...(onAskUserAnswer !== undefined
                  ? { onAnswer: onAskUserAnswer }
                  : {})}
              />
            </div>
          );
        }
      }
      const stateGlyph = entry.state === 'running' ? '…' : '✓';
      const stateLabel =
        entry.state === 'running' ? '실행 중' : formatToolState(entry.state);
      return (
        <details className="tool-row">
          <summary>
            <span className="tool-row-icon">{stateGlyph}</span>
            <span className="tool-row-name">{entry.tool}</span>
            <span className="tool-row-summary">{stateLabel}</span>
          </summary>
          <div className="tool-row-detail">
            {`도구: ${entry.tool}\n상태: ${stateLabel}`}
          </div>
        </details>
      );
    }
    case 'approval_request': {
      const summary = buildApprovalSummary(entry.pendingApproval);
      return (
        <div style={assistantStyles.approvalNoticeBlock}>
          <div>{summary.title}</div>
          {summary.detail ? (
            <div style={assistantStyles.approvalNoticeDetail}>
              {summary.detail}
            </div>
          ) : null}
        </div>
      );
    }
    case 'subagent_activity': {
      const title = formatSubagentActivityTitle(entry);
      const meta = formatSubagentActivityMeta(entry);
      const summaryText = meta ? `${title} (${meta})` : title;
      const childThreadId = entry.childThreadId;
      const detailLines = [
        title,
        ...(meta ? [meta] : []),
        ...(entry.usage
          ? [
              `토큰 (런 누적): 총 입력 ${formatTokenCount(entry.usage.inputTokens)} · 그중 캐시 ${formatTokenCount(entry.usage.cachedInputTokens)} · 출력 ${formatTokenCount(entry.usage.outputTokens)}`,
            ]
          : []),
        ...(entry.result ? [entry.result] : []),
      ];
      return (
        <details className="subagent-work-card">
          <summary className="subagent-work-summary">
            <span
              className={`subagent-state-dot ${entry.state}`}
              aria-hidden="true"
            />
            <span className="subagent-work-title">{summaryText}</span>
            <span className="subagent-work-chevron" aria-hidden="true">
              ⌄
            </span>
          </summary>
          <div className="subagent-work-detail">{detailLines.join('\n')}</div>
          {onOpenChildSession !== undefined && childThreadId !== undefined ? (
            <button
              type="button"
              className="tool-row-child-session-button"
              onClick={() => onOpenChildSession({ ...entry, childThreadId })}
            >
              트랜스크립트 보기
            </button>
          ) : null}
        </details>
      );
    }
  }
}

function formatToolState(state: string): string {
  switch (state) {
    case 'completed':
      return '완료';
    case 'failed':
      return '실패';
    default:
      return state;
  }
}

// Terminal meta labels gross run-cumulative input and its cached subset
// explicitly. Only terminal entries carry telemetry, so spawned/approval rows
// render unchanged.
// Exported for the child session viewer header.
export function formatSubagentActivityMeta(
  entry: Extract<RunTranscriptEntry, { kind: 'subagent_activity' }>,
): string | null {
  const parts: string[] = [];
  const modelMeta = formatSubagentModelMeta(entry);
  if (modelMeta !== null) {
    parts.push(modelMeta);
  }
  if (entry.elapsedMs !== undefined) {
    parts.push(formatElapsedDuration(entry.elapsedMs));
  }
  if (entry.usage) {
    parts.push(formatRunUsageMeta(entry.usage));
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function formatRunUsageMeta(usage: RunUsageTotals): string {
  return `런 누적 · 총 입력 ${formatTokenCount(usage.inputTokens)} (그중 캐시 ${formatTokenCount(usage.cachedInputTokens)}) · 출력 ${formatTokenCount(usage.outputTokens)}`;
}

// 상태줄(run-status)에서도 재사용한다.
export function formatElapsedDuration(elapsedMs: number): string {
  if (elapsedMs < 1000) {
    return '<1s';
  }
  const totalSeconds = Math.round(elapsedMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function formatTokenCount(count: number): string {
  if (count < 1000) {
    return String(count);
  }
  const scaled = count < 1_000_000 ? count / 1000 : count / 1_000_000;
  const unit = count < 1_000_000 ? 'k' : 'M';
  const rounded =
    scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
  return `${rounded}${unit}`;
}

function formatSubagentActivityTitle(
  entry: Extract<RunTranscriptEntry, { kind: 'subagent_activity' }>,
): string {
  switch (entry.state) {
    case 'spawned':
      return `${entry.subagentType} 작업 시작`;
    case 'approval_required':
      return `${entry.subagentType} 작업 승인 대기`;
    case 'completed':
      return `${entry.subagentType} 작업 완료`;
    case 'failed':
      return `${entry.subagentType} 작업 실패`;
    case 'cancelled':
      return `${entry.subagentType} 작업 취소됨`;
  }
}
