import type {
  ApprovalGrantScope,
  ApprovalRequired,
  PermissionMode,
} from '@geulbat/protocol/run-approval';
import type {
  RunAttachmentInput,
  RunModelId,
  RunProviderTransitionRecovery,
  RunReasoningSelection,
  RunRequest,
  RunServiceTier,
  RunStartRequest,
  RunSubagentModelRouting,
} from '@geulbat/protocol/run-contract';
import type {
  RunChildCancelRequest,
  RunInterjectRequest,
  RunToolRequest,
  RunToolResultPayload,
} from '@geulbat/protocol/run-channel';
import type {
  PlanModeDepth,
  PlanModeIntensity,
} from '@geulbat/protocol/planning-workflow';
import { getErrorMessage } from '../lib/error-message.js';

import { brandRunId, brandThreadId } from '../lib/id-brand-helpers.js';
import { buildArtifactFrameToolFallbackRunDraft } from '../features/artifacts/artifact-run-drafts.js';
import { tryConsumeArtifactBackchannelBudget } from '../features/assistant/runtime-frame/artifact-backchannel-rate-limit.js';

import {
  buildPromptRunRequest,
  buildRunStartRequest,
  prepareRunStartRequest,
  type ApprovalDecisionClient as ApprovalDecisionCommandClient,
  type CancelRunSessionClient as CancelRunCommandClient,
  cancelRunSession,
  resolveOptimisticRunPrompt,
  type StartRunCommandClient as StartRunClient,
  startRunRequestCommand,
  submitApprovalDecision,
} from './run-session-commands.js';
import type {
  RunSessionPhase,
  RunSessionStateAction,
} from './run-session-state-types.js';

// 런 세션 컨트롤러의 자유 액션 함수 계층 — 클로저 없이 인자만 받는 순수
// 파이프라인들. React 바인딩(useRunSessionControllerActions)은
// run-session-controller-actions.ts가 소유한다. commands → actions → hook
// 3계층에서 이 파일이 actions 층이다.

export interface PromptActionInputs {
  workingDirectory?: string;
  modelId: RunModelId;
  selectedThreadId: string | null;
  permissionMode: PermissionMode;
  planModeRequested: boolean;
  planModeIntensity: PlanModeIntensity;
  planModeDepth: PlanModeDepth;
  reasoningEffort: RunReasoningSelection;
  serviceTier: RunServiceTier;
  providerTransitionRecovery?: RunProviderTransitionRecovery;
  subagentModelRouting: RunSubagentModelRouting;
}

export interface InterjectRunClient {
  interject(
    request: RunInterjectRequest,
  ): Promise<{ requestId: string; receivedSeq: number }>;
  cancelInterject(request: {
    runId: RunInterjectRequest['runId'];
    receivedSeq: number;
  }): Promise<{ cancelled: boolean }>;
  flushInterject(request: {
    runId: RunInterjectRequest['runId'];
  }): Promise<{ flushed: boolean }>;
}

export interface ChildRunCancelClient {
  cancelChild(request: RunChildCancelRequest): Promise<string>;
}

export interface FrameToolClient {
  tool(request: RunToolRequest): Promise<RunToolResultPayload>;
}

export type RunToolFailure = Extract<RunToolResultPayload, { ok: false }>;

export interface CancelActionState {
  phase: RunSessionPhase;
  activeRunId: string | null;
  activeThreadId: string | null;
}

interface RunPromptActionArgs {
  client: StartRunClient;
  dispatch: (action: RunSessionStateAction) => void;
  clearSessionError: () => void;
  prompt: string;
  attachments?: RunAttachmentInput[];
  // 아티팩트 프레임 발 프롬프트 — 턴을 아티팩트 발로 귀속 렌더한다
  promptOrigin?: 'artifact_frame';
  promptInputs: PromptActionInputs;
  appendOptimisticUserMessage: (
    prompt: string,
    origin?: 'artifact_frame',
  ) => void;
  logCommandFailure: (logContext: string, message: string) => void;
  prepareStartRequest?: (request: RunRequest) => Promise<RunStartRequest>;
}

