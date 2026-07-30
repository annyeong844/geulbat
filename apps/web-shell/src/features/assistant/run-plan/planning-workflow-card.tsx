import { useCallback, useEffect, useId, useRef, useState } from 'react';

import type {
  PlanDraftV1,
  PlanningWorkflowSnapshot,
  PlanWorkflowCommand,
} from '@geulbat/protocol/planning-workflow';
import type { ThreadMessage } from '@geulbat/protocol/threads';
import {
  readAskUserCardViewFromToolCallContent,
  type AskUserPurpose,
} from '../ask-user/ask-user-card-view.js';
import {
  VisualizeWidget,
  type WidgetToolRequestHandler,
} from '../visualize/visualize-widget.js';
import type { VisualizePlanStepState } from '../../artifacts/runtime-preview/visualize/document.js';
import type { VisualizeWidgetView } from '../visualize/visualize-widget-view.js';
import type { RunPlanStep } from './run-plan.js';

export interface AssistantPlanningWorkflow {
  snapshot: PlanningWorkflowSnapshot;
  busy: boolean;
  onCommand: (command: PlanWorkflowCommand) => Promise<void>;
}

export interface PlanningInterviewDecision {
  purpose: AskUserPurpose;
  question: string;
  answer: string;
}

export function resolvePlanningInterviewDecisions(
  messages: readonly ThreadMessage[],
  workflowCreatedAt: string,
): PlanningInterviewDecision[] {
  const decisions: PlanningInterviewDecision[] = [];
  let pendingQuestion: {
    purpose: AskUserPurpose;
    question: string;
  } | null = null;

  for (const message of messages) {
    if (message.timestamp < workflowCreatedAt) {
      continue;
    }
    if (message.role === 'tool_call') {
      const view = readAskUserCardViewFromToolCallContent(message.content);
      if (view !== null) {
        pendingQuestion = {
          purpose: view.purpose,
          question: view.question,
        };
      }
      continue;
    }
    if (message.role !== 'user' || pendingQuestion === null) {
      continue;
    }
    const answer = message.content.trim();
    if (answer !== '') {
      decisions.push({
        purpose: pendingQuestion.purpose,
        question: pendingQuestion.question,
        answer,
      });
      pendingQuestion = null;
    }
  }

  return decisions;
}

interface PlanningRevisionChange {
  kind: 'added' | 'removed' | 'changed';
  label: string;
}

function resolvePlanningRevisionSummary(
  previous: PlanDraftV1,
  current: PlanDraftV1,
): PlanningRevisionChange[] {
  const changes: PlanningRevisionChange[] = [];
  if (previous.outcome !== current.outcome) {
    changes.push({
      kind: 'changed',
      label: `목표: ${previous.outcome} → ${current.outcome}`,
    });
  }

  const previousSteps = new Map(previous.steps.map((step) => [step.id, step]));
  const currentSteps = new Map(current.steps.map((step) => [step.id, step]));
  for (const step of current.steps) {
    const prior = previousSteps.get(step.id);
    if (prior === undefined) {
      changes.push({ kind: 'added', label: `단계 추가: ${step.text}` });
    } else if (
      prior.text !== step.text ||
      prior.acceptanceCriteria.length !== step.acceptanceCriteria.length ||
      prior.acceptanceCriteria.some(
        (criterion, index) => step.acceptanceCriteria[index] !== criterion,
      )
    ) {
      changes.push({ kind: 'changed', label: `단계 수정: ${step.text}` });
    }
  }
  for (const step of previous.steps) {
    if (!currentSteps.has(step.id)) {
      changes.push({ kind: 'removed', label: `단계 제외: ${step.text}` });
    }
  }

  const listChanges = (
    before: readonly string[],
    after: readonly string[],
    labels: { added: string; removed: string },
  ) => {
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    for (const value of after) {
      if (!beforeSet.has(value)) {
        changes.push({ kind: 'added', label: `${labels.added}: ${value}` });
      }
    }
    for (const value of before) {
      if (!afterSet.has(value)) {
        changes.push({ kind: 'removed', label: `${labels.removed}: ${value}` });
      }
    }
  };

  listChanges(
    previous.decisions.map(
      (decision) => `${decision.settledBy}:${decision.text}`,
    ),
    current.decisions.map(
      (decision) => `${decision.settledBy}:${decision.text}`,
    ),
    { added: '선택 추가', removed: '선택 제외' },
  );
  listChanges(previous.assumptions, current.assumptions, {
    added: '가정 추가',
    removed: '가정 제외',
  });
  listChanges(previous.openQuestions, current.openQuestions, {
    added: '열린 질문 추가',
    removed: '열린 질문 해결',
  });

  return changes.map((change) => ({
    ...change,
    label: change.label.replace(
      /^(선택 (?:추가|제외)): (?:user|agent):/u,
      '$1: ',
    ),
  }));
}

