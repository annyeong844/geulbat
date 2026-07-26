import type {
  ArtifactRef,
  ThreadArtifactVersion,
} from '@geulbat/protocol/artifacts';
import type { ApprovalRequired } from '@geulbat/protocol/run-approval';
import type { ErrorCode } from '@geulbat/protocol/errors';
import type {
  ContextUsageUpdatedEventPayload,
  ProviderRuntimeStatusEventPayload,
  RunUsageTotals,
} from '@geulbat/protocol/run-events';
import type { PendingSteer } from '../lib/run-channel/pending-steer.js';
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
  // 실제 provider admission이 대기한 동안만 표시하는 런타임 상태
  providerRuntime: ProviderRuntimeStatusEventPayload | null;
  // 스트리밍 중인 도구 호출 인자 (tool_call_delta 누적) — 완성본
  // tool_call이 도착하면 비워진다
  streamingToolCall: { callId: string; tool: string; argsText: string } | null;
  // 생성 중인 아티팩트 봉투 텍스트 (artifact_stream_delta 누적) — 커밋
  // (artifact_activated)되면 비워지고 중앙 창이 커밋본으로 전환된다
  streamingArtifactText: string;
  streamError: string | null;
  streamErrorCode: ErrorCode | null;
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

export interface RunSessionLaneState {
  phase: RunSessionPhase;
  activeRunView: ActiveRunViewState;
}

export interface RunSessionState {
  phase: RunSessionPhase;
  pendingStartThreadId: string | null;
  activeRunView: ActiveRunViewState;
  runLanesByThread?: Record<string, RunSessionLaneState>;
  newThreadRunLane?: RunSessionLaneState;
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
  // 생성 중인 아티팩트 봉투 라이브 텍스트 — 중앙 창 코드 모드가 소비
  streamingArtifactText: string;
  pendingApproval: ApprovalRequired | null;
  pendingSteers: PendingSteer[];
  pendingSteerFlushRequested: boolean;
  usageTotals: RunUsageTotals | null;
  providerRuntime: ProviderRuntimeStatusEventPayload | null;
  contextUsage: ContextUsageUpdatedEventPayload | null;
  streamError: string | null;
  streamErrorCode: ErrorCode | null;
  backgroundNotifications: BackgroundNotificationEntry[];
  isRunning: boolean;
  isSettling: boolean;
}

type AssistantTextStreamTarget = 'transcript' | 'answer';

export type RunSessionStateAction =
  | { type: 'run_start_requested'; threadId: string | null }
  | { type: 'run_started'; threadId: string; runId: string }
  | { type: 'new_thread_run_adopted'; threadId: string }
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
  | { type: 'artifact_text_streamed'; threadId: string; text: string }
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
      type: 'tool_output_streamed';
      threadId: string;
      callId: string;
      tool: string;
      stream: 'stdout' | 'stderr';
      text: string;
    }
  | {
      type: 'approval_requested';
      threadId: string;
      pendingApproval: ApprovalRequired;
    }
  | {
      type: 'run_usage_updated';
      runId: string;
      threadId: string;
      usage: RunUsageTotals;
    }
  | {
      type: 'run_context_usage_updated';
      threadId: string;
      contextUsage: ContextUsageUpdatedEventPayload;
    }
  | {
      type: 'provider_runtime_updated';
      runId: string;
      threadId: string;
      providerRuntime: ProviderRuntimeStatusEventPayload;
    }
  | {
      type: 'run_terminal';
      runId: string;
      threadId: string;
      ok: boolean;
    }
  | {
      type: 'steer_queued';
      runId: string;
      threadId: string;
      steer: PendingSteer;
    }
  | {
      type: 'steer_applied';
      runId: string;
      threadId: string;
      receivedSeqs: number[];
    }
  | { type: 'steer_cancelled'; runId: string; receivedSeq: number }
  | { type: 'steer_flush_requested'; runId: string }
  | {
      type: 'subagent_activity_added';
      threadId: string;
      entry: BackgroundNotificationEntry;
    }
  | { type: 'run_settle_sync_started'; threadId?: string; runId?: string }
  | { type: 'run_settled_success'; threadId?: string; runId?: string }
  | {
      type: 'run_settle_sync_failed';
      threadId: string;
      runId?: string;
      message: string;
    }
  | {
      type: 'run_settled_error';
      threadId: string;
      runId?: string;
      code: ErrorCode;
      message: string;
    }
  | { type: 'run_transport_error'; code: ErrorCode; message: string }
  | { type: 'session_error_recorded'; message: string }
  | { type: 'session_error_cleared' }
  | { type: 'run_start_failed'; threadId?: string | null; message: string }
  | { type: 'approval_submit_failed'; threadId?: string; message: string }
  | {
      type: 'approval_cleared';
      threadId?: string | null;
      pendingApproval?: PendingApprovalIdentity;
    }
  | { type: 'run_start_cancelled'; threadId?: string | null };

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
    providerRuntime: null,
    streamingToolCall: null,
    streamingArtifactText: '',
    streamError: null,
    streamErrorCode: null,
  };
}

export function createRunSessionLaneState(
  threadId: string | null = null,
): RunSessionLaneState {
  return {
    phase: 'idle',
    activeRunView: createEmptyActiveRunView(threadId),
  };
}
