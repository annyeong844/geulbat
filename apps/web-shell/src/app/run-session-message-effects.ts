import type {
  ArtifactCommittedEventPayload,
  ToolResultEventPayload,
} from '@geulbat/protocol/run-events';
import type { ApprovalRequired } from '@geulbat/protocol/run-approval';
import type { ErrorCode } from '@geulbat/protocol/errors';
import type { RunChannelServerMessage } from '@geulbat/protocol/run-channel';
import type { ThreadDetailResponse } from '@geulbat/protocol/threads';
import type { RunSessionStateAction } from './run-session-state-types.js';
import { createSubagentActivityEffect } from './run-session-subagent-effect.js';

export type RunSessionMessageEffect =
  | { kind: 'run_transport_error'; code: ErrorCode; message: string }
  | { kind: 'run_started'; threadId: string; runId: string }
  | {
      kind: 'assistant_text_streamed';
      threadId: string;
      target: 'transcript' | 'answer';
      text: string;
    }
  | {
      kind: 'artifact_activated';
      threadId: string;
      artifact: ArtifactCommittedEventPayload;
    }
  | {
      kind: 'transcript_activity_added';
      threadId: string;
      entry:
        | { kind: 'tool_activity'; tool: string; state: 'running' }
        | {
            kind: 'tool_activity';
            tool: string;
            state: 'completed' | 'failed';
          };
      workspaceFilesMayHaveChanged: boolean;
    }
  | {
      kind: 'approval_requested';
      threadId: string;
      pendingApproval: ApprovalRequired;
    }
  | ReturnType<typeof createSubagentActivityEffect>
  | { kind: 'settle_run_success'; thread: ThreadDetailResponse }
  | {
      kind: 'settle_run_sync_failed';
      threadId: string;
      message: string;
    }
  | {
      kind: 'settle_run_error';
      threadId: string;
      code: ErrorCode;
      message: string;
    };

interface RunSessionMessageEffectHandlers {
  dispatch: (action: RunSessionStateAction) => void;
  requestProjectTreeRefresh: () => void;
  handleRunStarted: (threadId: string, runId: string) => void | Promise<void>;
  handleRunSettledSuccess: (thread: ThreadDetailResponse) => Promise<void>;
  handleRunSettleSyncFailed: (
    threadId: string,
    message: string,
  ) => Promise<void>;
  handleRunSettledError: (threadId: string, message: string) => Promise<void>;
}

interface HandleRunSessionMessageArgs extends RunSessionMessageEffectHandlers {
  message: RunChannelServerMessage;
}

export function adaptRunSessionMessage(
  message: RunChannelServerMessage,
): RunSessionMessageEffect | null {
  if (message.type === 'run.error') {
    return {
      kind: 'run_transport_error',
      code: message.code,
      message: message.message,
    };
  }

  if (message.type !== 'run.event') {
    return null;
  }

  const event = message.event;
  switch (event.type) {
    case 'run_ack':
      return {
        kind: 'run_started',
        threadId: event.payload.threadId,
        runId: event.payload.runId,
      };
    case 'final_answer_delta':
      return {
        kind: 'assistant_text_streamed',
        threadId: event.threadId,
        target: 'answer',
        text: event.payload.text,
      };
    case 'artifact_committed':
      return {
        kind: 'artifact_activated',
        threadId: event.threadId,
        artifact: event.payload,
      };
    case 'thread_state_persisted':
      return {
        kind: 'settle_run_success',
        thread: event.payload,
      };
    case 'thread_state_persist_failed':
      return {
        kind: 'settle_run_sync_failed',
        threadId: event.threadId,
        message: event.payload.message,
      };
    case 'commentary_delta':
      return {
        kind: 'assistant_text_streamed',
        threadId: event.threadId,
        target: 'transcript',
        text: event.payload.text,
      };
    case 'tool_call':
      return {
        kind: 'transcript_activity_added',
        threadId: event.threadId,
        entry: {
          kind: 'tool_activity',
          tool: event.payload.tool,
          state: 'running',
        },
        workspaceFilesMayHaveChanged: false,
      };
    case 'tool_result':
      return {
        kind: 'transcript_activity_added',
        threadId: event.threadId,
        entry: {
          kind: 'tool_activity',
          tool: event.payload.tool,
          state: event.payload.ok ? 'completed' : 'failed',
        },
        workspaceFilesMayHaveChanged:
          event.payload.workspaceFilesMayHaveChanged,
      };
    case 'approval_required':
      return {
        kind: 'approval_requested',
        threadId: event.threadId,
        pendingApproval: event.payload,
      };
    case 'subagent_spawned':
      return createSubagentActivityEffect(event);
    case 'subagent_approval_required':
      return createSubagentActivityEffect(event);
    case 'subagent_terminal':
      return createSubagentActivityEffect(event);
    case 'done':
      return null;
    case 'error':
      return {
        kind: 'settle_run_error',
        threadId: event.threadId,
        code: event.payload.code,
        message: event.payload.message,
      };
  }
}

