import { isDeepStrictEqual } from 'node:util';

import type { GoalRef, GoalSnapshot } from '@geulbat/protocol/goal';
import type { RunId, ThreadId } from '@geulbat/protocol/ids';
import {
  isSamePlanRenderingStamp,
  type ApprovedPlanRef,
  type PlanDraftV1,
  type PlanModeDepth,
  type PlanModeIntensity,
  type PlanningWorkflowSnapshot,
} from '@geulbat/protocol/planning-workflow';
import type { AgentEvent } from '../runtime-contracts.js';
import type { GoalStore } from './goal-store.js';
import type { LiveRunEventStore } from './live-run-events.js';
import type { PlanningWorkflowStore } from './planning-workflow-store.js';
import type {
  RecoverableRunRequest,
  RunCheckpoint,
  RunCheckpointStore,
  RunCheckpointTerminalEvent,
} from './run-checkpoint-store.js';
import type { RunExecutionTemplate } from './run-execution-template.js';

const GOAL_RECOVERY_UNAVAILABLE_MESSAGE =
  'Goal completion admission is unavailable after daemon recovery';

export interface RunExecutionAgentBindings {
  planningWorkflow?: {
    workflowId: string;
    intensity: PlanModeIntensity;
    depth: PlanModeDepth;
  };
  approvedPlan?: {
    ref: ApprovedPlanRef;
    draft: PlanDraftV1;
  };
  goal?: Pick<GoalSnapshot, 'goalId' | 'objective'>;
}

type RunExecutionCheckpointBindings = Pick<
  RecoverableRunRequest,
  'planningWorkflow' | 'approvedPlanRef' | 'goal'
>;

interface RunExecutionLifecycleDependencies {
  planningWorkflows: PlanningWorkflowStore;
  goals: GoalStore;
  runCheckpoints: RunCheckpointStore;
  liveRunEvents: LiveRunEventStore;
  onTerminalSettled?: () => void;
}

interface InitialRunExecutionLifecycleArgs extends RunExecutionLifecycleDependencies {
  kind: 'initial';
  runId: RunId;
  threadId: ThreadId;
  prompt: string;
  executionTemplate: RunExecutionTemplate;
  planning: {
    requested: boolean;
    intensity: PlanModeIntensity | undefined;
    depth: PlanModeDepth | undefined;
    approvedPlanRef?: ApprovedPlanRef;
  };
  goal: {
    requested: boolean;
    ref?: GoalRef;
  };
}

interface RecoveredRunExecutionLifecycleArgs extends RunExecutionLifecycleDependencies {
  kind: 'recovery';
  checkpoint: RunCheckpoint;
}

type CreateRunExecutionLifecycleArgs =
  | InitialRunExecutionLifecycleArgs
  | RecoveredRunExecutionLifecycleArgs;

interface PreparedRunExecution extends RunExecutionAgentBindings {
  planningSnapshot: PlanningWorkflowSnapshot | null;
  goalSnapshot: GoalSnapshot | null;
  checkpointBindings: RunExecutionCheckpointBindings;
  unavailableRecoveredGoal?: GoalSnapshot;
}

interface RunExecutionLifecycle extends RunExecutionAgentBindings {
  readonly planningSnapshot: PlanningWorkflowSnapshot | null;
  readonly goalSnapshot: GoalSnapshot | null;
  readonly checkpointBindings: RunExecutionCheckpointBindings;
  readonly checkpointPrepared: boolean;
  beginDurableExecution(request: RecoverableRunRequest): Promise<void>;
  settleTerminal(event: RunCheckpointTerminalEvent): Promise<void>;
  settleFailure(event: RunCheckpointTerminalEvent): Promise<boolean>;
  settleUnavailableGoalRecovery(): Promise<boolean>;
}

