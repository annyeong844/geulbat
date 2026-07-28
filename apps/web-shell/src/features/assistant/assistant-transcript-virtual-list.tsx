import React, { useCallback, useMemo, useState } from 'react';
import {
  defaultRangeExtractor,
  elementScroll,
  observeElementOffset as observeElementScrollOffset,
  useVirtualizer,
  type Range,
  type Virtualizer,
} from '@tanstack/react-virtual';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { PlanningWorkflowSnapshot } from '@geulbat/protocol/planning-workflow';
import type { RunRequest } from '@geulbat/protocol/run-contract';
import type { ThreadMessage } from '@geulbat/protocol/threads';

import type { RunTranscriptEntry } from '../../lib/run-transcript-entry.js';
import type { ArtifactsByRefMap } from '../artifacts/artifact-transcript-lookup.js';
import {
  RunTranscriptEntryBlock,
  type WidgetToolRequestHandler,
} from './assistant-transcript-entry-blocks.js';
import { TranscriptMessage } from './assistant-transcript-message.js';
import {
  buildLiveToolTimelineItems,
  buildSettledToolTimelineItems,
  summarizeToolGroupHeader,
  summarizeToolGroupHeaderCounts,
} from './tool-timeline.js';
import { ToolTimeline } from './tool-timeline-view.js';
import { formatPtcToolActivityStatus } from './tool-result-view.js';
import type { AskUserAnswerHandler } from './ask-user/ask-user-card.js';
import {
  buildLiveTranscriptRows,
  buildSettledTranscriptRows,
  estimateTranscriptRowSize,
  findLastRoleIndex,
  isVisualizeWidgetRow,
  type TranscriptVirtualRow,
} from './assistant-transcript-row-model.js';

// 행 높이 추정은 행 모델 계층 소유 — 테스트/외부 소비자는 이 모듈을 통해
// 계속 가져간다 (이동 전 공개 표면 유지).
export { estimateTranscriptMessageRowSize } from './assistant-transcript-row-model.js';

type OpenChildSessionHandler = NonNullable<
  Parameters<typeof RunTranscriptEntryBlock>[0]['onOpenChildSession']
>;

// 전사 행이 소비하는 상호작용 표면 — 메시지 행과 런 엔트리 블록으로 그대로
// 내려간다. 같은 콜백 묶음을 조립 계층마다 다시 선언하지 않기 위해 한 벌로
// 소유한다. 소비자는 필요한 필드만 읽는다.
export interface TranscriptRowInteractions {
  onStartArtifactRun: (request: RunRequest) => Promise<void> | void;
  attachmentImageUrl?: (attachmentId: string) => string | null;
  onOpenChildSession?: OpenChildSessionHandler;
  // visualize 위젯의 sendPrompt를 기존 전송 경로로 번역하는 콜백
  onWidgetPrompt?: (prompt: string) => Promise<void> | void;
  // ask_user 카드 답변 — 사용자 선택이므로 아티팩트 귀속 없이 전송한다
  onAskUserAnswer?: AskUserAnswerHandler;
  answeredAskUserRequestKeys?: ReadonlySet<string>;
  // 아직 모델이 읽지 않은 내 말을 되돌린다 — 그 말풍선이 가진 동작이다
  onCancelPendingSteer?: (receivedSeq: number) => void;
  // 반짝이는 말풍선을 눌렀을 때 — 지금 밀어넣는다
  onFlushPendingSteer?: () => void;
  // 위젯 발 도구 호출(run.tool) 번역 콜백
  onWidgetToolRequest?: WidgetToolRequestHandler;
  // 존재하면 아티팩트는 인라인 대신 참조 칩으로 남고 중앙 패널에서 열린다
  onOpenArtifact?: (artifact: ThreadArtifactVersion) => void;
}

// 메시지 행 하단 액션 — 표시 조건은 Assistant가 판정하고, 없는 콜백은 해당
// 액션을 그리지 않는다는 뜻이다.
export interface TranscriptMessageEditActions {
  // 마지막 답변 액션에 ↻ 재시도를 붙인다
  onRetryLastPrompt?: () => void;
  // 마지막 질문에 ✎ 편집을 붙인다 (수정본은 재생성으로 전송)
  onEditLastUserPrompt?: (nextPrompt: string) => void;
  // 모든 답변에 ⑂ 여기서 새 채팅을 붙인다
  onBranchFromMessage?: (entryId: string) => void;
  // 과거 질문(마지막 제외)에 ✎ 편집을 붙인다 — 브랜치 기반 재실행
  onEditPastUserPrompt?: (entryId: string, nextPrompt: string) => void;
}

