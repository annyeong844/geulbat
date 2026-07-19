import { useCallback, useEffect, useRef } from 'react';
import type {
  ApprovalGrantScope,
  ApprovalRequired,
  PermissionMode,
} from '@geulbat/protocol/run-approval';
import type {
  RunAttachmentInput,
  RunModelId,
  RunReasoningEffort,
  RunRequest,
  RunStartRequest,
  RunSubagentModelRouting,
} from '@geulbat/protocol/run-contract';
import type {
  RunInterjectRequest,
  RunToolRequest,
  RunToolResultPayload,
} from '@geulbat/protocol/run-channel';
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

interface RunSessionControllerActionsArgs {
  startClient: StartRunClient;
  approvalClient: ApprovalDecisionCommandClient;
  cancelClient: CancelRunCommandClient;
  interjectClient: InterjectRunClient;
  frameToolClient: FrameToolClient;
  dispatch: (action: RunSessionStateAction) => void;
  appendOptimisticUserMessage: (
    prompt: string,
    origin?: 'artifact_frame',
  ) => void;
  trimMessagesForRegenerate: () => void;
  clearSessionError: () => void;
  reportSessionFailure: (logContext: string, error: unknown) => void;
  logCommandFailure: (logContext: string, message: string) => void;
  promptInputs: PromptActionInputs;
  cancelState: CancelActionState;
  prepareStartRequest?: (request: RunRequest) => Promise<RunStartRequest>;
}

interface PromptActionInputs {
  workingDirectory?: string;
  modelId: RunModelId;
  selectedThreadId: string | null;
  permissionMode: PermissionMode;
  reasoningEffort: RunReasoningEffort;
  subagentModelRouting: RunSubagentModelRouting;
}

