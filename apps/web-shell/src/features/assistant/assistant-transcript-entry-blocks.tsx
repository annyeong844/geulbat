import { useEffect, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type {
  ProviderRequestDiagnostics,
  ProviderRetryDiagnostics,
  RunUsageTotals,
} from '@geulbat/protocol/run-events';
import type { PlanningWorkflowSnapshot } from '@geulbat/protocol/planning-workflow';
import type { RunTranscriptEntry } from '../../lib/run-transcript-entry.js';
import { buildApprovalSummary } from '../../lib/approvals/approval-summary.js';
import { TranscriptTextMessage } from './assistant-transcript-message.js';
import { ReasoningDisclosure } from './assistant-reasoning-disclosure.js';
import { assistantStyles } from './assistant-styles.js';
import { formatSubagentModelMeta } from './model-copy.js';
import { formatPtcToolActivityStatus } from './tool-result-view.js';
import {
  AskUserCard,
  type AskUserAnswerHandler,
} from './ask-user/ask-user-card.js';
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
  planningWorkflowSnapshot?: PlanningWorkflowSnapshot | null;
  onOpenChildSession?: (
    entry: Extract<RunTranscriptEntry, { kind: 'subagent_activity' }> & {
      childThreadId: string;
    },
  ) => void;
  onStopChildRun?: (request: {
    parentRunId: string;
    childRunId: string;
  }) => Promise<void> | void;
  // visualize 위젯의 sendPrompt를 기존 전송 경로로 번역하는 콜백
  onWidgetPrompt?: (prompt: string) => Promise<void> | void;
  // ask_user 카드 답변 — 사용자 선택이므로 아티팩트 귀속 없이 전송한다
  onAskUserAnswer?: AskUserAnswerHandler;
  askUserRequestKey?: string;
  // 위젯 발 도구 호출(run.tool) 번역 콜백
  onWidgetToolRequest?: WidgetToolRequestHandler;
  deferVisualizeRuntimeBoot?: boolean;
  // approval_request 카드에 연결된 도구 실행 상태(실행중/완료/실패)
  approvalStatus?: Extract<
    RunTranscriptEntry,
    { kind: 'tool_activity' }
  >['state'];
  // 아직 모델이 읽지 않은 내 말을 되돌린다
  onCancelPendingSteer?: (receivedSeq: number) => void;
  // 아직 읽히지 않은 내 말을 지금 밀어넣는다 — 반짝이는 말풍선 자체가 버튼이다
  onFlushPendingSteer?: () => void;
}) {
  const {
    entry,
    planningWorkflowSnapshot,
    onOpenChildSession,
    onStopChildRun,
    onWidgetPrompt,
    onAskUserAnswer,
    askUserRequestKey,
    onWidgetToolRequest,
    deferVisualizeRuntimeBoot,
    approvalStatus,
    onCancelPendingSteer,
    onFlushPendingSteer,
  } = props;

  switch (entry.kind) {
    case 'assistant_text':
      return <ReasoningDisclosure text={entry.text} live />;
    case 'user_text': {
      const pendingSteerSeq = entry.pendingSteerSeq;
      if (pendingSteerSeq === undefined) {
        return (
          <TranscriptTextMessage messageRole="user" content={entry.text} />
        );
      }
      // 보냈지만 모델이 아직 읽지 않은 말. 말풍선은 이미 대화에 있고, 아직
      // 읽히기 전이라는 사실은 반짝임이 말한다.
      //
      // 그 반짝임이 곧 버튼이다: 누르면 다음 라운드를 기다리지 않고 지금
      // 밀어넣는다. 별도의 "즉시 반영" 줄을 아래에 두면, 앞당길 대상과
      // 앞당기는 버튼이 화면에서 떨어져 앉는다.
      const flushable = onFlushPendingSteer !== undefined;
      return (
        <div
          className={`pending-steer-message${flushable ? ' is-flushable' : ''}`}
          {...(flushable
            ? {
                role: 'button',
                tabIndex: 0,
                title: '아직 읽히지 않았습니다 — 눌러서 지금 반영',
                onClick: onFlushPendingSteer,
                onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onFlushPendingSteer();
                  }
                },
              }
            : {})}
        >
          <TranscriptTextMessage messageRole="user" content={entry.text} />
          <span className="pending-steer-badge">
            <span>{flushable ? '눌러서 지금 반영' : '대기 중'}</span>
            {onCancelPendingSteer === undefined ? null : (
              <button
                type="button"
                className="pending-steer-badge-cancel"
                title="대기 중 메시지 되돌리기"
                aria-label="대기 중 메시지 되돌리기"
                onClick={(event) => {
                  // 되돌리기는 반영과 반대 방향이다 — 말풍선 클릭으로 새지
                  // 않게 여기서 멈춘다.
                  event.stopPropagation();
                  onCancelPendingSteer(pendingSteerSeq);
                }}
              >
                <PendingSteerCancelIcon />
              </button>
            )}
          </span>
        </div>
      );
    }
    case 'tool_activity': {
      // 실데이터 스트리밍 중인 visualize — 코드가 도착하는 대로 그린다
      if (entry.tool === VISUALIZE_TOOL_NAME && entry.argsText !== undefined) {
        return (
          <div className="transcript-message from-assistant">
            <VisualizeStreamingWidget
              argsText={entry.argsText}
              {...(deferVisualizeRuntimeBoot !== undefined
                ? { deferRuntimeBoot: deferVisualizeRuntimeBoot }
                : {})}
            />
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
                {...(planningWorkflowSnapshot === undefined
                  ? {}
                  : { planningWorkflowSnapshot })}
                {...(deferVisualizeRuntimeBoot !== undefined
                  ? { deferRuntimeBoot: deferVisualizeRuntimeBoot }
                  : {})}
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
                requestKey={
                  entry.callId ?? askUserRequestKey ?? `live:${entry.tool}`
                }
                {...(onAskUserAnswer !== undefined
                  ? { onAnswer: onAskUserAnswer }
                  : {})}
              />
            </div>
          );
        }
      }
      const stateGlyph =
        entry.ptcStatus === 'queued' || entry.ptcStatus === 'running'
          ? '…'
          : entry.state === 'failed'
            ? '!'
            : entry.state === 'running'
              ? '…'
              : '✓';
      const stateLabel =
        entry.ptcStatus !== undefined
          ? formatPtcToolActivityStatus(entry.ptcStatus)
          : entry.state === 'running'
            ? '실행 중'
            : formatToolState(entry.state);
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
      // 채팅 속 기록 줄 — 실제 승인 UI(카드)는 컴포저 위에 따로 뜬다.
      // 카드 제목(대화체 문장)을 반복하면 "요청이 두 개?"로 읽히므로
      // 여기서는 명사형 라벨의 조용한 로그 표현만 남긴다.
      const summary = buildApprovalSummary(entry.pendingApproval);
      return (
        <div style={assistantStyles.approvalNoticeBlock}>
          {approvalStatus !== undefined ? (
            <span
              className={`tool-status-dot ${approvalStatus}`}
              aria-label={
                approvalStatus === 'running'
                  ? '실행 중'
                  : approvalStatus === 'failed'
                    ? '실패'
                    : '완료'
              }
            />
          ) : null}
          <span>{`승인 요청 · ${summary.label}`}</span>
          {summary.detail ? (
            <span style={assistantStyles.approvalNoticeDetail}>
              {summary.detail}
            </span>
          ) : null}
        </div>
      );
    }
    case 'subagent_activity': {
      return (
        <SubagentActivityBlock
          entry={entry}
          {...(onOpenChildSession !== undefined ? { onOpenChildSession } : {})}
          {...(onStopChildRun !== undefined ? { onStopChildRun } : {})}
        />
      );
    }
  }
}

