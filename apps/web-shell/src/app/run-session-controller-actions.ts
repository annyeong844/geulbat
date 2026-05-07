import { useCallback, useEffect, useRef } from 'react';
import type {
  ApprovalGrantScope,
  ApprovalRequired,
  PermissionMode,
} from '@geulbat/protocol/run-approval';
import type { RunRequest } from '@geulbat/protocol/run-contract';

import {
  buildPromptRunRequest,
  buildRunStartRequest,
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
  dispatch: (action: RunSessionStateAction) => void;
  projectId: string;
  appendOptimisticUserMessage: (prompt: string) => void;
  clearSessionError: () => void;
  reportSessionFailure: (logContext: string, error: unknown) => void;
  logCommandFailure: (logContext: string, message: string) => void;
  promptInputs: PromptActionInputs;
  cancelState: CancelActionState;
}

interface PromptActionInputs {
  selectedThreadId: string | null;
  selectedFile: string | null;
  permissionMode: PermissionMode;
}

interface CancelActionState {
  phase: RunSessionPhase;
  activeRunId: string | null;
}

interface RunPromptActionArgs {
  client: StartRunClient;
  dispatch: (action: RunSessionStateAction) => void;
  clearSessionError: () => void;
  projectId: string;
  prompt: string;
  promptInputs: PromptActionInputs;
  appendOptimisticUserMessage: (prompt: string) => void;
  logCommandFailure: (logContext: string, message: string) => void;
}

interface StartRunActionArgs {
  client: StartRunClient;
  dispatch: (action: RunSessionStateAction) => void;
  clearSessionError: () => void;
  request: RunRequest;
  permissionMode: PermissionMode;
  appendOptimisticUserMessage: (prompt: string) => void;
  optimisticPrompt: string | undefined;
  logCommandFailure: (logContext: string, message: string) => void;
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

async function runStartActionPipeline(
  client: StartRunClient,
  dispatch: (action: RunSessionStateAction) => void,
  clearSessionError: () => void,
  request: RunRequest,
  appendOptimisticUserMessage: (prompt: string) => void,
  logCommandFailure: (logContext: string, message: string) => void,
  optimisticPrompt?: string,
): Promise<void> {
  clearSessionError();
  appendOptimisticUserMessage(
    resolveOptimisticRunPrompt(request, optimisticPrompt),
  );
  dispatch({ type: 'run_start_requested', threadId: request.threadId ?? null });
  const result = await startRunRequestCommand({
    client,
    request,
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
  projectId,
  prompt,
  promptInputs,
  appendOptimisticUserMessage,
  logCommandFailure,
}: RunPromptActionArgs): Promise<void> {
  await runStartActionPipeline(
    client,
    dispatch,
    clearSessionError,
    buildPromptRunRequest({
      prompt,
      projectId,
      selectedThreadId: promptInputs.selectedThreadId,
      selectedFile: promptInputs.selectedFile,
      permissionMode: promptInputs.permissionMode,
    }),
    appendOptimisticUserMessage,
    logCommandFailure,
  );
}

export async function startRunAction({
  client,
  dispatch,
  clearSessionError,
  request,
  permissionMode,
  appendOptimisticUserMessage,
  optimisticPrompt,
  logCommandFailure,
}: StartRunActionArgs): Promise<void> {
  await runStartActionPipeline(
    client,
    dispatch,
    clearSessionError,
    buildRunStartRequest({
      request,
      permissionMode,
    }),
    appendOptimisticUserMessage,
    logCommandFailure,
    optimisticPrompt,
  );
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
  if (result.kind === 'approved') {
    dispatch({ type: 'approval_cleared' });
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
  dispatch,
  projectId,
  appendOptimisticUserMessage,
  clearSessionError,
  reportSessionFailure,
  logCommandFailure,
  promptInputs,
  cancelState,
}: RunSessionControllerActionsArgs) {
  const latestPromptInputsRef = useRef(promptInputs);
  const latestCancelStateRef = useRef(cancelState);

  useEffect(() => {
    latestPromptInputsRef.current = promptInputs;
  }, [promptInputs]);

  useEffect(() => {
    latestCancelStateRef.current = cancelState;
  }, [cancelState]);

  const sendPrompt = useCallback(
    async (prompt: string) => {
      await sendPromptAction({
        client: startClient,
        dispatch,
        clearSessionError,
        projectId,
        prompt,
        promptInputs: latestPromptInputsRef.current,
        appendOptimisticUserMessage,
        logCommandFailure,
      });
    },
    [
      appendOptimisticUserMessage,
      clearSessionError,
      startClient,
      dispatch,
      logCommandFailure,
      projectId,
    ],
  );

  const startRunRequest = useCallback(
    async (request: RunRequest, optimisticPrompt?: string) => {
      await startRunAction({
        client: startClient,
        dispatch,
        clearSessionError,
        request,
        permissionMode: latestPromptInputsRef.current.permissionMode,
        appendOptimisticUserMessage,
        optimisticPrompt,
        logCommandFailure,
      });
    },
    [
      appendOptimisticUserMessage,
      clearSessionError,
      startClient,
      dispatch,
      logCommandFailure,
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
    startRunRequest,
    handleApprove,
    handleDeny,
    handleCancel,
  };
}
