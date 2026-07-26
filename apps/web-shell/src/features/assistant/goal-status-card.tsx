import { useState } from 'react';
import type { GoalCommand, GoalSnapshot } from '@geulbat/protocol/goal';

export interface AssistantGoal {
  snapshot: GoalSnapshot;
  busy: boolean;
  onCommand: (command: GoalCommand) => Promise<void> | void;
}

const GOAL_STATE_COPY = {
  working: {
    title: '목표 작업 중',
    description: '목표를 달성하기 위한 작업을 진행하고 있어요.',
  },
  continuing: {
    title: '목표를 계속 진행하고 있어요',
    description: '완료 조건이 남아 있어 다음 작업을 이어갑니다.',
  },
  verifying: {
    title: '완료 확인 중…',
    description: '목표를 실제로 달성했는지 독립적으로 확인하고 있어요.',
  },
  completed: {
    title: '목표 완료',
    description: '완료 조건이 충족된 것으로 확인되었습니다.',
  },
  paused: {
    title: '목표 일시 중단',
    description: '원할 때 같은 목표를 다시 이어갈 수 있어요.',
  },
  verification_unavailable: {
    title: '완료 확인을 다시 시작해 주세요',
    description: '목표는 끝내지 않았으며, 확인을 재개할 수 있어요.',
  },
} as const;

export function GoalStatusCard({ goal }: { goal: AssistantGoal }) {
  const { snapshot } = goal;
  const [pendingCommand, setPendingCommand] = useState<
    GoalCommand['kind'] | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const actionsDisabled = goal.busy || pendingCommand !== null;
  const copy = GOAL_STATE_COPY[snapshot.state];

  const submit = async (kind: GoalCommand['kind']) => {
    setPendingCommand(kind);
    setError(null);
    try {
      await goal.onCommand({
        kind,
        threadId: snapshot.threadId,
        goalId: snapshot.goalId,
      });
    } catch (reason: unknown) {
      setError(
        reason instanceof Error
          ? reason.message
          : '목표 명령을 처리하지 못했습니다.',
      );
    } finally {
      setPendingCommand(null);
    }
  };

  const canPause =
    snapshot.state === 'working' || snapshot.state === 'continuing';
  const canResume =
    snapshot.state === 'paused' ||
    snapshot.state === 'verification_unavailable';
  const canCancel = snapshot.state !== 'completed';

  return (
    <section className="planning-workflow-card" aria-label="목표 상태">
      <div className="planning-workflow-card-header">
        <div>
          <strong>{copy.title}</strong>
          <p>{copy.description}</p>
        </div>
        <span className="planning-workflow-state">Goal</span>
      </div>

      <p>{snapshot.objective}</p>

      {canPause || canResume || canCancel ? (
        <div className="planning-workflow-actions">
          {canPause ? (
            <button
              type="button"
              className="planning-workflow-button"
              disabled={actionsDisabled}
              onClick={() => void submit('pause')}
            >
              목표 일시 중단
            </button>
          ) : null}
          {canResume ? (
            <button
              type="button"
              className="planning-workflow-button primary"
              disabled={actionsDisabled}
              onClick={() => void submit('resume')}
            >
              목표 계속하기
            </button>
          ) : null}
          {canCancel ? (
            <button
              type="button"
              className="planning-workflow-button quiet"
              disabled={actionsDisabled}
              onClick={() => void submit('cancel')}
            >
              목표 취소
            </button>
          ) : null}
        </div>
      ) : null}

      {error === null ? null : (
        <p className="planning-workflow-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
