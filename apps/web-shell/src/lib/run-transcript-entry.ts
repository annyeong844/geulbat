import type { ApprovalRequired } from '@geulbat/protocol/run-approval';
import type {
  AgentChildTerminalReason,
  AgentChildTerminalState,
  SubagentType,
} from '@geulbat/protocol/run-events';

type ToolActivityState = 'running' | 'completed' | 'failed';
type SubagentActivityState =
  | 'spawned'
  | 'approval_required'
  | AgentChildTerminalState;

interface SubagentActivityEntry {
  kind: 'subagent_activity';
  childRunId: string;
  subagentType: SubagentType;
  state: SubagentActivityState;
  deliveryId?: string;
  reason?: AgentChildTerminalReason;
  result?: string;
}

export type RunTranscriptEntry =
  | { kind: 'assistant_text'; text: string }
  | { kind: 'tool_activity'; tool: string; state: ToolActivityState }
  | { kind: 'approval_request'; pendingApproval: ApprovalRequired }
  | SubagentActivityEntry;
