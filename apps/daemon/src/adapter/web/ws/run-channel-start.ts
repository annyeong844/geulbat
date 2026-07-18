import WebSocket from 'ws';
import {
  resolveImageGenerationModelDescriptor,
  resolveRunModelDescriptor,
  resolveVideoGenerationModelDescriptor,
  VIDEO_GENERATION_MODEL_CATALOG,
  type RunStartRequest,
} from '@geulbat/protocol/run-contract';

import { executeForegroundRun } from '../../../daemon/agent/execute-foreground-run.js';
import { loadExistingHistory } from '../../../daemon/agent/loop-history.js';
import { recoverPendingReplaySafeToolCalls } from '../../../daemon/agent/loop-tool-recovery.js';
import type {
  AgentInput,
  ApprovalContext,
} from '../../../daemon/agent/loop-types.js';
import { startManagedRun } from '../../../daemon/agent/runtime/managed-run.js';
import { deleteRunPromptInputRefPath } from '../../../daemon/sessions/prompt-input-ref-store.js';
import { restorePendingInterjectFront } from '../../../daemon/sessions/active-run-interject-buffer.js';
import { loadThreadDetailSnapshot } from '../../../daemon/sessions/thread-detail.js';
import { readTranscriptEntries } from '../../../daemon/sessions/transcript-log.js';
import type {
  RecoverableRunRequest,
  RunCheckpoint,
  RunCheckpointTerminalEvent,
} from '../../../daemon/sessions/run-checkpoint-store.js';
import { createRunContext } from '../../../daemon/run-context.js';
import {
  assertRunId as assertValidRunId,
  assertThreadId as assertValidThreadId,
} from '@geulbat/protocol/ids';
import { getErrorMessage } from '../../../daemon/utils/error.js';
import { createLogger } from '@geulbat/shared-utils/logger';
import { sendError } from './run-channel-socket.js';
import type { RunChannelRuntimeContext } from './run-channel-runtime-context.js';
import {
  createSocketRunEventSink,
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
  const runtimeServices = buildRunScopedRuntimeServices(
    {
      ...(imageGenerationModel === undefined ? {} : { imageGenerationModel }),
      ...(videoGenerationModel === undefined ? {} : { videoGenerationModel }),
      ...(videoGenerationSettings === undefined
        ? {}
        : { videoGenerationSettings }),
    },
    runtimeContext,
  );
  const runProviderModel =
    selectedModel === undefined
      ? {
          providerId: runtimeServices.providerRequestOptions.providerId,
          model: runtimeServices.providerRequestOptions.model,
        }
      : {
          providerId: selectedModel.providerId,
          model: selectedModel.id,
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

  const durableRun = await runtimeContext.runCheckpoints.readThread(threadId);
  if (durableRun?.status === 'running' && durableRun.runId !== runId) {
    startedRun.finish();
    sendError(
      socket,
      requestId,
      409,
      'conflict_active_run',
      `thread ${threadId} has recoverable run ${durableRun.runId}`,
    );
    return;
  }

  const approvalContext = {
    sessionId: socketState.approvalSessionId,
    permissionMode,
  } satisfies ApprovalContext;
  try {
    runtimeContext.liveRunEvents.startRun({
      runId,
      threadId,
      ownerId: socketState.approvalSessionId,
      sink: createSocketRunEventSink(socket),
    });
  } catch (error: unknown) {
    startedRun.finish();
    throw error;
  }
  socketState.activeRunIds.add(runId);
  ensureThreadBackgroundSubscription(socket, threadId, runtimeContext);
  const runLogger = logger.withContext({
    requestId,
    runId,
    threadId,
  });
  let checkpointPrepared = false;
  const recoverableRequest: RecoverableRunRequest = {
    workingDirectory,
    permissionMode,
    providerModel: runProviderModel,
    ...(currentFile === undefined ? {} : { currentFile }),
    ...(selection === undefined ? {} : { selection }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(subagentModelRouting === undefined ? {} : { subagentModelRouting }),
    ...(allowedPublicToolNames === undefined
      ? {}
      : {
          toolSurface: {
            directRegistryNames: [...allowedPublicToolNames],
            allowedRegistryNames: [...allowedPublicToolNames],
          },
        }),
    ...(imageGenerationModel === undefined ? {} : { imageGenerationModel }),
    ...(videoGenerationModel === undefined ? {} : { videoGenerationModel }),
    ...(videoGenerationSettings === undefined
      ? {}
      : { videoGenerationSettings }),
  };

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
        providerModel: runProviderModel,
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
        onEvent: (agentEvent) => {
          runtimeContext.liveRunEvents.publishRunEvent(runId, agentEvent);
        },
      },
      transcriptPrompt,
      async onInputPersisted() {
        const startedCheckpoint = await runtimeContext.runCheckpoints.startRun({
          runId,
          threadId,
          request: recoverableRequest,
        });
        if (!startedCheckpoint.ok) {
          throw new Error(
            `recoverable run already exists: ${startedCheckpoint.activeRunId}`,
          );
        }
        checkpointPrepared = true;
      },
      async onTerminalEvent({ event }) {
        await commitDurableTerminalRunEvent(
          runtimeContext,
          threadId,
          runId,
          event,
        );
      },
    });
  } catch (err: unknown) {
    runLogger.error('unexpected error:', {
      message: getErrorMessage(err),
    });
    if (!checkpointPrepared) {
      sendError(socket, requestId, 500, 'internal', 'internal server error');
    } else {
      const settled = await settleCheckpointAfterRunFailure(
        runtimeContext,
        threadId,
        runId,
        {
          type: 'error',
          payload: { code: 'internal', message: 'internal server error' },
        },
      );
      if (!settled) {
        runLogger.warn(
          'run checkpoint retained because interject recovery is pending',
        );
      }
    }
  } finally {
    runtimeContext.liveRunEvents.finishRun(runId);
    startedRun.finish();
    socketState.activeRunIds.delete(runId);
  }
}

