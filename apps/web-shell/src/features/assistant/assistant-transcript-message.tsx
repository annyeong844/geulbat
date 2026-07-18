import { useMemo, useState, useSyncExternalStore } from 'react';
import type { WidgetToolRequestHandler } from './visualize/visualize-widget.js';
import type { RunRequest } from '@geulbat/protocol/run-contract';
import { isRecord } from '@geulbat/protocol/runtime-utils';
import type { ThreadMessageAttachment } from '@geulbat/protocol/thread-metadata';
import type { ThreadMessage } from '@geulbat/protocol/threads';

import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';

import {
  type ArtifactsByRefMap,
  readCommittedMessageArtifact,
} from '../artifacts/artifact-transcript-lookup.js';
import { ArtifactReferenceChip } from './artifact-pane/artifact-reference-chip.js';
import { CommittedArtifactMessage } from './artifact-pane/index.js';
import {
  canRenderInlineImageArtifact,
  InlineImageArtifactMessage,
} from './artifact-pane/inline-image-artifact.js';
import {
  AssistantMessageContent,
  useCopyToClipboard,
} from './assistant-message-content.js';
import {
  assistantStyles,
  getTranscriptMessageStyle,
} from './assistant-styles.js';
import { parseToolCallDiff, type ToolCallDiffView } from './tool-call-diff.js';
import {
  parseToolResultView,
  type ToolResultView,
} from './tool-result-view.js';
import { AskUserCard } from './ask-user/ask-user-card.js';
import { readAskUserCardViewFromToolCallContent } from './ask-user/ask-user-card-view.js';
import { VisualizeWidget } from './visualize/visualize-widget.js';
import { readVisualizeWidgetViewFromToolCallContent } from './visualize/visualize-widget-view.js';
import {
  getToolDiffExpandedDefault,
  getToolDiffExpandedDefaultServerSnapshot,
  subscribeToolDiffExpandedDefault,
} from './tool-diff-prefs.js';

// 메시지 하단 액션 — 답변은 항상 노출(좌측), 질문은 hover 시에만(우측).
interface TranscriptMessageActions {
  // 마지막 답변에만: 답변 재생성(덮어쓰기)
  onRetry?: () => void;
  // 마지막 질문에만: 인라인 편집 → 수정본으로 재생성
  onEditSubmit?: (nextPrompt: string) => void;
  // 모든 답변에: ⑂ 여기서 새 채팅(이 답변까지 복제한 새 스레드로 전환)
  onBranch?: () => void;
}

