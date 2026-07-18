import React, { useMemo } from 'react';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { RunRequest } from '@geulbat/protocol/run-contract';
import type { RunUsageTotals } from '@geulbat/protocol/run-events';
import type { ThreadMessage } from '@geulbat/protocol/threads';

import { createArtifactsByRefMap } from '../artifacts/artifact-transcript-lookup.js';
import type { RunTranscriptEntry } from '../../lib/run-transcript-entry.js';
import { assistantStyles } from './assistant-styles.js';
import {
  createStableOccurrenceKeys,
  getRunTranscriptEntryBaseKey,
  getThreadMessageBaseKey,
} from './assistant-transcript-content.js';
import { RunStatusRow } from './assistant-run-status.js';
import type { WidgetToolRequestHandler } from './assistant-transcript-entry-blocks.js';
import { AssistantTranscriptLiveTail } from './assistant-transcript-live-tail.js';
import {
  type OpenChildSessionHandler,
  VirtualizedTranscriptRows,
} from './assistant-transcript-virtual-list.js';
import { useAssistantTranscriptScrollState } from './use-assistant-transcript-scroll-state.js';

interface AssistantTranscriptProps {
  messages: ThreadMessage[];
  artifacts: ThreadArtifactVersion[];
  backgroundNotifications: Extract<
    RunTranscriptEntry,
    { kind: 'subagent_activity' }
  >[];
  transcriptEntries: RunTranscriptEntry[];
  finalAnswerText: string;
  activeArtifact: ThreadArtifactVersion | null;
  streamError: string | null;
  isRunning: boolean;
  // 실행 중 상태줄에 붙일 런 누적 토큰 사용량
  usageTotals?: RunUsageTotals | null;
  onStartArtifactRun: (request: RunRequest) => Promise<void> | void;
  attachmentImageUrl?: (attachmentId: string) => string | null;
  // 존재하면 마지막 답변 액션에 ↻ 재시도를 붙인다 — 표시 조건은 Assistant가 판정
  onRetryLastPrompt?: () => void;
  // 존재하면 마지막 질문에 ✎ 편집을 붙인다 (수정본은 재생성으로 전송)
  onEditLastUserPrompt?: (nextPrompt: string) => void;
  // 존재하면 모든 답변에 ⑂ 여기서 새 채팅을 붙인다
  onBranchFromMessage?: (entryId: string) => void;
  // 존재하면 과거 질문(마지막 제외)에 ✎ 편집을 붙인다 — 브랜치 기반 재실행
  onEditPastUserPrompt?: (entryId: string, nextPrompt: string) => void;
  onOpenChildSession?: OpenChildSessionHandler;
  // visualize 위젯의 sendPrompt를 기존 전송 경로로 번역하는 콜백
  onWidgetPrompt?: (prompt: string) => Promise<void> | void;
  // ask_user 카드 답변 — 사용자 선택이므로 아티팩트 귀속 없이 전송한다
  onAskUserAnswer?: (prompt: string) => Promise<void> | void;
  // 위젯 발 도구 호출(run.tool) 번역 콜백
  onWidgetToolRequest?: WidgetToolRequestHandler;
  // 존재하면 아티팩트는 인라인 대신 참조 칩으로 남고 중앙 패널에서 열린다
  onOpenArtifact?: (artifact: ThreadArtifactVersion) => void;
}

