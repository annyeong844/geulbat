import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  resolveImageGenerationModelDescriptor,
  resolveRunModelDescriptor,
  resolveVideoGenerationModelDescriptor,
  VIDEO_GENERATION_MODEL_CATALOG,
  type RunStartRequest,
} from '@geulbat/protocol/run-contract';
import type { RunEventReplayCursor } from '@geulbat/protocol/run-channel';

import { executeForegroundRun } from '../../../daemon/agent/execute-foreground-run.js';
import { loadExistingHistory } from '../../../daemon/agent/loop-history.js';
import { recoverPendingReplaySafeToolCalls } from '../../../daemon/agent/loop-tool-recovery.js';
import { createAgentToolCapabilityPolicy } from '../../../daemon/agent/loop-tool-library-projection.js';
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
} from '../../../daemon/sessions/run-checkpoint-store.js';
import { createRunExecutionLifecycle } from '../../../daemon/sessions/run-execution-lifecycle.js';
import type { RunExecutionTemplate } from '../../../daemon/sessions/run-execution-template.js';
import { createRunContext } from '../../../daemon/run-context.js';
import {
  assertRunId as assertValidRunId,
  assertThreadId as assertValidThreadId,
  type RunId,
} from '@geulbat/protocol/ids';
import type { AgentEvent } from '../../../daemon/runtime-contracts.js';
import { getErrorMessage } from '../../../daemon/utils/error.js';
import { createLogger } from '@geulbat/structured-logger/logger';
import {
  selectLiveRunReplayEvents,
  type LiveRunEventEnvelope,
  type LiveRunEventStore,
  type LiveRunEventSink,
} from '../../../daemon/sessions/live-run-events.js';
import { sendError, sendMessage } from './run-channel-socket.js';
import type { RunChannelRuntimeContext } from './run-channel-runtime-context.js';
import {
  createSocketRunEventSink,
  ensureThreadBackgroundSubscription,
  getSocketState,
} from './run-channel-socket-runtime.js';
import { readRunStartRequest } from './run-channel-start-request.js';

const logger = createLogger('run-channel/execute-run');

function publishLiveAgentEvent(
  liveRunEvents: LiveRunEventStore,
  runId: RunId,
  event: AgentEvent,
): void {
  if (event.type === 'tool_output_delta') {
    liveRunEvents.publishTransientRunEvent(runId, event);
    return;
  }
  liveRunEvents.publishRunEvent(runId, event);
}

interface ExecuteRunRequestArgs {
  socket: WebSocket;
  requestId: string;
  request: RunStartRequest;
  allowedPublicToolNames: string[] | undefined;
  runtimeContext: RunChannelRuntimeContext;
}

