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
import { isDeepStrictEqual } from 'node:util';

import {
  VIDEO_GENERATION_MODEL_CATALOG,
  resolveImageGenerationModelDescriptor,
  resolveVideoGenerationModelDescriptor,
} from '@geulbat/protocol/run-contract';
import type { RunId } from '@geulbat/protocol/ids';
import type { ModelSettlementIdentity } from '@geulbat/protocol/thread-metadata';
import { createLogger } from '@geulbat/structured-logger/logger';

import { executeForegroundRun } from './agent/execute-foreground-run.js';
import { loadExistingHistory } from './agent/loop-history.js';
import { createAgentToolCapabilityPolicy } from './agent/loop-tool-library-projection.js';
import { recoverPendingReplaySafeToolCalls } from './agent/loop-tool-recovery.js';
import type { AgentLoopImplementationAdmission } from './agent/loop-implementation-admission.js';
import type { AgentInput, ApprovalContext } from './agent/loop-types.js';
import type { ApprovalGate } from './agent/runtime/approval-gate.js';
import { startManagedRun } from './agent/runtime/managed-run.js';
import { createRunState, type RunState } from './agent/runtime/run-state.js';
import type { AgentRuntimeServices } from './daemon-runtime-contract.js';
import { createRunContext } from './run-context.js';
import type { AgentEvent, ToolRunState } from './runtime-contracts.js';
import {
  resolveSubagentToolSurfaceProfile,
  type BackgroundChildResult,
  type SubagentLaunchRequestInput,
} from './subagent-runtime-contracts.js';
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
const MODEL_ROUND_RECOVERY_OUTCOME_UNKNOWN_MESSAGE =
  'provider request outcome is unknown; explicit recovery is required before retrying';

/**
 * 이 모듈이 런을 실행하려면 필요한 것. 데몬 런타임 서비스 전체에 체크포인트·
 * 라이브 이벤트·상태 루트를 더한 것이고, 그 이상은 요구하지 않는다.
 */
type DurableRunExecutionServices = Omit<
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