interface StartRunActionArgs {
  client: StartRunClient;
  dispatch: (action: RunSessionStateAction) => void;
  clearSessionError: () => void;
  request: RunRequest;
  modelId: RunModelId;
  permissionMode: PermissionMode;
  serviceTier: RunServiceTier;
  subagentModelRouting: RunSubagentModelRouting;
  appendOptimisticUserMessage: (
    prompt: string,
    origin?: 'artifact_frame',
  ) => void;
  optimisticPrompt: string | undefined;
  logCommandFailure: (logContext: string, message: string) => void;
  prepareStartRequest?: (request: RunRequest) => Promise<RunStartRequest>;
}

interface ApprovalActionArgs {
  dispatch: (action: RunSessionStateAction) => void;
  clearSessionError: () => void;
  client: ApprovalDecisionCommandClient;
  pending: ApprovalRequired;
  approved: boolean;
  grantScope: ApprovalGrantScope;
  permissionMode?: PermissionMode;
  logCommandFailure: (logContext: string, message: string) => void;
}

interface CancelRunActionArgs {
  dispatch: (action: RunSessionStateAction) => void;
  clearSessionError: () => void;
  client: CancelRunCommandClient;
  cancelState: CancelActionState;
  reportSessionFailure: (logContext: string, error: unknown) => void;
}

interface InterjectPromptActionArgs {
  client: InterjectRunClient;
  dispatch: (action: RunSessionStateAction) => void;
  clearSessionError: () => void;
  activeRunId: string;
  threadId: string;
  prompt: string;
  logCommandFailure: (logContext: string, message: string) => void;
}

async function runStartActionPipeline(
  client: StartRunClient,
  dispatch: (action: RunSessionStateAction) => void,
  clearSessionError: () => void,
  request: RunRequest,
  appendOptimisticUserMessage: (
    prompt: string,
    origin?: 'artifact_frame',
  ) => void,
  logCommandFailure: (logContext: string, message: string) => void,
  prepareStartRequest: (request: RunRequest) => Promise<RunStartRequest>,
  optimisticPrompt?: string,
): Promise<boolean> {
  clearSessionError();
  // silent 요청(아티팩트 ♻ 등)은 채팅에 질문 말풍선을 만들지 않는다
  if (request.silentPrompt !== true) {
    appendOptimisticUserMessage(
      resolveOptimisticRunPrompt(request, optimisticPrompt),
      // 아티팩트 발 턴은 낙관 말풍선부터 귀속 배지를 단다
      request.promptOrigin,
    );
  }
  dispatch({ type: 'run_start_requested', threadId: request.threadId ?? null });
  const result = await startRunRequestCommand({
    client,
    request,
    prepareStartRequest,
  });
  if (result.kind === 'failed') {
    logCommandFailure('stream error', result.message);
    dispatch({
      type: 'run_start_failed',
      threadId: request.threadId ?? null,
      message: `[internal] ${result.message}`,
    });
    return false;
  }
  return true;
}

