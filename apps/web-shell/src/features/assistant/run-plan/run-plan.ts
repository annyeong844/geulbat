import { isRecord } from '@geulbat/protocol/runtime-utils';
import type { ThreadMessage } from '@geulbat/protocol/threads';

import type { RunTranscriptEntry } from '../../../lib/run-transcript-entry.js';

// 진행 상황 체크리스트 — update_plan은 매 호출이 전체 계획을 교체하므로
// 스레드에서 가장 최근 update_plan 호출의 args가 곧 현재 진행 상황이다.
// 데몬 상태를 다시 묻지 않고 트랜스크립트에서 파생한다.
export const UPDATE_PLAN_TOOL_NAME = 'update_plan';

export type RunPlanStepStatus = 'pending' | 'in_progress' | 'completed';

export interface RunPlanStep {
  step: string;
  status: RunPlanStepStatus;
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

  for (let index = args.messages.length - 1; index >= 0; index -= 1) {
    const message = args.messages[index];
    if (message?.role !== 'tool_call') {
      continue;
    }
    // 긴 스레드에서 매 스트림 이벤트마다 모든 tool_call을 JSON 파싱하지
    // 않도록 문자열 프리필터로 후보만 거른다 (record는 공백 없는 canonical
    // JSON.stringify 산출물이다).
    if (!message.content.includes('"tool":"update_plan"')) {
      continue;
    }
    const plan = readRunPlanFromToolCallContent(message.content);
    if (plan !== null) {
      return plan;
    }
  }

  return null;
}

function isRunPlanStepStatus(value: unknown): value is RunPlanStepStatus {
  return (
    value === 'pending' || value === 'in_progress' || value === 'completed'
  );
}
