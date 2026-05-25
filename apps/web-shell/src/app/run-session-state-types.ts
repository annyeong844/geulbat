import type {
  ArtifactRef,
  ThreadArtifactVersion,
} from '@geulbat/protocol/artifacts';
import type { ApprovalRequired } from '@geulbat/protocol/run-approval';
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
  streamError: string | null;
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
}

export interface VisibleRunState {
  visibleThreadId: string | null;
  activeRunId: string | null;
  transcriptEntries: RunTranscriptEntry[];
  finalAnswerText: string;
  activeArtifact: ThreadArtifactVersion | null;
  pendingApproval: ApprovalRequired | null;
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
    }
  | {
      type: 'approval_requested';
      threadId: string;
      pendingApproval: ApprovalRequired;
    }
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
    streamError: null,
  };
}