export async function sendPromptAction({
  client,
  dispatch,
  clearSessionError,
  prompt,
  attachments,
  promptOrigin,
  promptInputs,
  appendOptimisticUserMessage,
  logCommandFailure,
  prepareStartRequest = prepareRunStartRequest,
}: RunPromptActionArgs): Promise<boolean> {
  return await runStartActionPipeline(
    client,
    dispatch,
    clearSessionError,
    buildPromptRunRequest({
      prompt,
      ...(promptInputs.workingDirectory !== undefined
        ? { workingDirectory: promptInputs.workingDirectory }
        : {}),
      modelId: promptInputs.modelId,
      selectedThreadId: promptInputs.selectedThreadId,
      permissionMode: promptInputs.permissionMode,
      planModeRequested: promptInputs.planModeRequested,
      planModeIntensity: promptInputs.planModeIntensity,
      planModeDepth: promptInputs.planModeDepth,
      reasoningEffort: promptInputs.reasoningEffort,
      serviceTier: promptInputs.serviceTier,
      ...(promptInputs.providerTransitionRecovery === undefined
        ? {}
        : {
            providerTransitionRecovery: promptInputs.providerTransitionRecovery,
          }),
      subagentModelRouting: promptInputs.subagentModelRouting,
      ...(attachments !== undefined ? { attachments } : {}),
      ...(promptOrigin !== undefined ? { promptOrigin } : {}),
    }),
    appendOptimisticUserMessage,
    logCommandFailure,
    prepareStartRequest,
  );
}

// 티어 B 강등 (back-channel 설계 §7) — read-only 게이트가 거부한 프레임 발
// 도구 호출을 "아티팩트가 X를 요청함" 프롬프트로 번역해 agent loop +
// ApprovalRequired가 승인을 중재하게 한다. 강등도 턴을 만들므로 prompt
// 레인 예산을 소모하고, 실행 중이면 스티어로 합류한다. 프레임에는 원래
// 거부를 강등 사실과 함께 데이터 응답으로 되돌린다 — 도구 결과가 프레임
// 으로 직행하는 일은 없다 (부수효과 직통 금지 불변식 유지).
export async function degradeWidgetToolRequestAction(args: {
  request: {
    toolName: string;
    args: Record<string, unknown>;
    scopeHandle: string;
  };
  threadId: string;
  rejection: RunToolFailure;
  cancelState: CancelActionState;
  startClient: StartRunClient;
  interjectClient: InterjectRunClient;
  dispatch: (action: RunSessionStateAction) => void;
  clearSessionError: () => void;
  appendOptimisticUserMessage: (
    prompt: string,
    origin?: 'artifact_frame',
  ) => void;
  logCommandFailure: (logContext: string, message: string) => void;
  prepareStartRequest?: (request: RunRequest) => Promise<RunStartRequest>;
  startRequestInFlight: { current: boolean };
  tryConsumeBudget?: (scopeHandle: string, lane: 'prompt') => boolean;
  workingDirectory?: string;
}): Promise<RunToolResultPayload> {
  const {
    request,
    threadId,
    rejection,
    cancelState,
    startClient,
    interjectClient,
    dispatch,
    clearSessionError,
    appendOptimisticUserMessage,
    logCommandFailure,
    prepareStartRequest = prepareRunStartRequest,
    startRequestInFlight,
    tryConsumeBudget = tryConsumeArtifactBackchannelBudget,
  } = args;
  if (!tryConsumeBudget(request.scopeHandle, 'prompt')) {
    return rejection;
  }
  const draft = buildArtifactFrameToolFallbackRunDraft({
    toolName: request.toolName,
    toolArgs: request.args,
    threadId: brandThreadId(threadId),
  });
  const runDraft =
    args.workingDirectory === undefined || draft.workingDirectory !== undefined
      ? draft
      : { ...draft, workingDirectory: args.workingDirectory };
  if (cancelState.phase === 'running' && cancelState.activeRunId !== null) {
    if (cancelState.activeThreadId !== threadId) {
      return rejection;
    }
    await interjectPromptAction({
      client: interjectClient,
      dispatch,
      clearSessionError,
      activeRunId: cancelState.activeRunId,
      threadId: cancelState.activeThreadId,
      prompt: draft.prompt,
      logCommandFailure,
    });
    return {
      ok: false,
      errorCode: rejection.errorCode,
      error: `${rejection.error}; degraded to a steer in the active run`,
    };
  }
  if (cancelState.phase === 'starting' || startRequestInFlight.current) {
    return rejection;
  }
  startRequestInFlight.current = true;
  try {
    await runStartActionPipeline(
      startClient,
      dispatch,
      clearSessionError,
      runDraft,
      appendOptimisticUserMessage,
      logCommandFailure,
      prepareStartRequest,
      runDraft.displayPrompt,
    );
  } finally {
    startRequestInFlight.current = false;
  }
  return {
    ok: false,
    errorCode: rejection.errorCode,
    error: `${rejection.error}; degraded to a chat prompt pending user approval`,
  };
}

