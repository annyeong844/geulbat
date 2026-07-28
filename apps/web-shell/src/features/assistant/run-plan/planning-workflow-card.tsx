import { useCallback, useEffect, useId, useRef, useState } from 'react';

import type {
  PlanDraftV1,
  PlanningWorkflowSnapshot,
  PlanWorkflowCommand,
} from '@geulbat/protocol/planning-workflow';
import {
  VisualizeWidget,
  type WidgetToolRequestHandler,
} from '../visualize/visualize-widget.js';
import type { VisualizeWidgetView } from '../visualize/visualize-widget-view.js';

export interface AssistantPlanningWorkflow {
  snapshot: PlanningWorkflowSnapshot;
  busy: boolean;
  onCommand: (command: PlanWorkflowCommand) => Promise<void>;
}

function PlanningWorkflowDismissIcon() {
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

const PLAN_FILE_REFERENCE_PATTERN =
  /(?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@.-]+\.(?:[cm]?[jt]sx?|css|scss|md|json|ya?ml|toml|py|rs|go|java|kt|swift|sh|ps1)/giu;

function collectPlanFileReferences(draft: PlanDraftV1): string[] {
  const text = [
    draft.outcome,
    ...draft.steps.flatMap((step) => [step.text, ...step.acceptanceCriteria]),
    ...draft.decisions.map((decision) => decision.text),
    ...draft.assumptions,
    ...draft.openQuestions,
  ].join('\n');
  const references: string[] = [];
  for (const match of text.match(PLAN_FILE_REFERENCE_PATTERN) ?? []) {
    const baseName = match.split('/').at(-1);
    const existingIndex = references.findIndex(
      (reference) => reference.split('/').at(-1) === baseName,
    );
    if (existingIndex === -1) {
      references.push(match);
    } else if (
      match.includes('/') &&
      references[existingIndex]?.includes('/') !== true
    ) {
      references[existingIndex] = match;
    }
  }
  return references;
}

function resolvePlanCardTitle(
  outcome: string,
  fileReferences: readonly string[],
): string {
  let title = outcome;
  for (const reference of fileReferences) {
    for (const candidate of [
      reference,
      reference.split('/').at(-1) ?? reference,
    ]) {
      title = title
        .replaceAll(`\`${candidate}\``, ' ')
        .replaceAll(candidate, ' ');
    }
  }
  title = title
    .replace(/^\s*(?:한\s+)?파일(?:만)?(?:의|에서|을|를)?\s*/u, '')
    .replace(/^\s*(?:의|에서|을|를)\s*/u, '')
    .replace(/\s{2,}/gu, ' ')
    .replace(/\s+([,.;:])/gu, '$1')
    .replace(/^[\s·,:;—–-]+|[\s·,:;—–-]+$/gu, '')
    .trim();
  return title || '계획을 검토해 주세요';
}

export function PlanningWorkflowCard({
  workflow,
  visualization = null,
  onWidgetPrompt,
  onWidgetToolRequest,
  onDismiss,
}: {
  workflow: AssistantPlanningWorkflow;
  visualization?: VisualizeWidgetView | null;
  onWidgetPrompt?: (prompt: string) => Promise<void> | void;
  onWidgetToolRequest?: WidgetToolRequestHandler;
  onDismiss?: () => void;
}) {
  const { snapshot } = workflow;
  const [feedback, setFeedback] = useState('');
  const [pendingCommand, setPendingCommand] = useState<
    PlanWorkflowCommand['kind'] | null
  >(null);
  const [visualRequestPending, setVisualRequestPending] = useState(false);
  const [visualExpanded, setVisualExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoExplainKeyRef = useRef<string | null>(null);
  const visualOpenButtonRef = useRef<HTMLButtonElement | null>(null);
  const visualCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const visualDialogTitleId = useId();
  const actionsDisabled =
    workflow.busy || pendingCommand !== null || visualRequestPending;
  const visualAwaitingDiagram =
    snapshot.state === 'awaiting_approval' &&
    snapshot.intensity === 'visual' &&
    visualization === null;
  const approveDisabled = actionsDisabled || visualAwaitingDiagram;
  // 시각화는 계획 초안과 별개인 보조 작업이다. 그림이 늦더라도 텍스트
  // 계획을 읽고 수정하거나 취소할 수 있어야 한다.
  const planEditActionsDisabled =
    pendingCommand !== null || (workflow.busy && !visualAwaitingDiagram);

  const closeExpandedVisualization = useCallback(() => {
    setVisualExpanded(false);
    visualOpenButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!visualExpanded || typeof document === 'undefined') {
      return;
    }
    visualCloseButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeExpandedVisualization();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [closeExpandedVisualization, visualExpanded]);

  const submit = async (command: PlanWorkflowCommand) => {
    setPendingCommand(command.kind);
    setError(null);
    try {
      await workflow.onCommand(command);
    } catch (reason: unknown) {
      setError(
        reason instanceof Error
          ? reason.message
          : '계획 명령을 처리하지 못했습니다.',
      );
    } finally {
      setPendingCommand(null);
    }
  };

  const requestVisualization = useCallback(async () => {
    if (snapshot.state !== 'awaiting_approval') {
      return;
    }
    setVisualRequestPending(true);
    setError(null);
    try {
      await workflow.onCommand({
        kind: 'explain_visual',
        threadId: snapshot.threadId,
        workflowId: snapshot.workflowId,
        planId: snapshot.planId,
        revision: snapshot.revision,
        digest: snapshot.digest,
      });
    } catch (reason: unknown) {
      setError(
        reason instanceof Error
          ? reason.message
          : '계획 그림을 만들지 못했습니다.',
      );
    } finally {
      setVisualRequestPending(false);
    }
  }, [snapshot, workflow]);

  useEffect(() => {
    if (
      snapshot.state !== 'awaiting_approval' ||
      snapshot.intensity !== 'visual'
    ) {
      return;
    }
    if (
      visualization !== null ||
      workflow.busy ||
      pendingCommand !== null ||
      visualRequestPending
    ) {
      return;
    }
    const planKey = `${snapshot.workflowId}:${snapshot.planId}:${snapshot.revision}:${snapshot.digest}`;
    if (autoExplainKeyRef.current === planKey) {
      return;
    }
    autoExplainKeyRef.current = planKey;
    // 모델이 같은 턴에 visualize를 빠뜨린 경우 호스트가 그림을 먼저 채운다.
    void requestVisualization();
  }, [
    pendingCommand,
    snapshot,
    visualization,
    visualRequestPending,
    workflow,
    requestVisualization,
  ]);

  const cancel = () =>
    submit({
      kind: 'cancel',
      threadId: snapshot.threadId,
      workflowId: snapshot.workflowId,
      ...('planId' in snapshot ? { planId: snapshot.planId } : {}),
      ...('revision' in snapshot ? { revision: snapshot.revision } : {}),
    });

  if (snapshot.state === 'collecting') {
    if (workflow.busy) {
      return null;
    }
    return (
      <section
        className="planning-workflow-collecting-control"
        aria-label="진행 중인 계획 워크플로"
      >
        <span>
          {snapshot.depth === 'deep'
            ? '심층 계획 진행 중'
            : '일반 계획 진행 중'}
        </span>
        <button
          type="button"
          className="planning-workflow-collecting-cancel"
          disabled={actionsDisabled}
          onClick={() => void cancel()}
        >
          계획 취소
        </button>
        {error === null ? null : (
          <p className="planning-workflow-error" role="alert">
            {error}
          </p>
        )}
      </section>
    );
  }

  const stamp =
    snapshot.state === 'approved_pending_publish' ||
    snapshot.state === 'awaiting_approval' ||
    snapshot.state === 'approved' ||
    snapshot.state === 'executing' ||
    snapshot.state === 'completed' ||
    snapshot.state === 'execution_failed'
      ? `${snapshot.planId} · r${snapshot.revision} · ${snapshot.digest.slice(0, 15)}…`
      : '';

  const target = {
    threadId: snapshot.threadId,
    workflowId: snapshot.workflowId,
    planId: snapshot.planId,
    revision: snapshot.revision,
    digest: snapshot.digest,
  };

  if (snapshot.state === 'approved_pending_publish') {
    return (
      <section className="planning-workflow-card" aria-label="계획 게시 복구">
        <div className="planning-workflow-card-header">
          <div>
            <strong>승인은 보존되어 있어요</strong>
            <p>
              계획 체크리스트 게시가 끝나지 않았습니다. 다시 시도하거나 계획을
              취소할 수 있습니다.
            </p>
          </div>
          <span className="planning-workflow-state">게시 보류</span>
        </div>
        <code className="planning-workflow-stamp">{stamp}</code>
        <div className="planning-workflow-actions">
          <button
            type="button"
            className="planning-workflow-button primary"
            disabled={actionsDisabled}
            onClick={() =>
              void submit({
                kind: 'approve',
                ...target,
              })
            }
          >
            게시 다시 시도
          </button>
          <button
            type="button"
            className="planning-workflow-button quiet"
            disabled={actionsDisabled}
            onClick={() => void cancel()}
          >
            계획 취소
          </button>
        </div>
        {error === null ? null : (
          <p className="planning-workflow-error" role="alert">
            {error}
          </p>
        )}
      </section>
    );
  }

  if (snapshot.state !== 'awaiting_approval') {
    const stateCopy = {
      approved: ['승인됨', '정확히 승인된 계획의 실행을 준비하고 있어요.'],
      executing: ['실행 중', '승인된 revision만 새 실행에 고정되어 있습니다.'],
      completed: ['실행 완료', '승인된 계획 실행이 완료되었습니다.'],
      execution_failed: [
        '실행 실패',
        '승인된 revision은 보존되었고 실행은 실패로 기록되었습니다.',
      ],
    } as const;
    const copy = stateCopy[snapshot.state];
    // 진행 중인 계획은 치울 수 없다 — 실행이 끝난 기록만 사용자가 정리한다.
    const dismissible =
      onDismiss !== undefined &&
      (snapshot.state === 'completed' || snapshot.state === 'execution_failed');
    return (
      <section className="planning-workflow-card" aria-label="계획 워크플로">
        <div className="planning-workflow-card-header">
          <div>
            <strong>{copy[0]}</strong>
            <p>{copy[1]}</p>
          </div>
          <span className="planning-workflow-state">{snapshot.state}</span>
          {dismissible ? (
            <button
              type="button"
              className="planning-workflow-dismiss"
              title="이 기록을 화면에서 치우기"
              aria-label={`${copy[0]} 기록 치우기`}
              onClick={onDismiss}
            >
              <PlanningWorkflowDismissIcon />
            </button>
          ) : null}
        </div>
        <code className="planning-workflow-stamp">{stamp}</code>
        {snapshot.state === 'execution_failed' ? (
          <>
            <div className="planning-workflow-actions">
              <button
                type="button"
                className="planning-workflow-button primary"
                disabled={actionsDisabled}
                onClick={() =>
                  void submit({ kind: 'retry_execution', ...target })
                }
              >
                {pendingCommand === 'retry_execution'
                  ? '다시 실행하는 중…'
                  : '이 계획 다시 실행'}
              </button>
            </div>
            {error === null ? null : (
              <p className="planning-workflow-error" role="alert">
                {error}
              </p>
            )}
          </>
        ) : null}
      </section>
    );
  }

  const fileReferences = collectPlanFileReferences(snapshot.draft);
  const planCardTitle = resolvePlanCardTitle(
    snapshot.draft.outcome,
    fileReferences,
  );

  return (
    <section className="planning-workflow-card" aria-label="계획 승인">
      <div className="planning-workflow-card-header">
        <div className="planning-workflow-card-copy">
          <strong className="planning-workflow-card-title">
            {planCardTitle}
          </strong>
          <p>
            {visualAwaitingDiagram
              ? '그림을 준비하는 동안에도 계획을 검토·수정·취소할 수 있습니다.'
              : '아래 내용과 digest가 함께 승인됩니다.'}
          </p>
        </div>
        <span className="planning-workflow-state">
          {visualAwaitingDiagram ? '그림 준비' : '승인 대기'}
        </span>
      </div>

      {fileReferences.length === 0 ? null : (
        <div className="planning-workflow-targets" aria-label="관련 파일">
          <span>관련 파일</span>
          {fileReferences.map((reference) => (
            <code key={reference} title={reference}>
              {reference.split('/').at(-1)}
            </code>
          ))}
        </div>
      )}

      {visualization === null ? (
        snapshot.intensity === 'visual' ? (
          <p className="planning-workflow-note" role="status">
            {workflow.busy || visualRequestPending
              ? '관계 그림을 그리는 중… 완성되면 이 카드 맨 위에 표시됩니다.'
              : '그림이 아직 없어요. 텍스트 계획을 검토하거나 그림을 다시 요청할 수 있습니다.'}
          </p>
        ) : null
      ) : (
        <div className="planning-workflow-visualization">
          <div
            className="planning-workflow-visualization-preview"
            aria-hidden="true"
            inert
          >
            <VisualizeWidget
              view={visualization}
              planningWorkflowSnapshot={snapshot}
              playback="instant"
            />
          </div>
          <button
            ref={visualOpenButtonRef}
            type="button"
            className="planning-workflow-visualization-open"
            aria-haspopup="dialog"
            onClick={() => setVisualExpanded(true)}
          >
            <span>{visualization.title ?? '계획 관계도'}</span>
            <strong>크게 보기</strong>
          </button>
        </div>
      )}

      {visualization !== null && visualExpanded ? (
        <div className="planning-workflow-visual-dialog" role="presentation">
          <button
            type="button"
            className="planning-workflow-visual-dialog-backdrop"
            aria-label="계획 그림 크게 보기 닫기"
            onClick={closeExpandedVisualization}
          />
          <section
            className="planning-workflow-visual-dialog-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby={visualDialogTitleId}
          >
            <header className="planning-workflow-visual-dialog-header">
              <div>
                <span>계획 그림</span>
                <strong id={visualDialogTitleId}>{planCardTitle}</strong>
              </div>
              <button
                ref={visualCloseButtonRef}
                type="button"
                aria-label="계획 그림 크게 보기 닫기 (Esc)"
                onClick={closeExpandedVisualization}
              >
                ✕
              </button>
            </header>
            <div className="planning-workflow-visual-dialog-body">
              <VisualizeWidget
                view={visualization}
                planningWorkflowSnapshot={snapshot}
                playback="instant"
                {...(onWidgetPrompt === undefined ? {} : { onWidgetPrompt })}
                {...(onWidgetToolRequest === undefined
                  ? {}
                  : { onWidgetToolRequest })}
              />
            </div>
          </section>
        </div>
      ) : null}

      <details className="planning-workflow-details planning-workflow-plan-details">
        <summary>계획 단계 {snapshot.draft.steps.length}개</summary>
        <ol className="planning-workflow-steps">
          {snapshot.draft.steps.map((step) => (
            <li key={step.id}>
              <span>{step.text}</span>
              {step.acceptanceCriteria.length === 0 ? null : (
                <ul>
                  {step.acceptanceCriteria.map((criterion) => (
                    <li key={criterion}>{criterion}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      </details>

      {snapshot.draft.assumptions.length === 0 ? null : (
        <details className="planning-workflow-details">
          <summary>가정 {snapshot.draft.assumptions.length}개</summary>
          <ul>
            {snapshot.draft.assumptions.map((assumption) => (
              <li key={assumption}>{assumption}</li>
            ))}
          </ul>
        </details>
      )}

      {snapshot.draft.openQuestions.length === 0 ? null : (
        <div className="planning-workflow-open-questions">
          <strong>열린 질문</strong>
          <ul>
            {snapshot.draft.openQuestions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        </div>
      )}

      <code className="planning-workflow-stamp" title={snapshot.digest}>
        {stamp}
      </code>

      <label className="planning-workflow-feedback">
        <span>수정 요청</span>
        <textarea
          value={feedback}
          disabled={planEditActionsDisabled}
          placeholder="바꿔야 할 점을 적어주세요."
          onChange={(event) => setFeedback(event.target.value)}
        />
      </label>

      <div className="planning-workflow-actions">
        <button
          type="button"
          className="planning-workflow-button primary"
          disabled={approveDisabled}
          title={
            visualAwaitingDiagram
              ? '그림이 준비된 뒤에 승인할 수 있습니다.'
              : undefined
          }
          onClick={() => void submit({ kind: 'approve', ...target })}
        >
          이 계획 승인
        </button>
        <button
          type="button"
          className="planning-workflow-button"
          disabled={planEditActionsDisabled}
          onClick={() =>
            void submit({
              kind: 'request_revision',
              ...target,
              ...(feedback.trim() === '' ? {} : { feedback: feedback.trim() }),
            })
          }
        >
          수정 요청
        </button>
        {snapshot.intensity === 'visual' ? (
          <button
            type="button"
            className="planning-workflow-button"
            disabled={actionsDisabled}
            onClick={() => {
              // 수동 재시도는 같은 revision에 다시 그림을 요청할 수 있게 키를 연다.
              autoExplainKeyRef.current = null;
              void requestVisualization();
            }}
          >
            {workflow.busy || visualRequestPending
              ? '그림을 만들고 있어요…'
              : visualization === null
                ? '그림으로 설명'
                : '그림 다시 만들기'}
          </button>
        ) : null}
        <button
          type="button"
          className="planning-workflow-button quiet"
          disabled={planEditActionsDisabled}
          onClick={() => void cancel()}
        >
          취소
        </button>
      </div>

      {workflow.busy || visualRequestPending ? (
        <p className="planning-workflow-note">
          {snapshot.intensity === 'visual'
            ? '그림을 만드는 동안에도 수정 요청을 적거나 계획을 취소할 수 있습니다.'
            : '현재 계획 턴이 정리되면 버튼이 다시 열립니다.'}
        </p>
      ) : null}
      {error === null ? null : (
        <p className="planning-workflow-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
