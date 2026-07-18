import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ThreadDetailResponse } from '@geulbat/protocol/threads';

import { getThread } from '../../lib/api/threads.js';
import type { RunTranscriptEntry } from '../../lib/run-transcript-entry.js';
import { formatSubagentActivityMeta } from './assistant-transcript-entry-blocks.js';
import { AssistantTranscript } from './AssistantTranscript.js';

export type ChildSessionTarget = Extract<
  RunTranscriptEntry,
  { kind: 'subagent_activity' }
> & { childThreadId: string };

type ChildSessionLoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; detail: ThreadDetailResponse };

function ignoreArtifactRun(): void {
  // This viewer is read-only; artifacts may render but cannot start a new run.
}

const DIALOG_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not(:disabled)',
  'details > summary:first-of-type',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

// 보조 작업 카드에서 여는 읽기 전용 차일드 세션 뷰 — 부모 세션은 그대로
// 두고 차일드 스레드 transcript(프롬프트/작업/결과)만 오버레이로 보여준다.
export function ChildSessionViewer(props: {
  target: ChildSessionTarget;
  onClose: () => void;
  loadThread?: typeof getThread;
}) {
  const { target, onClose, loadThread = getThread } = props;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const [loadState, setLoadState] = useState<ChildSessionLoadState>({
    kind: 'loading',
  });

  useEffect(() => {
    let cancelled = false;
    setLoadState({ kind: 'loading' });
    loadThread(target.childThreadId).then(
      (detail) => {
        if (!cancelled) {
          setLoadState({ kind: 'loaded', detail });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setLoadState({
            kind: 'error',
            message:
              error instanceof Error
                ? error.message
                : '차일드 세션을 불러오지 못했습니다.',
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [loadThread, target.childThreadId]);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  const handleOverlayKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || panelRef.current === null) {
      return;
    }

    const focusableElements = Array.from(
      panelRef.current.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR),
    );
    const firstFocusable = focusableElements[0];
    const lastFocusable = focusableElements.at(-1);
    if (!firstFocusable || !lastFocusable) {
      return;
    }
    if (event.shiftKey && document.activeElement === firstFocusable) {
      event.preventDefault();
      lastFocusable.focus();
    } else if (!event.shiftKey && document.activeElement === lastFocusable) {
      event.preventDefault();
      firstFocusable.focus();
    }
  };

  const meta = formatSubagentActivityMeta(target);

  return (
    <div
      className="child-session-overlay"
      role="presentation"
      onKeyDown={handleOverlayKeyDown}
    >
      <button
        type="button"
        className="child-session-backdrop"
        aria-label="보조 작업 세션 닫기"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        className="child-session-panel"
        role="dialog"
        aria-modal="true"
        aria-label="보조 작업 세션"
      >
        <div className="child-session-header">
          <div>
            <div className="child-session-title">
              보조 작업 세션 — {target.subagentType}
            </div>
            <div className="child-session-meta">
              {meta ? `${meta} · ` : ''}
              {target.childThreadId}
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="child-session-close"
            aria-label="닫기"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="child-session-body">
          {loadState.kind === 'loading' ? (
            <div className="child-session-notice">불러오는 중…</div>
          ) : loadState.kind === 'error' ? (
            <div className="child-session-notice">
              불러오기 실패: {loadState.message}
            </div>
          ) : loadState.detail.messages.length === 0 ? (
            <div className="child-session-notice">기록된 대화가 없습니다.</div>
          ) : (
            <AssistantTranscript
              messages={loadState.detail.messages}
              artifacts={loadState.detail.artifacts ?? []}
              backgroundNotifications={[]}
              transcriptEntries={[]}
              finalAnswerText=""
              activeArtifact={null}
              streamError={null}
              isRunning={false}
              onStartArtifactRun={ignoreArtifactRun}
            />
          )}
        </div>
      </div>
    </div>
  );
}