// 답변 재생성(덮어쓰기) — 프롬프트를 regenerate 플래그로 재실행한다.
// 옛 질문+답변을 뷰에서 걷어내고 (수정된) 질문을 낙관적으로 즉시 다시
// 그린다 — 데몬 truncate가 settle에서 같은 결과를 확정한다.
export async function regeneratePromptAction({
  client,
  dispatch,
  clearSessionError,
  prompt,
  promptInputs,
  trimMessagesForRegenerate,
  appendOptimisticUserMessage,
  logCommandFailure,
  prepareStartRequest = prepareRunStartRequest,
}: Omit<RunPromptActionArgs, 'attachments'> & {
  trimMessagesForRegenerate: () => void;
}): Promise<boolean> {
  if (promptInputs.selectedThreadId === null) {
    return false;
  }
  // 옛 질문+답변을 걷어내고, 파이프라인의 낙관적 append가 (수정된) 질문을
  // 즉시 그 자리에 다시 그린다 — 수정 제출 순간 화면이 바뀐다.
  trimMessagesForRegenerate();
  return await runStartActionPipeline(
    client,
    dispatch,
    clearSessionError,
    buildPromptRunRequest({
      prompt,
      ...(promptInputs.workingDirectory !== undefined
        ? { workingDirectory: promptInputs.workingDirectory }
        : {}),
      modelId: promptInputs.modelId,
      selectedThreadId: promptInputs.selectedThreadId,
      permissionMode: promptInputs.permissionMode,
      planModeRequested: promptInputs.planModeRequested,
      planModeIntensity: promptInputs.planModeIntensity,
      planModeDepth: promptInputs.planModeDepth,
      reasoningEffort: promptInputs.reasoningEffort,
      serviceTier: promptInputs.serviceTier,
      ...(promptInputs.providerTransitionRecovery === undefined
        ? {}
        : {
            providerTransitionRecovery: promptInputs.providerTransitionRecovery,
          }),
      subagentModelRouting: promptInputs.subagentModelRouting,
      regenerate: true,
    }),
    appendOptimisticUserMessage,
    logCommandFailure,
    prepareStartRequest,
  );
}

export async function startRunAction({
  client,
  dispatch,
  clearSessionError,
  request,
  modelId,
  permissionMode,
  serviceTier,
  subagentModelRouting,
  appendOptimisticUserMessage,
  optimisticPrompt,
  logCommandFailure,
  prepareStartRequest = prepareRunStartRequest,
}: StartRunActionArgs): Promise<boolean> {
  return await runStartActionPipeline(
    client,
    dispatch,
    clearSessionError,
    buildRunStartRequest({
      request,
      modelId,
      permissionMode,
      serviceTier,
      subagentModelRouting,
    }),
    appendOptimisticUserMessage,
    logCommandFailure,
    prepareStartRequest,
    optimisticPrompt,
  );
}

// 스티어는 즉시 말풍선이 되지 않는다 — 큐 행으로 잡혀 있다가 모델이
// 소비하는 순간(interject_applied) 대화에 합류한다.
export async function interjectPromptAction({
  client,
  dispatch,
  clearSessionError,
  activeRunId,
  threadId,
  prompt,
  logCommandFailure,
}: InterjectPromptActionArgs): Promise<void> {
  clearSessionError();
  try {
    const queued = await client.interject({
      runId: brandRunId(activeRunId),
      text: prompt,
    });
    dispatch({
      type: 'steer_queued',
      runId: activeRunId,
      threadId,
      steer: { receivedSeq: queued.receivedSeq, text: prompt },
    });
  } catch (error: unknown) {
    logCommandFailure('interject failed', getErrorMessage(error));
    throw error;
  }
}