export async function recoverDurableRunsForSocket(
  socket: WebSocket,
  runtimeContext: RunChannelRuntimeContext,
): Promise<number> {
  const terminalCheckpoints =
    await runtimeContext.runCheckpoints.listUnacknowledgedTerminal();
  let recoveredCount = 0;
  for (const checkpoint of terminalCheckpoints) {
    if (
      !runtimeContext.liveRunEvents.hasRun(checkpoint.runId) &&
      (await projectDurableTerminalCheckpoint(
        socket,
        runtimeContext,
        checkpoint,
      ))
    ) {
      recoveredCount += 1;
    }
  }

  const runningCheckpoints = await runtimeContext.runCheckpoints.listRunning();
  const recovered = await Promise.all(
    runningCheckpoints.map(async (checkpoint) => {
      if (runtimeContext.liveRunEvents.hasRun(checkpoint.runId)) {
        return false;
      }
      const reconciled = await reconcilePersistedTerminalCheckpoint(
        runtimeContext,
        checkpoint,
      );
      if (reconciled !== null) {
        return await projectDurableTerminalCheckpoint(
          socket,
          runtimeContext,
          reconciled,
        );
      }
      return await recoverDurableRunForSocket(
        socket,
        runtimeContext,
        checkpoint,
      );
    }),
  );
  return recoveredCount + recovered.filter(Boolean).length;
}

async function reconcilePersistedTerminalCheckpoint(
  runtimeContext: RunChannelRuntimeContext,
  checkpoint: RunCheckpoint,
): Promise<RunCheckpoint | null> {
  if (
    checkpoint.applyingInterject !== null ||
    checkpoint.pendingInterjects.length > 0
  ) {
    return null;
  }
  const transcript = await readTranscriptEntries(
    runtimeContext.homeStateRoot,
    checkpoint.threadId,
  );
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index];
    if (
      entry?.role !== 'assistant' ||
      entry.metadata?.phase !== 'final_answer' ||
      entry.metadata.sourceRunId !== checkpoint.runId
    ) {
      continue;
    }
    return await runtimeContext.runCheckpoints.settleRun({
      threadId: checkpoint.threadId,
      runId: checkpoint.runId,
      terminal: {
        eventCursor: 1,
        event: {
          type: 'done',
          payload: { answer: entry.content, ok: true },
        },
      },
    });
  }
  return null;
}