function SubagentActivityBlock(props: {
  entry: Extract<RunTranscriptEntry, { kind: 'subagent_activity' }>;
  onOpenChildSession?: NonNullable<
    Parameters<typeof RunTranscriptEntryBlock>[0]['onOpenChildSession']
  >;
  onStopChildRun?: NonNullable<
    Parameters<typeof RunTranscriptEntryBlock>[0]['onStopChildRun']
  >;
}) {
  const { entry, onOpenChildSession, onStopChildRun } = props;
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const tracksActivityAge =
    entry.runtime !== undefined &&
    (entry.state === 'spawned' || entry.state === 'approval_required');
  const nowMs = useSubagentActivityNow(tracksActivityAge);
  const title = formatSubagentActivityTitle(entry);
  const meta = formatSubagentActivityMeta(entry, nowMs);
  const summaryElapsed = formatSubagentActivitySummaryMeta(entry, nowMs);
  const childThreadId = entry.childThreadId;
  const canStop =
    onStopChildRun !== undefined &&
    entry.parentRunId !== undefined &&
    (entry.state === 'spawned' || entry.state === 'approval_required');
  const resultReference =
    entry.resultReport?.sourceResultRef ?? entry.resultRef;
  const detailLines = [
    title,
    ...(meta ? [meta] : []),
    ...(entry.usage
      ? [
          `토큰 (런 누적): 총 입력 ${formatTokenCount(entry.usage.inputTokens)} · 그중 캐시 ${formatTokenCount(entry.usage.cachedInputTokens)} · 출력 ${formatTokenCount(entry.usage.outputTokens)}`,
        ]
      : []),
    ...(entry.runtime?.providerRequest === undefined
      ? []
      : formatProviderRequestDetail(entry.runtime.providerRequest, nowMs)),
    ...(entry.resultReport ? [`결과 보고: ${entry.resultReport.summary}`] : []),
    ...(entry.result
      ? [entry.resultReport ? `원문 결과: ${entry.result}` : entry.result]
      : []),
    ...(resultReference
      ? [
          `${entry.resultReport ? '원문 결과 참조' : '결과 참조'}: ${resultReference}`,
        ]
      : []),
  ];

  const stopChildRun = async (): Promise<void> => {
    if (!canStop || entry.parentRunId === undefined || stopping) {
      return;
    }
    setStopping(true);
    setStopError(null);
    try {
      await onStopChildRun({
        parentRunId: entry.parentRunId,
        childRunId: entry.childRunId,
      });
    } catch (error: unknown) {
      setStopError(
        error instanceof Error ? error.message : '중지하지 못했어요.',
      );
      setStopping(false);
    }
  };

  return (
    <details className="subagent-work-card">
      <summary className="subagent-work-summary">
        <span
          className={`subagent-state-dot ${entry.state}`}
          aria-hidden="true"
        />
        <span className="subagent-work-title">{title}</span>
        {summaryElapsed === null ? null : (
          <span className="subagent-work-elapsed">{summaryElapsed}</span>
        )}
        <span className="subagent-work-chevron" aria-hidden="true">
          ⌄
        </span>
      </summary>
      <div className="subagent-work-detail">{detailLines.join('\n')}</div>
      <div className="subagent-work-actions">
        {onOpenChildSession !== undefined && childThreadId !== undefined ? (
          <button
            type="button"
            className="tool-row-child-session-button"
            onClick={() => onOpenChildSession({ ...entry, childThreadId })}
          >
            트랜스크립트 보기
          </button>
        ) : null}
        {canStop ? (
          <button
            type="button"
            className="tool-row-child-session-button danger"
            disabled={stopping}
            onClick={() => void stopChildRun()}
          >
            {stopping ? '중지 중…' : '중지'}
          </button>
        ) : null}
      </div>
      {stopError !== null ? (
        <div className="subagent-work-stop-error" role="alert">
          {stopError}
        </div>
      ) : null}
    </details>
  );
}