interface VirtualizedTranscriptRowsProps {
  scrollElementRef: React.RefObject<HTMLDivElement | null>;
  shouldApplyVirtualizerScroll: () => boolean;
  isProgrammaticTranscriptScroll: (offset: number) => boolean;
  messages: ThreadMessage[];
  messageKeys: string[];
  transcriptEntries: RunTranscriptEntry[];
  transcriptEntryKeys: string[];
  anchoredSubagentEntries?: ReadonlyMap<
    string,
    Extract<RunTranscriptEntry, { kind: 'subagent_activity' }>[]
  >;
  artifactsByRef: ArtifactsByRefMap;
  planningWorkflowSnapshot?: PlanningWorkflowSnapshot | null;
  isRunning: boolean;
  // 행 재렌더를 아끼려면 호출부가 이 객체 identity를 안정적으로 유지한다.
  rowInteractions: TranscriptRowInteractions;
  messageEditActions?: TranscriptMessageEditActions;
}

const INITIAL_VIEWPORT_RECT = { width: 400, height: 800 };
const TRANSCRIPT_ROW_OVERSCAN = 3;
const EMPTY_ANSWERED_ASK_USER_REQUEST_KEYS: ReadonlySet<string> = new Set();

export function extractTranscriptVirtualRange(args: {
  range: Range;
  retainedIndexes: Iterable<number>;
  focusedIndex: number | undefined;
}): number[] {
  const indexes = new Set(defaultRangeExtractor(args.range));
  for (const index of args.retainedIndexes) {
    indexes.add(index);
  }
  if (args.focusedIndex !== undefined) {
    indexes.add(args.focusedIndex);
  }
  return [...indexes].sort((left, right) => left - right);
}