async function projectDurableTerminalCheckpoint(
  socket: WebSocket,
  runtimeContext: RunChannelRuntimeContext,
  checkpoint: RunCheckpoint,
): Promise<boolean> {
  const socketState = getSocketState(socket);
  const terminal = checkpoint.terminal;
  if (
    terminal === null ||
    terminal.acknowledged ||
    socketState.closed ||
    socket.readyState !== WebSocket.OPEN
  ) {
    return false;
  }
  const sink = createSocketRunEventSink(socket);
  if (terminal.event.type === 'done' && terminal.event.payload.ok) {
    if (terminal.eventCursor < 1) {
      throw new Error(
        `successful terminal checkpoint has no snapshot cursor: ${checkpoint.runId}`,
      );
    }
    const delivered = sink({
      runId: checkpoint.runId,
      threadId: checkpoint.threadId,
      seq: terminal.eventCursor - 1,
      event: {
        type: 'thread_state_persisted',
        payload: await loadThreadDetailSnapshot({
          workspaceRoot: runtimeContext.homeStateRoot,
          threadId: checkpoint.threadId,
        }),
      },
    });
    if (!delivered) {
      return false;
    }
  }
  return sink({
    runId: checkpoint.runId,
    threadId: checkpoint.threadId,
    seq: terminal.eventCursor,
    event: terminal.event,
  });
}

async function recoverDurableRunForSocket(
  socket: WebSocket,
  runtimeContext: RunChannelRuntimeContext,
  checkpoint: RunCheckpoint,
): Promise<boolean> {
  const socketState = getSocketState(socket);
  if (socketState.closed || socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  const abortController = new AbortController();
  const startedRun = startManagedRun(
    {
      runId: checkpoint.runId,
      runContext: {
        threadId: checkpoint.threadId,
        stateRoot: runtimeContext.homeStateRoot,
        workingDirectory: checkpoint.request.workingDirectory,
      },
      abortController,
    },
    { activeRuns: runtimeContext.activeRuns },
  );
  if (!startedRun.ok) {
    return false;
  }
  restorePendingInterjectFront(
    startedRun.runState.interject,
    [
      ...(checkpoint.applyingInterject === null
        ? []
        : [checkpoint.applyingInterject]),
      ...checkpoint.pendingInterjects,
    ],
    checkpoint.interjectSeq,
  );
  const runId = assertValidRunId(startedRun.runId);
  const threadId = assertValidThreadId(startedRun.threadId);
  const runContext = createRunContext({
    threadId,
    stateRoot: runtimeContext.homeStateRoot,
    workingDirectory: checkpoint.request.workingDirectory,
  });
  const approvalContext = {
    sessionId: socketState.approvalSessionId,
    permissionMode: checkpoint.request.permissionMode,
  } satisfies ApprovalContext;
  try {
    runtimeContext.liveRunEvents.startRun({
      runId,
      threadId,
      ownerId: socketState.approvalSessionId,
      sink: createSocketRunEventSink(socket),
    });
  } catch (error: unknown) {
    startedRun.finish();
    throw error;
  }
  socketState.activeRunIds.add(runId);
  ensureThreadBackgroundSubscription(socket, threadId, runtimeContext);
  const runtimeServices = buildRunScopedRuntimeServices(
    checkpoint.request,
    runtimeContext,
  );

  try {
    const agentInput: AgentInput = {
      runId,
      runContext,
      prompt: '',
      approvalContext,
      signal: abortController.signal,
      runState: startedRun.runState,
      runtimeServices,
      ...(checkpoint.request.providerModel === undefined
        ? {}
        : { providerModel: checkpoint.request.providerModel }),
      ...(checkpoint.request.currentFile === undefined
        ? {}
        : { currentFile: checkpoint.request.currentFile }),
      ...(checkpoint.request.selection === undefined
        ? {}
        : { selection: checkpoint.request.selection }),
      ...(checkpoint.request.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: checkpoint.request.reasoningEffort }),
      ...(checkpoint.request.subagentModelRouting === undefined
        ? {}
        : { subagentModelRouting: checkpoint.request.subagentModelRouting }),
      ...(checkpoint.request.toolSurface === undefined
        ? {}
        : { toolSurface: checkpoint.request.toolSurface }),
      onEvent(agentEvent) {
        runtimeContext.liveRunEvents.publishRunEvent(runId, agentEvent);
      },
    };
    const recovered = await recoverPendingReplaySafeToolCalls({ agentInput });
    await executeForegroundRun({
      agentInput: {
        ...agentInput,
        prompt: recovered.modelPrompt,
        historyPort: {
          async loadInitialHistory(args) {
            return await loadExistingHistory(
              args.workspaceRoot,
              args.threadId,
              args.providerTarget,
            );
          },
        },
      },
      transcriptPrompt: recovered.transcriptPrompt,
      resumeModelPrompt: recovered.modelPrompt,
      async onTerminalEvent({ event }) {
        await commitDurableTerminalRunEvent(
          runtimeContext,
          threadId,
          runId,
          event,
        );
      },
    });
  } catch (error: unknown) {
    logger.withContext({ runId, threadId }).error('run recovery failed:', {
      message: getErrorMessage(error),
    });
    const settled = await settleCheckpointAfterRunFailure(
      runtimeContext,
      threadId,
      runId,
      {
        type: 'error',
        payload: { code: 'internal', message: 'run recovery failed' },
      },
    );
    if (!settled) {
      logger
        .withContext({ runId, threadId })
        .warn('run checkpoint retained because interject recovery is pending');
    }
  } finally {
    runtimeContext.liveRunEvents.finishRun(runId);
    startedRun.finish();
    socketState.activeRunIds.delete(runId);
  }
  return true;
}