interface DurableRunRecoveryDelivery {
  ownerId: string;
  sink: LiveRunEventSink;
  replayAfterSeq?: number;
  onStarted?: (
    runId: RunCheckpoint['runId'],
    threadId: RunCheckpoint['threadId'],
  ) => void;
  onFinished?: (runId: RunCheckpoint['runId']) => void;
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
    planModeRequested,
    planModeIntensity,
    planModeDepth,
    approvedPlanRef,
    goalModeRequested,
    goalRef,
    ultraReasoning,
    silentPrompt,
    promptOrigin,
    reasoningEffort,
    serviceTier,
    providerTransitionRecovery,
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
          providerId: runtimeServices.provider.requestOptions.providerId,
          model: runtimeServices.provider.requestOptions.model,
        }
      : {
          providerId: selectedModel.providerId,
          model: selectedModel.id,
        };
  const requestedToolSurface =
    allowedPublicToolNames === undefined
      ? undefined
      : {
          directRegistryNames: allowedPublicToolNames,
          allowedRegistryNames: allowedPublicToolNames,
        };
  const requestedToolCapabilityPolicy = createAgentToolCapabilityPolicy({
    registry: runtimeServices.toolRegistry,
    ...(requestedToolSurface === undefined
      ? {}
      : { toolSurface: requestedToolSurface }),
  });

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
  const runExecutionTemplate = {
    workingDirectory,
    ...(modelId === undefined ? {} : { modelId }),
    ...(currentFile === undefined ? {} : { currentFile }),
    ...(selection === undefined ? {} : { selection }),
    ...(allowedPublicToolNames === undefined ? {} : { allowedPublicToolNames }),
    permissionMode,
    ...(reasoningEffort === undefined
      ? {}
      : {
          reasoningEffort: ultraReasoning
            ? ('ultra' as const)
            : reasoningEffort,
        }),
    ...(serviceTier === undefined ? {} : { serviceTier }),
    ...(providerTransitionRecovery === undefined
      ? {}
      : { providerTransitionRecovery }),
    ...(subagentModelRouting === undefined ? {} : { subagentModelRouting }),
    ...(imageGenerationModel === undefined ? {} : { imageGenerationModel }),
    ...(videoGenerationModel === undefined ? {} : { videoGenerationModel }),
    ...(videoGenerationSettings === undefined
      ? {}
      : { videoGenerationSettings }),
  } satisfies RunExecutionTemplate;

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

  let executionLifecycle: Awaited<
    ReturnType<typeof createRunExecutionLifecycle>
  >;
  try {
    executionLifecycle = await createRunExecutionLifecycle({
      kind: 'initial',
      runId,
      threadId,
      prompt,
      executionTemplate: runExecutionTemplate,
      planning: {
        requested: planModeRequested,
        intensity: planModeIntensity,
        depth: planModeDepth,
        ...(approvedPlanRef === undefined ? {} : { approvedPlanRef }),
      },
      goal: {
        requested: goalModeRequested,
        ...(goalRef === undefined ? {} : { ref: goalRef }),
      },
      planningWorkflows: runtimeContext.planningWorkflows,
      goals: runtimeContext.goals,
      runCheckpoints: runtimeContext.runCheckpoints,
      liveRunEvents: runtimeContext.liveRunEvents,
    });
  } catch (error: unknown) {
    startedRun.finish();
    sendError(socket, requestId, 409, 'conflict', getErrorMessage(error));
    return;
  }

  const admittedLoopImplementation =
    await runtimeContext.agent.loopImplementationAdmission
      .admitRun({
        runId,
        threadId,
        stateRoot: runtimeContext.homeStateRoot,
        modelConfiguration: {
          providerId: runProviderModel.providerId,
          model: runProviderModel.model,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          ...(serviceTier === undefined ? {} : { serviceTier }),
        },
        toolCapabilityPolicy: requestedToolCapabilityPolicy,
      })
      .catch((error: unknown) => {
        startedRun.finish();
        throw error;
      });
  if (!admittedLoopImplementation.ok) {
    startedRun.finish();
    sendError(
      socket,
      requestId,
      503,
      'execution_failed',
      admittedLoopImplementation.message,
    );
    return;
  }

  const approvalContext = {
    computerSessionId: socketState.computerSessionId,
    permissionMode,
  } satisfies ApprovalContext;
  try {
    runtimeContext.liveRunEvents.startRun({
      runId,
      threadId,
      ownerId: socketState.computerSessionId,
      sink: createSocketRunEventSink(socket),
      async persistRunEvents(events) {
        await runtimeContext.runCheckpoints.appendRunEvents({
          threadId,
          runId,
          events,
        });
      },
      /**
       * 축출된 저널 구간을 체크포인트에서 되읽는다. 종단 봉투는 메모리에
       * 남으므로(저널 레코드 타입이 done/error를 담지 못한다) 여기서 돌려줄
       * 범위는 항상 저널 대상 구간뿐이다 — 종단 투영을 다시 만들지 않는다.
       */
      async readPersistedRunEvents(throughSeq) {
        const checkpoint =
          await runtimeContext.runCheckpoints.readThread(threadId);
        if (checkpoint === null || checkpoint.runId !== runId) {
          return [];
        }
        return checkpoint.eventHistory.filter(
          (record) => record.seq <= throughSeq,
        );
      },
    });
  } catch (error: unknown) {
    startedRun.finish();
    throw error;
  }
  socketState.activeRunIds.add(runId);
  socketState.ownedRunIds.add(runId);
  ensureThreadBackgroundSubscription(socket, threadId, runtimeContext);
  sendMessage(socket, {
    type: 'plan.workflow',
    threadId,
    snapshot: executionLifecycle.planningSnapshot,
  });
  sendMessage(socket, {
    type: 'goal.state',
    threadId,
    snapshot: executionLifecycle.goalSnapshot,
  });
  const runLogger = logger.withContext({
    requestId,
    runId,
    threadId,
  });
  const recoverableRequest: RecoverableRunRequest = {
    workingDirectory,
    permissionMode,
    ...executionLifecycle.checkpointBindings,
    ultraReasoning,
    loopImplementation: admittedLoopImplementation.identity,
    providerModel: runProviderModel,
    ...(providerTransitionRecovery === undefined
      ? {}
      : { providerTransitionRecovery }),
    ...(currentFile === undefined ? {} : { currentFile }),
    ...(selection === undefined ? {} : { selection }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(serviceTier === undefined ? {} : { serviceTier }),
    ...(subagentModelRouting === undefined ? {} : { subagentModelRouting }),
    ...(admittedLoopImplementation.toolCapabilityPolicy === undefined
      ? requestedToolSurface === undefined
        ? {}
        : {
            toolSurface: {
              directRegistryNames: [
                ...requestedToolSurface.directRegistryNames,
              ],
              allowedRegistryNames: [
                ...requestedToolSurface.allowedRegistryNames,
              ],
            },
          }
      : {
          toolCapabilityPolicy: admittedLoopImplementation.toolCapabilityPolicy,
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
        loopImplementation: admittedLoopImplementation.implementation,
        runtimeServices,
        providerModel: runProviderModel,
        ultraReasoning,
        ...(providerTransitionRecovery === undefined
          ? {}
          : { providerTransitionRecovery }),
        ...(currentFile !== undefined ? { currentFile } : {}),
        ...(executionLifecycle.planningWorkflow === undefined
          ? {}
          : { planningWorkflow: executionLifecycle.planningWorkflow }),
        ...(executionLifecycle.approvedPlan === undefined
          ? {}
          : { approvedPlan: executionLifecycle.approvedPlan }),
        ...(executionLifecycle.goal === undefined
          ? {}
          : { goal: executionLifecycle.goal }),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        ...(serviceTier !== undefined ? { serviceTier } : {}),
        ...(subagentModelRouting !== undefined ? { subagentModelRouting } : {}),
        ...(selection !== undefined ? { selection } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(admittedLoopImplementation.toolCapabilityPolicy === undefined
          ? requestedToolSurface === undefined
            ? {}
            : { toolSurface: requestedToolSurface }
          : {
              toolCapabilityPolicy:
                admittedLoopImplementation.toolCapabilityPolicy,
            }),
        onEvent: (agentEvent) => {
          publishLiveAgentEvent(
            runtimeContext.liveRunEvents,
            runId,
            agentEvent,
          );
        },
      },
      transcriptPrompt,
      async onInputPersisted() {
        await executionLifecycle.beginDurableExecution(recoverableRequest);
      },
      async onTerminalEvent({ event }) {
        await executionLifecycle.settleTerminal(event);
      },
    });
  } catch (err: unknown) {
    runLogger.error('unexpected error:', {
      message: getErrorMessage(err),
    });
    if (!executionLifecycle.checkpointPrepared) {
      sendError(socket, requestId, 500, 'internal', 'internal server error');
    } else {
      const settled = await executionLifecycle.settleFailure({
        type: 'error',
        payload: { code: 'internal', message: 'internal server error' },
      });
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
  runEventCursors?: readonly RunEventReplayCursor[],
): Promise<number> {
  const afterSeqByRun =
    runEventCursors === undefined
      ? undefined
      : new Map(runEventCursors.map((cursor) => [cursor.runId, cursor.seq]));
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
        afterSeqByRun?.get(checkpoint.runId),
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
          afterSeqByRun?.get(reconciled.runId),
        );
      }
      return await recoverDurableRunForSocket(
        socket,
        runtimeContext,
        checkpoint,
        afterSeqByRun?.get(checkpoint.runId),
      );
    }),
  );
  return recoveredCount + recovered.filter(Boolean).length;
}

