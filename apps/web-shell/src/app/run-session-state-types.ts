import type {
  ArtifactRef,
  ThreadArtifactVersion,
} from '@geulbat/protocol/artifacts';
import type { ApprovalRequired } from '@geulbat/protocol/run-approval';
import type {
  ContextUsageUpdatedEventPayload,
  RunUsageTotals,
} from '@geulbat/protocol/run-events';
import type { RunTranscriptEntry } from '../lib/run-transcript-entry.js';

export type PendingApprovalIdentity = Pick<
  ApprovalRequired,
  'callId' | 'runId' | 'threadId'
>;

export type BackgroundNotificationEntry = Extract<
  RunTranscriptEntry,
  { kind: 'subagent_activity' }
>;

export interface ActiveRunViewState {
  threadId: string | null;
  runId: string | null;
  transcriptEntries: RunTranscriptEntry[];
  finalAnswerText: string;
  artifactsByRef: Record<string, ThreadArtifactVersion>;
  activeArtifactRef: ArtifactRef | null;
  pendingApproval: ApprovalRequired | null;
  pendingApprovals: ApprovalRequired[];
  // 대기 중 스티어 큐 — 모델이 소비하기 전의 mid-run 입력들
  pendingSteers: PendingSteer[];
  // 즉시 반영 요청됨 — 다음 소비까지 UI 힌트를 바꾸고 버튼을 잠근다
  pendingSteerFlushRequested: boolean;
  // 런 누적 토큰 사용량 — usage_updated 이벤트로 라운드마다 갱신
  usageTotals: RunUsageTotals | null;
  // 스트리밍 중인 도구 호출 인자 (tool_call_delta 누적) — 완성본
  // tool_call이 도착하면 비워진다
  streamingToolCall: { callId: string; tool: string; argsText: string } | null;
  streamError: string | null;
}

export interface PendingSteer {
  receivedSeq: number;
  text: string;
}

export type RunSessionPhase =
  | 'idle'
  | 'starting'
  | 'running'
  | 'settling'
  | 'error';

export type BackgroundNotificationsByThread = Record<
  string,
  BackgroundNotificationEntry[]
>;

export interface RunSessionState {
  phase: RunSessionPhase;
  pendingStartThreadId: string | null;
  activeRunView: ActiveRunViewState;
  sessionError: string | null;
  backgroundNotificationsByThread: BackgroundNotificationsByThread;
  contextUsageByThread: Record<string, ContextUsageUpdatedEventPayload>;
}

export interface VisibleRunState {
  visibleThreadId: string | null;
  activeRunId: string | null;
  transcriptEntries: RunTranscriptEntry[];
  finalAnswerText: string;
  activeArtifact: ThreadArtifactVersion | null;
  pendingApproval: ApprovalRequired | null;
  pendingSteers: PendingSteer[];
  pendingSteerFlushRequested: boolean;
  usageTotals: RunUsageTotals | null;
  contextUsage: ContextUsageUpdatedEventPayload | null;
  streamError: string | null;
  backgroundNotifications: BackgroundNotificationEntry[];
  isRunning: boolean;
  isSettling: boolean;
}

type AssistantTextStreamTarget = 'transcript' | 'answer';

export type RunSessionStateAction =
  | { type: 'run_start_requested'; threadId: string | null }
  | { type: 'run_started'; threadId: string; runId: string }
  | {
      type: 'assistant_text_streamed';
      threadId: string;
      target: AssistantTextStreamTarget;
      text: string;
    }
  | {
      type: 'artifact_activated';
      threadId: string;
      artifact: ThreadArtifactVersion;
    }
  | {
      type: 'transcript_activity_added';
      threadId: string;
      entry: Exclude<RunTranscriptEntry, { kind: 'assistant_text' }>;
      // 이 완성본이 닫는 스트리밍 도구 호출 (tool_call 이벤트의 callId)
      streamedToolCallId?: string;
    }
  | {
      type: 'tool_call_args_streamed';
      threadId: string;
      callId: string;
      tool: string;
      argsDelta: string;
    }
  | {
      type: 'approval_requested';
      threadId: string;
      pendingApproval: ApprovalRequired;
    }
  | { type: 'run_usage_updated'; threadId: string; usage: RunUsageTotals }
  | {
      type: 'run_context_usage_updated';
      threadId: string;
      contextUsage: ContextUsageUpdatedEventPayload;
    }
  | {
      type: 'run_terminal';
      runId: string;
      threadId: string;
      ok: boolean;
    }
  | { type: 'steer_queued'; threadId: string; steer: PendingSteer }
  | { type: 'steer_applied'; threadId: string; receivedSeqs: number[] }
  | { type: 'steer_cancelled'; receivedSeq: number }
  | { type: 'steer_flush_requested' }
  | {
      type: 'subagent_activity_added';
      threadId: string;
      entry: BackgroundNotificationEntry;
    }
  | { type: 'run_settle_sync_started' }
  | { type: 'run_settled_success' }
  | { type: 'run_settle_sync_failed'; threadId: string; message: string }
  | { type: 'run_settled_error'; threadId: string; message: string }
  | { type: 'run_transport_error'; message: string }
  | { type: 'session_error_recorded'; message: string }
  | { type: 'session_error_cleared' }
  | { type: 'run_start_failed'; message: string }
  | { type: 'approval_submit_failed'; message: string }
  | { type: 'approval_cleared'; pendingApproval?: PendingApprovalIdentity }
  | { type: 'run_start_cancelled' };

export function createEmptyActiveRunView(
  threadId: string | null = null,
): ActiveRunViewState {
  return {
    threadId,
    runId: null,
    transcriptEntries: [],
    finalAnswerText: '',
    artifactsByRef: {},
    activeArtifactRef: null,
    pendingApproval: null,
    pendingApprovals: [],
    pendingSteers: [],
    pendingSteerFlushRequested: false,
    usageTotals: null,
    streamingToolCall: null,
    streamError: null,
  };
}