async function settleCheckpointAfterRunFailure(
  runtimeContext: RunChannelRuntimeContext,
  threadId: RunCheckpoint['threadId'],
  runId: RunCheckpoint['runId'],
  terminalEvent: RunCheckpointTerminalEvent,
): Promise<boolean> {
  const checkpoint = await runtimeContext.runCheckpoints.readThread(threadId);
  if (checkpoint === null || checkpoint.runId !== runId) {
    throw new Error(`run checkpoint not found after failure: ${runId}`);
  }
  if (checkpoint.status === 'terminal') {
    return true;
  }
  if (
    checkpoint.applyingInterject !== null ||
    checkpoint.pendingInterjects.length > 0
  ) {
    return false;
  }
  await commitDurableTerminalRunEvent(
    runtimeContext,
    threadId,
    runId,
    terminalEvent,
  );
  return true;
}

async function commitDurableTerminalRunEvent(
  runtimeContext: RunChannelRuntimeContext,
  threadId: RunCheckpoint['threadId'],
  runId: RunCheckpoint['runId'],
  event: RunCheckpointTerminalEvent,
): Promise<void> {
  await runtimeContext.liveRunEvents.commitTerminalRunEvent({
    runId,
    event,
    async persist(envelope) {
      await runtimeContext.runCheckpoints.settleRun({
        threadId,
        runId,
        terminal: {
          eventCursor: envelope.seq,
          event: envelope.event,
        },
      });
    },
  });
}

function buildRunScopedRuntimeServices(
  request: Pick<
    RecoverableRunRequest,
    'imageGenerationModel' | 'videoGenerationModel' | 'videoGenerationSettings'
  >,
  runtimeContext: RunChannelRuntimeContext,
): RunChannelRuntimeContext {
  const selectedImageModel =
    request.imageGenerationModel === undefined
      ? undefined
      : resolveImageGenerationModelDescriptor(request.imageGenerationModel);
  const selectedVideoModel =
    request.videoGenerationModel === undefined
      ? undefined
      : resolveVideoGenerationModelDescriptor(request.videoGenerationModel);
  const videoDefaults =
    selectedVideoModel === undefined &&
    request.videoGenerationSettings === undefined
      ? undefined
      : {
          model: selectedVideoModel?.id ?? VIDEO_GENERATION_MODEL_CATALOG[0].id,
          ...(request.videoGenerationSettings?.durationSeconds === undefined
            ? {}
            : {
                durationSeconds:
                  request.videoGenerationSettings.durationSeconds,
              }),
          ...(request.videoGenerationSettings?.aspectRatio === undefined
            ? {}
            : { aspectRatio: request.videoGenerationSettings.aspectRatio }),
          ...(request.videoGenerationSettings?.resolution === undefined
            ? {}
            : { resolution: request.videoGenerationSettings.resolution }),
        };
  return {
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