export function TranscriptMessage(props: {
  message: ThreadMessage;
  artifactsByRef: ArtifactsByRefMap;
  isRunning: boolean;
  onStartArtifactRun?: (request: RunRequest) => Promise<void> | void;
  attachmentImageUrl?: (attachmentId: string) => string | null;
  actions?: TranscriptMessageActions;
  // visualize 위젯의 sendPrompt를 기존 전송 경로로 번역하는 콜백
  onWidgetPrompt?: (prompt: string) => Promise<void> | void;
  // ask_user 카드 답변 — 사용자 선택이므로 아티팩트 귀속 없이 전송한다
  onAskUserAnswer?: (prompt: string) => Promise<void> | void;
  // 위젯 발 도구 호출(run.tool) 번역 콜백
  onWidgetToolRequest?: WidgetToolRequestHandler;
  // 존재하면 아티팩트를 인라인으로 그리지 않고 참조 칩으로 두며, 클릭 시
  // 중앙 아티팩트 패널로 연다
  onOpenArtifact?: (artifact: ThreadArtifactVersion) => void;
}) {
  const {
    message,
    artifactsByRef,
    isRunning,
    onStartArtifactRun,
    attachmentImageUrl,
    actions,
    onWidgetPrompt,
    onAskUserAnswer,
    onWidgetToolRequest,
    onOpenArtifact,
  } = props;
  // 렌더마다 tool_call JSON을 다시 파싱해 view 객체(와 그 아래 위젯 문서
  // 빌드·해시)를 재생성하지 않도록 content 기준으로 고정한다
  const visualizeWidgetView = useMemo(
    () =>
      message.role === 'tool_call'
        ? readVisualizeWidgetViewFromToolCallContent(message.content)
        : null,
    [message.content, message.role],
  );
  const askUserCardView = useMemo(
    () =>
      message.role === 'tool_call'
        ? readAskUserCardViewFromToolCallContent(message.content)
        : null,
    [message.content, message.role],
  );
  if (message.role === 'assistant') {
    const committedArtifact = readCommittedMessageArtifact(
      message,
      artifactsByRef,
    );
    if (committedArtifact) {
      return (
        <>
          {message.content ? (
            <TranscriptTextMessage
              messageRole="assistant"
              content={message.content}
              {...(actions !== undefined ? { actions } : {})}
            />
          ) : null}
          {canRenderInlineImageArtifact(committedArtifact) ? (
            <div className="transcript-message from-assistant">
              <InlineImageArtifactMessage artifact={committedArtifact} />
            </div>
          ) : onOpenArtifact !== undefined ? (
            <div className="transcript-message from-assistant">
              <ArtifactReferenceChip
                artifact={committedArtifact}
                onOpen={onOpenArtifact}
              />
            </div>
          ) : (
            <CommittedArtifactMessage
              label="assistant"
              artifact={committedArtifact}
              isRunning={isRunning}
              {...(onStartArtifactRun !== undefined
                ? { onStartArtifactRun }
                : {})}
            />
          )}
        </>
      );
    }
  }

  // visualize 호출은 위젯 자체를 인라인으로 그린다 — 코드 원본은 호출
  // 인자에 실려 있고, 결과 메시지는 작은 확인 행으로만 남는다
  if (message.role === 'tool_call' && visualizeWidgetView !== null) {
    return (
      <div className="transcript-message from-assistant">
        <VisualizeWidget
          view={visualizeWidgetView}
          {...(onWidgetPrompt !== undefined ? { onWidgetPrompt } : {})}
          {...(onWidgetToolRequest !== undefined
            ? { onWidgetToolRequest }
            : {})}
        />
      </div>
    );
  }

  // ask_user 호출은 선택지 카드로 — 옵션 클릭이 답장이 된다
  if (message.role === 'tool_call' && askUserCardView !== null) {
    return (
      <div className="transcript-message from-assistant">
        <AskUserCard
          view={askUserCardView}
          {...(onAskUserAnswer !== undefined
            ? { onAnswer: onAskUserAnswer }
            : {})}
        />
      </div>
    );
  }

  // 파일 변경 도구 호출은 raw JSON 대신 CC식 diff 블록으로 보여준다
  if (message.role === 'tool_call') {
    const diff = parseToolCallDiff(message.content);
    if (diff !== null) {
      return (
        <div className="transcript-message from-assistant">
          <ToolDiffBlock diff={diff} />
        </div>
      );
    }
    const toolName = readToolMessageName(message.content);
    return (
      <div className="transcript-message from-assistant">
        <div className="tool-call-summary">
          <span className="tool-row-icon">…</span>
          <span className="tool-row-name">{toolName ?? '도구'}</span>
          <span className="tool-row-summary">호출함</span>
        </div>
      </div>
    );
  }

  // 도구 결과도 raw JSON 대신 접힌 요약 블록으로 보여준다
  if (message.role === 'tool_result') {
    const result = parseToolResultView(message.content);
    if (result !== null) {
      return (
        <div className="transcript-message from-assistant">
          <ToolResultBlock view={result} />
        </div>
      );
    }
  }

  return (
    <TranscriptTextMessage
      messageRole={message.role}
      content={message.content}
      attachments={readMessageAttachments(message)}
      {...(message.role === 'user' &&
      message.metadata?.origin === 'artifact_frame'
        ? { originBadge: '아티팩트 요청' }
        : {})}
      {...(attachmentImageUrl !== undefined ? { attachmentImageUrl } : {})}
      {...(actions !== undefined ? { actions } : {})}
    />
  );
}

function readToolMessageName(content: string): string | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed)) {
      return null;
    }
    const tool = parsed.tool;
    return typeof tool === 'string' && tool.trim().length > 0 ? tool : null;
  } catch {
    return null;
  }
}

