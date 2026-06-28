import WebSocket from 'ws';
import type { RunStartRequest } from '@geulbat/protocol/run-contract';

import { executeForegroundRun } from '../../../daemon/agent/execute-foreground-run.js';
import type { AgentEvent } from '../../../daemon/agent/events.js';
import type { ApprovalContext } from '../../../daemon/agent/loop-types.js';
import { startManagedRun } from '../../../daemon/agent/runtime/managed-run.js';
import { deleteRunPromptInputRefPath } from '../../../daemon/sessions/prompt-input-ref-store.js';
import { createRunWorkspaceContext } from '../../../daemon/run-workspace-context.js';
import {
  assertRunId as assertValidRunId,
  assertThreadId as assertValidThreadId,
} from '@geulbat/protocol/ids';
import { getErrorMessage } from '../../../daemon/utils/error.js';
import { createLogger } from '@geulbat/shared-utils/logger';
import { sendError, sendRunEvent } from './run-channel-socket.js';
import type { RunChannelRuntimeContext } from './run-channel-runtime-context.js';
import {
  ensureThreadBackgroundSubscription,
  getSocketState,
} from './run-channel-socket-runtime.js';
import { readRunStartRequest } from './run-channel-start-request.js';

const logger = createLogger('run-channel/execute-run');

interface ExecuteRunRequestArgs {
  socket: WebSocket;
  requestId: string;
  request: RunStartRequest;
  allowedToolNames: string[] | undefined;
  runtimeContext: RunChannelRuntimeContext;
}

export async function executeRunRequest({
  socket,
  requestId,
  request,
  allowedToolNames,
  runtimeContext,
}: ExecuteRunRequestArgs): Promise<void> {
  const normalizedRequest = await readRunStartRequest(request, {
    projectRegistry: runtimeContext.projectRegistry,
  });
  if (!normalizedRequest.ok) {
    sendError(
      socket,
      requestId,
      normalizedRequest.status,
      normalizedRequest.code,
      normalizedRequest.message,
    );
    return;
  }
  const {
    prompt,
    transcriptPrompt,
    projectId: resolvedProjectId,
    workspaceRoot,
    currentFile,
    selection,
    requestedThreadId,
    permissionMode,
    promptRef,
  } = normalizedRequest.value;

  const requestLogger = logger.withContext({
    projectId: resolvedProjectId,
    requestId,
    requestedThreadId: requestedThreadId ?? null,
  });
  if (promptRef !== undefined) {
    await deleteRunPromptInputRefAfterUse(promptRef, requestLogger);
  }

  const socketState = getSocketState(socket);
  if (socketState.closed || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  const abortController = new AbortController();
  const startParams = {
    runContext: {
      projectId: resolvedProjectId,
      workspaceRoot,
      ...(requestedThreadId !== undefined
        ? { threadId: requestedThreadId }
        : {}),
    },
    abortController,
  };
  const startedRun = startManagedRun(startParams, {
    activeRuns: runtimeContext.activeRuns,
  });
  if (!startedRun.ok) {
    sendError(
      socket,
      requestId,
      409,
      'conflict_active_run',
      `thread ${startedRun.threadId} already has an active run`,
    );
    return;
  }
  const { runId: rawRunId, threadId: rawThreadId, runState } = startedRun;
  const runId = assertValidRunId(rawRunId);
  const threadId = assertValidThreadId(rawThreadId);
  const runContext = createRunWorkspaceContext({
    threadId,
    projectId: resolvedProjectId,
    workspaceRoot,
  });

  const approvalContext = {
    sessionId: socketState.approvalSessionId,
    permissionMode,
  } satisfies ApprovalContext;
  socketState.activeRunIds.add(runId);
  ensureThreadBackgroundSubscription(socket, threadId, runtimeContext);
  let seq = 0;
  const runLogger = logger.withContext({
    projectId: resolvedProjectId,
    requestId,
    runId,
    threadId,
  });

  try {
    await executeForegroundRun({
      agentInput: {
        runId,
        runContext,
        prompt,
        approvalContext,
        signal: abortController.signal,
        runState,
        runtimeServices: runtimeContext,
        ...(currentFile !== undefined ? { currentFile } : {}),
        ...(selection !== undefined ? { selection } : {}),
        ...(allowedToolNames !== undefined ? { allowedToolNames } : {}),
        onEvent: (agentEvent: AgentEvent) => {
          sendRunEvent(socket, runId, threadId, seq++, agentEvent);
        },
      },
      transcriptPrompt,
    });
  } catch (err: unknown) {
    runLogger.error('unexpected error:', {
      message: getErrorMessage(err),
    });
    sendRunEvent(socket, runId, threadId, seq++, {
      type: 'error',
      payload: { code: 'internal', message: 'internal server error' },
    });
  } finally {
    startedRun.finish();
    socketState.activeRunIds.delete(runId);
  }
}

async function deleteRunPromptInputRefAfterUse(
  input: { promptRef: string; path: string },
  runLogger: ReturnType<typeof logger.withContext>,
): Promise<void> {
  try {
    await deleteRunPromptInputRefPath(input.path);
  } catch (error: unknown) {
    runLogger.warn('failed to delete consumed run prompt ref:', {
      promptRef: input.promptRef,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
