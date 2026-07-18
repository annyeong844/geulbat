import type {
  ArtifactCommittedEventPayload,
  ContextUsageUpdatedEventPayload,
  RunUsageTotals,
  ToolResultEventPayload,
} from '@geulbat/protocol/run-events';
import type { ApprovalRequired } from '@geulbat/protocol/run-approval';
import type { ErrorCode } from '@geulbat/protocol/errors';
import type { RunChannelServerMessage } from '@geulbat/protocol/run-channel';
import type { ThreadDetailResponse } from '@geulbat/protocol/threads';
import { ASK_USER_TOOL_NAME } from '../features/assistant/ask-user/ask-user-card-view.js';
import { UPDATE_PLAN_TOOL_NAME } from '../features/assistant/run-plan/run-plan.js';
import {
  readVisualizeWidgetViewFromToolArgs,
  VISUALIZE_TOOL_NAME,
} from '../features/assistant/visualize/visualize-widget-view.js';
import { markVisualizeStreamPlayed } from '../features/assistant/visualize/visualize-widget.js';
import type { RunSessionStateAction } from './run-session-state-types.js';
import { createSubagentActivityEffect } from './run-session-subagent-effect.js';

// 실데이터 스트리밍이 실제로 흐른 도구 호출(첫 델타 시각) — 완성본 도착 시
// 이 표식으로 visualize 재생 완료를 판단한다. 델타가 끝에 몰아서 온 경우
// (긴 추론 뒤 폭주)는 사용자가 그려지는 과정을 못 봤으므로 완성 위젯이
// 기존 점진 렌더를 재생한다.
const streamedToolCallFirstDeltaAtMs = new Map<string, number>();
// 이 시간 이상 스트리밍이 화면에 보였으면 과정을 본 것으로 친다 —
// 완성 위젯의 점진 렌더 하한(600ms)보다 넉넉한 값.
const VISUALIZE_STREAM_VISIBLE_MS = 1_500;

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
      streamedToolCallId?: string;
      entry:
        | {
            kind: 'tool_activity';
            tool: string;
            state: 'running';
            // 호출 인자가 곧 렌더 원본인 도구(visualize, update_plan)만
            // 실어 온다
            args?: Record<string, unknown>;
          }
        | {
            kind: 'tool_activity';
            tool: string;
            state: 'completed' | 'failed';
          };
      computerFilesMayHaveChanged: boolean;
    }
  | {
      kind: 'tool_call_args_streamed';
      threadId: string;
      callId: string;
      tool: string;
      argsDelta: string;
    }
  | {
      kind: 'approval_requested';
      threadId: string;
      pendingApproval: ApprovalRequired;
    }
  | { kind: 'steer_applied'; threadId: string; receivedSeqs: number[] }
  | { kind: 'usage_updated'; threadId: string; usage: RunUsageTotals }
  | {
      kind: 'context_usage_updated';
      threadId: string;
      contextUsage: ContextUsageUpdatedEventPayload;
    }
  | {
      kind: 'run_terminal';
      runId: string;
      threadId: string;
      ok: boolean;
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
    case 'tool_call': {
      // 실데이터 스트리밍으로 충분히 오래 그려진 visualize만 완성본 위젯이
      // 애니메이션을 반복하지 않도록 재생 완료로 표시한다.
      {
        const firstDeltaAtMs = streamedToolCallFirstDeltaAtMs.get(
          event.payload.callId,
        );
        streamedToolCallFirstDeltaAtMs.delete(event.payload.callId);
        if (
          firstDeltaAtMs !== undefined &&
          Date.now() - firstDeltaAtMs >= VISUALIZE_STREAM_VISIBLE_MS &&
          event.payload.tool === VISUALIZE_TOOL_NAME
        ) {
          const playedView = readVisualizeWidgetViewFromToolArgs(
            event.payload.args,
          );
          if (playedView !== null) {
            markVisualizeStreamPlayed(playedView);
          }
        }
      }
      return {
        kind: 'transcript_activity_added',
        threadId: event.threadId,
        streamedToolCallId: event.payload.callId,
        entry: {
          kind: 'tool_activity',
          tool: event.payload.tool,
          state: 'running',
          ...(event.payload.tool === VISUALIZE_TOOL_NAME ||
          event.payload.tool === UPDATE_PLAN_TOOL_NAME ||
          event.payload.tool === ASK_USER_TOOL_NAME
            ? { args: event.payload.args }
            : {}),
        },
        computerFilesMayHaveChanged: false,
      };
    }
    case 'tool_call_delta':
      if (!streamedToolCallFirstDeltaAtMs.has(event.payload.callId)) {
        streamedToolCallFirstDeltaAtMs.set(event.payload.callId, Date.now());
      }
      return {
        kind: 'tool_call_args_streamed',
        threadId: event.threadId,
        callId: event.payload.callId,
        tool: event.payload.tool,
        argsDelta: event.payload.argsDelta,
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
        computerFilesMayHaveChanged: event.payload.computerFilesMayHaveChanged,
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
    case 'interject_applied':
      return {
        kind: 'steer_applied',
        threadId: event.threadId,
        receivedSeqs: event.payload.receivedSeqs,
      };
    case 'usage_updated':
      return {
        kind: 'usage_updated',
        threadId: event.threadId,
        usage: event.payload,
      };
    case 'context_usage_updated':
      return {
        kind: 'context_usage_updated',
        threadId: event.threadId,
        contextUsage: event.payload,
      };
    case 'done':
      return {
        kind: 'run_terminal',
        runId: event.runId,
        threadId: event.threadId,
        ok: event.payload.ok,
      };
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
  payload: Pick<ToolResultEventPayload, 'computerFilesMayHaveChanged'>,
): boolean {
  return payload.computerFilesMayHaveChanged;
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
        ...(effect.streamedToolCallId !== undefined
          ? { streamedToolCallId: effect.streamedToolCallId }
          : {}),
      });
      return;
    case 'tool_call_args_streamed':
      dispatch({
        type: 'tool_call_args_streamed',
        threadId: effect.threadId,
        callId: effect.callId,
        tool: effect.tool,
        argsDelta: effect.argsDelta,
      });
      return;
    case 'approval_requested':
      dispatch({
        type: 'approval_requested',
        threadId: effect.threadId,
        pendingApproval: effect.pendingApproval,
      });
      return;
    case 'steer_applied':
      dispatch({
        type: 'steer_applied',
        threadId: effect.threadId,
        receivedSeqs: effect.receivedSeqs,
      });
      return;
    case 'usage_updated':
      dispatch({
        type: 'run_usage_updated',
        threadId: effect.threadId,
        usage: effect.usage,
      });
      return;
    case 'context_usage_updated':
      dispatch({
        type: 'run_context_usage_updated',
        threadId: effect.threadId,
        contextUsage: effect.contextUsage,
      });
      return;
    case 'run_terminal':
      dispatch({
        type: 'run_terminal',
        runId: effect.runId,
        threadId: effect.threadId,
        ok: effect.ok,
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