export function shouldRefreshTreeAfterToolResult(
  payload: Pick<ToolResultEventPayload, 'workspaceFilesMayHaveChanged'>,
): boolean {
  return payload.workspaceFilesMayHaveChanged;
}

export async function handleRunSessionMessage({
  message,
  dispatch,
  requestProjectTreeRefresh,
  handleRunStarted,
  handleRunSettledSuccess,
  handleRunSettleSyncFailed,
  handleRunSettledError,
}: HandleRunSessionMessageArgs): Promise<void> {
  const effect = adaptRunSessionMessage(message);
  if (!effect) {
    return;
  }

  await applyRunSessionMessageEffect({
    effect,
    dispatch,
    requestProjectTreeRefresh,
    handleRunStarted,
    handleRunSettledSuccess,
    handleRunSettleSyncFailed,
    handleRunSettledError,
  });
}

async function applyRunSessionMessageEffect({
  effect,
  dispatch,
  requestProjectTreeRefresh,
  handleRunStarted,
  handleRunSettledSuccess,
  handleRunSettleSyncFailed,
  handleRunSettledError,
}: RunSessionMessageEffectHandlers & {
  effect: RunSessionMessageEffect;
}): Promise<void> {
  switch (effect.kind) {
    case 'run_transport_error':
      dispatch({
        type: 'run_transport_error',
        message: `[${effect.code}] ${effect.message}`,
      });
      return;
    case 'run_started':
      await handleRunStarted(effect.threadId, effect.runId);
      return;
    case 'assistant_text_streamed':
      dispatch({
        type: 'assistant_text_streamed',
        threadId: effect.threadId,
        target: effect.target,
        text: effect.text,
      });
      return;
    case 'artifact_activated':
      dispatch({
        type: 'artifact_activated',
        threadId: effect.threadId,
        artifact: effect.artifact,
      });
      return;
    case 'transcript_activity_added':
      if (shouldRefreshTreeAfterToolResult(effect)) {
        requestProjectTreeRefresh();
      }
      dispatch({
        type: 'transcript_activity_added',
        threadId: effect.threadId,
        entry: effect.entry,
      });
      return;
    case 'approval_requested':
      dispatch({
        type: 'approval_requested',
        threadId: effect.threadId,
        pendingApproval: effect.pendingApproval,
      });
      return;
    case 'subagent_activity_added':
      dispatch({
        type: 'subagent_activity_added',
        threadId: effect.threadId,
        entry: effect.entry,
      });
      return;
    case 'settle_run_success':
      await handleRunSettledSuccess(effect.thread);
      return;
    case 'settle_run_sync_failed':
      await handleRunSettleSyncFailed(effect.threadId, effect.message);
      return;
    case 'settle_run_error':
      await handleRunSettledError(
        effect.threadId,
        `[${effect.code}] ${effect.message}`,
      );
      return;
  }
}
