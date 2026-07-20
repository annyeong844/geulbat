import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  defaultRangeExtractor,
  elementScroll,
  useVirtualizer,
  type Range,
  type Virtualizer,
} from '@tanstack/react-virtual';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { RunRequest } from '@geulbat/protocol/run-contract';
import type { ThreadMessage } from '@geulbat/protocol/threads';

import type { RunTranscriptEntry } from '../../lib/run-transcript-entry.js';
import type { ArtifactsByRefMap } from '../artifacts/artifact-transcript-lookup.js';
import {
  RunTranscriptEntryBlock,
  type WidgetToolRequestHandler,
} from './assistant-transcript-entry-blocks.js';
import { TranscriptMessage } from './assistant-transcript-message.js';
import { prepareAssistantMessageContent } from './assistant-message-content.js';
import {
  buildLiveToolTimelineItems,
  buildSettledToolTimelineItems,
  isCommandToolName,
  summarizeToolGroupHeader,
  summarizeToolGroupHeaderCounts,
} from './tool-timeline.js';
import { ToolTimeline } from './tool-timeline-view.js';
import { ASK_USER_TOOL_NAME } from './ask-user/ask-user-card-view.js';
import { VISUALIZE_TOOL_NAME } from './visualize/visualize-widget-view.js';

type ToolActivityEntry = Extract<RunTranscriptEntry, { kind: 'tool_activity' }>;
type SubagentSpawnEntry = Extract<
  RunTranscriptEntry,
  { kind: 'subagent_activity' }
> & { state: 'spawned' };

export type OpenChildSessionHandler = NonNullable<
  Parameters<typeof RunTranscriptEntryBlock>[0]['onOpenChildSession']
>;

type TranscriptVirtualRow =
  | {
      kind: 'message';
      key: string;
      message: ThreadMessage;
      messageIndex: number;
    }
  | {
      kind: 'settled_tool_group';
      key: string;
      messages: ThreadMessage[];
      messageKeys: string[];
      tools: string[];
      activityCount: number;
      // 접힌 헤더용 호출 수 — 그룹 빌드 시 경량 스캔으로 세어 둔다
      commandCallCount: number;
      toolCallCount: number;
      failed: boolean;
    }
  | {
      kind: 'entry';
      key: string;
      entry: RunTranscriptEntry;
    }
  | {
      kind: 'live_tool_group';
      key: string;
      entries: ToolActivityEntry[];
      tools: string[];
      activityCount: number;
      failed: boolean;
      running: boolean;
    }
  | {
      kind: 'subagent_spawn_group';
      key: string;
      entries: SubagentSpawnEntry[];
    };

interface VirtualizedTranscriptRowsProps {
  scrollElementRef: React.RefObject<HTMLDivElement | null>;
  onVirtualizerUpdate: () => void;
  messages: ThreadMessage[];
  messageKeys: string[];
  transcriptEntries: RunTranscriptEntry[];
  transcriptEntryKeys: string[];
  artifactsByRef: ArtifactsByRefMap;
  isRunning: boolean;
  onStartArtifactRun: (request: RunRequest) => Promise<void> | void;
  attachmentImageUrl?: (attachmentId: string) => string | null;
  onRetryLastPrompt?: () => void;
  onEditLastUserPrompt?: (nextPrompt: string) => void;
  onBranchFromMessage?: (entryId: string) => void;
  onEditPastUserPrompt?: (entryId: string, nextPrompt: string) => void;
  onOpenChildSession?: OpenChildSessionHandler;
  onWidgetPrompt?: (prompt: string) => Promise<void> | void;
  // ask_user 카드 답변 — 사용자 선택이므로 아티팩트 귀속 없이 전송한다
  onAskUserAnswer?: (prompt: string) => Promise<void> | void;
  onWidgetToolRequest?: WidgetToolRequestHandler;
  onOpenArtifact?: (artifact: ThreadArtifactVersion) => void;
}

interface ParsedToolMessage {
  tool: string | null;
  callId: string | null;
  failed: boolean;
}

const INITIAL_VIEWPORT_RECT = { width: 400, height: 800 };
const TRANSCRIPT_ROW_OVERSCAN = 3;
const TRANSCRIPT_ROW_ESTIMATE = 120;

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