export async function createRunExecutionLifecycle(
  args: CreateRunExecutionLifecycleArgs,
): Promise<RunExecutionLifecycle> {
  const prepared =
    args.kind === 'initial'
      ? await prepareInitialRunExecution(args)
      : await prepareRecoveredRunExecution(args);
  const runId = args.kind === 'initial' ? args.runId : args.checkpoint.runId;
  const threadId =
    args.kind === 'initial' ? args.threadId : args.checkpoint.threadId;
  let checkpointPrepared = false;
  let claimedExecutionSnapshot: PlanningWorkflowSnapshot | undefined;
  let claimEventPublished = false;
  let executionSettlementOk: boolean | undefined;
  let settledExecutionSnapshot: PlanningWorkflowSnapshot | undefined;
  let settlementEventPublished = false;
  let intendedTerminalEvent: RunCheckpointTerminalEvent | undefined;
  let unavailableRecoveryStarted = false;
  let unavailableGoalEventPublished = false;
  let terminalSettlementNotified = false;

  function publishLifecycleEvent(event: AgentEvent): void {
    args.liveRunEvents.publishRunEvent(runId, event);
  }

  async function readCorrelatedCheckpoint(): Promise<RunCheckpoint> {
    const checkpoint = await args.runCheckpoints.readThread(threadId);
    if (checkpoint === null || checkpoint.runId !== runId) {
      throw new Error(`run execution checkpoint is not current: ${runId}`);
    }
    assertCheckpointBindings(
      checkpoint.request,
      prepared.checkpointBindings,
      runId,
    );
    return checkpoint;
  }

  async function claimApprovedExecution(): Promise<void> {
    const approvedPlanRef = prepared.checkpointBindings.approvedPlanRef;
    if (approvedPlanRef === undefined) {
      return;
    }
    if (claimedExecutionSnapshot === undefined) {
      try {
        const claimed = await args.planningWorkflows.claimExecution({
          ref: approvedPlanRef,
          threadId,
          executionRunId: runId,
        });
        claimedExecutionSnapshot = claimed.snapshot;
      } catch (error: unknown) {
        const current = await args.planningWorkflows
          .readApprovedPlan({
            ref: approvedPlanRef,
            threadId,
          })
          .catch(() => {
            throw error;
          });
        if (
          current.snapshot.state !== 'executing' ||
          current.snapshot.executionRunId !== runId
        ) {
          throw error;
        }
        claimedExecutionSnapshot = current.snapshot;
      }
    }
    if (
      !claimEventPublished &&
      args.kind === 'recovery' &&
      args.checkpoint.eventHistory.some(
        ({ event }) =>
          event.type === 'planning_workflow_updated' &&
          isDeepStrictEqual(event.payload, claimedExecutionSnapshot),
      )
    ) {
      claimEventPublished = true;
    }
    if (!claimEventPublished) {
      publishLifecycleEvent({
        type: 'planning_workflow_updated',
        payload: claimedExecutionSnapshot,
      });
      claimEventPublished = true;
    }
  }

  async function settleApprovedExecution(ok: boolean): Promise<void> {
    const approvedPlanRef = prepared.checkpointBindings.approvedPlanRef;
    if (
      approvedPlanRef === undefined ||
      claimedExecutionSnapshot === undefined
    ) {
      return;
    }
    if (executionSettlementOk !== undefined && executionSettlementOk !== ok) {
      throw new Error(`run execution already settled differently: ${runId}`);
    }
    executionSettlementOk = ok;
    if (settledExecutionSnapshot === undefined) {
      try {
        settledExecutionSnapshot =
          await args.planningWorkflows.completeExecution({
            ref: approvedPlanRef,
            threadId,
            executionRunId: runId,
            ok,
          });
      } catch (error: unknown) {
        const current = await args.planningWorkflows
          .readApprovedPlan({
            ref: approvedPlanRef,
            threadId,
          })
          .catch(() => {
            throw error;
          });
        if (
          (current.snapshot.state !== 'completed' &&
            current.snapshot.state !== 'execution_failed') ||
          current.snapshot.executionRunId !== runId ||
          (current.snapshot.state === 'completed') !== ok
        ) {
          throw error;
        }
        settledExecutionSnapshot = current.snapshot;
      }
    }
    if (!settlementEventPublished) {
      publishLifecycleEvent({
        type: 'planning_workflow_updated',
        payload: settledExecutionSnapshot,
      });
      settlementEventPublished = true;
    }
  }

  async function publishUnavailableGoalRecovery(): Promise<void> {
    if (
      prepared.unavailableRecoveredGoal === undefined ||
      unavailableGoalEventPublished
    ) {
      return;
    }
    publishLifecycleEvent({
      type: 'goal_updated',
      payload: prepared.unavailableRecoveredGoal,
    });
    unavailableGoalEventPublished = true;
  }

  async function commitTerminalEvent(
    event: RunCheckpointTerminalEvent,
  ): Promise<void> {
    await args.liveRunEvents.commitTerminalRunEvent({
      runId,
      event,
      async persist(envelope) {
        await args.runCheckpoints.settleRun({
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

  function notifyTerminalSettled(): void {
    if (terminalSettlementNotified) {
      return;
    }
    terminalSettlementNotified = true;
    args.onTerminalSettled?.();
  }

  async function settleTerminal(
    event: RunCheckpointTerminalEvent,
  ): Promise<void> {
    if (
      intendedTerminalEvent !== undefined &&
      !isDeepStrictEqual(intendedTerminalEvent, event)
    ) {
      throw new Error(
        `run terminal event already chosen differently: ${runId}`,
      );
    }
    const checkpoint = await readCorrelatedCheckpoint();
    if (checkpoint.status === 'terminal') {
      if (
        checkpoint.terminal === null ||
        !isDeepStrictEqual(checkpoint.terminal.event, event)
      ) {
        throw new Error(`run terminal checkpoint conflicts: ${runId}`);
      }
      await settleApprovedExecution(event.type === 'done' && event.payload.ok);
      notifyTerminalSettled();
      return;
    }
    if (hasPendingInterject(checkpoint)) {
      throw new Error(`run checkpoint still has pending interjects: ${runId}`);
    }
    intendedTerminalEvent = event;
    await settleApprovedExecution(event.type === 'done' && event.payload.ok);
    await commitTerminalEvent(event);
    notifyTerminalSettled();
  }

  return {
    planningSnapshot: prepared.planningSnapshot,
    goalSnapshot: prepared.goalSnapshot,
    ...(prepared.planningWorkflow === undefined
      ? {}
      : { planningWorkflow: prepared.planningWorkflow }),
    ...(prepared.approvedPlan === undefined
      ? {}
      : { approvedPlan: prepared.approvedPlan }),
    ...(prepared.goal === undefined ? {} : { goal: prepared.goal }),
    checkpointBindings: prepared.checkpointBindings,
    get checkpointPrepared() {
      return checkpointPrepared;
    },
    async beginDurableExecution(request) {
      assertCheckpointBindings(request, prepared.checkpointBindings, runId);
      if (!checkpointPrepared) {
        if (args.kind === 'initial') {
          const started = await args.runCheckpoints.startRun({
            runId,
            threadId,
            request,
          });
          if (!started.ok) {
            throw new Error(
              `recoverable run already exists: ${started.activeRunId}`,
            );
          }
          assertCheckpointBindings(
            started.checkpoint.request,
            prepared.checkpointBindings,
            runId,
          );
        } else {
          const checkpoint = await readCorrelatedCheckpoint();
          if (checkpoint.status !== 'running') {
            throw new Error(`run execution checkpoint is terminal: ${runId}`);
          }
        }
        checkpointPrepared = true;
      }
      await claimApprovedExecution();
    },
    settleTerminal,
    async settleFailure(event) {
      if (!checkpointPrepared) {
        return false;
      }
      const checkpoint = await readCorrelatedCheckpoint();
      if (checkpoint.status === 'terminal') {
        await settleApprovedExecution(
          checkpoint.terminal?.event.type === 'done' &&
            checkpoint.terminal.event.payload.ok,
        );
        notifyTerminalSettled();
        return true;
      }
      if (hasPendingInterject(checkpoint)) {
        return false;
      }
      if (unavailableRecoveryStarted) {
        await publishUnavailableGoalRecovery();
      }
      await settleTerminal(intendedTerminalEvent ?? event);
      return true;
    },
    async settleUnavailableGoalRecovery() {
      if (prepared.unavailableRecoveredGoal === undefined) {
        return false;
      }
      if (!checkpointPrepared) {
        throw new Error(
          `Goal recovery requires a durable run checkpoint: ${runId}`,
        );
      }
      const checkpoint = await readCorrelatedCheckpoint();
      if (checkpoint.status === 'terminal') {
        notifyTerminalSettled();
        return true;
      }
      if (hasPendingInterject(checkpoint)) {
        return true;
      }
      unavailableRecoveryStarted = true;
      intendedTerminalEvent = {
        type: 'error',
        payload: {
          code: 'execution_failed',
          message: GOAL_RECOVERY_UNAVAILABLE_MESSAGE,
        },
      };
      await publishUnavailableGoalRecovery();
      await settleTerminal(intendedTerminalEvent);
      return true;
    },
  };
}

async function prepareInitialRunExecution(
  args: InitialRunExecutionLifecycleArgs,
): Promise<PreparedRunExecution> {
  const planningSnapshot = await args.planningWorkflows.enterOrResume({
    threadId: args.threadId,
    requested: args.planning.requested,
    intensity: args.planning.intensity,
    depth: args.planning.depth,
    executionTemplate: args.executionTemplate,
  });
  let approvedPlan: RunExecutionAgentBindings['approvedPlan'];
  const approvedPlanRef = args.planning.approvedPlanRef;
  if (approvedPlanRef !== undefined) {
    const approved = await args.planningWorkflows.readApprovedPlan({
      threadId: args.threadId,
      ref: approvedPlanRef,
    });
    if (approved.snapshot.state !== 'approved') {
      throw new Error('approved plan execution has already started or settled');
    }
    approvedPlan = { ref: approvedPlanRef, draft: approved.draft };
  } else if (
    planningSnapshot?.state === 'approved' ||
    planningSnapshot?.state === 'executing'
  ) {
    throw new Error(
      'planning workflow requires its exact approved execution handoff',
    );
  }
  const goalSnapshot =
    args.goal.ref === undefined
      ? await args.goals.enterOrResume({
          threadId: args.threadId,
          requested: args.goal.requested,
          objective: args.prompt,
          executionTemplate: args.executionTemplate,
        })
      : await args.goals.resumeForRun({
          threadId: args.threadId,
          ref: args.goal.ref,
          executionTemplate: args.executionTemplate,
        });
  const planningWorkflow =
    approvedPlan === undefined &&
    planningSnapshot !== null &&
    isPlanningRunState(planningSnapshot)
      ? {
          workflowId: planningSnapshot.workflowId,
          intensity: planningSnapshot.intensity,
          depth: planningSnapshot.depth,
        }
      : undefined;
  const goal =
    planningWorkflow === undefined &&
    goalSnapshot !== null &&
    isWorkingGoal(goalSnapshot)
      ? {
          goalId: goalSnapshot.goalId,
          objective: goalSnapshot.objective,
        }
      : undefined;
  return {
    planningSnapshot,
    goalSnapshot,
    ...(planningWorkflow === undefined ? {} : { planningWorkflow }),
    ...(approvedPlan === undefined ? {} : { approvedPlan }),
    ...(goal === undefined ? {} : { goal }),
    checkpointBindings: {
      ...(planningWorkflow === undefined
        ? {}
        : { planningWorkflow: { workflowId: planningWorkflow.workflowId } }),
      ...(approvedPlanRef === undefined ? {} : { approvedPlanRef }),
      ...(goal === undefined ? {} : { goal: { goalId: goal.goalId } }),
    },
  };
}

async function prepareRecoveredRunExecution(
  args: RecoveredRunExecutionLifecycleArgs,
): Promise<PreparedRunExecution> {
  const { checkpoint } = args;
  if (checkpoint.status !== 'running') {
    throw new Error(
      `run execution recovery requires a running checkpoint: ${checkpoint.runId}`,
    );
  }
  let planningSnapshot: PlanningWorkflowSnapshot | null = null;
  let planningWorkflow: RunExecutionAgentBindings['planningWorkflow'];
  if (checkpoint.request.planningWorkflow !== undefined) {
    planningSnapshot = await args.planningWorkflows.readThread(
      checkpoint.threadId,
    );
    if (
      planningSnapshot === null ||
      planningSnapshot.workflowId !==
        checkpoint.request.planningWorkflow.workflowId ||
      !isPlanningRunState(planningSnapshot)
    ) {
      throw new Error('recoverable planning workflow binding is stale');
    }
    planningWorkflow = {
      workflowId: planningSnapshot.workflowId,
      intensity: planningSnapshot.intensity,
      depth: planningSnapshot.depth,
    };
  }
  let approvedPlan: RunExecutionAgentBindings['approvedPlan'];
  if (checkpoint.request.approvedPlanRef !== undefined) {
    const approved = await args.planningWorkflows.readApprovedPlan({
      threadId: checkpoint.threadId,
      ref: checkpoint.request.approvedPlanRef,
    });
    if (
      approved.snapshot.state === 'completed' ||
      approved.snapshot.state === 'execution_failed'
    ) {
      throw new Error('recoverable approved plan execution already settled');
    }
    if (
      approved.snapshot.state === 'executing' &&
      approved.snapshot.executionRunId !== checkpoint.runId
    ) {
      throw new Error(
        'recoverable approved plan execution is claimed by another run',
      );
    }
    approvedPlan = {
      ref: checkpoint.request.approvedPlanRef,
      draft: approved.draft,
    };
  }
  let goalSnapshot: GoalSnapshot | null = null;
  let goal: RunExecutionAgentBindings['goal'];
  let unavailableRecoveredGoal: GoalSnapshot | undefined;
  if (checkpoint.request.goal !== undefined) {
    goalSnapshot = await args.goals.readForRun({
      threadId: checkpoint.threadId,
      ref: checkpoint.request.goal,
    });
    if (
      goalSnapshot === null ||
      (goalSnapshot.state !== 'working' &&
        goalSnapshot.state !== 'continuing' &&
        goalSnapshot.state !== 'verification_unavailable')
    ) {
      throw new Error('recoverable Goal binding is stale');
    }
    goal = {
      goalId: goalSnapshot.goalId,
      objective: goalSnapshot.objective,
    };
    if (goalSnapshot.state === 'verification_unavailable') {
      unavailableRecoveredGoal = goalSnapshot;
    }
  }
  return {
    planningSnapshot,
    goalSnapshot,
    ...(planningWorkflow === undefined ? {} : { planningWorkflow }),
    ...(approvedPlan === undefined ? {} : { approvedPlan }),
    ...(goal === undefined ? {} : { goal }),
    checkpointBindings: {
      ...(checkpoint.request.planningWorkflow === undefined
        ? {}
        : { planningWorkflow: checkpoint.request.planningWorkflow }),
      ...(checkpoint.request.approvedPlanRef === undefined
        ? {}
        : { approvedPlanRef: checkpoint.request.approvedPlanRef }),
      ...(checkpoint.request.goal === undefined
        ? {}
        : { goal: checkpoint.request.goal }),
    },
    ...(unavailableRecoveredGoal === undefined
      ? {}
      : { unavailableRecoveredGoal }),
  };
}

function assertCheckpointBindings(
  request: RecoverableRunRequest,
  expected: RunExecutionCheckpointBindings,
  runId: RunId,
): void {
  if (
    request.planningWorkflow?.workflowId !==
      expected.planningWorkflow?.workflowId ||
    request.goal?.goalId !== expected.goal?.goalId ||
    !sameApprovedPlanRef(request.approvedPlanRef, expected.approvedPlanRef)
  ) {
    throw new Error(`run execution checkpoint binding mismatch: ${runId}`);
  }
}

function sameApprovedPlanRef(
  left: ApprovedPlanRef | undefined,
  right: ApprovedPlanRef | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return isSamePlanRenderingStamp(left, right);
}

function hasPendingInterject(checkpoint: RunCheckpoint): boolean {
  return (
    checkpoint.applyingInterject !== null ||
    checkpoint.pendingInterjects.length > 0
  );
}

function isPlanningRunState(
  snapshot: PlanningWorkflowSnapshot,
): snapshot is Extract<
  PlanningWorkflowSnapshot,
  {
    state: 'collecting' | 'awaiting_approval' | 'approved_pending_publish';
  }
> {
  return (
    snapshot.state === 'collecting' ||
    snapshot.state === 'awaiting_approval' ||
    snapshot.state === 'approved_pending_publish'
  );
}

function isWorkingGoal(
  snapshot: GoalSnapshot,
): snapshot is GoalSnapshot & { state: 'working' | 'continuing' } {
  return snapshot.state === 'working' || snapshot.state === 'continuing';
}