export async function recoverDurableRunsAtDaemonStartup(
  runtimeContext: DurableRunExecutionServices,
): Promise<number> {
  let recoveredCount = 0;
  const { running: runningCheckpoints, unacknowledgedTerminal } =
    await runtimeContext.runCheckpoints.listRecoveryCandidates();
  for (const checkpoint of unacknowledgedTerminal) {
    if (checkpoint.request.backgroundChild === undefined) {
      continue;
    }
    const terminal = checkpoint.terminal;
    if (terminal === null) {
      continue;
    }
    const acknowledged =
      await runtimeContext.runCheckpoints.acknowledgeTerminalEvent({
        threadId: checkpoint.threadId,
        runId: checkpoint.runId,
        eventCursor: terminal.eventCursor,
      });
    if (acknowledged.ok) {
      recoveredCount += 1;
    }
  }

  const rootCheckpoints = runningCheckpoints.filter(
    (checkpoint) => checkpoint.request.backgroundChild === undefined,
  );
  const childCheckpoints = runningCheckpoints.filter(
    (checkpoint) => checkpoint.request.backgroundChild !== undefined,
  );
  const runStates = new Map<RunId, ToolRunState>();
  const recoverableParentRunIds = new Set<RunId>();

  for (const checkpoint of rootCheckpoints) {
    if (runtimeContext.liveRunEvents.hasRun(checkpoint.runId)) {
      recoverableParentRunIds.add(checkpoint.runId);
      continue;
    }
    try {
      const reconciled = await reconcilePersistedTerminalCheckpoint(
        runtimeContext,
        checkpoint,
      );
      if (reconciled !== null) {
        recoveredCount += 1;
        continue;
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
        continue;
      }
      runStates.set(checkpoint.runId, recovery.runState);
      recoverableParentRunIds.add(checkpoint.runId);
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
      recoveredCount += 1;
    } catch (error: unknown) {
      logger
        .withContext({
          runId: checkpoint.runId,
          threadId: checkpoint.threadId,
        })
        .error('daemon startup root checkpoint recovery failed:', {
          message: getErrorMessage(error),
        });
    }
  }

  const allChildRunIds = new Set(
    childCheckpoints.map((checkpoint) => checkpoint.runId),
  );
  const terminalHandledChildRunIds = new Set<RunId>();
  for (const checkpoint of childCheckpoints) {
    const durableOutcome =
      runtimeContext.subagent.terminalDeliveries?.readSubagentTerminalOutcomeByChildRunId(
        checkpoint.runId,
      );
    if (durableOutcome === undefined) {
      continue;
    }
    terminalHandledChildRunIds.add(checkpoint.runId);
    try {
      await settleAndAcknowledgeBackgroundChildCheckpoint(
        runtimeContext.runCheckpoints,
        checkpoint,
        durableOutcome.result,
      );
      recoveredCount += 1;
    } catch (error: unknown) {
      logger
        .withContext({
          runId: checkpoint.runId,
          threadId: checkpoint.threadId,
        })
        .error('durable child terminal checkpoint reconciliation failed:', {
          message: getErrorMessage(error),
        });
    }
  }

  const recoverableChildren = new Map<RunId, RecoverableBackgroundChild>();
  for (const checkpoint of childCheckpoints) {
    if (terminalHandledChildRunIds.has(checkpoint.runId)) {
      continue;
    }
    try {
      const reconciled = await reconcilePersistedTerminalCheckpoint(
        runtimeContext,
        checkpoint,
      );
      if (reconciled !== null) {
        terminalHandledChildRunIds.add(checkpoint.runId);
        recoveredCount += 1;
        continue;
      }
    } catch (error: unknown) {
      logger
        .withContext({
          runId: checkpoint.runId,
          threadId: checkpoint.threadId,
        })
        .error('persisted child terminal reconciliation failed:', {
          message: getErrorMessage(error),
        });
      continue;
    }
    const child = readRecoverableBackgroundChild(runtimeContext, checkpoint);
    if (child !== null) {
      recoverableChildren.set(checkpoint.runId, child);
    }
  }

  const recoveredChildRunIds = new Set<RunId>();
  const syntheticParentStates = new Map<RunId, RunState>();
  while (recoverableChildren.size > 0) {
    let progressed = false;
    for (const [childRunId, child] of recoverableChildren) {
      const parentRunId = child.checkpoint.request.backgroundChild?.parentRunId;
      if (parentRunId === undefined) {
        recoverableChildren.delete(childRunId);
        progressed = true;
        continue;
      }
      if (recoverableChildren.has(parentRunId) && !runStates.has(parentRunId)) {
        continue;
      }
      if (
        allChildRunIds.has(parentRunId) &&
        !terminalHandledChildRunIds.has(parentRunId) &&
        !runStates.has(parentRunId)
      ) {
        recoverableChildren.delete(childRunId);
        progressed = true;
        continue;
      }
      const parentRunState =
        runStates.get(parentRunId) ??
        readOrCreateSyntheticParentRunState({
          states: syntheticParentStates,
          child,
        });
      const admission =
        runtimeContext.subagent.admission.reserveSubagentLaunchSlots({
          runState: parentRunState,
          requestedChildren: 1,
          ultraReasoning: child.launchInput.ultraReasoning ?? false,
        });
      recoverableChildren.delete(childRunId);
      progressed = true;
      if (!admission.ok) {
        continue;
      }
      const recoverBackgroundRun =
        runtimeContext.subagent.runs.recoverBackgroundRun;
      if (recoverBackgroundRun === undefined) {
        admission.reservation.release();
        continue;
      }
      const recovery = await recoverBackgroundRun({
        checkpoint: child.checkpoint,
        launchInput: child.launchInput,
        parentRunState,
        runtimeServices: runtimeContext,
        launchReservation: admission.reservation,
      });
      if (recovery === null) {
        continue;
      }
      runStates.set(childRunId, recovery.runState);
      recoveredChildRunIds.add(childRunId);
      recoverableParentRunIds.add(childRunId);
      runDetached('daemon/durable-background-child-recovery', () =>
        recovery.completion.catch((error: unknown) => {
          logger
            .withContext({
              runId: child.checkpoint.runId,
              threadId: child.checkpoint.threadId,
            })
            .error('daemon startup child recovery task failed:', {
              message: getErrorMessage(error),
            });
        }),
      );
      recoveredCount += 1;
    }
    if (!progressed) {
      break;
    }
  }

  runtimeContext.subagent.launchRequests?.reconcileSubagentLaunchesAfterRestart?.(
    {
      recoverableChildRunIds: [...recoveredChildRunIds],
      recoverableParentRunIds: [...recoverableParentRunIds],
    },
  );
  for (const checkpoint of childCheckpoints) {
    if (
      recoveredChildRunIds.has(checkpoint.runId) ||
      terminalHandledChildRunIds.has(checkpoint.runId)
    ) {
      continue;
    }
    const interruptedOutcome =
      runtimeContext.subagent.terminalDeliveries?.readSubagentTerminalOutcomeByChildRunId(
        checkpoint.runId,
      );
    if (interruptedOutcome === undefined) {
      continue;
    }
    try {
      await settleAndAcknowledgeBackgroundChildCheckpoint(
        runtimeContext.runCheckpoints,
        checkpoint,
        interruptedOutcome.result,
      );
    } catch (error: unknown) {
      logger
        .withContext({
          runId: checkpoint.runId,
          threadId: checkpoint.threadId,
        })
        .error('interrupted child checkpoint settlement failed:', {
          message: getErrorMessage(error),
        });
    }
  }
  return recoveredCount;
}

