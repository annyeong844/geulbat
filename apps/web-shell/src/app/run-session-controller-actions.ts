import { useCallback, useRef } from 'react';
import type {
  ApprovalGrantScope,
  ApprovalRequired,
  PermissionMode,
} from '@geulbat/protocol/run-approval';
import type {
  RunAck,
  RunAttachmentInput,
  RunRequest,
  RunStartRequest,
} from '@geulbat/protocol/run-contract';
import type { RunToolResultPayload } from '@geulbat/protocol/run-channel';
import { getErrorMessage } from '../lib/error-message.js';

import { brandRunId, brandThreadId } from '../lib/id-brand-helpers.js';

import {
  prepareRunStartRequest,
  type ApprovalDecisionClient as ApprovalDecisionCommandClient,
  type CancelRunSessionClient as CancelRunCommandClient,
  type StartRunCommandClient as StartRunClient,
} from './run-session-commands.js';
import type { RunSessionStateAction } from './run-session-state-types.js';
import {
  cancelRunAction,
  cancelSteerAction,
  degradeWidgetToolRequestAction,
  flushSteersAction,
  interjectPromptAction,
  regeneratePromptAction,
  sendPromptAction,
  startRunAction,
  submitApprovalAction,
  type CancelActionState,
  type ChildRunCancelClient,
  type FrameToolClient,
  type InterjectRunClient,
  type PromptActionInputs,
  type RunToolFailure,
  type WidgetToolRequestIntent,
} from './run-session-controller-action-fns.js';

// 자유 액션 함수 계층은 run-session-controller-action-fns.ts로 이동 —
// 기존 소비자(테스트 포함)를 위해 공개 표면을 재수출로 유지한다.
export {
  cancelSteerAction,
  degradeWidgetToolRequestAction,
  flushSteersAction,
  interjectPromptAction,
  regeneratePromptAction,
  sendPromptAction,
  startRunAction,
} from './run-session-controller-action-fns.js';

interface RunSessionSyncClient {
  connect(): Promise<unknown>;
  getActiveRunForThread(threadId: string | null): RunAck | null;
}