export const VirtualizedTranscriptRows = React.memo(
  function VirtualizedTranscriptRows({
    scrollElementRef,
    shouldApplyVirtualizerScroll,
    isProgrammaticTranscriptScroll,
    messages,
    messageKeys,
    transcriptEntries,
    transcriptEntryKeys,
    anchoredSubagentEntries,
    artifactsByRef,
    planningWorkflowSnapshot = null,
    isRunning,
    rowInteractions,
    messageEditActions,
  }: VirtualizedTranscriptRowsProps) {
    const answeredAskUserRequestKeys =
      rowInteractions.answeredAskUserRequestKeys ??
      EMPTY_ANSWERED_ASK_USER_REQUEST_KEYS;
    // settled 메시지 행과 라이브 엔트리 행을 따로 메모한다 — 스트리밍으로
    // 엔트리가 붙을 때 settled 행 객체의 identity가 보존되어, 아래
    // React.memo 행 콘텐츠가 화면에 보이는 과거 행을 다시 그리지 않는다.
    const settledRowCollection = useMemo(
      () =>
        buildSettledTranscriptRows({
          messages,
          messageKeys,
          answeredAskUserRequestKeys,
          ...(anchoredSubagentEntries !== undefined
            ? { anchoredSubagentEntries }
            : {}),
        }),
      [
        anchoredSubagentEntries,
        answeredAskUserRequestKeys,
        messageKeys,
        messages,
      ],
    );
    const liveRowCollection = useMemo(
      () =>
        buildLiveTranscriptRows({
          transcriptEntries,
          transcriptEntryKeys,
          answeredAskUserRequestKeys,
        }),
      [answeredAskUserRequestKeys, transcriptEntries, transcriptEntryKeys],
    );
    const settledRows = settledRowCollection.rows;
    const liveRows = liveRowCollection.rows;
    const rows = useMemo(
      () => [...settledRows, ...liveRows],
      [liveRows, settledRows],
    );
    const [initialTranscriptOffset] = useState(() =>
      Math.max(
        0,
        rows.reduce(
          (total, row) =>
            total + estimateTranscriptRowSize(row, artifactsByRef),
          0,
        ) - INITIAL_VIEWPORT_RECT.height,
      ),
    );
    // Keep visualize row components alive for the open thread so an iframe
    // that has booted never reloads merely because the user scrolled away.
    // Offscreen rows still receive deferVisualizeRuntimeBoot, so a frame the
    // user has never reached remains a cheap placeholder rather than booting.
    const visualizeRowIndexes = useMemo(
      () => [
        ...settledRowCollection.visualizeRowIndexes,
        ...liveRowCollection.visualizeRowIndexes.map(
          (index) => settledRows.length + index,
        ),
      ],
      [liveRowCollection, settledRowCollection, settledRows.length],
    );
    const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);
    const focusedRowIndex = useMemo(() => {
      if (focusedRowKey === null) {
        return undefined;
      }
      const index = rows.findIndex((row) => row.key === focusedRowKey);
      return index < 0 ? undefined : index;
    }, [focusedRowKey, rows]);
    const [lastAssistantIndex, lastUserIndex] = useMemo(
      () => [
        findLastRoleIndex(messages, 'assistant'),
        findLastRoleIndex(messages, 'user'),
      ],
      [messages],
    );
    const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(
      () => new Set(),
    );
    const toggleGroup = useCallback((key: string) => {
      setExpandedGroups((current) => {
        const next = new Set(current);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        return next;
      });
    }, []);
    // 끝난 보조 작업 카드는 스스로 사라지지 않는다 — 무엇이 돌았는지는 기록이다.
    // 대신 사용자가 치울 수 있게 둔다. 이 치움은 화면 상태이며 트랜스크립트를
    // 지우지 않는다(다시 열면 기록은 그대로 있다).
    const [dismissedGroups, setDismissedGroups] = useState<ReadonlySet<string>>(
      () => new Set(),
    );
    const dismissGroup = useCallback((key: string) => {
      setDismissedGroups((current) => {
        if (current.has(key)) {
          return current;
        }
        const next = new Set(current);
        next.add(key);
        return next;
      });
    }, []);
    const handleFocusCapture = useCallback(
      (event: React.FocusEvent<HTMLDivElement>) => {
        const target = event.target;
        if (!(target instanceof Element)) {
          return;
        }
        const rowElement = target.closest<HTMLElement>(
          '[data-transcript-row-key]',
        );
        setFocusedRowKey(rowElement?.dataset.transcriptRowKey ?? null);
      },
      [],
    );
    const handleBlurCapture = useCallback(
      (event: React.FocusEvent<HTMLDivElement>) => {
        const nextTarget = event.relatedTarget;
        if (
          nextTarget instanceof Node &&
          event.currentTarget.contains(nextTarget)
        ) {
          return;
        }
        setFocusedRowKey(null);
      },
      [],
    );
    const scrollVirtualizer = useCallback(
      (
        offset: number,
        options: { adjustments?: number; behavior?: ScrollBehavior },
        instance: Virtualizer<HTMLDivElement, HTMLDivElement>,
      ) => {
        // While the transcript is pinned, its content ResizeObserver is the
        // sole scroll owner. TanStack still updates its internal end anchor,
        // but must not duplicate that owner with one scroll write per row
        // measurement. When the user is reading history, TanStack keeps its
        // normal correction path so changing row estimates preserve position.
        if (!shouldApplyVirtualizerScroll()) {
          return;
        }
        elementScroll(offset, options, instance);
      },
      [shouldApplyVirtualizerScroll],
    );
    const measureVirtualRow = useCallback(
      (
        element: HTMLDivElement,
        entry: ResizeObserverEntry | undefined,
        instance: Virtualizer<HTMLDivElement, HTMLDivElement>,
      ) => {
        if (entry !== undefined) {
          const borderBox = entry.borderBoxSize[0];
          if (borderBox !== undefined) {
            return Math.round(
              instance.options.horizontal
                ? borderBox.inlineSize
                : borderBox.blockSize,
            );
          }
          return Math.round(
            instance.options.horizontal
              ? entry.contentRect.width
              : entry.contentRect.height,
          );
        }

        const index = instance.indexFromElement(element);
        const key = instance.options.getItemKey(index);
        return (
          instance.itemSizeCache.get(key) ??
          instance.options.estimateSize(index)
        );
      },
      [],
    );
    const observeTranscriptViewport = useCallback(
      (
        instance: Virtualizer<HTMLDivElement, HTMLDivElement>,
        onRect: (rect: { width: number; height: number }) => void,
      ) => {
        const element = instance.scrollElement;
        const ResizeObserverConstructor = instance.targetWindow?.ResizeObserver;
        if (element === null || ResizeObserverConstructor === undefined) {
          return;
        }

        const observer = new ResizeObserverConstructor((entries) => {
          const entry = entries[0];
          if (entry === undefined) {
            return;
          }
          const borderBox = entry.borderBoxSize[0];
          onRect({
            width: Math.round(borderBox?.inlineSize ?? entry.contentRect.width),
            height: Math.round(
              borderBox?.blockSize ?? entry.contentRect.height,
            ),
          });
        });
        observer.observe(element, { box: 'border-box' });
        return () => observer.disconnect();
      },
      [],
    );
    const observeTranscriptOffset = useCallback(
      (
        instance: Virtualizer<HTMLDivElement, HTMLDivElement>,
        onOffset: (offset: number, isScrolling: boolean) => void,
      ) =>
        observeElementScrollOffset(instance, (offset, isScrolling) => {
          onOffset(
            offset,
            isScrolling && !isProgrammaticTranscriptScroll(offset),
          );
        }),
      [isProgrammaticTranscriptScroll],
    );
    const virtualizer = useVirtualizer({
      count: rows.length,
      getScrollElement: () => scrollElementRef.current,
      estimateSize: (index) =>
        estimateTranscriptRowSize(rows[index], artifactsByRef),
      initialOffset: initialTranscriptOffset,
      getItemKey: (index) => rows[index]?.key ?? index,
      rangeExtractor: (range: Range) =>
        extractTranscriptVirtualRange({
          range,
          retainedIndexes: visualizeRowIndexes,
          focusedIndex: focusedRowIndex,
        }),
      overscan: TRANSCRIPT_ROW_OVERSCAN,
      anchorTo: 'end',
      followOnAppend: true,
      scrollToFn: scrollVirtualizer,
      measureElement: measureVirtualRow,
      observeElementRect: observeTranscriptViewport,
      observeElementOffset: observeTranscriptOffset,
      initialRect: INITIAL_VIEWPORT_RECT,
      useFlushSync: false,
      directDomUpdates: true,
      directDomUpdatesMode: 'position',
    });
    const virtualItems = virtualizer.getVirtualItems();
    return (
      <div
        ref={virtualizer.containerRef}
        className="transcript-virtual-list"
        onFocusCapture={handleFocusCapture}
        onBlurCapture={handleBlurCapture}
      >
        {virtualItems.map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (row === undefined) {
            return null;
          }
          const visibleRange = virtualizer.range;
          const isOutsideVisibleRange =
            visibleRange === null ||
            virtualRow.index < visibleRange.startIndex ||
            virtualRow.index > visibleRange.endIndex;
          // direct DOM의 position 모드는 transform stacking context를 만들지
          // 않아 position:fixed 아티팩트 오버레이의 viewport 기준을 보존한다.
          return (
            <div
              key={virtualRow.key}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              data-transcript-row-key={row.key}
              className="transcript-virtual-row"
            >
              <TranscriptVirtualRowContent
                row={row}
                artifactsByRef={artifactsByRef}
                planningWorkflowSnapshot={planningWorkflowSnapshot}
                isRunning={isRunning}
                deferVisualizeRuntimeBoot={
                  isVisualizeWidgetRow(row) &&
                  (virtualizer.isScrolling || isOutsideVisibleRange)
                }
                isLastAssistantMessage={
                  row.kind === 'message' &&
                  row.messageIndex === lastAssistantIndex
                }
                isLastUserMessage={
                  row.kind === 'message' && row.messageIndex === lastUserIndex
                }
                expanded={expandedGroups.has(row.key)}
                onToggleGroup={toggleGroup}
                dismissed={dismissedGroups.has(row.key)}
                onDismissGroup={dismissGroup}
                rowInteractions={rowInteractions}
                {...(messageEditActions !== undefined
                  ? { messageEditActions }
                  : {})}
              />
            </div>
          );
        })}
      </div>
    );
  },
);

