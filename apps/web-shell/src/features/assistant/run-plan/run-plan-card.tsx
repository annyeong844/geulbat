import type { RunPlanStep } from './run-plan.js';

// 진행 상황 카드 — 디자인개편 참조안의 우측 "진행 상황" 체크리스트를
// 채팅 패널에 얹은 것. 완료 항목은 체크 + 취소선으로 가라앉는다.
export function RunPlanCard(props: {
  plan: RunPlanStep[];
  isRunning: boolean;
}) {
  const { plan, isRunning } = props;
  const completedCount = plan.filter(
    (step) => step.status === 'completed',
  ).length;

  return (
    <details className="run-plan-card" open={isRunning}>
      <summary className="run-plan-summary">
        <span className="run-plan-title">진행 상황</span>
        <span className="run-plan-count">
          {completedCount}/{plan.length}
        </span>
        <span className="run-plan-chevron" aria-hidden="true">
          ⌄
        </span>
      </summary>
      <ul className="run-plan-list">
        {plan.map((step, index) => (
          <li
            key={`${index}:${step.step}`}
            className={`run-plan-item ${step.status}`}
          >
            <span className="run-plan-glyph" aria-hidden="true">
              {step.status === 'completed'
                ? '✓'
                : step.status === 'in_progress'
                  ? '…'
                  : '○'}
            </span>
            <span className="run-plan-step">{step.step}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