function useTranscriptScrollFrameActivity(
  scrollElementRef: React.RefObject<HTMLDivElement | null>,
) {
  const [isActive, setIsActive] = useState(false);
  const isActiveRef = useRef(false);

  useEffect(() => {
    const scrollElement = scrollElementRef.current;
    if (scrollElement === null) {
      return;
    }
    const view = scrollElement.ownerDocument.defaultView;
    if (view === null) {
      return;
    }
    const observedScrollElement: HTMLDivElement = scrollElement;
    const observedView: Window = view;

    let animationFrameId: number | null = null;
    let activityRevision = 0;
    let checkedRevision = -1;
    let checkedScrollTop = Number.NaN;

    function scheduleStabilityCheck() {
      if (animationFrameId !== null) {
        return;
      }
      animationFrameId = observedView.requestAnimationFrame(checkStability);
    }
    function checkStability() {
      animationFrameId = null;
      const scrollTop = observedScrollElement.scrollTop;
      if (
        checkedRevision === activityRevision &&
        checkedScrollTop === scrollTop
      ) {
        if (isActiveRef.current) {
          isActiveRef.current = false;
          setIsActive(false);
        }
        return;
      }
      checkedRevision = activityRevision;
      checkedScrollTop = scrollTop;
      scheduleStabilityCheck();
    }
    function markActive() {
      activityRevision += 1;
      if (!isActiveRef.current) {
        isActiveRef.current = true;
        setIsActive(true);
      }
      scheduleStabilityCheck();
    }

    observedScrollElement.addEventListener('wheel', markActive, {
      capture: true,
      passive: true,
    });
    observedScrollElement.addEventListener('scroll', markActive, {
      passive: true,
    });
    return () => {
      observedScrollElement.removeEventListener('wheel', markActive, {
        capture: true,
      });
      observedScrollElement.removeEventListener('scroll', markActive);
      if (animationFrameId !== null) {
        observedView.cancelAnimationFrame(animationFrameId);
      }
    };
  }, [scrollElementRef]);

  return isActive;
}