// CC식 diff 블록 — 기본 펼침 여부는 [+] 메뉴의 "diff 항상 펼치기" 설정을
// 따르고(토글 시 화면의 블록들도 즉시 반영), 개별 블록은 헤더 클릭으로
// 그 자리에서 뒤집을 수 있다.
export function ToolDiffBlock(props: { diff: ToolCallDiffView }) {
  const { diff } = props;
  const defaultExpanded = useSyncExternalStore(
    subscribeToolDiffExpandedDefault,
    getToolDiffExpandedDefault,
    getToolDiffExpandedDefaultServerSnapshot,
  );
  // 사용자가 이 블록을 직접 토글했으면 그 선택이 기본값보다 우선한다
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = override ?? defaultExpanded;
  return (
    <div className="tool-diff">
      <button
        type="button"
        className="tool-diff-header"
        aria-expanded={expanded}
        aria-label={`${diff.path} 변경 내용 ${expanded ? '접기' : '펼치기'}`}
        onClick={() => setOverride(!expanded)}
      >
        <span className="tool-diff-path" title={diff.path}>
          {diff.path}
        </span>
        <span className="tool-diff-stats">
          {diff.action} · <span className="added">+{diff.addedCount}</span>
          {diff.removedCount > 0 ? (
            <>
              {' '}
              <span className="removed">−{diff.removedCount}</span>
            </>
          ) : null}
        </span>
        <span className="tool-diff-chevron" aria-hidden="true">
          {expanded ? '⌃' : '⌄'}
        </span>
      </button>
      {expanded ? (
        <pre className="tool-diff-body">
          {diff.lines.map((line, index) => (
            <div key={index} className={`tool-diff-line ${line.type}`}>
              {line.text || ' '}
            </div>
          ))}
          {diff.truncatedLineCount > 0 ? (
            <div className="tool-diff-line truncated">
              … {diff.truncatedLineCount}줄 더 있음
            </div>
          ) : null}
        </pre>
      ) : null}
    </div>
  );
}

// 도구 결과 블록 — 접힌 헤더(도구명 + ✓/! + 한 줄 요약), 클릭 시
// displayText/output 본문(JSON은 pretty)이 펼쳐진다. diff 블록과 같은
// 시각 언어를 공유한다.
function ToolResultBlock(props: { view: ToolResultView }) {
  const { view } = props;
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="tool-diff tool-result">
      <button
        type="button"
        className="tool-diff-header"
        aria-expanded={expanded}
        aria-label={`${view.tool} 결과 ${expanded ? '접기' : '펼치기'}`}
        onClick={() => setExpanded((current) => !current)}
      >
        <span
          className={`tool-result-status ${view.ok ? 'ok' : 'failed'}`}
          aria-hidden="true"
        >
          {view.ok ? '✓' : '!'}
        </span>
        <span className="tool-diff-path">{view.tool}</span>
        <span className="tool-result-summary" title={view.summary}>
          {view.summary}
        </span>
        <span className="tool-diff-chevron" aria-hidden="true">
          {expanded ? '⌃' : '⌄'}
        </span>
      </button>
      {expanded ? (
        <pre className="tool-diff-body">
          {view.bodyLines.length === 0 ? (
            <div className="tool-diff-line truncated">(출력 없음)</div>
          ) : (
            view.bodyLines.map((line, index) => (
              <div key={index} className="tool-diff-line">
                {line || ' '}
              </div>
            ))
          )}
          {view.truncatedLineCount > 0 ? (
            <div className="tool-diff-line truncated">
              … {view.truncatedLineCount}줄 더 있음
            </div>
          ) : null}
        </pre>
      ) : null}
    </div>
  );
}

// 사용자 메시지에 실려 간 첨부 — 모델에 전달된 첨부의 표시용 기록
function readMessageAttachments(
  message: ThreadMessage,
): ThreadMessageAttachment[] {
  const metadata = message.metadata;
  if (
    message.role !== 'user' ||
    !metadata ||
    !('attachments' in metadata) ||
    !metadata.attachments
  ) {
    return [];
  }
  return metadata.attachments;
}