export async function recoverDurableRunsAtDaemonStartup(
  runtimeContext: RunChannelRuntimeContext,
): Promise<number> {
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
        return true;
      }

      const ownerId = `daemon-recovery:${randomUUID()}`;
      const recovery = await startDurableRunRecovery(
        runtimeContext,
        checkpoint,
        {
          ownerId,
          sink: () => false,
          onStarted() {
            runtimeContext.liveRunEvents.detachOwner(ownerId);
          },
        },
      );
      if (recovery === null) {
        return false;
      }
      void recovery.completion.catch((error: unknown) => {
        logger
          .withContext({
            runId: checkpoint.runId,
            threadId: checkpoint.threadId,
          })
          .error('daemon startup run recovery task failed:', {
            message: getErrorMessage(error),
          });
      });
      return true;
    }),
  );
  return recovered.filter(Boolean).length;
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
        eventCursor:
          checkpoint.eventHistory.length +
          (checkpoint.eventHistory.at(-1)?.event.type ===
          'thread_state_persisted'
            ? 0
            : 1),
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
  replayAfterSeq?: number,
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
  const durableHistory = checkpoint.eventHistory.map(
    ({ seq, event }) =>
      ({
        runId: checkpoint.runId,
        threadId: checkpoint.threadId,
        seq,
        event,
      }) satisfies LiveRunEventEnvelope,
  );
  const needsSyntheticThreadSnapshot =
    terminal.event.type === 'done' &&
    terminal.event.payload.ok &&
    durableHistory.at(-1)?.event.type !== 'thread_state_persisted';
  const shouldSynthesizeThreadSnapshot =
    needsSyntheticThreadSnapshot &&
    (durableHistory.length === 0
      ? terminal.eventCursor >= 1
      : terminal.eventCursor === durableHistory.length + 1);
  if (
    durableHistory.length > 0 &&
    terminal.eventCursor !== durableHistory.length &&
    !shouldSynthesizeThreadSnapshot
  ) {
    throw new Error(
      `run event journal does not reach terminal cursor: ${checkpoint.runId}`,
    );
  }
  const projectionHistory = [...durableHistory];
  if (shouldSynthesizeThreadSnapshot) {
    projectionHistory.push({
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
  }
  const replayEvents = selectLiveRunReplayEvents(
    projectionHistory,
    replayAfterSeq,
  );
  for (const event of replayEvents) {
    if (!sink(event)) {
      return false;
    }
  }
  // A terminal checkpoint remains unacknowledged until the client explicitly
  // acks it, so reconnect always re-delivers the terminal event even when its
  // replay cursor says it was seen immediately before the disconnect.
  const delivered = sink({
    runId: checkpoint.runId,
    threadId: checkpoint.threadId,
    seq: terminal.eventCursor,
    event: terminal.event,
  });
  if (delivered) {
    socketState.ownedRunIds.add(checkpoint.runId);
  }
  return delivered;
}

async function recoverDurableRunForSocket(
  socket: WebSocket,
  runtimeContext: RunChannelRuntimeContext,
  checkpoint: RunCheckpoint,
  replayAfterSeq?: number,
): Promise<boolean> {
  const socketState = getSocketState(socket);
  if (socketState.closed || socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  const recovery = await startDurableRunRecovery(runtimeContext, checkpoint, {
    ownerId: socketState.computerSessionId,
    sink: createSocketRunEventSink(socket),
    ...(replayAfterSeq === undefined ? {} : { replayAfterSeq }),
    onStarted(runId, threadId) {
      socketState.activeRunIds.add(runId);
      socketState.ownedRunIds.add(runId);
      ensureThreadBackgroundSubscription(socket, threadId, runtimeContext);
    },
    onFinished(runId) {
      socketState.activeRunIds.delete(runId);
    },
  });
  if (recovery === null) {
    return false;
  }
  void recovery.completion.catch((error: unknown) => {
    logger
      .withContext({ runId: checkpoint.runId, threadId: checkpoint.threadId })
      .error('socket run recovery task failed:', {
        message: getErrorMessage(error),
      });
  });
  return true;
}

async function startDurableRunRecovery(
  runtimeContext: RunChannelRuntimeContext,
  checkpoint: RunCheckpoint,
  delivery: DurableRunRecoveryDelivery,
): Promise<{ readonly completion: Promise<void> } | null> {
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
    return null;
  }
  const runId = assertValidRunId(startedRun.runId);
  const threadId = assertValidThreadId(startedRun.threadId);
  const runContext = createRunContext({
    threadId,
    stateRoot: runtimeContext.homeStateRoot,
    workingDirectory: checkpoint.request.workingDirectory,
  });
  let executionLifecycle: Awaited<
    ReturnType<typeof createRunExecutionLifecycle>
  >;
  try {
    executionLifecycle = await createRunExecutionLifecycle({
      kind: 'recovery',
      checkpoint,
      planningWorkflows: runtimeContext.planningWorkflows,
      goals: runtimeContext.goals,
      runCheckpoints: runtimeContext.runCheckpoints,
      liveRunEvents: runtimeContext.liveRunEvents,
    });
  } catch (error: unknown) {
    startedRun.finish();
    logger
      .withContext({ runId, threadId })
      .error('run recovery workflow validation failed:', {
        message: getErrorMessage(error),
      });
    return null;
  }
  const recoveryProviderModel = checkpoint.request.providerModel ?? {
    providerId: runtimeContext.provider.requestOptions.providerId,
    model: runtimeContext.provider.requestOptions.model,
  };
  const requestedToolCapabilityPolicy =
    checkpoint.request.toolCapabilityPolicy ??
    createAgentToolCapabilityPolicy({
      registry: runtimeContext.toolRegistry,
      ...(checkpoint.request.toolSurface === undefined
        ? {}
        : { toolSurface: checkpoint.request.toolSurface }),
    });
  let admittedLoopImplementation;
  try {
    admittedLoopImplementation =
      await runtimeContext.agent.loopImplementationAdmission.admitRun({
        runId,
        threadId,
        stateRoot: runtimeContext.homeStateRoot,
        ...(checkpoint.request.loopImplementation === undefined
          ? {}
          : { requiredIdentity: checkpoint.request.loopImplementation }),
        modelConfiguration: {
          providerId: recoveryProviderModel.providerId,
          model: recoveryProviderModel.model,
          ...(checkpoint.request.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: checkpoint.request.reasoningEffort }),
          ...(checkpoint.request.serviceTier === undefined
            ? {}
            : { serviceTier: checkpoint.request.serviceTier }),
        },
        toolCapabilityPolicy: requestedToolCapabilityPolicy,
      });
  } catch (error: unknown) {
    startedRun.finish();
    logger
      .withContext({ runId, threadId })
      .error('run recovery agent loop admission failed:', {
        message: getErrorMessage(error),
      });
    return null;
  }
  if (!admittedLoopImplementation.ok) {
    startedRun.finish();
    logger
      .withContext({ runId, threadId })
      .error('run recovery blocked by agent loop admission:', {
        reason: admittedLoopImplementation.reason,
        implementationId: admittedLoopImplementation.implementationId,
        contractVersion: admittedLoopImplementation.contractVersion ?? null,
        supportedContractVersion:
          admittedLoopImplementation.supportedContractVersion,
      });
    return null;
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
  const approvalContext = {
    computerSessionId: delivery.ownerId,
    permissionMode: checkpoint.request.permissionMode,
  } satisfies ApprovalContext;
  try {
    runtimeContext.liveRunEvents.startRun({
      runId,
      threadId,
      ownerId: delivery.ownerId,
      sink: delivery.sink,
      eventHistory: checkpoint.eventHistory,
      async persistRunEvents(events) {
        await runtimeContext.runCheckpoints.appendRunEvents({
          threadId,
          runId,
          events,
        });
      },
      /**
       * 축출된 저널 구간을 체크포인트에서 되읽는다. 종단 봉투는 메모리에
       * 남으므로(저널 레코드 타입이 done/error를 담지 못한다) 여기서 돌려줄
       * 범위는 항상 저널 대상 구간뿐이다 — 종단 투영을 다시 만들지 않는다.
       */
      async readPersistedRunEvents(throughSeq) {
        const checkpoint =
          await runtimeContext.runCheckpoints.readThread(threadId);
        if (checkpoint === null || checkpoint.runId !== runId) {
          return [];
        }
        return checkpoint.eventHistory.filter(
          (record) => record.seq <= throughSeq,
        );
      },
      ...(delivery.replayAfterSeq === undefined
        ? {}
        : { replayAfterSeq: delivery.replayAfterSeq }),
    });
    await executionLifecycle.beginDurableExecution(checkpoint.request);
    delivery.onStarted?.(runId, threadId);
  } catch (error: unknown) {
    runtimeContext.liveRunEvents.finishRun(runId);
    startedRun.finish();
    throw error;
  }
  const completion = (async () => {
    try {
      if (await executionLifecycle.settleUnavailableGoalRecovery()) {
        return;
      }
      const runtimeServices = buildRunScopedRuntimeServices(
        checkpoint.request,
        runtimeContext,
      );
      const agentInput: AgentInput = {
        runId,
        runContext,
        prompt: '',
        approvalContext,
        signal: abortController.signal,
        runState: startedRun.runState,
        loopImplementation: admittedLoopImplementation.implementation,
        runtimeServices,
        ...(checkpoint.request.providerModel === undefined
          ? {}
          : { providerModel: checkpoint.request.providerModel }),
        ...(checkpoint.request.providerTransitionRecovery === undefined
          ? {}
          : {
              providerTransitionRecovery:
                checkpoint.request.providerTransitionRecovery,
            }),
        ...(checkpoint.request.ultraReasoning === undefined
          ? {}
          : { ultraReasoning: checkpoint.request.ultraReasoning }),
        ...(checkpoint.request.currentFile === undefined
          ? {}
          : { currentFile: checkpoint.request.currentFile }),
        ...(checkpoint.request.selection === undefined
          ? {}
          : { selection: checkpoint.request.selection }),
        ...(checkpoint.request.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: checkpoint.request.reasoningEffort }),
        ...(checkpoint.request.serviceTier === undefined
          ? {}
          : { serviceTier: checkpoint.request.serviceTier }),
        ...(checkpoint.request.subagentModelRouting === undefined
          ? {}
          : { subagentModelRouting: checkpoint.request.subagentModelRouting }),
        ...(admittedLoopImplementation.toolCapabilityPolicy === undefined
          ? checkpoint.request.toolCapabilityPolicy === undefined
            ? checkpoint.request.toolSurface === undefined
              ? {}
              : { toolSurface: checkpoint.request.toolSurface }
            : { toolCapabilityPolicy: checkpoint.request.toolCapabilityPolicy }
          : {
              toolCapabilityPolicy:
                admittedLoopImplementation.toolCapabilityPolicy,
            }),
        ...(executionLifecycle.planningWorkflow === undefined
          ? {}
          : { planningWorkflow: executionLifecycle.planningWorkflow }),
        ...(executionLifecycle.approvedPlan === undefined
          ? {}
          : { approvedPlan: executionLifecycle.approvedPlan }),
        ...(executionLifecycle.goal === undefined
          ? {}
          : { goal: executionLifecycle.goal }),
        onEvent(agentEvent) {
          publishLiveAgentEvent(
            runtimeContext.liveRunEvents,
            runId,
            agentEvent,
          );
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
          await executionLifecycle.settleTerminal(event);
        },
      });
    } catch (error: unknown) {
      logger.withContext({ runId, threadId }).error('run recovery failed:', {
        message: getErrorMessage(error),
      });
      const settled = await executionLifecycle.settleFailure({
        type: 'error',
        payload: { code: 'internal', message: 'run recovery failed' },
      });
      if (!settled) {
        logger
          .withContext({ runId, threadId })
          .warn(
            'run checkpoint retained because interject recovery is pending',
          );
      }
    } finally {
      runtimeContext.liveRunEvents.finishRun(runId);
      startedRun.finish();
      delivery.onFinished?.(runId);
    }
  })();
  return Object.freeze({ completion });
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
