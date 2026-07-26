import { isRecord } from '../../../lib/json.js';
import type { ThreadMessage } from '@geulbat/protocol/threads';

import type { RunTranscriptEntry } from '../../../lib/run-transcript-entry.js';

// 진행 상황 체크리스트 — update_plan은 매 호출이 전체 계획을 교체하므로
// 스레드에서 가장 최근 update_plan 호출의 args가 곧 현재 진행 상황이다.
// 데몬 상태를 다시 묻지 않고 트랜스크립트에서 파생한다.
export const UPDATE_PLAN_TOOL_NAME = 'update_plan';

type RunPlanStepStatus = 'pending' | 'in_progress' | 'completed';

export interface RunPlanStep {
  step: string;
  status: RunPlanStepStatus;
}

interface RunPlanHistory {
  plansByRunId: ReadonlyMap<string, RunPlanStep[]>;
  pendingPlan: RunPlanStep[] | null;
}

export function readRunPlanFromToolArgs(args: unknown): RunPlanStep[] | null {
  if (!isRecord(args) || !Array.isArray(args.plan)) {
    return null;
  }
  const steps: RunPlanStep[] = [];
  for (const item of args.plan) {
    if (!isRecord(item)) {
      return null;
    }
    const step = typeof item.step === 'string' ? item.step.trim() : '';
    if (step === '' || !isRunPlanStepStatus(item.status)) {
      return null;
    }
    steps.push({ step, status: item.status });
  }
  return steps.length > 0 ? steps : null;
}

export function readRunPlanFromToolCallContent(
  content: string,
): RunPlanStep[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.tool !== UPDATE_PLAN_TOOL_NAME) {
    return null;
  }
  return readRunPlanFromToolArgs(parsed.args);
}

// update_plan 호출은 별도 run id를 갖지 않으므로, 순서상 뒤따르는 최종
// 답변의 sourceRunId에 최신 계획을 귀속한다. 새 일반 사용자 턴과 최종
// 답변은 pending 계획의 경계이고, 실행 중 interject는 같은 run이므로
// 경계를 만들지 않는다.
export function resolveRunPlanHistory(
  messages: readonly ThreadMessage[],
): RunPlanHistory {
  const plansByRunId = new Map<string, RunPlanStep[]>();
  let pendingPlan: RunPlanStep[] | null = null;

  for (const message of messages) {
    if (message.role === 'user' && message.metadata?.source !== 'interject') {
      pendingPlan = null;
      continue;
    }

    if (
      message.role === 'tool_call' &&
      message.content.includes('"tool":"update_plan"')
    ) {
      const plan = readRunPlanFromToolCallContent(message.content);
      if (plan !== null) {
        pendingPlan = plan;
      }
      continue;
    }

    if (
      message.role === 'assistant' &&
      message.metadata?.phase === 'final_answer'
    ) {
      const sourceRunId = message.metadata.sourceRunId;
      if (sourceRunId !== undefined && pendingPlan !== null) {
        plansByRunId.set(sourceRunId, pendingPlan);
      }
      if (
        pendingPlan === null ||
        pendingPlan.every((step) => step.status === 'completed')
      ) {
        pendingPlan = null;
      }
    }
  }

  return { plansByRunId, pendingPlan };
}

// 라이브 엔트리(최신) → settled 메시지 순으로 뒤에서부터 훑어 가장 최근
// 계획을 찾는다.
export function resolveLatestRunPlan(args: {
  messages: readonly ThreadMessage[];
  transcriptEntries: readonly RunTranscriptEntry[];
}): RunPlanStep[] | null {
  for (let index = args.transcriptEntries.length - 1; index >= 0; index -= 1) {
    const entry = args.transcriptEntries[index];
    if (
      entry?.kind === 'tool_activity' &&
      entry.tool === UPDATE_PLAN_TOOL_NAME &&
      entry.args !== undefined
    ) {
      const plan = readRunPlanFromToolArgs(entry.args);
      if (plan !== null) {
        return plan;
      }
    }
  }

  return resolveRunPlanHistory(args.messages).pendingPlan;
}

function isRunPlanStepStatus(value: unknown): value is RunPlanStepStatus {
  return (
    value === 'pending' || value === 'in_progress' || value === 'completed'
  );
}