export function TranscriptTextMessage(props: {
  messageRole: ThreadMessage['role'];
  content: string;
  attachments?: ThreadMessageAttachment[];
  attachmentImageUrl?: (attachmentId: string) => string | null;
  actions?: TranscriptMessageActions;
  // 아티팩트 프레임 발 턴 귀속 라벨 (back-channel 설계 가시성 불변식) —
  // 사용자가 직접 친 질문과 프레임이 올린 요청을 채팅에서 구분한다.
  originBadge?: string;
}) {
  const {
    messageRole,
    content,
    attachments = [],
    attachmentImageUrl,
    actions,
    originBadge,
  } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const canEdit = messageRole === 'user' && actions?.onEditSubmit !== undefined;
  const showActions =
    (messageRole === 'user' || messageRole === 'assistant') &&
    content.trim().length > 0;

  const wrapperClassName = `transcript-message ${
    messageRole === 'user' ? 'from-user' : 'from-assistant'
  }`;

  if (editing && canEdit) {
    return (
      <div className={wrapperClassName}>
        <textarea
          className="message-edit-input"
          value={draft}
          rows={Math.min(8, Math.max(2, draft.split('\n').length))}
          aria-label="질문 수정"
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="message-actions user-actions editing">
          <button
            type="button"
            className="message-action-button"
            onClick={() => {
              setEditing(false);
              setDraft(content);
            }}
          >
            취소
          </button>
          <button
            type="button"
            className="message-action-button primary"
            disabled={!draft.trim()}
            onClick={() => {
              setEditing(false);
              actions?.onEditSubmit?.(draft.trim());
            }}
          >
            보내기
          </button>
        </div>
      </div>
    );
  }

  // 액션 행은 말풍선 "밖"에 둔다 — 사용자 버블의 어두운 배경이 버튼 줄까지
  // 늘어나 보이지 않도록 버블(스타일 div)과 액션을 형제로 분리.
  return (
    <div className={wrapperClassName}>
      {originBadge !== undefined ? (
        <div className="message-origin-badge">{originBadge}</div>
      ) : null}
      <div style={getTranscriptMessageStyle(messageRole)}>
        {messageRole !== 'user' && messageRole !== 'assistant' ? (
          <div style={assistantStyles.messageRole}>{messageRole}</div>
        ) : null}
        {messageRole === 'assistant' ? (
          <AssistantMessageContent content={content} />
        ) : (
          <pre style={assistantStyles.messageText}>{content}</pre>
        )}
        {attachments.length > 0 ? (
          <div className="composer-attachments">
            {attachments.map((attachment) => (
              <TranscriptAttachment
                key={attachment.attachmentId}
                attachment={attachment}
                imageUrl={
                  attachment.kind === 'image'
                    ? (attachmentImageUrl?.(attachment.attachmentId) ?? null)
                    : null
                }
              />
            ))}
          </div>
        ) : null}
      </div>
      {showActions ? (
        <MessageActionsRow
          role={messageRole}
          content={content}
          {...(actions?.onRetry !== undefined && messageRole === 'assistant'
            ? { onRetry: actions.onRetry }
            : {})}
          {...(actions?.onBranch !== undefined && messageRole === 'assistant'
            ? { onBranch: actions.onBranch }
            : {})}
          {...(canEdit
            ? {
                onEdit: () => {
                  setDraft(content);
                  setEditing(true);
                },
              }
            : {})}
        />
      ) : null}
    </div>
  );
}

// 메시지 하단 액션 행 — claude.ai 배치: 답변(좌, 항상), 질문(우, hover).
function MessageActionsRow(props: {
  role: ThreadMessage['role'];
  content: string;
  onRetry?: () => void;
  onEdit?: () => void;
  onBranch?: () => void;
}) {
  const { role, content, onRetry, onEdit, onBranch } = props;
  const { copied, copy } = useCopyToClipboard();

  return (
    <div
      className={`message-actions ${
        role === 'user' ? 'user-actions' : 'assistant-actions'
      }`}
    >
      <button
        type="button"
        className="message-action-button"
        title="복사"
        aria-label="메시지 복사"
        onClick={() => copy(content)}
      >
        {copied ? '✓' : '⧉'}
      </button>
      {onRetry !== undefined ? (
        <button
          type="button"
          className="message-action-button"
          title="답변 다시 시도"
          aria-label="답변 다시 시도"
          onClick={onRetry}
        >
          ↻
        </button>
      ) : null}
      {onBranch !== undefined ? (
        <button
          type="button"
          className="message-action-button"
          title="여기서 새 채팅"
          aria-label="여기서 새 채팅"
          onClick={onBranch}
        >
          ⑂
        </button>
      ) : null}
      {onEdit !== undefined ? (
        <button
          type="button"
          className="message-action-button"
          title="질문 수정"
          aria-label="질문 수정"
          onClick={onEdit}
        >
          ✎
        </button>
      ) : null}
    </div>
  );
}

// 이미지 첨부는 인라인 렌더, 그 외에는 이름 칩
function TranscriptAttachment(props: {
  attachment: ThreadMessageAttachment;
  imageUrl: string | null;
}) {
  const { attachment, imageUrl } = props;
  if (imageUrl !== null) {
    return (
      <img
        className="attachment-image"
        src={imageUrl}
        alt={attachment.name}
        title={attachment.name}
      />
    );
  }
  return (
    <span className="attachment-chip" title={attachment.name}>
      📎 {attachment.name}
    </span>
  );
}
