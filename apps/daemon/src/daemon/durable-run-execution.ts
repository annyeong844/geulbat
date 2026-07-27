// 체크포인트를 근거로 **런을 실행하고 이어가는 일**을 소유한다.
//
// 이 코드는 오래 `adapter/web/ws/run-channel-start.ts` 안에 있었지만, 소비자가
// 이미 둘이고 그중 하나는 어댑터가 아니다: 웹소켓 채널은 재접속 시 재개를
// 부르고, `host.ts`(daemon-entry)는 부팅 시 복구를 부른다. 그리고 이 코드가
// 쓰는 서비스는 전부 데몬 런타임의 것이다 — 소켓도, `artifactFrameToolDispatch`
// 같은 채널 전용 표면도 쓰지 않는다. 그래서 소유를 데몬으로 내렸다.
//
// 아래 `DurableRunExecutionServices`가 이 모듈의 요구를 명시한다. 어댑터
// 컨텍스트는 이것의 상위집합이므로 그대로 넘길 수 있고, 반대로 이 모듈은
// 어댑터 타입을 알지 못한다. 그것이 경계다.

import { randomUUID } from 'node:crypto';

import {
  VIDEO_GENERATION_MODEL_CATALOG,
  resolveImageGenerationModelDescriptor,
  resolveVideoGenerationModelDescriptor,
} from '@geulbat/protocol/run-contract';
import type { RunId } from '@geulbat/protocol/ids';
import { createLogger } from '@geulbat/structured-logger/logger';

import { executeForegroundRun } from './agent/execute-foreground-run.js';
import { loadExistingHistory } from './agent/loop-history.js';
import { createAgentToolCapabilityPolicy } from './agent/loop-tool-library-projection.js';
import { recoverPendingReplaySafeToolCalls } from './agent/loop-tool-recovery.js';
import type { AgentLoopImplementationAdmission } from './agent/loop-implementation-admission.js';
import type { AgentInput, ApprovalContext } from './agent/loop-types.js';
import type { ApprovalGate } from './agent/runtime/approval-gate.js';
import { startManagedRun } from './agent/runtime/managed-run.js';
import type { AgentRuntimeServices } from './daemon-runtime-contract.js';
import { createRunContext } from './run-context.js';
import type { AgentEvent } from './runtime-contracts.js';
import { restorePendingInterjectFront } from './sessions/active-run-interject-buffer.js';
import {
  assertSessionRunId as assertValidRunId,
  assertSessionThreadId as assertValidThreadId,
} from './sessions/contract.js';
import type {
  LiveRunEventSink,
  LiveRunEventStore,
} from './sessions/live-run-events.js';
import type {
  RecoverableRunRequest,
  RunCheckpoint,
  RunCheckpointStore,
} from './sessions/run-checkpoint-store.js';
import { createRunExecutionLifecycle } from './sessions/run-execution-lifecycle.js';
import { readTranscriptEntries } from './sessions/transcript-log.js';
import { getErrorMessage } from './utils/error.js';
import { runDetached } from './utils/run-detached.js';

const logger = createLogger('daemon/durable-run-execution');

/**
 * 이 모듈이 런을 실행하려면 필요한 것. 데몬 런타임 서비스 전체에 체크포인트·
 * 라이브 이벤트·상태 루트를 더한 것이고, 그 이상은 요구하지 않는다.
 */
export type DurableRunExecutionServices = Omit<
  AgentRuntimeServices,
  'agent' | 'approvalGate'
> & {
  /** 런을 실행하려면 어느 loop 구현이 허가됐는지 알아야 한다. */
  agent: AgentRuntimeServices['agent'] & {
    loopImplementationAdmission: AgentLoopImplementationAdmission;
  };
  /** 승인 대기뿐 아니라, 런이 정착하면 그 런타임을 놓아주어야 한다. */
  approvalGate: AgentRuntimeServices['approvalGate'] &
    Pick<ApprovalGate, 'clearRunRuntime'>;
  homeStateRoot: string;
  liveRunEvents: LiveRunEventStore;
  runCheckpoints: RunCheckpointStore;
};

export function publishLiveAgentEvent(
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

export interface DurableRunRecoveryDelivery {
  ownerId: string;
  sink: LiveRunEventSink;
  replayAfterSeq?: number;
  onStarted?: (
    runId: RunCheckpoint['runId'],
    threadId: RunCheckpoint['threadId'],
  ) => void;
  onFinished?: (runId: RunCheckpoint['runId']) => void;
}

export async function recoverDurableRunsAtDaemonStartup(
  runtimeContext: DurableRunExecutionServices,
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
      // 부팅 복구는 클라이언트 없이 진행되므로, 실패가 데몬 프로세스를 끝내지
      // 않고 이 소유자에게 귀속되도록 runDetached로 넘긴다.
      runDetached('daemon/durable-run-recovery', () =>
        recovery.completion.catch((error: unknown) => {
          logger
            .withContext({
              runId: checkpoint.runId,
              threadId: checkpoint.threadId,
            })
            .error('daemon startup run recovery task failed:', {
              message: getErrorMessage(error),
            });
        }),
      );
      return true;
    }),
  );
  return recovered.filter(Boolean).length;
}

export async function reconcilePersistedTerminalCheckpoint(
  runtimeContext: DurableRunExecutionServices,
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

export async function startDurableRunRecovery(
  runtimeContext: DurableRunExecutionServices,
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
      onTerminalSettled() {
        runtimeContext.approvalGate.clearRunRuntime(delivery.ownerId, runId);
      },
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
        ...(checkpoint.request.toolLibraryProjectionIdentity === undefined
          ? {}
          : {
              toolLibraryProjectionIdentity:
                checkpoint.request.toolLibraryProjectionIdentity,
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

export function buildRunScopedRuntimeServices(
  request: Pick<
    RecoverableRunRequest,
    'imageGenerationModel' | 'videoGenerationModel' | 'videoGenerationSettings'
  >,
  runtimeContext: DurableRunExecutionServices,
): DurableRunExecutionServices {
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