interface RecoverableBackgroundChild {
  checkpoint: RunCheckpoint;
  launchInput: SubagentLaunchRequestInput;
}

function readRecoverableBackgroundChild(
  runtimeContext: DurableRunExecutionServices,
  checkpoint: RunCheckpoint,
): RecoverableBackgroundChild | null {
  const binding = checkpoint.request.backgroundChild;
  const launchStore = runtimeContext.subagent.launchRequests;
  if (binding === undefined || launchStore === undefined) {
    return null;
  }
  try {
    const launch = launchStore.readSubagentLaunchRequestByChildRunId(
      checkpoint.runId,
    );
    if (
      launch === undefined ||
      (launch.launchState !== 'starting' && launch.launchState !== 'started') ||
      launch.childThreadId !== checkpoint.threadId ||
      launch.parentRunId !== binding.parentRunId ||
      launch.ownerThreadId !== binding.ownerThreadId
    ) {
      return null;
    }
    const launchInput = launchStore.readSubagentLaunchInput(checkpoint.runId);
    const expectedPermissionMode = launchInput.permissionMode ?? 'basic';
    const expectedProviderModel =
      launchInput.modelPin.providerRunSelection.providerModel;
    if (
      launchInput.parentRunId !== binding.parentRunId ||
      launchInput.ownerThreadId !== binding.ownerThreadId ||
      launchInput.stateRoot !== runtimeContext.homeStateRoot ||
      launchInput.workingDirectory !== checkpoint.request.workingDirectory ||
      expectedPermissionMode !== checkpoint.request.permissionMode ||
      checkpoint.request.loopImplementation === undefined ||
      (checkpoint.request.toolSurface === undefined &&
        checkpoint.request.toolCapabilityPolicy === undefined) ||
      checkpoint.request.planningWorkflow !== undefined ||
      checkpoint.request.approvedPlanRef !== undefined ||
      checkpoint.request.goal !== undefined ||
      checkpoint.request.providerTransitionRecovery !== undefined ||
      checkpoint.request.currentFile !== undefined ||
      checkpoint.request.selection !== undefined ||
      checkpoint.request.toolLibraryProjectionIdentity !== undefined ||
      checkpoint.request.imageGenerationModel !== undefined ||
      checkpoint.request.videoGenerationModel !== undefined ||
      checkpoint.request.videoGenerationSettings !== undefined ||
      !isDeepStrictEqual(
        checkpoint.request.providerModel,
        expectedProviderModel,
      ) ||
      checkpoint.request.reasoningEffort !==
        launchInput.modelPin.providerRunSelection.reasoningEffort ||
      checkpoint.request.serviceTier !==
        launchInput.modelPin.providerRunSelection.serviceTier ||
      (checkpoint.request.ultraReasoning ?? false) !==
        (launchInput.ultraReasoning ?? false) ||
      !isDeepStrictEqual(
        checkpoint.request.subagentModelRouting,
        launchInput.subagentModelRouting,
      )
    ) {
      return null;
    }
    return { checkpoint, launchInput };
  } catch (error: unknown) {
    logger
      .withContext({ runId: checkpoint.runId, threadId: checkpoint.threadId })
      .error('durable child checkpoint correlation failed:', {
        message: getErrorMessage(error),
      });
    return null;
  }
}

function readOrCreateSyntheticParentRunState(args: {
  states: Map<RunId, RunState>;
  child: RecoverableBackgroundChild;
}): RunState {
  const binding = args.child.checkpoint.request.backgroundChild;
  if (binding === undefined) {
    throw new Error('recoverable child binding disappeared');
  }
  const existing = args.states.get(binding.parentRunId);
  if (existing !== undefined) {
    return existing;
  }
  const created = createRunState({
    runId: binding.parentRunId,
    runContext: createRunContext({
      threadId: binding.ownerThreadId,
      stateRoot: args.child.launchInput.stateRoot,
      ...(args.child.launchInput.workingDirectory === undefined
        ? {}
        : { workingDirectory: args.child.launchInput.workingDirectory }),
    }),
  });
  args.states.set(binding.parentRunId, created);
  return created;
}