interface InterjectRunClient {
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

interface FrameToolClient {
  tool(request: RunToolRequest): Promise<RunToolResultPayload>;
}

type RunToolFailure = Extract<RunToolResultPayload, { ok: false }>;

// 위젯/프레임이 올린 도구 호출 의도 — 데이터만 담고, 신뢰 컨텍스트
// (threadId/workingDirectory)는 이 컨트롤러가 주입한다.
interface WidgetToolRequestIntent {
  requestId: string;
  toolName: string;
  args: Record<string, unknown>;
  scopeHandle: string;
}

interface CancelActionState {
  phase: RunSessionPhase;
  activeRunId: string | null;
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
): Promise<void> {
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
      message: `[internal] ${result.message}`,
    });
  }
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
}: RunPromptActionArgs): Promise<void> {
  await runStartActionPipeline(
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
      reasoningEffort: promptInputs.reasoningEffort,
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
    await interjectPromptAction({
      client: interjectClient,
      dispatch,
      clearSessionError,
      activeRunId: cancelState.activeRunId,
      threadId,
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
}): Promise<void> {
  if (promptInputs.selectedThreadId === null) {
    return;
  }
  // 옛 질문+답변을 걷어내고, 파이프라인의 낙관적 append가 (수정된) 질문을
  // 즉시 그 자리에 다시 그린다 — 수정 제출 순간 화면이 바뀐다.
  trimMessagesForRegenerate();
  await runStartActionPipeline(
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
      reasoningEffort: promptInputs.reasoningEffort,
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
  subagentModelRouting,
  appendOptimisticUserMessage,
  optimisticPrompt,
  logCommandFailure,
  prepareStartRequest = prepareRunStartRequest,
}: StartRunActionArgs): Promise<void> {
  await runStartActionPipeline(
    client,
    dispatch,
    clearSessionError,
    buildRunStartRequest({
      request,
      modelId,
      permissionMode,
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
      dispatch({ type: 'steer_flush_requested' });
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
    await client.cancelInterject({
      runId: brandRunId(activeRunId),
      receivedSeq,
    });
    dispatch({ type: 'steer_cancelled', receivedSeq });
  } catch (error: unknown) {
    logCommandFailure('steer cancel failed', getErrorMessage(error));
  }
}

async function submitApprovalAction({
  client,
  dispatch,
  clearSessionError,
  pending,
  approved,
  grantScope,
  logCommandFailure,
}: ApprovalActionArgs): Promise<void> {
  clearSessionError();
  const result = await submitApprovalDecision({
    client,
    pending,
    approved,
    grantScope,
  });
  if (result.kind === 'approved' || result.kind === 'denied') {
    dispatch({ type: 'approval_cleared', pendingApproval: pending });
    return;
  }
  if (result.kind === 'failed') {
    logCommandFailure(
      approved ? 'approve failed' : 'deny failed',
      result.message,
    );
    dispatch({
      type: 'approval_submit_failed',
      message: `[internal] ${result.message}`,
    });
  }
}

async function cancelRunAction({
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
    dispatch({ type: 'run_start_cancelled' });
    dispatch({ type: 'approval_cleared' });
    return;
  }
  if (result.kind === 'reconnect_failed') {
    reportSessionFailure('run channel reconnect failed', result.message);
    dispatch({
      type: 'run_transport_error',
      message: `[internal] ${result.message}`,
    });
  }
}

export function useRunSessionControllerActions({
  startClient,
  approvalClient,
  cancelClient,
  interjectClient,
  frameToolClient,
  dispatch,
  appendOptimisticUserMessage,
  trimMessagesForRegenerate,
  clearSessionError,
  reportSessionFailure,
  logCommandFailure,
  promptInputs,
  cancelState,
  prepareStartRequest = prepareRunStartRequest,
}: RunSessionControllerActionsArgs) {
  const latestPromptInputsRef = useRef(promptInputs);
  const latestCancelStateRef = useRef(cancelState);
  const startRequestInFlightRef = useRef(false);

  useEffect(() => {
    latestPromptInputsRef.current = promptInputs;
  }, [promptInputs]);

  useEffect(() => {
    latestCancelStateRef.current = cancelState;
  }, [cancelState]);

  const sendPromptWithOrigin = useCallback(
    async (
      prompt: string,
      attachments?: RunAttachmentInput[],
      promptOrigin?: 'artifact_frame',
    ) => {
      // 실행 중이면 새 run 대신 스티어링(run.interject)으로 주입한다
      // (스티어링은 텍스트 전용 — 첨부는 새 run에서만 지원)
      const activeRun = latestCancelStateRef.current;
      if (activeRun.phase === 'running' && activeRun.activeRunId !== null) {
        await interjectPromptAction({
          client: interjectClient,
          dispatch,
          clearSessionError,
          activeRunId: activeRun.activeRunId,
          threadId: latestPromptInputsRef.current.selectedThreadId ?? '',
          prompt,
          logCommandFailure,
        });
        return;
      }
      if (activeRun.phase === 'starting' || startRequestInFlightRef.current) {
        return;
      }
      startRequestInFlightRef.current = true;
      try {
        await sendPromptAction({
          client: startClient,
          dispatch,
          clearSessionError,
          prompt,
          ...(attachments !== undefined ? { attachments } : {}),
          ...(promptOrigin !== undefined ? { promptOrigin } : {}),
          promptInputs: latestPromptInputsRef.current,
          appendOptimisticUserMessage,
          logCommandFailure,
          prepareStartRequest,
        });
      } finally {
        startRequestInFlightRef.current = false;
      }
    },
    [
      appendOptimisticUserMessage,
      clearSessionError,
      startClient,
      interjectClient,
      dispatch,
      logCommandFailure,
      prepareStartRequest,
    ],
  );

  const sendPrompt = useCallback(
    async (prompt: string, attachments?: RunAttachmentInput[]) =>
      sendPromptWithOrigin(prompt, attachments),
    [sendPromptWithOrigin],
  );

  // 위젯/아티팩트 프레임 발 request_prompt — 전송 경로는 컴포저와 같지만
  // 턴을 아티팩트 발로 귀속 렌더한다 (은밀한 새 턴 금지, 가시성 불변식).
  const sendWidgetPrompt = useCallback(
    async (prompt: string) =>
      sendPromptWithOrigin(prompt, undefined, 'artifact_frame'),
    [sendPromptWithOrigin],
  );

  const degradeWidgetToolToPrompt = useCallback(
    async (
      request: WidgetToolRequestIntent,
      threadId: string,
      rejection: RunToolFailure,
    ): Promise<RunToolResultPayload> =>
      degradeWidgetToolRequestAction({
        request,
        threadId,
        rejection,
        cancelState: latestCancelStateRef.current,
        startClient,
        interjectClient,
        dispatch,
        clearSessionError,
        appendOptimisticUserMessage,
        logCommandFailure,
        prepareStartRequest,
        startRequestInFlight: startRequestInFlightRef,
        ...(latestPromptInputsRef.current.workingDirectory !== undefined
          ? {
              workingDirectory: latestPromptInputsRef.current.workingDirectory,
            }
          : {}),
      }),
    [
      appendOptimisticUserMessage,
      clearSessionError,
      dispatch,
      interjectClient,
      logCommandFailure,
      prepareStartRequest,
      startClient,
    ],
  );

  // 위젯/아티팩트 프레임 발 도구 호출 — 프레임은 데이터만 주고 신뢰
  // threadId와 사용자가 고른 시작 위치는 여기서 주입한다. 활성 run의 cwd는
  // daemon이 소유하며, 탐색기 위치는 권한이나 cwd가 아니다. 실패는 데이터
  // 응답으로 돌려 pending Promise를 settle한다.
  const requestWidgetTool = useCallback(
    async (request: WidgetToolRequestIntent): Promise<RunToolResultPayload> => {
      const inputs = latestPromptInputsRef.current;
      const threadId = inputs.selectedThreadId;
      if (threadId === null || threadId === '') {
        return {
          ok: false,
          errorCode: 'invalid_args',
          error: 'no active thread for artifact tool call',
        };
      }
      try {
        const result = await frameToolClient.tool({
          threadId: brandThreadId(threadId),
          ...(inputs.workingDirectory !== undefined
            ? { workingDirectory: inputs.workingDirectory }
            : {}),
          toolName: request.toolName,
          args: request.args,
          scopeHandle: request.scopeHandle,
          frameRequestId: request.requestId,
        });
        // 티어 A 밖(승인 필요/서피스 밖) 거부는 티어 B 프롬프트로 강등한다
        if (result.ok === false && result.errorCode === 'approval_required') {
          return await degradeWidgetToolToPrompt(request, threadId, result);
        }
        return result;
      } catch (error: unknown) {
        logCommandFailure('artifact tool call failed', getErrorMessage(error));
        return {
          ok: false,
          errorCode: 'internal',
          error: 'artifact tool call failed',
        };
      }
    },
    [degradeWidgetToolToPrompt, frameToolClient, logCommandFailure],
  );

  const regeneratePrompt = useCallback(
    async (prompt: string) => {
      const activeRun = latestCancelStateRef.current;
      if (
        activeRun.phase === 'running' ||
        activeRun.phase === 'starting' ||
        startRequestInFlightRef.current
      ) {
        return;
      }
      startRequestInFlightRef.current = true;
      try {
        await regeneratePromptAction({
          client: startClient,
          dispatch,
          clearSessionError,
          prompt,
          promptInputs: latestPromptInputsRef.current,
          trimMessagesForRegenerate,
          appendOptimisticUserMessage,
          logCommandFailure,
          prepareStartRequest,
        });
      } finally {
        startRequestInFlightRef.current = false;
      }
    },
    [
      appendOptimisticUserMessage,
      clearSessionError,
      startClient,
      dispatch,
      logCommandFailure,
      prepareStartRequest,
      trimMessagesForRegenerate,
    ],
  );

  const cancelSteer = useCallback(
    async (receivedSeq: number) => {
      const activeRun = latestCancelStateRef.current;
      if (activeRun.activeRunId === null) {
        dispatch({ type: 'steer_cancelled', receivedSeq });
        return;
      }
      await cancelSteerAction({
        client: interjectClient,
        dispatch,
        activeRunId: activeRun.activeRunId,
        receivedSeq,
        logCommandFailure,
      });
    },
    [dispatch, interjectClient, logCommandFailure],
  );

  const flushSteers = useCallback(async () => {
    const activeRun = latestCancelStateRef.current;
    if (activeRun.activeRunId === null) {
      return;
    }
    await flushSteersAction({
      client: interjectClient,
      dispatch,
      activeRunId: activeRun.activeRunId,
      logCommandFailure,
    });
  }, [dispatch, interjectClient, logCommandFailure]);

  const startRunRequest = useCallback(
    async (request: RunRequest, optimisticPrompt?: string) => {
      const activeRun = latestCancelStateRef.current;
      if (activeRun.phase === 'starting' || startRequestInFlightRef.current) {
        return;
      }
      startRequestInFlightRef.current = true;
      try {
        const inputs = latestPromptInputsRef.current;
        const requestWithWorkingDirectory =
          request.workingDirectory !== undefined ||
          inputs.workingDirectory === undefined
            ? request
            : { ...request, workingDirectory: inputs.workingDirectory };
        await startRunAction({
          client: startClient,
          dispatch,
          clearSessionError,
          request: requestWithWorkingDirectory,
          modelId: inputs.modelId,
          permissionMode: inputs.permissionMode,
          subagentModelRouting: inputs.subagentModelRouting,
          appendOptimisticUserMessage,
          optimisticPrompt,
          logCommandFailure,
          prepareStartRequest,
        });
      } finally {
        startRequestInFlightRef.current = false;
      }
    },
    [
      appendOptimisticUserMessage,
      clearSessionError,
      startClient,
      dispatch,
      logCommandFailure,
      prepareStartRequest,
    ],
  );

  const handleApprove = useCallback(
    async (
      pending: ApprovalRequired,
      grantScope: ApprovalGrantScope = 'once',
    ) => {
      await submitApprovalAction({
        client: approvalClient,
        dispatch,
        clearSessionError,
        pending,
        approved: true,
        grantScope,
        logCommandFailure,
      });
    },
    [approvalClient, clearSessionError, dispatch, logCommandFailure],
  );

  const handleDeny = useCallback(
    async (pending: ApprovalRequired) => {
      await submitApprovalAction({
        client: approvalClient,
        dispatch,
        clearSessionError,
        pending,
        approved: false,
        grantScope: 'once',
        logCommandFailure,
      });
    },
    [approvalClient, clearSessionError, dispatch, logCommandFailure],
  );

  const handleCancel = useCallback(async () => {
    await cancelRunAction({
      client: cancelClient,
      dispatch,
      clearSessionError,
      cancelState: latestCancelStateRef.current,
      reportSessionFailure,
    });
  }, [cancelClient, clearSessionError, dispatch, reportSessionFailure]);

  return {
    sendPrompt,
    sendWidgetPrompt,
    requestWidgetTool,
    regeneratePrompt,
    cancelSteer,
    flushSteers,
    startRunRequest,
    handleApprove,
    handleDeny,
    handleCancel,
  };
}