export const AssistantTranscript = React.memo(function AssistantTranscript({
  messages,
  artifacts,
  backgroundNotifications,
  transcriptEntries,
  finalAnswerText,
  activeArtifact,
  streamError,
  isRunning,
  usageTotals = null,
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
}: AssistantTranscriptProps) {
  const activeArtifactKey = activeArtifact
    ? `${activeArtifact.artifactId}:${activeArtifact.version}`
    : null;
  const messageKeys = useMemo(
    () => createStableOccurrenceKeys(messages, getThreadMessageBaseKey),
    [messages],
  );
  const transcriptEntryKeys = useMemo(
    () =>
      createStableOccurrenceKeys(
        transcriptEntries,
        getRunTranscriptEntryBaseKey,
      ),
    [transcriptEntries],
  );
  const backgroundNotificationKeys = useMemo(
    () =>
      createStableOccurrenceKeys(
        backgroundNotifications,
        getRunTranscriptEntryBaseKey,
      ),
    [backgroundNotifications],
  );
  const artifactsByRef = useMemo(
    () => createArtifactsByRefMap(artifacts),
    [artifacts],
  );
  const {
    transcriptRef,
    contentRef,
    bottomRef,
    hasUnreadStreamContent,
    isAwayFromBottom,
    handleTranscriptScroll,
    handleJumpToLatest,
  } = useAssistantTranscriptScrollState({
    isRunning,
    messageCount: messages.length,
    backgroundNotificationCount: backgroundNotifications.length,
    transcriptEntryCount: transcriptEntries.length,
    finalAnswerText,
    activeArtifactKey,
    streamError,
  });

  return (
    <div
      ref={transcriptRef}
      onScroll={handleTranscriptScroll}
      role="log"
      aria-label="Assistant transcript"
      aria-live="polite"
      aria-relevant="additions text"
      aria-atomic="false"
      aria-busy={isRunning}
      style={assistantStyles.transcript}
    >
      {/* ResizeObserver 대상 — iframe 아티팩트처럼 나중에 자라는 내용도
          바닥 따라가기가 유지되도록 내용 전체를 한 래퍼로 감싼다 */}
      <div ref={contentRef} style={assistantStyles.transcriptContent}>
        <VirtualizedTranscriptRows
          scrollElementRef={transcriptRef}
          messages={messages}
          messageKeys={messageKeys}
          transcriptEntries={transcriptEntries}
          transcriptEntryKeys={transcriptEntryKeys}
          artifactsByRef={artifactsByRef}
          isRunning={isRunning}
          onStartArtifactRun={onStartArtifactRun}
          {...(attachmentImageUrl !== undefined ? { attachmentImageUrl } : {})}
          {...(onRetryLastPrompt !== undefined ? { onRetryLastPrompt } : {})}
          {...(onEditLastUserPrompt !== undefined
            ? { onEditLastUserPrompt }
            : {})}
          {...(onBranchFromMessage !== undefined
            ? { onBranchFromMessage }
            : {})}
          {...(onEditPastUserPrompt !== undefined
            ? { onEditPastUserPrompt }
            : {})}
          {...(onOpenChildSession !== undefined ? { onOpenChildSession } : {})}
          {...(onWidgetPrompt !== undefined ? { onWidgetPrompt } : {})}
          {...(onAskUserAnswer !== undefined ? { onAskUserAnswer } : {})}
          {...(onWidgetToolRequest !== undefined
            ? { onWidgetToolRequest }
            : {})}
          {...(onOpenArtifact !== undefined ? { onOpenArtifact } : {})}
        />

        <AssistantTranscriptLiveTail
          finalAnswerText={finalAnswerText}
          activeArtifact={activeArtifact}
          streamError={streamError}
          backgroundNotifications={backgroundNotifications}
          backgroundNotificationKeys={backgroundNotificationKeys}
          hasUnreadStreamContent={hasUnreadStreamContent}
          isRunning={isRunning}
          onStartArtifactRun={onStartArtifactRun}
          onJumpToLatest={handleJumpToLatest}
          {...(onOpenChildSession !== undefined ? { onOpenChildSession } : {})}
          {...(onOpenArtifact !== undefined ? { onOpenArtifact } : {})}
        />
        {isRunning ? (
          <RunStatusRow
            transcriptEntries={transcriptEntries}
            usageTotals={usageTotals}
          />
        ) : null}
        {onRetryLastPrompt !== undefined &&
        messages.at(-1)?.role !== 'assistant' ? (
          <div className="transcript-retry-row">
            <button
              type="button"
              className="transcript-retry-button"
              onClick={onRetryLastPrompt}
            >
              ↻ 답변 다시 시도
            </button>
          </div>
        ) : null}
        <div ref={bottomRef} />
      </div>
      {/* ↓ 맨 아래로 — 바닥에서 떨어져 있을 때만. contentRef 밖(sticky)에
          두어 ResizeObserver 바닥 따라가기에 영향을 주지 않는다 */}
      {isAwayFromBottom ? (
        <div className="jump-to-bottom-row">
          <button
            type="button"
            className="jump-to-bottom"
            title="맨 아래로"
            aria-label="맨 아래로 이동"
            onClick={handleJumpToLatest}
          >
            ↓
          </button>
        </div>
      ) : null}
    </div>
  );
});