async function settleAndAcknowledgeBackgroundChildCheckpoint(
  runCheckpoints: RunCheckpointStore,
  checkpoint: RunCheckpoint,
  result: BackgroundChildResult,
  modelSettlementIdentity?: ModelSettlementIdentity,
): Promise<RunCheckpoint> {
  const settled = await runCheckpoints.settleRun({
    threadId: checkpoint.threadId,
    runId: checkpoint.runId,
    terminal: {
      eventCursor: 0,
      event: {
        type: 'done',
        payload: {
          answer: result.result,
          ok: result.terminalState === 'completed',
        },
      },
      ...(modelSettlementIdentity === undefined
        ? {}
        : { modelSettlementIdentity }),
    },
  });
  const acknowledged = await runCheckpoints.acknowledgeTerminalEvent({
    threadId: checkpoint.threadId,
    runId: checkpoint.runId,
    eventCursor: settled.terminal?.eventCursor ?? 0,
  });
  if (!acknowledged.ok) {
    throw new Error(
      `durable child terminal acknowledgement failed: ${acknowledged.code}`,
    );
  }
  return acknowledged.checkpoint;
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
    if (checkpoint.request.backgroundChild !== undefined) {
      const child = readRecoverableBackgroundChild(runtimeContext, checkpoint);
      if (child === null) {
        return null;
      }
      const terminalStore = runtimeContext.subagent.terminalDeliveries;
      const launchStore = runtimeContext.subagent.launchRequests;
      if (terminalStore === undefined || launchStore === undefined) {
        throw new Error(
          `durable child terminal store is unavailable: ${checkpoint.runId}`,
        );
      }
      const launch = launchStore.readSubagentLaunchRequestByChildRunId(
        checkpoint.runId,
      );
      if (launch === undefined) {
        throw new Error(
          `durable child launch disappeared: ${checkpoint.runId}`,
        );
      }
      // A final-answer transcript proves that the child loop reached its
      // terminal persistence step, but it does not preserve whether the
      // original outcome was completed, failed, or cancelled. Preserve the
      // exact prose, refuse a duplicate model/tool replay, and classify the
      // lost terminal envelope fail-closed.
      const recorded = terminalStore.recordSubagentTerminalDelivery({
        ownerThreadId: child.launchInput.ownerThreadId,
        result: {
          deliveryId: randomUUID(),
          parentRunId: child.launchInput.parentRunId,
          childRunId: checkpoint.runId,
          childThreadId: checkpoint.threadId,
          subagentType: child.launchInput.subagentType,
          capabilities: child.launchInput.capabilities,
          toolSurface: resolveSubagentToolSurfaceProfile({
            subagentType: child.launchInput.subagentType,
            capabilities: child.launchInput.capabilities,
          }),
          runtime: launch.runtime,
          terminalState: 'failed',
          reason: 'daemon_restart',
          result: entry.content,
          completedAt: entry.timestamp,
          modelId: child.launchInput.modelPin.modelId,
          reasoningEffort:
            child.launchInput.modelPin.providerRunSelection.reasoningEffort,
        },
      });
      return await settleAndAcknowledgeBackgroundChildCheckpoint(
        runtimeContext.runCheckpoints,
        checkpoint,
        recorded.outcome.result,
        entry.metadata.modelSettlementIdentity,
      );
    }
    return await runtimeContext.runCheckpoints.settleRun({
      threadId: checkpoint.threadId,
      runId: checkpoint.runId,
      terminal: {
        eventCursor:
          checkpoint.eventHistory.length +
          (checkpoint.eventHistory.at(-1)?.event.type ===
            'thread_state_persisted' ||
          checkpoint.eventHistory.at(-1)?.event.type ===
            'thread_state_delta_persisted'
            ? 0
            : 1),
        event: {
          type: 'done',
          payload: { answer: entry.content, ok: true },
        },
        ...(entry.metadata.modelSettlementIdentity === undefined
          ? {}
          : {
              modelSettlementIdentity: entry.metadata.modelSettlementIdentity,
            }),
      },
    });
  }
  return null;
}