// 스트리밍 append마다 부모가 다시 그려져도, row identity가 보존되는 settled
// 행은 재렌더를 건너뛴다 (핸들러 props는 상위에서 useCallback으로 고정됨).
const TranscriptVirtualRowContent = React.memo(
  function TranscriptVirtualRowContent(props: {
    row: TranscriptVirtualRow;
    artifactsByRef: ArtifactsByRefMap;
    planningWorkflowSnapshot: PlanningWorkflowSnapshot | null;
    isRunning: boolean;
    isLastAssistantMessage: boolean;
    isLastUserMessage: boolean;
    rowInteractions: TranscriptRowInteractions;
    messageEditActions?: TranscriptMessageEditActions;
    deferVisualizeRuntimeBoot: boolean;
    expanded: boolean;
    onToggleGroup: (key: string) => void;
    dismissed: boolean;
    onDismissGroup: (key: string) => void;
  }) {
    const {
      row,
      artifactsByRef,
      planningWorkflowSnapshot,
      isRunning,
      isLastAssistantMessage,
      isLastUserMessage,
      rowInteractions,
      messageEditActions,
      deferVisualizeRuntimeBoot,
      expanded,
      onToggleGroup,
      dismissed,
      onDismissGroup,
    } = props;
    const {
      onStartArtifactRun,
      attachmentImageUrl,
      onOpenChildSession,
      onWidgetPrompt,
      onCancelPendingSteer,
      onFlushPendingSteer,
      onAskUserAnswer,
      onWidgetToolRequest,
      onOpenArtifact,
    } = rowInteractions;
    const {
      onRetryLastPrompt,
      onEditLastUserPrompt,
      onBranchFromMessage,
      onEditPastUserPrompt,
    } = messageEditActions ?? {};

    if (row.kind === 'message') {
      const actions = {
        ...(onRetryLastPrompt !== undefined && isLastAssistantMessage
          ? { onRetry: onRetryLastPrompt }
          : {}),
        ...(onEditLastUserPrompt !== undefined && isLastUserMessage
          ? { onEditSubmit: onEditLastUserPrompt }
          : {}),
        // 과거 질문(마지막 제외) 편집 — 수정본은 그 직전까지 브랜치한 새
        // 스레드에서 재실행된다 (마지막 질문은 위의 in-place 재생성 경로)
        ...(onEditPastUserPrompt !== undefined &&
        row.message.role === 'user' &&
        !isLastUserMessage
          ? {
              onEditSubmit: (nextPrompt: string) =>
                onEditPastUserPrompt(row.message.entryId, nextPrompt),
            }
          : {}),
        ...(onBranchFromMessage !== undefined &&
        row.message.role === 'assistant'
          ? { onBranch: () => onBranchFromMessage(row.message.entryId) }
          : {}),
      };
      return (
        <TranscriptMessage
          message={row.message}
          artifactsByRef={artifactsByRef}
          planningWorkflowSnapshot={planningWorkflowSnapshot}
          isRunning={isRunning}
          onStartArtifactRun={onStartArtifactRun}
          deferVisualizeRuntimeBoot={deferVisualizeRuntimeBoot}
          {...(attachmentImageUrl !== undefined ? { attachmentImageUrl } : {})}
          {...(Object.keys(actions).length > 0 ? { actions } : {})}
          {...(onWidgetPrompt !== undefined ? { onWidgetPrompt } : {})}
          {...(onCancelPendingSteer !== undefined
            ? { onCancelPendingSteer }
            : {})}
          {...(onFlushPendingSteer !== undefined
            ? { onFlushPendingSteer }
            : {})}
          {...(onAskUserAnswer !== undefined && row.askUserAnswered !== true
            ? { onAskUserAnswer }
            : {})}
          {...(onWidgetToolRequest !== undefined
            ? { onWidgetToolRequest }
            : {})}
          {...(onOpenArtifact !== undefined ? { onOpenArtifact } : {})}
        />
      );
    }

    if (row.kind === 'entry') {
      return (
        <RunTranscriptEntryBlock
          entry={row.entry}
          planningWorkflowSnapshot={planningWorkflowSnapshot}
          askUserRequestKey={row.key}
          {...(row.approvalStatus !== undefined
            ? { approvalStatus: row.approvalStatus }
            : {})}
          deferVisualizeRuntimeBoot={deferVisualizeRuntimeBoot}
          {...(onOpenChildSession !== undefined ? { onOpenChildSession } : {})}
          {...(onWidgetPrompt !== undefined ? { onWidgetPrompt } : {})}
          {...(onCancelPendingSteer !== undefined
            ? { onCancelPendingSteer }
            : {})}
          {...(onFlushPendingSteer !== undefined
            ? { onFlushPendingSteer }
            : {})}
          {...(onAskUserAnswer !== undefined ? { onAskUserAnswer } : {})}
          {...(onWidgetToolRequest !== undefined
            ? { onWidgetToolRequest }
            : {})}
        />
      );
    }

    if (row.kind === 'subagent_group') {
      if (dismissed) {
        return null;
      }
      return (
        <SubagentActivityGroup
          row={row}
          expanded={expanded}
          onToggle={() => onToggleGroup(row.key)}
          onDismiss={() => onDismissGroup(row.key)}
          {...(onOpenChildSession === undefined ? {} : { onOpenChildSession })}
        />
      );
    }

    return (
      <TranscriptActivityGroup
        row={row}
        expanded={expanded}
        onToggle={() => onToggleGroup(row.key)}
      />
    );
  },
);