function isVisualizationBoundToDraft(
  visualization: VisualizeWidgetView,
  draft: PlanDraftV1,
): boolean {
  return (
    visualization.planStepIds !== undefined &&
    visualization.planStepIds.length === draft.steps.length &&
    visualization.planStepIds.every(
      (stepId, index) => stepId === draft.steps[index]?.id,
    )
  );
}

function resolveVisualPlanStepStates(
  draft: PlanDraftV1,
  workflowState: PlanningWorkflowSnapshot['state'],
  executionPlan: readonly RunPlanStep[] | null,
): VisualizePlanStepState[] {
  const executionStatuses = new Map(
    (executionPlan ?? []).flatMap((step) =>
      step.id === undefined ? [] : [[step.id, step.status] as const],
    ),
  );
  return draft.steps.map((step) => {
    const executionStatus = executionStatuses.get(step.id) ?? 'pending';
    const status: VisualizePlanStepState['status'] =
      workflowState === 'completed'
        ? 'completed'
        : workflowState === 'execution_failed' &&
            executionStatus !== 'completed'
          ? 'failed'
          : executionStatus;
    return { id: step.id, status };
  });
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

function PlanningWorkflowVisualPreparing({
  decisionCount,
  stepCount,
  outcome,
  busy,
}: {
  decisionCount: number;
  stepCount: number;
  outcome: string;
  busy: boolean;
}) {
  return (
    <section
      className={`planning-workflow-visual-preparing${busy ? ' is-busy' : ''}`}
      role="status"
      aria-label="계획 관계도 준비 중"
    >
      <header>
        <span aria-hidden="true">✦</span>
        <strong>결정에서 목표까지 연결하는 중</strong>
      </header>
      <div className="planning-workflow-visual-preparing-rail">
        <div className="planning-workflow-visual-preparing-node decisions">
          <span>확정한 선택</span>
          <strong>{decisionCount}개</strong>
        </div>
        <span
          className="planning-workflow-visual-preparing-connector"
          aria-hidden="true"
        >
          →
        </span>
        <div className="planning-workflow-visual-preparing-node steps">
          <span>실행 단계</span>
          <strong>{stepCount}개</strong>
        </div>
        <span
          className="planning-workflow-visual-preparing-connector"
          aria-hidden="true"
        >
          →
        </span>
        <div className="planning-workflow-visual-preparing-node outcome">
          <span>도달할 목표</span>
          <strong>{outcome}</strong>
        </div>
      </div>
      <p>
        {busy
          ? '정규 계획의 실제 내용을 먼저 보여드리고, 완성된 관계도로 곧 교체합니다.'
          : '정규 계획은 그대로 검토할 수 있어요. 풍부한 관계도는 다시 요청할 수 있습니다.'}
      </p>
    </section>
  );
}

export function PlanningWorkflowCard({
  workflow,
  visualization: visualizationInput = null,
  executionPlan = null,
  interviewDecisions = [],
  onWidgetPrompt,
  onWidgetToolRequest,
  onDismiss,
}: {
  workflow: AssistantPlanningWorkflow;
  visualization?: VisualizeWidgetView | null;
  executionPlan?: readonly RunPlanStep[] | null;
  interviewDecisions?: readonly PlanningInterviewDecision[];
  onWidgetPrompt?: (prompt: string) => Promise<void> | void;
  onWidgetToolRequest?: WidgetToolRequestHandler;
  onDismiss?: () => void;
}) {
  const { snapshot } = workflow;
  const visualization =
    visualizationInput !== null &&
    snapshot.state !== 'collecting' &&
    isVisualizationBoundToDraft(visualizationInput, snapshot.draft)
      ? visualizationInput
      : null;
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
    if (workflow.busy && interviewDecisions.length === 0) {
      return null;
    }
    const understandingConfirmed = interviewDecisions.some(
      (decision) => decision.purpose === 'understanding_confirmation',
    );
    return (
      <section
        className={`planning-workflow-collecting-control${
          interviewDecisions.length === 0 ? '' : ' has-decisions'
        }${workflow.busy ? ' is-busy' : ''}`}
        aria-label="진행 중인 계획 워크플로"
      >
        <div className="planning-workflow-collecting-summary">
          {workflow.busy && interviewDecisions.length > 0 ? (
            <span
              className="planning-workflow-collecting-spark"
              aria-hidden="true"
            >
              ✦
            </span>
          ) : null}
          <span className="planning-workflow-collecting-mode">
            {interviewDecisions.length === 0
              ? snapshot.depth === 'deep'
                ? '심층 계획 진행 중'
                : '일반 계획 진행 중'
              : understandingConfirmed
                ? '목표 이해 확인'
                : snapshot.depth === 'deep'
                  ? '심층 인터뷰'
                  : '계획 확인'}
          </span>
          {interviewDecisions.length === 0 ? null : (
            <details className="planning-workflow-interview-ledger">
              <summary>
                {understandingConfirmed ? '확인한 내용' : '확정한 선택'}{' '}
                {interviewDecisions.length}개
              </summary>
              <ol>
                {interviewDecisions.map((decision, index) => (
                  <li
                    key={`${decision.question}:${index}`}
                    className={
                      decision.purpose === 'understanding_confirmation'
                        ? 'is-understanding-confirmation'
                        : undefined
                    }
                  >
                    {decision.purpose === 'understanding_confirmation' ? (
                      <small>제가 이해한 목표</small>
                    ) : null}
                    <span>{decision.question}</span>
                    <strong>{decision.answer}</strong>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </div>
        {workflow.busy ? null : (
          <button
            type="button"
            className="planning-workflow-collecting-cancel"
            disabled={actionsDisabled}
            onClick={() => void cancel()}
          >
            계획 취소
          </button>
        )}
        {error === null ? null : (
          <p className="planning-workflow-error" role="alert">
            {error}
          </p>
        )}
      </section>
    );
  }

  const planStepStates = resolveVisualPlanStepStates(
    snapshot.draft,
    snapshot.state,
    executionPlan,
  );
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
        {visualization === null ? null : (
          <div className="planning-workflow-visualization">
            <VisualizeWidget
              view={visualization}
              planningWorkflowSnapshot={snapshot}
              planStepStates={planStepStates}
              playback="instant"
              {...(onWidgetPrompt === undefined ? {} : { onWidgetPrompt })}
              {...(onWidgetToolRequest === undefined
                ? {}
                : { onWidgetToolRequest })}
            />
          </div>
        )}
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
        {visualization === null ? null : (
          <div className="planning-workflow-visualization">
            <VisualizeWidget
              view={visualization}
              planningWorkflowSnapshot={snapshot}
              planStepStates={planStepStates}
              playback="instant"
              {...(onWidgetPrompt === undefined ? {} : { onWidgetPrompt })}
              {...(onWidgetToolRequest === undefined
                ? {}
                : { onWidgetToolRequest })}
            />
          </div>
        )}
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
  const revisionChanges =
    snapshot.supersededPlan === undefined
      ? null
      : resolvePlanningRevisionSummary(
          snapshot.supersededPlan.draft,
          snapshot.draft,
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

      {snapshot.draft.decisions.length === 0 ? null : (
        <section
          className="planning-workflow-decision-ledger"
          aria-label="승인에 포함된 선택"
        >
          <header>
            <span>승인에 포함된 선택</span>
            <strong>{snapshot.draft.decisions.length}</strong>
          </header>
          <ol>
            {snapshot.draft.decisions.map((decision, index) => (
              <li key={`${decision.text}:${index}`}>
                <span
                  className={`planning-workflow-decision-source ${decision.settledBy}`}
                >
                  {decision.settledBy === 'user'
                    ? '사용자 선택'
                    : '에이전트 판단'}
                </span>
                <span>{decision.text}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {revisionChanges === null ? null : (
        <details className="planning-workflow-revision-summary">
          <summary>
            <span>
              이전 계획에서 달라진 점 · r{snapshot.supersededPlan?.revision} → r
              {snapshot.revision}
            </span>
            <strong>
              {revisionChanges.length === 0
                ? '내용 변경 없음'
                : `${revisionChanges.length}개`}
            </strong>
          </summary>
          {revisionChanges.length === 0 ? (
            <p>
              다시 제안된 내용은 이전 revision과 같습니다. 승인 전에 수정 요청이
              반영되었는지 확인해 주세요.
            </p>
          ) : (
            <ul>
              {revisionChanges.map((change, index) => (
                <li
                  key={`${change.kind}:${change.label}:${index}`}
                  className={change.kind}
                >
                  <span aria-hidden="true">
                    {change.kind === 'added'
                      ? '+'
                      : change.kind === 'removed'
                        ? '−'
                        : '↻'}
                  </span>
                  <span>{change.label}</span>
                </li>
              ))}
            </ul>
          )}
        </details>
      )}

      {visualization === null ? (
        snapshot.intensity === 'visual' ? (
          <PlanningWorkflowVisualPreparing
            decisionCount={snapshot.draft.decisions.length}
            stepCount={snapshot.draft.steps.length}
            outcome={planCardTitle}
            busy={workflow.busy || visualRequestPending}
          />
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
              planStepStates={planStepStates}
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
                <p>
                  그림의 항목을 누르면 계획은 그대로 둔 채 그 부분을 더 물어볼
                  수 있어요.
                </p>
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
                planStepStates={planStepStates}
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