export async function startDurableRunRecovery(
  runtimeContext: DurableRunExecutionServices,
  checkpoint: RunCheckpoint,
  delivery: DurableRunRecoveryDelivery,
): Promise<{
  readonly completion: Promise<void>;
  readonly runState: RunState;
} | null> {
  const abortController = new AbortController();
  const startedRun = startManagedRun(
    {
      runId: checkpoint.runId,
      runContext: {
        threadId: checkpoint.threadId,
        stateRoot: runtimeContext.homeStateRoot,
        ...(checkpoint.request.workingDirectory === undefined
          ? {}
          : { workingDirectory: checkpoint.request.workingDirectory }),
      },
      abortController,
    },
    { activeRuns: runtimeContext.activeRuns },
  );
  if (!startedRun.ok) {
    return null;
  }
  if (
    checkpoint.modelRoundState === null ||
    runtimeContext.runCheckpoints.claimActiveModelRound === undefined
  ) {
    await settleUnavailableModelRoundBoundary(
      runtimeContext,
      checkpoint,
      delivery,
    );
    startedRun.finish();
    logger
      .withContext({
        runId: checkpoint.runId,
        threadId: checkpoint.threadId,
      })
      .error('run recovery model round boundary is unavailable:', {
        code: 'llm_provider_request_outcome_unknown',
      });
    return null;
  }
  const modelRoundClaimId = randomUUID();
  const claimedModelRound =
    await runtimeContext.runCheckpoints.claimActiveModelRound({
      threadId: checkpoint.threadId,
      runId: checkpoint.runId,
      claimId: modelRoundClaimId,
    });
  if (
    !claimedModelRound.ok ||
    claimedModelRound.checkpoint.modelRoundState === null
  ) {
    startedRun.finish();
    logger
      .withContext({
        runId: checkpoint.runId,
        threadId: checkpoint.threadId,
      })
      .error('run recovery model round claim failed:', {
        code: 'llm_provider_request_outcome_unknown',
        reason: claimedModelRound.ok
          ? 'model_round_unavailable'
          : claimedModelRound.code,
      });
    return null;
  }
  const claimedModelRoundState = claimedModelRound.checkpoint.modelRoundState;
  const runId = assertValidRunId(startedRun.runId);
  const threadId = assertValidThreadId(startedRun.threadId);
  const runContext = createRunContext({
    threadId,
    stateRoot: runtimeContext.homeStateRoot,
    ...(checkpoint.request.workingDirectory === undefined
      ? {}
      : { workingDirectory: checkpoint.request.workingDirectory }),
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
        modelRoundRecovery: {
          claimId: modelRoundClaimId,
          state: claimedModelRoundState,
        },
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
  return Object.freeze({ completion, runState: startedRun.runState });
}

async function settleUnavailableModelRoundBoundary(
  runtimeContext: DurableRunExecutionServices,
  checkpoint: RunCheckpoint,
  delivery: DurableRunRecoveryDelivery,
): Promise<void> {
  const event = {
    type: 'error',
    payload: {
      code: 'llm_provider_request_outcome_unknown',
      message: MODEL_ROUND_RECOVERY_OUTCOME_UNKNOWN_MESSAGE,
    },
  } as const;
  runtimeContext.liveRunEvents.startRun({
    runId: checkpoint.runId,
    threadId: checkpoint.threadId,
    ownerId: delivery.ownerId,
    sink: delivery.sink,
    eventHistory: checkpoint.eventHistory,
    async persistRunEvents(events) {
      await runtimeContext.runCheckpoints.appendRunEvents({
        threadId: checkpoint.threadId,
        runId: checkpoint.runId,
        events,
      });
    },
    async readPersistedRunEvents(throughSeq) {
      const current = await runtimeContext.runCheckpoints.readThread(
        checkpoint.threadId,
      );
      if (current === null || current.runId !== checkpoint.runId) {
        return [];
      }
      return current.eventHistory.filter((record) => record.seq <= throughSeq);
    },
    ...(delivery.replayAfterSeq === undefined
      ? {}
      : { replayAfterSeq: delivery.replayAfterSeq }),
  });
  try {
    await runtimeContext.liveRunEvents.commitTerminalRunEvent({
      runId: checkpoint.runId,
      event,
      async persist(envelope) {
        await runtimeContext.runCheckpoints.settleRun({
          threadId: checkpoint.threadId,
          runId: checkpoint.runId,
          terminal: {
            eventCursor: envelope.seq,
            event: envelope.event,
          },
        });
      },
    });
    runtimeContext.approvalGate.clearRunRuntime(
      delivery.ownerId,
      checkpoint.runId,
    );
  } finally {
    runtimeContext.liveRunEvents.finishRun(checkpoint.runId);
  }
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
