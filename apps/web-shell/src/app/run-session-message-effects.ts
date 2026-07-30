import type {
  ArtifactCommittedEventPayload,
  ContextUsageUpdatedEventPayload,
  ProviderRuntimeStatusEventPayload,
  RunUsageTotals,
  ThreadStateSettlePayload,
  ToolResultEventPayload,
} from '@geulbat/protocol/run-events';
import type { ApprovalRequired } from '@geulbat/protocol/run-approval';
import type { ErrorCode } from '@geulbat/protocol/errors';
import type { RunChannelServerMessage } from '@geulbat/protocol/run-channel';
import type { PlanningWorkflowSnapshot } from '@geulbat/protocol/planning-workflow';
import type { GoalSnapshot } from '@geulbat/protocol/goal';
import { ASK_USER_TOOL_NAME } from '../features/assistant/ask-user/ask-user-card-view.js';
import { UPDATE_PLAN_TOOL_NAME } from '../features/assistant/run-plan/run-plan.js';
import { readPtcToolActivityStatus } from '../features/assistant/tool-result-view.js';
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
  // 아티팩트 전용 답변의 봉투 텍스트 라이브 스트림 — 채팅 대신 중앙
  // 아티팩트 창이 생성 과정을 실시간으로 그린다.
  | { kind: 'artifact_text_streamed'; threadId: string; text: string }
  | {
      kind: 'transcript_activity_added';
      runId: string;
      threadId: string;
      streamedToolCallId?: string;
      entry:
        | {
            kind: 'tool_activity';
            tool: string;
            state: 'running';
            callId: string;
            // 호출 인자가 곧 렌더 원본인 도구(visualize, update_plan)만
            // 실어 온다
            args?: Record<string, unknown>;
          }
        | {
            kind: 'tool_activity';
            tool: string;
            state: 'completed' | 'failed';
            callId: string;
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
      kind: 'tool_output_streamed';
      threadId: string;
      callId: string;
      tool: string;
      stream: 'stdout' | 'stderr';
      text: string;
    }
  | {
      kind: 'approval_requested';
      runId: string;
      threadId: string;
      pendingApproval: ApprovalRequired;
    }
  | {
      kind: 'steer_applied';
      runId: string;
      threadId: string;
      receivedSeqs: number[];
    }
  | {
      kind: 'usage_updated';
      runId: string;
      threadId: string;
      usage: RunUsageTotals;
    }
  | {
      kind: 'context_usage_updated';
      threadId: string;
      contextUsage: ContextUsageUpdatedEventPayload;
    }
  | {
      kind: 'provider_runtime_updated';
      runId: string;
      threadId: string;
      providerRuntime: ProviderRuntimeStatusEventPayload;
    }
  | {
      kind: 'planning_workflow_updated';
      threadId: string;
      snapshot: PlanningWorkflowSnapshot | null;
    }
  | {
      kind: 'goal_updated';
      threadId: string;
      snapshot: GoalSnapshot | null;
    }
  | {
      kind: 'run_terminal';
      runId: string;
      threadId: string;
      ok: boolean;
    }
  | ReturnType<typeof createSubagentActivityEffect>
  | {
      kind: 'settle_run_success';
      runId: string;
      thread: ThreadStateSettlePayload;
    }
  | {
      kind: 'settle_run_sync_failed';
      runId: string;
      threadId: string;
      message: string;
    }
  | {
      kind: 'settle_run_error';
      runId: string;
      threadId: string;
      code: ErrorCode;
      message: string;
    };

interface RunSessionMessageEffectHandlers {
  dispatch: (action: RunSessionStateAction) => void;
  requestComputerTreeRefresh: () => void;
  handleRunStarted: (threadId: string, runId: string) => void | Promise<void>;
  handleRunSettledSuccess: (
    thread: ThreadStateSettlePayload,
    runId?: string,
  ) => Promise<void>;
  handleRunSettleSyncFailed: (
    threadId: string,
    message: string,
    runId?: string,
  ) => Promise<void>;
  handleRunSettledError: (
    threadId: string,
    code: ErrorCode,
    message: string,
    runId?: string,
  ) => Promise<void>;
  handlePlanningWorkflow?:
    | ((threadId: string, snapshot: PlanningWorkflowSnapshot | null) => void)
    | undefined;
  handleGoal?:
    | ((threadId: string, snapshot: GoalSnapshot | null) => void)
    | undefined;
}

interface HandleRunSessionMessageArgs extends RunSessionMessageEffectHandlers {
  message: RunChannelServerMessage;
  /** 다음 걸음 제안이 도착했을 때. 저장하지 않고 컴포저에만 띄운다. */
  handleFollowupSuggested?: ((prompt: string) => void) | undefined;
}

/** 제안 도구 이름 — daemon builtin과 같은 문자열이어야 한다. */
const SUGGEST_FOLLOWUP_TOOL_NAME = 'suggest_followup';

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

  if (message.type === 'run.tool.output.delta') {
    return {
      kind: 'tool_output_streamed',
      threadId: message.threadId,
      callId: message.payload.callId,
      tool: message.payload.tool,
      stream: message.payload.stream,
      text: message.payload.text,
    };
  }

  if (message.type === 'plan.workflow') {
    return {
      kind: 'planning_workflow_updated',
      threadId: message.threadId,
      snapshot: message.snapshot,
    };
  }

  if (message.type === 'goal.state') {
    return {
      kind: 'goal_updated',
      threadId: message.threadId,
      snapshot: message.snapshot,
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
    case 'artifact_stream_delta':
      return {
        kind: 'artifact_text_streamed',
        threadId: event.threadId,
        text: event.payload.text,
      };
    case 'thread_state_persisted':
      return {
        kind: 'settle_run_success',
        runId: event.runId,
        thread: event.payload,
      };
    case 'thread_state_delta_persisted':
      return {
        kind: 'settle_run_success',
        runId: event.runId,
        thread: event.payload,
      };
    case 'thread_state_persist_failed':
      return {
        kind: 'settle_run_sync_failed',
        runId: event.runId,
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
        runId: event.runId,
        threadId: event.threadId,
        streamedToolCallId: event.payload.callId,
        entry: {
          kind: 'tool_activity',
          tool: event.payload.tool,
          state: 'running',
          callId: event.payload.callId,
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
    case 'tool_result': {
      const ptcStatus = readPtcToolActivityStatus({
        tool: event.payload.tool,
        ok: event.payload.ok,
        text: event.payload.displayText,
        raw: event.payload.raw,
      });
      return {
        kind: 'transcript_activity_added',
        runId: event.runId,
        threadId: event.threadId,
        entry: {
          kind: 'tool_activity',
          tool: event.payload.tool,
          state: event.payload.ok ? 'completed' : 'failed',
          callId: event.payload.callId,
          ...(ptcStatus !== undefined ? { ptcStatus } : {}),
        },
        computerFilesMayHaveChanged: event.payload.computerFilesMayHaveChanged,
      };
    }
    case 'approval_required':
      return {
        kind: 'approval_requested',
        runId: event.runId,
        threadId: event.threadId,
        pendingApproval: event.payload,
      };
    case 'subagent_spawned':
      return createSubagentActivityEffect(event);
    case 'subagent_status':
      return createSubagentActivityEffect(event);
    case 'subagent_approval_required':
      return createSubagentActivityEffect(event);
    case 'subagent_terminal':
      return createSubagentActivityEffect(event);
    case 'interject_applied':
      return {
        kind: 'steer_applied',
        runId: event.runId,
        threadId: event.threadId,
        receivedSeqs: event.payload.receivedSeqs,
      };
    case 'usage_updated':
      return {
        kind: 'usage_updated',
        runId: event.runId,
        threadId: event.threadId,
        usage: event.payload,
      };
    case 'context_usage_updated':
      return {
        kind: 'context_usage_updated',
        threadId: event.threadId,
        contextUsage: event.payload,
      };
    case 'planning_workflow_updated':
      return {
        kind: 'planning_workflow_updated',
        threadId: event.threadId,
        snapshot: event.payload,
      };
    case 'goal_updated':
      return {
        kind: 'goal_updated',
        threadId: event.threadId,
        snapshot: event.payload,
      };
    case 'provider_status':
      return {
        kind: 'provider_runtime_updated',
        runId: event.runId,
        threadId: event.threadId,
        providerRuntime: event.payload,
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
        runId: event.runId,
        threadId: event.threadId,
        code: event.payload.code,
        message: event.payload.message,
      };
  }
}

/**
 * suggest_followup 호출에서 제안 문구를 읽는다. 제안은 저장하지 않는 그 턴의
 * 표시값이고, 도구 호출 자체는 평소처럼 전사에 남는다 — 숨기지 않는다.
 */
export function readFollowupSuggestion(
  message: RunChannelServerMessage,
): string | null {
  if (message.type !== 'run.event' || message.event.type !== 'tool_call') {
    return null;
  }
  if (message.event.payload.tool !== SUGGEST_FOLLOWUP_TOOL_NAME) {
    return null;
  }
  const prompt = message.event.payload.args['prompt'];
  return typeof prompt === 'string' && prompt.trim() !== '' ? prompt : null;
}

export function shouldRefreshTreeAfterToolResult(
  payload: Pick<ToolResultEventPayload, 'computerFilesMayHaveChanged'>,
): boolean {
  return payload.computerFilesMayHaveChanged;
}

export async function handleRunSessionMessage({
  message,
  dispatch,
  requestComputerTreeRefresh,
  handleRunStarted,
  handleRunSettledSuccess,
  handleRunSettleSyncFailed,
  handleRunSettledError,
  handleFollowupSuggested,
  handlePlanningWorkflow,
  handleGoal,
}: HandleRunSessionMessageArgs): Promise<void> {
  const suggestion = readFollowupSuggestion(message);
  if (suggestion !== null) {
    handleFollowupSuggested?.(suggestion);
  }

  const effect = adaptRunSessionMessage(message);
  if (!effect) {
    return;
  }

  await applyRunSessionMessageEffect({
    effect,
    dispatch,
    requestComputerTreeRefresh,
    handleRunStarted,
    handleRunSettledSuccess,
    handleRunSettleSyncFailed,
    handleRunSettledError,
    handlePlanningWorkflow,
    handleGoal,
  });
}

async function applyRunSessionMessageEffect({
  effect,
  dispatch,
  requestComputerTreeRefresh,
  handleRunStarted,
  handleRunSettledSuccess,
  handleRunSettleSyncFailed,
  handleRunSettledError,
  handlePlanningWorkflow,
  handleGoal,
}: RunSessionMessageEffectHandlers & {
  effect: RunSessionMessageEffect;
}): Promise<void> {
  switch (effect.kind) {
    case 'run_transport_error':
      dispatch({
        type: 'run_transport_error',
        code: effect.code,
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
    case 'artifact_text_streamed':
      dispatch({
        type: 'artifact_text_streamed',
        threadId: effect.threadId,
        text: effect.text,
      });
      return;
    case 'transcript_activity_added':
      if (shouldRefreshTreeAfterToolResult(effect)) {
        requestComputerTreeRefresh();
      }
      dispatch({
        type: 'transcript_activity_added',
        runId: effect.runId,
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
    case 'tool_output_streamed':
      dispatch({
        type: 'tool_output_streamed',
        threadId: effect.threadId,
        callId: effect.callId,
        tool: effect.tool,
        stream: effect.stream,
        text: effect.text,
      });
      return;
    case 'approval_requested':
      dispatch({
        type: 'approval_requested',
        runId: effect.runId,
        threadId: effect.threadId,
        pendingApproval: effect.pendingApproval,
      });
      return;
    case 'steer_applied':
      dispatch({
        type: 'steer_applied',
        runId: effect.runId,
        threadId: effect.threadId,
        receivedSeqs: effect.receivedSeqs,
      });
      return;
    case 'usage_updated':
      dispatch({
        type: 'run_usage_updated',
        runId: effect.runId,
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
    case 'provider_runtime_updated':
      dispatch({
        type: 'provider_runtime_updated',
        runId: effect.runId,
        threadId: effect.threadId,
        providerRuntime: effect.providerRuntime,
      });
      return;
    case 'planning_workflow_updated':
      handlePlanningWorkflow?.(effect.threadId, effect.snapshot);
      return;
    case 'goal_updated':
      handleGoal?.(effect.threadId, effect.snapshot);
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
      await handleRunSettledSuccess(effect.thread, effect.runId);
      return;
    case 'settle_run_sync_failed':
      await handleRunSettleSyncFailed(
        effect.threadId,
        effect.message,
        effect.runId,
      );
      return;
    case 'settle_run_error':
      await handleRunSettledError(
        effect.threadId,
        effect.code,
        effect.message,
        effect.runId,
      );
      return;
  }
}
