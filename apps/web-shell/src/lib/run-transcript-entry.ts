import type { ApprovalRequired } from '@geulbat/protocol/run-approval';
import type {
  RunUsageTotals,
  SubagentCapability,
  SubagentRuntimeDiagnostics,
  SubagentToolSurfaceProfile,
  SubagentType,
} from '@geulbat/protocol/run-events';
import type {
  AgentChildTerminalReason,
  AgentChildTerminalState,
} from '@geulbat/protocol/subagent-terminal';
import type { RunReasoningEffort } from '@geulbat/protocol/run-contract';

type ToolActivityState = 'running' | 'completed' | 'failed';
export interface ToolActivityOutput {
  stdout: string;
  stderr: string;
}

type SubagentActivityState =
  | 'spawned'
  | 'approval_required'
  | AgentChildTerminalState;

interface SubagentActivityEntry {
  kind: 'subagent_activity';
  // 원래 top-level run 답변 옆에 background completion을 다시 배치한다.
  parentRunId?: string;
  childRunId: string;
  // Present when the source event carried it — enables child session drill-down.
  childThreadId?: string;
  subagentType: SubagentType;
  capabilities?: readonly SubagentCapability[];
  toolSurface?: SubagentToolSurfaceProfile;
  runtime?: SubagentRuntimeDiagnostics;
  state: SubagentActivityState;
  deliveryId?: string;
  reason?: AgentChildTerminalReason;
  result?: string;
  resultRef?: string;
  resultDigest?: `sha256:${string}`;
  completedAt?: string;
  // Terminal-only drill-down telemetry from subagent_terminal.
  elapsedMs?: number;
  usage?: RunUsageTotals;
  // 차일드 런이 호출한 모델 정체 — spawned/terminal 이벤트가 실어 준다
  modelId?: string;
  reasoningEffort?: RunReasoningEffort;
}

export type RunTranscriptEntry =
  | { kind: 'assistant_text'; text: string }
  // 스티어가 모델에 주입된 순간 대화에 합류한 사용자 발화
  | { kind: 'user_text'; text: string }
  // args는 호출 인자가 곧 렌더 원본인 도구(visualize)만 실어 온다 —
  // 일반 도구는 상태 요약 행만 그리므로 인자를 상태에 들고 있지 않는다.
  | {
      kind: 'tool_activity';
      tool: string;
      state: ToolActivityState;
      ptcStatus?:
        | 'queued'
        | 'running'
        | 'completed'
        | 'failed'
        | 'terminated'
        | 'completed_with_cleanup_failure'
        | 'terminated_with_cleanup_failure'
        | 'missing'
        | 'expired'
        | 'resource_budget_unavailable'
        | 'resource_budget_insufficient';
      callId?: string;
      args?: Record<string, unknown>;
      // 스트리밍 중인 도구 인자 원문(JSON 텍스트) — visualize 실시간 렌더용
      argsText?: string;
      // 현재 라이브 실행의 즉시 피드백만 담는다. 정본과 재접속 복구는
      // 최종 tool_result가 계속 담당한다.
      output?: ToolActivityOutput;
    }
  | { kind: 'approval_request'; pendingApproval: ApprovalRequired }
  | SubagentActivityEntry;

export function appendSubagentTranscriptEntry(
  entries: RunTranscriptEntry[],
  entry: Extract<RunTranscriptEntry, { kind: 'subagent_activity' }>,
): RunTranscriptEntry[] {
  const alreadyPresent =
    entry.deliveryId !== undefined &&
    entries.some(
      (existing) =>
        existing.kind === 'subagent_activity' &&
        existing.deliveryId === entry.deliveryId,
    );
  if (alreadyPresent) {
    return entries;
  }
  let existingChildIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const existing = entries[index];
    if (
      existing?.kind === 'subagent_activity' &&
      existing.childRunId === entry.childRunId
    ) {
      existingChildIndex = index;
      break;
    }
  }
  if (existingChildIndex !== -1) {
    return entries.map((existing, index) =>
      index === existingChildIndex && existing.kind === 'subagent_activity'
        ? { ...existing, ...entry }
        : existing,
    );
  }
  return [...entries, entry];
}
