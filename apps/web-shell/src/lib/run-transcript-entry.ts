import type { ApprovalRequired } from '@geulbat/protocol/run-approval';
import type {
  AgentChildTerminalReason,
  AgentChildTerminalState,
  RunUsageTotals,
  SubagentType,
} from '@geulbat/protocol/run-events';
import type { RunReasoningEffort } from '@geulbat/protocol/run-contract';

type ToolActivityState = 'running' | 'completed' | 'failed';
type SubagentActivityState =
  | 'spawned'
  | 'approval_required'
  | AgentChildTerminalState;

interface SubagentActivityEntry {
  kind: 'subagent_activity';
  childRunId: string;
  // Present when the source event carried it — enables child session drill-down.
  childThreadId?: string;
  subagentType: SubagentType;
  state: SubagentActivityState;
  deliveryId?: string;
  reason?: AgentChildTerminalReason;
  result?: string;
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
      args?: Record<string, unknown>;
      // 스트리밍 중인 도구 인자 원문(JSON 텍스트) — visualize 실시간 렌더용
      argsText?: string;
    }
  | { kind: 'approval_request'; pendingApproval: ApprovalRequired }
  | SubagentActivityEntry;
