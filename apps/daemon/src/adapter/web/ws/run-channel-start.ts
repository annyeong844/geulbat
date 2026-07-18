import WebSocket from 'ws';
import {
  resolveImageGenerationModelDescriptor,
  resolveRunModelDescriptor,
  resolveVideoGenerationModelDescriptor,
  VIDEO_GENERATION_MODEL_CATALOG,
  type RunStartRequest,
} from '@geulbat/protocol/run-contract';

import { executeForegroundRun } from '../../../daemon/agent/execute-foreground-run.js';
import type { AgentEvent } from '../../../daemon/agent/events.js';
import type { ApprovalContext } from '../../../daemon/agent/loop-types.js';
import { startManagedRun } from '../../../daemon/agent/runtime/managed-run.js';
import { deleteRunPromptInputRefPath } from '../../../daemon/sessions/prompt-input-ref-store.js';
import { createRunContext } from '../../../daemon/run-context.js';
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
  allowedPublicToolNames: string[] | undefined;
  runtimeContext: RunChannelRuntimeContext;
}

export async function executeRunRequest({
  socket,
  requestId,
  request,
  allowedPublicToolNames,
  runtimeContext,
}: ExecuteRunRequestArgs): Promise<void> {
  const normalizedRequest = await readRunStartRequest(request, {
    homeStateRoot: runtimeContext.homeStateRoot,
    ...(runtimeContext.computerFileScope === undefined
      ? {}
      : { computerFileScope: runtimeContext.computerFileScope }),
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
    workingDirectory,
    modelId,
    currentFile,
    selection,
    requestedThreadId,
    permissionMode,
    silentPrompt,
    promptOrigin,
    reasoningEffort,
    subagentModelRouting,
    attachments,
    regenerate,
    imageGenerationModel,
    videoGenerationModel,
    videoGenerationSettings,
    promptRef,
  } = normalizedRequest.value;

  const requestLogger = logger.withContext({
    requestId,
    requestedThreadId: requestedThreadId ?? null,
  });
  if (promptRef !== undefined) {
    await deleteRunPromptInputRefAfterUse(promptRef, requestLogger);
  }
  const selectedModel =
    modelId === undefined ? undefined : resolveRunModelDescriptor(modelId);
  // 사용자의 기본 이미지 모델 — 이 run에만 적용되는 요청 스코프 기본값.
  // 싱글턴 runtimeContext를 변경하지 않는다(동시 run 격리, §4.3).
  const selectedImageModel =
    imageGenerationModel === undefined
      ? undefined
      : resolveImageGenerationModelDescriptor(imageGenerationModel);
  // 동영상도 동일 계약 — 모델·설정 선택을 요청 스코프 파생 런타임으로 주입
  const selectedVideoModel =
    videoGenerationModel === undefined
      ? undefined
      : resolveVideoGenerationModelDescriptor(videoGenerationModel);
  const videoDefaults =
    selectedVideoModel === undefined && videoGenerationSettings === undefined
      ? undefined
      : {
          model: selectedVideoModel?.id ?? VIDEO_GENERATION_MODEL_CATALOG[0].id,
          ...(videoGenerationSettings?.durationSeconds !== undefined
            ? { durationSeconds: videoGenerationSettings.durationSeconds }
            : {}),
          ...(videoGenerationSettings?.aspectRatio !== undefined
            ? { aspectRatio: videoGenerationSettings.aspectRatio }
            : {}),
          ...(videoGenerationSettings?.resolution !== undefined
            ? { resolution: videoGenerationSettings.resolution }
            : {}),
        };
  const runtimeServices = {
    ...runtimeContext,
    ...(selectedImageModel === undefined
      ? {}
      : {
          imageGeneration: runtimeContext.imageGeneration.withRequestDefaults({
            providerId: selectedImageModel.providerId,
            model: selectedImageModel.id,
          }),
        }),
    ...(videoDefaults === undefined
      ? {}
      : {
          videoGeneration:
            runtimeContext.videoGeneration.withRequestDefaults(videoDefaults),
        }),
  };

  const socketState = getSocketState(socket);
  if (socketState.closed || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  const abortController = new AbortController();
  const startParams = {
    runContext: {
      stateRoot: runtimeContext.homeStateRoot,
      workingDirectory,
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
  const runContext = createRunContext({
    threadId,
    stateRoot: runtimeContext.homeStateRoot,
    workingDirectory,
  });

  const approvalContext = {
    sessionId: socketState.approvalSessionId,
    permissionMode,
  } satisfies ApprovalContext;
  socketState.activeRunIds.add(runId);
  ensureThreadBackgroundSubscription(socket, threadId, runtimeContext);
  let seq = 0;
  const runLogger = logger.withContext({
    requestId,
    runId,
    threadId,
  });

  try {
    await executeForegroundRun({
      regenerate,
      silentPrompt,
      ...(promptOrigin !== undefined ? { promptOrigin } : {}),
      agentInput: {
        runId,
        runContext,
        prompt,
        approvalContext,
        signal: abortController.signal,
        runState,
        runtimeServices,
        ...(selectedModel !== undefined
          ? {
              providerModel: {
                providerId: selectedModel.providerId,
                model: selectedModel.id,
              },
            }
          : {}),
        ...(currentFile !== undefined ? { currentFile } : {}),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        ...(subagentModelRouting !== undefined ? { subagentModelRouting } : {}),
        ...(selection !== undefined ? { selection } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(allowedPublicToolNames !== undefined
          ? {
              toolSurface: {
                directRegistryNames: allowedPublicToolNames,
                allowedRegistryNames: allowedPublicToolNames,
              },
            }
          : {}),
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