interface RunSessionControllerActionsArgs {
  startClient: StartRunClient & RunSessionSyncClient;
  approvalClient: ApprovalDecisionCommandClient;
  cancelClient: CancelRunCommandClient & ChildRunCancelClient;
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
  onProviderTransitionRecoveryStarted?: () => void;
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
  onProviderTransitionRecoveryStarted,
}: RunSessionControllerActionsArgs) {
  const latestPromptInputsRef = useRef(promptInputs);
  const latestCancelStateRef = useRef(cancelState);
  const startRequestInFlightRef = useRef(false);

  // 이벤트 핸들러는 effect가 실행되기 전에도 클릭될 수 있다. 특히
  // ask_user 직후 running → idle 전환 프레임에서는 한 렌더 늦은 ref가
  // 답변을 종료된 run의 interject로 잘못 보낼 수 있으므로 렌더와 동시에
  // 최신 상태를 공개한다.
  latestPromptInputsRef.current = promptInputs;
  latestCancelStateRef.current = cancelState;

  const sendPromptWithOrigin = useCallback(
    async (
      prompt: string,
      attachments?: RunAttachmentInput[],
      promptOrigin?: 'artifact_frame',
      route: 'interject_or_start' | 'start_only' = 'interject_or_start',
    ) => {
      // 실행 중이면 새 run 대신 스티어링(run.interject)으로 주입한다
      // (스티어링은 텍스트 전용 — 첨부는 새 run에서만 지원)
      const activeRun = latestCancelStateRef.current;
      if (activeRun.phase === 'running' && activeRun.activeRunId !== null) {
        if (route === 'start_only') {
          throw new Error('a new turn cannot start while a run is active');
        }
        const activeThreadId = activeRun.activeThreadId;
        const selectedThreadId = latestPromptInputsRef.current.selectedThreadId;
        if (
          activeThreadId === null ||
          (selectedThreadId !== null && selectedThreadId !== activeThreadId)
        ) {
          const error = new Error('another thread already owns the active run');
          reportSessionFailure('cross-thread steer rejected', error);
          throw error;
        }
        await interjectPromptAction({
          client: interjectClient,
          dispatch,
          clearSessionError,
          activeRunId: activeRun.activeRunId,
          threadId: activeThreadId,
          prompt,
          logCommandFailure,
        });
        return;
      }
      if (activeRun.phase === 'starting' || startRequestInFlightRef.current) {
        if (route === 'start_only') {
          throw new Error('a new turn is already starting');
        }
        return;
      }
      startRequestInFlightRef.current = true;
      try {
        const inputs = latestPromptInputsRef.current;
        try {
          await startClient.connect();
        } catch (error: unknown) {
          const message = getErrorMessage(error);
          logCommandFailure('stream error', message);
          dispatch({
            type: 'run_start_failed',
            threadId: inputs.selectedThreadId,
            message: `[internal] ${message}`,
          });
          if (route === 'start_only') {
            throw error;
          }
          return;
        }
        const synchronizedRun = startClient.getActiveRunForThread(
          inputs.selectedThreadId,
        );
        if (synchronizedRun !== null) {
          dispatch({
            type: 'run_started',
            runId: synchronizedRun.runId,
            threadId: synchronizedRun.threadId,
          });
          if (route === 'start_only') {
            throw new Error(
              'a synchronized run is still active; refusing to steer a new-turn-only prompt',
            );
          }
          await interjectPromptAction({
            client: interjectClient,
            dispatch,
            clearSessionError,
            activeRunId: synchronizedRun.runId,
            threadId: synchronizedRun.threadId,
            prompt,
            logCommandFailure,
          });
          return;
        }
        const started = await sendPromptAction({
          client: startClient,
          dispatch,
          clearSessionError,
          prompt,
          ...(attachments !== undefined ? { attachments } : {}),
          ...(promptOrigin !== undefined ? { promptOrigin } : {}),
          promptInputs: inputs,
          appendOptimisticUserMessage,
          logCommandFailure,
          prepareStartRequest,
        });
        if (!started && route === 'start_only') {
          throw new Error('the new turn did not start');
        }
        if (started && inputs.providerTransitionRecovery !== undefined) {
          onProviderTransitionRecoveryStarted?.();
        }
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
      reportSessionFailure,
      onProviderTransitionRecoveryStarted,
    ],
  );

  const sendPrompt = useCallback(
    async (prompt: string, attachments?: RunAttachmentInput[]) =>
      sendPromptWithOrigin(prompt, attachments),
    [sendPromptWithOrigin],
  );

  // ask_user 답변처럼 이전 run의 후속 사용자 턴이어야 하는 입력은 재연결
  // 동기화가 활성 run을 발견해도 interject로 바꾸지 않는다. 새 턴을 시작할
  // 수 없는 동안은 거부하여 호출자가 답변 UI를 복구하고 다시 시도하게 한다.
  const sendPromptAsNewTurn = useCallback(
    async (prompt: string) =>
      sendPromptWithOrigin(prompt, undefined, undefined, 'start_only'),
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
        const inputs = latestPromptInputsRef.current;
        const started = await regeneratePromptAction({
          client: startClient,
          dispatch,
          clearSessionError,
          prompt,
          promptInputs: inputs,
          trimMessagesForRegenerate,
          appendOptimisticUserMessage,
          logCommandFailure,
          prepareStartRequest,
        });
        if (started && inputs.providerTransitionRecovery !== undefined) {
          onProviderTransitionRecoveryStarted?.();
        }
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
      onProviderTransitionRecoveryStarted,
    ],
  );

  const cancelSteer = useCallback(
    async (receivedSeq: number) => {
      const activeRun = latestCancelStateRef.current;
      if (activeRun.activeRunId === null) {
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
        const requestWithTransitionRecovery =
          inputs.providerTransitionRecovery === undefined ||
          requestWithWorkingDirectory.providerTransitionRecovery !==
            undefined ||
          (requestWithWorkingDirectory.modelId ?? inputs.modelId) !==
            inputs.modelId
            ? requestWithWorkingDirectory
            : {
                ...requestWithWorkingDirectory,
                providerTransitionRecovery: inputs.providerTransitionRecovery,
              };
        const started = await startRunAction({
          client: startClient,
          dispatch,
          clearSessionError,
          request: requestWithTransitionRecovery,
          modelId: inputs.modelId,
          permissionMode: inputs.permissionMode,
          serviceTier: inputs.serviceTier,
          subagentModelRouting: inputs.subagentModelRouting,
          appendOptimisticUserMessage,
          optimisticPrompt,
          logCommandFailure,
          prepareStartRequest,
        });
        if (
          started &&
          requestWithTransitionRecovery.providerTransitionRecovery !== undefined
        ) {
          onProviderTransitionRecoveryStarted?.();
        }
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
      onProviderTransitionRecoveryStarted,
      prepareStartRequest,
    ],
  );

  const handleApprove = useCallback(
    async (
      pending: ApprovalRequired,
      grantScope: ApprovalGrantScope = 'once',
      permissionMode?: PermissionMode,
    ) => {
      await submitApprovalAction({
        client: approvalClient,
        dispatch,
        clearSessionError,
        pending,
        approved: true,
        grantScope,
        ...(permissionMode === undefined ? {} : { permissionMode }),
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

  const stopChildRun = useCallback(
    async (request: { parentRunId: string; childRunId: string }) => {
      try {
        await cancelClient.cancelChild({
          parentRunId: brandRunId(request.parentRunId),
          childRunId: brandRunId(request.childRunId),
        });
      } catch (error: unknown) {
        logCommandFailure('child run cancel failed', getErrorMessage(error));
        throw error;
      }
    },
    [cancelClient, logCommandFailure],
  );

  return {
    sendPrompt,
    sendPromptAsNewTurn,
    sendWidgetPrompt,
    requestWidgetTool,
    regeneratePrompt,
    cancelSteer,
    flushSteers,
    startRunRequest,
    handleApprove,
    handleDeny,
    handleCancel,
    stopChildRun,
  };
}