function SubagentGroupDismissIcon() {
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

function SubagentActivityGroup(props: {
  row: Extract<TranscriptVirtualRow, { kind: 'subagent_group' }>;
  expanded: boolean;
  onToggle: () => void;
  onDismiss?: () => void;
  onOpenChildSession?: OpenChildSessionHandler;
}) {
  const { row, expanded, onToggle, onDismiss, onOpenChildSession } = props;
  const failed = row.entries.some(
    (entry) => entry.state === 'failed' || entry.state === 'cancelled',
  );
  const subagentTypes = new Set(row.entries.map((entry) => entry.subagentType));
  const label =
    subagentTypes.size === 1
      ? `${row.entries[0]?.subagentType ?? '보조'} 작업`
      : '보조 작업';

  return (
    <div className="subagent-work-card subagent-work-group">
      <button
        type="button"
        className="subagent-work-summary subagent-work-group-toggle"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span
          className={`subagent-state-dot ${failed ? 'failed' : 'completed'}`}
          aria-hidden="true"
        />
        <span className="subagent-work-title">
          {label} {row.entries.length}개 {failed ? '종료' : '완료'}
        </span>
        <span className="subagent-work-chevron" aria-hidden="true">
          {expanded ? '⌃' : '›'}
        </span>
      </button>
      {onDismiss === undefined ? null : (
        <button
          type="button"
          className="subagent-work-dismiss"
          title="이 기록을 화면에서 치우기"
          aria-label={`${label} 기록 치우기`}
          onClick={onDismiss}
        >
          <SubagentGroupDismissIcon />
        </button>
      )}
      {expanded ? (
        <div className="subagent-work-group-detail">
          {row.entries.map((entry) => (
            <RunTranscriptEntryBlock
              key={entry.childRunId}
              entry={entry}
              {...(onOpenChildSession === undefined
                ? {}
                : { onOpenChildSession })}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TranscriptActivityGroup(props: {
  row: Extract<
    TranscriptVirtualRow,
    {
      kind: 'settled_tool_group' | 'live_tool_group';
    }
  >;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { row, expanded, onToggle } = props;
  const ptcPending = row.ptcStatus === 'queued' || row.ptcStatus === 'running';
  const running = (row.kind === 'live_tool_group' && row.running) || ptcPending;
  const glyph = row.failed ? '!' : running ? '…' : '✓';
  // live 행 모델은 파싱이 없어 항상 접어도 싸다. settled는 메시지 JSON
  // 파싱이 들므로 펼칠 때만 만들고, 접힌 헤더는 그룹 빌드 때 세어 둔
  // 카운트로 그린다.
  const liveItems = useMemo(
    () =>
      row.kind === 'live_tool_group'
        ? buildLiveToolTimelineItems(row.entries)
        : null,
    [row],
  );
  const timelineItems = useMemo(() => {
    if (liveItems !== null) {
      return liveItems;
    }
    if (row.kind !== 'settled_tool_group' || !expanded) {
      return [];
    }
    return buildSettledToolTimelineItems(row.messages, row.messageKeys);
  }, [expanded, liveItems, row]);
  const baseSummary =
    row.kind === 'settled_tool_group'
      ? summarizeToolGroupHeaderCounts({
          commandCount: row.commandCallCount,
          toolCount: row.toolCallCount,
        })
      : summarizeToolGroupHeader(liveItems ?? []);
  const summary =
    row.ptcStatus === undefined
      ? baseSummary
      : `${baseSummary} · ${formatPtcToolActivityStatus(row.ptcStatus)}`;

  return (
    <div className="tool-row transcript-tool-group">
      <button
        type="button"
        className="transcript-tool-group-toggle"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="tool-row-icon">{glyph}</span>
        <span className="tool-row-summary transcript-work-group-title">
          {summary}
        </span>
        <span className="transcript-tool-group-chevron" aria-hidden="true">
          {expanded ? '⌃' : '›'}
        </span>
      </button>
      {expanded ? (
        <div className="transcript-tool-group-detail">
          <ToolTimeline items={timelineItems} running={running} />
        </div>
      ) : null}
    </div>
  );
}