function useSubagentActivityNow(active: boolean): number {
  const [nowMs, setNowMs] = useState(Date.now);

  useEffect(() => {
    if (!active || typeof window === 'undefined') {
      return undefined;
    }
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, [active]);

  return nowMs;
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
/**
 * 접힌 요약줄이 말할 것은 제목과 "얼마나 됐는가"뿐이다.
 *
 * 관측 시각·capability·토큰 누적은 펼친 본문이 이미 그대로 싣고 있다. 요약에
 * 옮겨 적으면 같은 문장이 두 번 나오면서, 한 줄 안에서 읽어야 할 제목을 계측이
 * 밀어낸다. 접힌 카드의 값은 "펼칠지 말지 정할 수 있다"이지 "전부 보여준다"가
 * 아니다.
 */
function formatSubagentActivitySummaryMeta(
  entry: Extract<RunTranscriptEntry, { kind: 'subagent_activity' }>,
  nowMs = Date.now(),
): string | null {
  if (
    entry.runtime !== undefined &&
    (entry.state === 'spawned' || entry.state === 'approval_required')
  ) {
    return formatElapsedDuration(
      Math.max(0, nowMs - Date.parse(entry.runtime.observedAt)),
    );
  }
  return entry.elapsedMs === undefined
    ? null
    : formatElapsedDuration(entry.elapsedMs);
}

export function formatSubagentActivityMeta(
  entry: Extract<RunTranscriptEntry, { kind: 'subagent_activity' }>,
  nowMs = Date.now(),
): string | null {
  const parts: string[] = [];
  // 정상 완료 카드에는 마지막 관측 시점의 runtime 진단("진행: 응답 생성 중"
  // 등)을 붙이지 않는다 — 완료와 모순되게 읽힌다. 실패/취소는 진단 가치가
  // 있어 그대로 남긴다.
  if (entry.runtime !== undefined && entry.state !== 'completed') {
    parts.push(`진행: ${formatSubagentRuntimePhase(entry.runtime.phase)}`);
    parts.push(`관측: ${entry.runtime.observedAt}`);
    if (entry.state === 'spawned' || entry.state === 'approval_required') {
      parts.push(
        `활동 경과: ${formatElapsedDuration(
          Math.max(0, nowMs - Date.parse(entry.runtime.observedAt)),
        )}`,
      );
    }
    if (entry.runtime.lastTool !== undefined) {
      parts.push(
        `최근 도구: ${entry.runtime.lastTool.name} (${formatSubagentRuntimeToolState(entry.runtime.lastTool.state)})`,
      );
    }
    parts.push(
      `부분 출력: ${entry.runtime.partialOutputAvailable ? '있음' : '없음'}`,
    );
    if (entry.runtime.previousChildRunId !== undefined) {
      parts.push(`재시도 원본: ${entry.runtime.previousChildRunId}`);
    }
  }
  if (entry.reason !== undefined) {
    parts.push(`종료 원인: ${formatSubagentTerminalReason(entry.reason)}`);
  }
  if (entry.toolSurface !== undefined) {
    parts.push(formatSubagentToolSurface(entry.toolSurface));
  }
  if (entry.capabilities !== undefined) {
    parts.push(
      entry.capabilities.length === 0
        ? 'capability: 없음'
        : `capability: ${entry.capabilities.map((capability) => capability.toUpperCase()).join(', ')}`,
    );
  }
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

function formatProviderRequestDetail(
  request: ProviderRequestDiagnostics,
  nowMs: number,
): string[] {
  const durationMs =
    request.durationMs ?? Math.max(0, nowMs - Date.parse(request.startedAt));
  return [
    `모델 요청 시작: ${request.startedAt}`,
    ...(request.lastEventAt === undefined
      ? []
      : [`마지막 제공자 이벤트: ${request.lastEventAt}`]),
    ...(request.endedAt === undefined
      ? []
      : [`모델 요청 종료: ${request.endedAt}`]),
    `모델 요청 경과: ${formatElapsedDuration(durationMs)}`,
    `모델 요청 횟수: ${request.attemptCount}`,
    ...(request.retry === undefined
      ? []
      : [formatProviderRetryDiagnostics(request.retry)]),
  ];
}

function formatProviderRetryDiagnostics(
  retry: ProviderRetryDiagnostics,
): string {
  const availability = retry.available ? '가능' : '불가';
  const performed = retry.performed ? '수행함' : '수행하지 않음';
  const outcome =
    retry.outcome === 'scheduled'
      ? '예약됨'
      : retry.outcome === 'recovered'
        ? '복구됨'
        : retry.outcome === 'exhausted'
          ? '예산 소진'
          : retry.outcome === 'unsafe_after_output'
            ? '출력 이후 중복 위험'
            : '지원되지 않는 오류';
  return `자동 재시도: ${availability} · ${performed} · ${outcome}`;
}

function formatSubagentRuntimePhase(
  phase: NonNullable<
    Extract<RunTranscriptEntry, { kind: 'subagent_activity' }>['runtime']
  >['phase'],
): string {
  switch (phase) {
    case 'queued':
      return '실행 대기';
    case 'starting':
      return '시작 중';
    case 'auth_waiting':
      return '제공자 인증 갱신 대기';
    case 'provider_waiting':
      return '모델 응답 대기';
    case 'rate_limit_waiting':
      return '요청 제한 해제 대기';
    case 'provider_streaming':
      return '응답 생성 중';
    case 'tool_running':
      return '도구 실행 중';
    case 'approval_pending':
      return '승인 대기';
  }
}

function formatSubagentRuntimeToolState(
  state: NonNullable<
    NonNullable<
      Extract<RunTranscriptEntry, { kind: 'subagent_activity' }>['runtime']
    >['lastTool']
  >['state'],
): string {
  switch (state) {
    case 'running':
      return '실행 중';
    case 'succeeded':
      return '성공';
    case 'failed':
      return '실패';
  }
}

function formatSubagentTerminalReason(
  reason: NonNullable<
    Extract<RunTranscriptEntry, { kind: 'subagent_activity' }>['reason']
  >,
): string {
  switch (reason) {
    case 'child_error':
      return '하위 작업 오류';
    case 'provider_error':
      return '모델 제공자 오류';
    case 'tool_error':
      return '도구 오류';
    case 'persistence_error':
      return '상태 저장 오류';
    case 'daemon_restart':
      return '데몬 재시작';
    case 'daemon_shutdown':
      return '데몬 종료';
    case 'timeout':
      return '제한 시간 초과';
    case 'user_interrupt':
      return '사용자 중단';
    case 'sibling_error':
      return '동시 하위 작업 실패';
    case 'explicit_stop':
      return '명시적 중지';
  }
}

function formatSubagentToolSurface(
  profile: NonNullable<
    Extract<RunTranscriptEntry, { kind: 'subagent_activity' }>['toolSurface']
  >,
): string {
  switch (profile) {
    case 'explorer':
      return '도구: 읽기·검색';
    case 'explorer_ptc':
      return '도구: 읽기·검색 + PTC';
    case 'worker':
      return '도구: 읽기·수정';
  }
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
      return entry.runtime === undefined
        ? `${entry.subagentType} 작업 시작`
        : `${entry.subagentType} ${formatSubagentRuntimePhase(entry.runtime.phase)}`;
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

function PendingSteerCancelIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