export const VirtualizedTranscriptRows = React.memo(
  function VirtualizedTranscriptRows({
    scrollElementRef,
    onVirtualizerUpdate,
    messages,
    messageKeys,
    transcriptEntries,
    transcriptEntryKeys,
    artifactsByRef,
    isRunning,
    onStartArtifactRun,
    attachmentImageUrl,
    onRetryLastPrompt,
    onEditLastUserPrompt,
    onBranchFromMessage,
    onEditPastUserPrompt,
    onOpenChildSession,
    onWidgetPrompt,
    onAskUserAnswer,
    onWidgetToolRequest,
    onOpenArtifact,
  }: VirtualizedTranscriptRowsProps) {
    // settled 메시지 행과 라이브 엔트리 행을 따로 메모한다 — 스트리밍으로
    // 엔트리가 붙을 때 settled 행 객체의 identity가 보존되어, 아래
    // React.memo 행 콘텐츠가 화면에 보이는 과거 행을 다시 그리지 않는다.
    const settledRows = useMemo(
      () => buildSettledTranscriptRows({ messages, messageKeys }),
      [messages, messageKeys],
    );
    const liveRows = useMemo(
      () => buildLiveTranscriptRows({ transcriptEntries, transcriptEntryKeys }),
      [transcriptEntries, transcriptEntryKeys],
    );
    const rows = useMemo(
      () => [...settledRows, ...liveRows],
      [liveRows, settledRows],
    );
    const rowIndexesByKey = useMemo(
      () => new Map(rows.map((row, index) => [row.key, index])),
      [rows],
    );
    // iframe-backed visualize rows are expensive to destroy and recreate.
    // Keep a row that has entered the virtual range connected until the
    // current scroll gesture settles; then release anything outside the
    // ordinary overscan range. This is gesture-scoped retention, not a
    // growing keep-alive cache.
    const retainedVisualizeRowKeysRef = useRef(new Set<string>());
    const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);
    const isScrollFrameActive =
      useTranscriptScrollFrameActivity(scrollElementRef);
    useEffect(() => {
      if (!isScrollFrameActive) {
        retainedVisualizeRowKeysRef.current.clear();
      }
    }, [isScrollFrameActive]);
    useEffect(() => {
      const requestIdleCallback = globalThis.requestIdleCallback;
      const cancelIdleCallback = globalThis.cancelIdleCallback;
      if (
        typeof requestIdleCallback !== 'function' ||
        typeof cancelIdleCallback !== 'function'
      ) {
        return;
      }
      let messageIndex = messages.length - 1;
      let idleCallbackId: number | null = null;
      let cancelled = false;
      const prepareNextMessages = (deadline: IdleDeadline) => {
        while (
          !cancelled &&
          messageIndex >= 0 &&
          deadline.timeRemaining() > 0
        ) {
          const message = messages[messageIndex];
          messageIndex -= 1;
          if (message?.role === 'assistant') {
            prepareAssistantMessageContent(message, message.content);
          }
        }
        if (!cancelled && messageIndex >= 0) {
          idleCallbackId = requestIdleCallback(prepareNextMessages);
        }
      };
      idleCallbackId = requestIdleCallback(prepareNextMessages);
      return () => {
        cancelled = true;
        if (idleCallbackId !== null) {
          cancelIdleCallback(idleCallbackId);
        }
      };
    }, [messages]);
    const lastAssistantIndex = findLastRoleIndex(messages, 'assistant');
    const lastUserIndex = findLastRoleIndex(messages, 'user');
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
        elementScroll(offset, options, instance);
        // TanStack의 scroll write가 끝난 바로 뒤 최종 follow 판정을
        // transcript owner에게 돌려준다. 브라우저 scroll event보다 먼저
        // 실행되므로 내부 offset 보정을 사용자 스크롤로 오인하지 않는다.
        onVirtualizerUpdate();
      },
      [onVirtualizerUpdate],
    );
    const virtualizer = useVirtualizer({
      count: rows.length,
      getScrollElement: () => scrollElementRef.current,
      estimateSize: (index) => estimateTranscriptRowSize(rows[index]),
      getItemKey: (index) => rows[index]?.key ?? index,
      rangeExtractor: (range: Range) => {
        const retainedIndexes: number[] = [];
        if (isScrollFrameActive) {
          for (const key of retainedVisualizeRowKeysRef.current) {
            const index = rowIndexesByKey.get(key);
            if (index !== undefined) {
              retainedIndexes.push(index);
            }
          }
        }
        return extractTranscriptVirtualRange({
          range,
          retainedIndexes,
          focusedIndex:
            focusedRowKey === null
              ? undefined
              : rowIndexesByKey.get(focusedRowKey),
        });
      },
      overscan: TRANSCRIPT_ROW_OVERSCAN,
      anchorTo: 'end',
      followOnAppend: true,
      scrollToFn: scrollVirtualizer,
      onChange: (instance, sync) => {
        const range = instance.range;
        if ((instance.isScrolling || isScrollFrameActive) && range !== null) {
          for (const index of defaultRangeExtractor({
            ...range,
            overscan: TRANSCRIPT_ROW_OVERSCAN,
            count: rows.length,
          })) {
            const row = rows[index];
            if (row !== undefined && isVisualizeWidgetRow(row)) {
              retainedVisualizeRowKeysRef.current.add(row.key);
            }
          }
        }
        if (!sync) {
          onVirtualizerUpdate();
        }
      },
      initialRect: INITIAL_VIEWPORT_RECT,
      useFlushSync: false,
      directDomUpdates: true,
      directDomUpdatesMode: 'position',
    });
    return (
      <div
        ref={virtualizer.containerRef}
        className="transcript-virtual-list"
        onFocusCapture={handleFocusCapture}
        onBlurCapture={handleBlurCapture}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
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
                isRunning={isRunning}
                deferVisualizeRuntimeBoot={
                  isVisualizeWidgetRow(row) &&
                  (virtualizer.isScrolling ||
                    isScrollFrameActive ||
                    isOutsideVisibleRange)
                }
                lastAssistantIndex={lastAssistantIndex}
                lastUserIndex={lastUserIndex}
                onStartArtifactRun={onStartArtifactRun}
                expanded={expandedGroups.has(row.key)}
                onToggleGroup={toggleGroup}
                {...(attachmentImageUrl !== undefined
                  ? { attachmentImageUrl }
                  : {})}
                {...(onRetryLastPrompt !== undefined
                  ? { onRetryLastPrompt }
                  : {})}
                {...(onEditLastUserPrompt !== undefined
                  ? { onEditLastUserPrompt }
                  : {})}
                {...(onBranchFromMessage !== undefined
                  ? { onBranchFromMessage }
                  : {})}
                {...(onEditPastUserPrompt !== undefined
                  ? { onEditPastUserPrompt }
                  : {})}
                {...(onOpenChildSession !== undefined
                  ? { onOpenChildSession }
                  : {})}
                {...(onWidgetPrompt !== undefined ? { onWidgetPrompt } : {})}
                {...(onAskUserAnswer !== undefined ? { onAskUserAnswer } : {})}
                {...(onWidgetToolRequest !== undefined
                  ? { onWidgetToolRequest }
                  : {})}
                {...(onOpenArtifact !== undefined ? { onOpenArtifact } : {})}
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
    isRunning: boolean;
    lastAssistantIndex: number;
    lastUserIndex: number;
    onStartArtifactRun: (request: RunRequest) => Promise<void> | void;
    attachmentImageUrl?: (attachmentId: string) => string | null;
    onRetryLastPrompt?: () => void;
    onEditLastUserPrompt?: (nextPrompt: string) => void;
    onBranchFromMessage?: (entryId: string) => void;
    onEditPastUserPrompt?: (entryId: string, nextPrompt: string) => void;
    onOpenChildSession?: OpenChildSessionHandler;
    onWidgetPrompt?: (prompt: string) => Promise<void> | void;
    // ask_user 카드 답변 — 사용자 선택이므로 아티팩트 귀속 없이 전송한다
    onAskUserAnswer?: (prompt: string) => Promise<void> | void;
    onWidgetToolRequest?: WidgetToolRequestHandler;
    onOpenArtifact?: (artifact: ThreadArtifactVersion) => void;
    deferVisualizeRuntimeBoot: boolean;
    expanded: boolean;
    onToggleGroup: (key: string) => void;
  }) {
    const {
      row,
      artifactsByRef,
      isRunning,
      lastAssistantIndex,
      lastUserIndex,
      onStartArtifactRun,
      attachmentImageUrl,
      onRetryLastPrompt,
      onEditLastUserPrompt,
      onBranchFromMessage,
      onEditPastUserPrompt,
      onOpenChildSession,
      onWidgetPrompt,
      onAskUserAnswer,
      onWidgetToolRequest,
      onOpenArtifact,
      deferVisualizeRuntimeBoot,
      expanded,
      onToggleGroup,
    } = props;

    if (row.kind === 'message') {
      const actions = {
        ...(onRetryLastPrompt !== undefined &&
        row.messageIndex === lastAssistantIndex
          ? { onRetry: onRetryLastPrompt }
          : {}),
        ...(onEditLastUserPrompt !== undefined &&
        row.messageIndex === lastUserIndex
          ? { onEditSubmit: onEditLastUserPrompt }
          : {}),
        // 과거 질문(마지막 제외) 편집 — 수정본은 그 직전까지 브랜치한 새
        // 스레드에서 재실행된다 (마지막 질문은 위의 in-place 재생성 경로)
        ...(onEditPastUserPrompt !== undefined &&
        row.message.role === 'user' &&
        row.messageIndex !== lastUserIndex
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
          isRunning={isRunning}
          onStartArtifactRun={onStartArtifactRun}
          deferVisualizeRuntimeBoot={deferVisualizeRuntimeBoot}
          {...(attachmentImageUrl !== undefined ? { attachmentImageUrl } : {})}
          {...(Object.keys(actions).length > 0 ? { actions } : {})}
          {...(onWidgetPrompt !== undefined ? { onWidgetPrompt } : {})}
          {...(onAskUserAnswer !== undefined ? { onAskUserAnswer } : {})}
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
          deferVisualizeRuntimeBoot={deferVisualizeRuntimeBoot}
          {...(onOpenChildSession !== undefined ? { onOpenChildSession } : {})}
          {...(onWidgetPrompt !== undefined ? { onWidgetPrompt } : {})}
          {...(onAskUserAnswer !== undefined ? { onAskUserAnswer } : {})}
          {...(onWidgetToolRequest !== undefined
            ? { onWidgetToolRequest }
            : {})}
        />
      );
    }

    if (row.kind === 'subagent_spawn_group') {
      return (
        <SubagentSpawnGroup
          row={row}
          expanded={expanded}
          onToggle={() => onToggleGroup(row.key)}
          {...(onOpenChildSession !== undefined ? { onOpenChildSession } : {})}
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
  const running = row.kind === 'live_tool_group' && row.running;
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
  const summary =
    row.kind === 'settled_tool_group'
      ? summarizeToolGroupHeaderCounts({
          commandCount: row.commandCallCount,
          toolCount: row.toolCallCount,
        })
      : summarizeToolGroupHeader(liveItems ?? []);

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

function SubagentSpawnGroup(props: {
  row: Extract<TranscriptVirtualRow, { kind: 'subagent_spawn_group' }>;
  expanded: boolean;
  onToggle: () => void;
  onOpenChildSession?: OpenChildSessionHandler;
}) {
  const { row, expanded, onToggle, onOpenChildSession } = props;
  const summary = `보조 작업 ${row.entries.length}개 시작함`;
  return (
    <div className="tool-row transcript-tool-group">
      <button
        type="button"
        className="transcript-subagent-group-toggle"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="tool-row-icon">…</span>
        <span className="tool-row-summary transcript-work-group-title">
          {summary}
        </span>
        <span className="subagent-progress-dots" aria-hidden="true">
          {row.entries.map((entry) => (
            <span
              key={entry.childRunId}
              className={`subagent-progress-dot ${entry.state}`}
            />
          ))}
        </span>
        <span className="transcript-tool-group-chevron" aria-hidden="true">
          {expanded ? '⌃' : '⌄'}
        </span>
      </button>
      {expanded ? (
        <div className="transcript-tool-group-detail">
          {row.entries.map((entry) => (
            <RunTranscriptEntryBlock
              key={entry.childRunId}
              entry={entry}
              {...(onOpenChildSession !== undefined
                ? { onOpenChildSession }
                : {})}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function buildSettledTranscriptRows(args: {
  messages: ThreadMessage[];
  messageKeys: string[];
}): TranscriptVirtualRow[] {
  const rows: TranscriptVirtualRow[] = [];

  for (let index = 0; index < args.messages.length;) {
    const message = args.messages[index]!;
    // visualize 호출 메시지는 접힌 도구 그룹에 넣지 않고 위젯 행으로 노출
    if (!isToolMessage(message) || isInteractiveToolCallMessage(message)) {
      rows.push({
        kind: 'message',
        key: args.messageKeys[index] ?? message.entryId,
        message,
        messageIndex: index,
      });
      index += 1;
      continue;
    }

    const start = index;
    while (
      index < args.messages.length &&
      isToolMessage(args.messages[index]!) &&
      !isInteractiveToolCallMessage(args.messages[index]!)
    ) {
      index += 1;
    }
    const messages = args.messages.slice(start, index);
    const parsed = messages.map(parseToolMessage);
    const callIds = new Set(
      parsed.flatMap((item) => (item.callId === null ? [] : [item.callId])),
    );
    let commandCallCount = 0;
    let toolCallCount = 0;
    parsed.forEach((item, parsedIndex) => {
      if (messages[parsedIndex]!.role !== 'tool_call') {
        return;
      }
      if (isCommandToolName(item.tool)) {
        commandCallCount += 1;
      } else {
        toolCallCount += 1;
      }
    });
    const firstKey = args.messageKeys[start] ?? messages[0]!.entryId;
    const lastKey = args.messageKeys[index - 1] ?? messages.at(-1)!.entryId;
    rows.push({
      kind: 'settled_tool_group',
      key: `settled-tool-group:${firstKey}:${lastKey}`,
      messages,
      messageKeys: args.messageKeys.slice(start, index),
      tools: uniqueStrings(
        parsed.flatMap((item) => (item.tool === null ? [] : [item.tool])),
      ),
      activityCount: callIds.size > 0 ? callIds.size : messages.length,
      commandCallCount,
      toolCallCount,
      failed: parsed.some((item) => item.failed),
    });
  }

  return rows;
}

function buildLiveTranscriptRows(args: {
  transcriptEntries: RunTranscriptEntry[];
  transcriptEntryKeys: string[];
}): TranscriptVirtualRow[] {
  const rows: TranscriptVirtualRow[] = [];

  for (let index = 0; index < args.transcriptEntries.length;) {
    const entry = args.transcriptEntries[index]!;
    if (isSpawnedSubagentEntry(entry)) {
      const start = index;
      const entries: SubagentSpawnEntry[] = [];
      while (index < args.transcriptEntries.length) {
        const candidate = args.transcriptEntries[index]!;
        if (!isSpawnedSubagentEntry(candidate)) {
          break;
        }
        entries.push(candidate);
        index += 1;
      }
      if (entries.length === 1) {
        rows.push({
          kind: 'entry',
          key: args.transcriptEntryKeys[start] ?? `subagent:${start}`,
          entry,
        });
      } else {
        const firstKey =
          args.transcriptEntryKeys[start] ?? entries[0]!.childRunId;
        const lastKey =
          args.transcriptEntryKeys[index - 1] ?? entries.at(-1)!.childRunId;
        rows.push({
          kind: 'subagent_spawn_group',
          key: `subagent-spawn-group:${firstKey}:${lastKey}`,
          entries,
        });
      }
      continue;
    }
    // visualize 위젯 엔트리도 접힌 도구 그룹 밖의 독립 행으로 노출
    if (entry.kind !== 'tool_activity' || isVisualizeWidgetEntry(entry)) {
      rows.push({
        kind: 'entry',
        key: args.transcriptEntryKeys[index] ?? `${entry.kind}:${index}`,
        entry,
      });
      index += 1;
      continue;
    }

    const start = index;
    const entries: ToolActivityEntry[] = [];
    while (index < args.transcriptEntries.length) {
      const candidate = args.transcriptEntries[index]!;
      if (
        candidate.kind !== 'tool_activity' ||
        isVisualizeWidgetEntry(candidate)
      ) {
        break;
      }
      entries.push(candidate);
      index += 1;
    }
    const firstKey =
      args.transcriptEntryKeys[start] ?? `${entries[0]!.tool}:${start}`;
    const lastKey =
      args.transcriptEntryKeys[index - 1] ??
      `${entries.at(-1)!.tool}:${index - 1}`;
    rows.push({
      kind: 'live_tool_group',
      key: `live-tool-group:${firstKey}:${lastKey}`,
      entries,
      tools: uniqueStrings(entries.map((item) => item.tool)),
      activityCount: entries.length,
      failed: entries.some((item) => item.state === 'failed'),
      running: entries.some((item) => item.state === 'running'),
    });
  }

  return rows;
}

function isToolMessage(message: ThreadMessage): boolean {
  return message.role === 'tool_call' || message.role === 'tool_result';
}

// 접힌 도구 그룹에 넣지 않고 독립 행으로 그리는 상호작용형 호출
// (visualize 위젯, ask_user 선택지 카드)
function isInteractiveToolCallMessage(message: ThreadMessage): boolean {
  if (message.role !== 'tool_call') {
    return false;
  }
  const tool = readCanonicalJsonStringField(message.content, 'tool');
  return tool === VISUALIZE_TOOL_NAME || tool === ASK_USER_TOOL_NAME;
}

function isVisualizeWidgetEntry(entry: RunTranscriptEntry): boolean {
  return (
    entry.kind === 'tool_activity' &&
    entry.tool === VISUALIZE_TOOL_NAME &&
    entry.args !== undefined
  );
}

function isVisualizeWidgetRow(row: TranscriptVirtualRow | undefined): boolean {
  if (row?.kind === 'message') {
    return (
      row.message.role === 'tool_call' &&
      readCanonicalJsonStringField(row.message.content, 'tool') ===
        VISUALIZE_TOOL_NAME
    );
  }
  return row?.kind === 'entry' && isVisualizeWidgetEntry(row.entry);
}

function isSpawnedSubagentEntry(
  entry: RunTranscriptEntry,
): entry is SubagentSpawnEntry {
  return entry.kind === 'subagent_activity' && entry.state === 'spawned';
}

function parseToolMessage(message: ThreadMessage): ParsedToolMessage {
  return {
    tool: readCanonicalJsonStringField(message.content, 'tool'),
    callId: readCanonicalJsonStringField(message.content, 'callId'),
    failed: message.content.includes('"ok":false'),
  };
}

function readCanonicalJsonStringField(
  content: string,
  field: string,
): string | null {
  const marker = `"${field}":"`;
  const valueStart = content.indexOf(marker);
  if (valueStart < 0) {
    return null;
  }
  const start = valueStart + marker.length;
  const end = content.indexOf('"', start);
  if (end < 0) {
    return null;
  }
  const value = content.slice(start, end);
  return value.includes('\\') ? null : value;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function findLastRoleIndex(
  messages: readonly ThreadMessage[],
  role: ThreadMessage['role'],
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === role) {
      return index;
    }
  }
  return -1;
}

function estimateTranscriptRowSize(
  row: TranscriptVirtualRow | undefined,
): number {
  if (
    row?.kind === 'settled_tool_group' ||
    row?.kind === 'live_tool_group' ||
    row?.kind === 'subagent_spawn_group'
  ) {
    return 44;
  }
  return TRANSCRIPT_ROW_ESTIMATE;
}
