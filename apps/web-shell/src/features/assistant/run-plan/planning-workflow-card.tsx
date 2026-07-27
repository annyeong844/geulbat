import { useEffect, useRef, useState } from 'react';

import type {
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

export function PlanningWorkflowCard({
  workflow,
  visualization = null,
  onWidgetPrompt,
  onWidgetToolRequest,
}: {
  workflow: AssistantPlanningWorkflow;
  visualization?: VisualizeWidgetView | null;
  onWidgetPrompt?: (prompt: string) => Promise<void> | void;
  onWidgetToolRequest?: WidgetToolRequestHandler;
}) {
  const { snapshot } = workflow;
  const [feedback, setFeedback] = useState('');
  const [pendingCommand, setPendingCommand] = useState<
    PlanWorkflowCommand['kind'] | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const autoExplainKeyRef = useRef<string | null>(null);
  const actionsDisabled = workflow.busy || pendingCommand !== null;
  // visual 강도는 그림을 먼저 보여 준 뒤에만 승인한다 — 텍스트 카드가 앞서 뜨는
  // 흐름을 호스트에서 막는다.
  const visualAwaitingDiagram =
    snapshot.state === 'awaiting_approval' &&
    snapshot.intensity === 'visual' &&
    visualization === null;
  const approveDisabled = actionsDisabled || visualAwaitingDiagram;

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

  useEffect(() => {
    if (
      snapshot.state !== 'awaiting_approval' ||
      snapshot.intensity !== 'visual'
    ) {
      return;
    }
    if (visualization !== null || workflow.busy || pendingCommand !== null) {
      return;
    }
    const planKey = `${snapshot.workflowId}:${snapshot.planId}:${snapshot.revision}:${snapshot.digest}`;
    if (autoExplainKeyRef.current === planKey) {
      return;
    }
    autoExplainKeyRef.current = planKey;
    // 모델이 같은 턴에 visualize를 빠뜨린 경우 호스트가 그림을 먼저 채운다.
    void (async () => {
      setPendingCommand('explain_visual');
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
        setPendingCommand(null);
      }
    })();
  }, [pendingCommand, snapshot, visualization, workflow]);

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
    return (
      <section className="planning-workflow-card" aria-label="계획 워크플로">
        <div className="planning-workflow-card-header">
          <div>
            <strong>{copy[0]}</strong>
            <p>{copy[1]}</p>
          </div>
          <span className="planning-workflow-state">{snapshot.state}</span>
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

  return (
    <section className="planning-workflow-card" aria-label="계획 승인">
      <div className="planning-workflow-card-header">
        <div>
          <strong>{snapshot.draft.outcome}</strong>
          <p>
            {visualAwaitingDiagram
              ? '그림을 먼저 준비한 뒤 승인할 수 있습니다.'
              : '아래 내용과 digest가 함께 승인됩니다.'}
          </p>
        </div>
        <span className="planning-workflow-state">
          {visualAwaitingDiagram ? '그림 준비' : '승인 대기'}
        </span>
      </div>

      {visualization === null ? (
        snapshot.intensity === 'visual' ? (
          <p className="planning-workflow-note" role="status">
            {workflow.busy || pendingCommand === 'explain_visual'
              ? '관계 그림을 그리는 중… 완성되면 이 카드 맨 위에 표시됩니다.'
              : '시각 계획이라 그림이 준비된 뒤에만 승인할 수 있습니다.'}
          </p>
        ) : null
      ) : (
        <div className="planning-workflow-visualization">
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
      )}

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
          disabled={actionsDisabled}
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
          disabled={actionsDisabled}
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
              void submit({ kind: 'explain_visual', ...target });
            }}
          >
            {workflow.busy || pendingCommand === 'explain_visual'
              ? '그림을 만들고 있어요…'
              : visualization === null
                ? '그림으로 설명'
                : '그림 다시 만들기'}
          </button>
        ) : null}
        <button
          type="button"
          className="planning-workflow-button quiet"
          disabled={actionsDisabled}
          onClick={() => void cancel()}
        >
          취소
        </button>
      </div>

      {workflow.busy || pendingCommand === 'explain_visual' ? (
        <p className="planning-workflow-note">
          {snapshot.intensity === 'visual'
            ? '그림이 완성되면 이 승인 카드 맨 위에 바로 표시됩니다.'
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