// 대기 중 스티어 즉시 반영 — 데몬이 flushed=true로 답하면 UI 힌트를
// 바꾼다. 큐가 이미 비었으면(경합) 아무 일도 하지 않는 것이 정상 흐름.
export async function flushSteersAction({
  client,
  dispatch,
  activeRunId,
  logCommandFailure,
}: {
  client: InterjectRunClient;
  dispatch: (action: RunSessionStateAction) => void;
  activeRunId: string;
  logCommandFailure: (logContext: string, message: string) => void;
}): Promise<void> {
  try {
    const result = await client.flushInterject({
      runId: brandRunId(activeRunId),
    });
    if (result.flushed) {
      dispatch({ type: 'steer_flush_requested', runId: activeRunId });
    }
  } catch (error: unknown) {
    logCommandFailure('steer flush failed', getErrorMessage(error));
  }
}

// 대기 중 스티어 취소 — 이미 소비됐다면(경합) 큐에서만 지우면 된다.
export async function cancelSteerAction({
  client,
  dispatch,
  activeRunId,
  receivedSeq,
  logCommandFailure,
}: {
  client: InterjectRunClient;
  dispatch: (action: RunSessionStateAction) => void;
  activeRunId: string;
  receivedSeq: number;
  logCommandFailure: (logContext: string, message: string) => void;
}): Promise<void> {
  try {
    const result = await client.cancelInterject({
      runId: brandRunId(activeRunId),
      receivedSeq,
    });
    if (result.cancelled) {
      dispatch({ type: 'steer_cancelled', runId: activeRunId, receivedSeq });
    }
  } catch (error: unknown) {
    logCommandFailure('steer cancel failed', getErrorMessage(error));
  }
}

export async function submitApprovalAction({
  client,
  dispatch,
  clearSessionError,
  pending,
  approved,
  grantScope,
  permissionMode,
  logCommandFailure,
}: ApprovalActionArgs): Promise<void> {
  clearSessionError();
  const result = await submitApprovalDecision({
    client,
    pending,
    approved,
    grantScope,
    ...(permissionMode === undefined ? {} : { permissionMode }),
  });
  if (result.kind === 'approved' || result.kind === 'denied') {
    dispatch({
      type: 'approval_cleared',
      threadId: pending.threadId,
      pendingApproval: pending,
    });
    return;
  }
  if (result.kind === 'failed') {
    logCommandFailure(
      approved ? 'approve failed' : 'deny failed',
      result.message,
    );
    dispatch({
      type: 'approval_submit_failed',
      threadId: pending.threadId,
      message: `[internal] ${result.message}`,
    });
  }
}

export async function cancelRunAction({
  client,
  dispatch,
  clearSessionError,
  cancelState,
  reportSessionFailure,
}: CancelRunActionArgs): Promise<void> {
  clearSessionError();
  const result = await cancelRunSession({
    client,
    activeRunId: cancelState.activeRunId,
    phase: cancelState.phase,
  });
  if (result.kind === 'cancel_failed') {
    reportSessionFailure('cancel failed', result.message);
    return;
  }
  if (result.kind === 'start_cancelled') {
    dispatch({
      type: 'run_start_cancelled',
      threadId: cancelState.activeThreadId,
    });
    dispatch({
      type: 'approval_cleared',
      threadId: cancelState.activeThreadId,
    });
    return;
  }
  if (result.kind === 'reconnect_failed') {
    reportSessionFailure('run channel reconnect failed', result.message);
    dispatch({
      type: 'run_transport_error',
      code: 'internal',
      message: `[internal] ${result.message}`,
    });
  }
}
