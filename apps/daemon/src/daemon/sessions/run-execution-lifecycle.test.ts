import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assertRunId, type RunId, type ThreadId } from '@geulbat/protocol/ids';
import type {
  ApprovedPlanRef,
  PlanDraftV1,
} from '@geulbat/protocol/planning-workflow';
import { testThreadId } from '../../test-support/thread-id.js';
import type { AgentEvent } from '../runtime-contracts.js';
import { createGoalStore } from './goal-store.js';
import {
  createLiveRunEventStore,
  type LiveRunEventStore,
} from './live-run-events.js';
import {
  createPlanningWorkflowStore,
  type PlanningWorkflowStore,
} from './planning-workflow-store.js';
import {
  createRunCheckpointStore,
  type RecoverableRunRequest,
  type RunCheckpoint,
  type RunCheckpointStore,
} from './run-checkpoint-store.js';
import { createRunExecutionLifecycle } from './run-execution-lifecycle.js';

const executionTemplate = {
  workingDirectory: '/workspace',
  permissionMode: 'basic' as const,
};

function planDraft(): PlanDraftV1 {
  return {
    schemaVersion: 'plan_draft_v1',
    outcome: 'Keep one run execution lifecycle owner',
    steps: [
      {
        id: 'lifecycle-owner',
        text: 'Unify initial and recovery transitions',
        acceptanceCriteria: ['Claim and settle exactly once'],
      },
    ],
    decisions: [{ text: 'Keep state policy in daemon', settledBy: 'agent' }],
    assumptions: ['The durable checkpoint remains the recovery boundary'],
    openQuestions: [],
  };
}

async function approvePlan(
  planningWorkflows: PlanningWorkflowStore,
  threadId: ThreadId,
  proposalRunId: RunId,
): Promise<ApprovedPlanRef> {
  await planningWorkflows.enterOrResume({
    threadId,
    requested: true,
    intensity: 'quiet',
    depth: 'standard',
    executionTemplate,
  });
  const proposed = await planningWorkflows.propose({
    threadId,
    proposalRunId,
    draft: planDraft(),
  });
  const approved = await planningWorkflows.applyCommand({
    kind: 'approve',
    threadId,
    workflowId: proposed.workflowId,
    planId: proposed.planId,
    revision: proposed.revision,
    digest: proposed.digest,
  });
  if (approved.approvedPlanRef === undefined) {
    throw new Error('expected approved plan reference');
  }
  return approved.approvedPlanRef;
}

function startLiveDelivery(args: {
  liveRunEvents: LiveRunEventStore;
  runCheckpoints: RunCheckpointStore;
  runId: RunId;
  threadId: ThreadId;
  checkpoint?: RunCheckpoint;
}): AgentEvent[] {
  const delivered: AgentEvent[] = [];
  args.liveRunEvents.startRun({
    runId: args.runId,
    threadId: args.threadId,
    ownerId: 'run-execution-lifecycle-test',
    sink(envelope) {
      delivered.push(envelope.event);
      return true;
    },
    ...(args.checkpoint === undefined
      ? {}
      : { eventHistory: args.checkpoint.eventHistory }),
    async persistRunEvents(events) {
      await args.runCheckpoints.appendRunEvents({
        threadId: args.threadId,
        runId: args.runId,
        events,
      });
    },
  });
  return delivered;
}

void test('initial lifecycle derives plan and Goal bindings, claims after checkpoint persistence, and settles once', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'run-lifecycle-initial-'));
  t.after(async () => await rm(stateRoot, { recursive: true, force: true }));
  const planningWorkflows = createPlanningWorkflowStore({ stateRoot });
  const goals = createGoalStore({ stateRoot });
  const runCheckpoints = createRunCheckpointStore({ stateRoot });
  const liveRunEvents = createLiveRunEventStore();
  const threadId = testThreadId(501);
  const runId = assertRunId('run-lifecycle-initial');
  const approvedPlanRef = await approvePlan(
    planningWorkflows,
    threadId,
    assertRunId('run-lifecycle-initial-proposal'),
  );
  const lifecycle = await createRunExecutionLifecycle({
    kind: 'initial',
    runId,
    threadId,
    prompt: 'Finish the approved plan as one Goal',
    executionTemplate,
    planning: {
      requested: false,
      intensity: undefined,
      depth: undefined,
      approvedPlanRef,
    },
    goal: { requested: true },
    planningWorkflows,
    goals,
    runCheckpoints,
    liveRunEvents,
  });
  const delivered = startLiveDelivery({
    liveRunEvents,
    runCheckpoints,
    runId,
    threadId,
  });
  const request: RecoverableRunRequest = {
    ...executionTemplate,
    ...lifecycle.checkpointBindings,
  };

  assert.equal(lifecycle.checkpointPrepared, false);
  assert.equal(lifecycle.approvedPlan?.ref, approvedPlanRef);
  assert.equal(
    lifecycle.goal?.objective,
    'Finish the approved plan as one Goal',
  );
  await lifecycle.beginDurableExecution(request);
  assert.equal(lifecycle.checkpointPrepared, true);
  assert.equal(
    (await planningWorkflows.readThread(threadId))?.state,
    'executing',
  );

  const done = {
    type: 'done',
    payload: { answer: 'finished', ok: true },
  } as const;
  await lifecycle.settleTerminal(done);
  await lifecycle.settleTerminal(done);

  assert.equal(
    (await planningWorkflows.readThread(threadId))?.state,
    'completed',
  );
  assert.equal((await runCheckpoints.readThread(threadId))?.status, 'terminal');
  assert.deepEqual(
    delivered.map((event) =>
      event.type === 'planning_workflow_updated'
        ? `${event.type}:${event.payload.state}`
        : event.type,
    ),
    [
      'planning_workflow_updated:executing',
      'planning_workflow_updated:completed',
      'done',
    ],
  );
});

void test('initial lifecycle refuses an approved plan already claimed by another run before creating a checkpoint', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'run-lifecycle-refusal-'));
  t.after(async () => await rm(stateRoot, { recursive: true, force: true }));
  const planningWorkflows = createPlanningWorkflowStore({ stateRoot });
  const goals = createGoalStore({ stateRoot });
  const runCheckpoints = createRunCheckpointStore({ stateRoot });
  const threadId = testThreadId(502);
  const approvedPlanRef = await approvePlan(
    planningWorkflows,
    threadId,
    assertRunId('run-lifecycle-refusal-proposal'),
  );
  await planningWorkflows.claimExecution({
    ref: approvedPlanRef,
    threadId,
    executionRunId: assertRunId('run-lifecycle-other-execution'),
  });

  await assert.rejects(
    createRunExecutionLifecycle({
      kind: 'initial',
      runId: assertRunId('run-lifecycle-refused'),
      threadId,
      prompt: 'Do not steal the claimed plan',
      executionTemplate,
      planning: {
        requested: false,
        intensity: undefined,
        depth: undefined,
        approvedPlanRef,
      },
      goal: { requested: false },
      planningWorkflows,
      goals,
      runCheckpoints,
      liveRunEvents: createLiveRunEventStore(),
    }),
    /already started or settled/,
  );
  assert.equal(await runCheckpoints.readThread(threadId), null);
});

void test('initial lifecycle refuses a checkpoint request that drops its admitted Goal binding', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'run-lifecycle-correlation-'));
  t.after(async () => await rm(stateRoot, { recursive: true, force: true }));
  const planningWorkflows = createPlanningWorkflowStore({ stateRoot });
  const goals = createGoalStore({ stateRoot });
  const runCheckpoints = createRunCheckpointStore({ stateRoot });
  const threadId = testThreadId(509);
  const runId = assertRunId('run-lifecycle-correlation');
  const lifecycle = await createRunExecutionLifecycle({
    kind: 'initial',
    runId,
    threadId,
    prompt: 'Keep this Goal pinned to its checkpoint',
    executionTemplate,
    planning: {
      requested: false,
      intensity: undefined,
      depth: undefined,
    },
    goal: { requested: true },
    planningWorkflows,
    goals,
    runCheckpoints,
    liveRunEvents: createLiveRunEventStore(),
  });
  assert.ok(lifecycle.checkpointBindings.goal);

  await assert.rejects(
    lifecycle.beginDurableExecution(executionTemplate),
    /checkpoint binding mismatch/,
  );
  assert.equal(await runCheckpoints.readThread(threadId), null);
});

void test('checkpoint persistence failure leaves the approved plan unclaimed', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'run-lifecycle-start-fail-'));
  t.after(async () => await rm(stateRoot, { recursive: true, force: true }));
  const planningWorkflows = createPlanningWorkflowStore({ stateRoot });
  const goals = createGoalStore({ stateRoot });
  const persistedCheckpoints = createRunCheckpointStore({ stateRoot });
  const failingCheckpoints: RunCheckpointStore = {
    ...persistedCheckpoints,
    async startRun() {
      throw new Error('checkpoint persistence failed');
    },
  };
  const liveRunEvents = createLiveRunEventStore();
  const threadId = testThreadId(503);
  const runId = assertRunId('run-lifecycle-start-fail');
  const approvedPlanRef = await approvePlan(
    planningWorkflows,
    threadId,
    assertRunId('run-lifecycle-start-fail-proposal'),
  );
  const lifecycle = await createRunExecutionLifecycle({
    kind: 'initial',
    runId,
    threadId,
    prompt: 'Persist before claim',
    executionTemplate,
    planning: {
      requested: false,
      intensity: undefined,
      depth: undefined,
      approvedPlanRef,
    },
    goal: { requested: false },
    planningWorkflows,
    goals,
    runCheckpoints: failingCheckpoints,
    liveRunEvents,
  });
  const delivered = startLiveDelivery({
    liveRunEvents,
    runCheckpoints: persistedCheckpoints,
    runId,
    threadId,
  });

  await assert.rejects(
    lifecycle.beginDurableExecution({
      ...executionTemplate,
      ...lifecycle.checkpointBindings,
    }),
    /checkpoint persistence failed/,
  );
  assert.equal(lifecycle.checkpointPrepared, false);
  assert.equal(
    (await planningWorkflows.readThread(threadId))?.state,
    'approved',
  );
  assert.equal(await persistedCheckpoints.readThread(threadId), null);
  assert.deepEqual(delivered, []);
  liveRunEvents.finishRun(runId);
});

void test('terminal checkpoint persistence retries the chosen success instead of downgrading it to a failure', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'run-lifecycle-terminal-retry-'),
  );
  t.after(async () => await rm(stateRoot, { recursive: true, force: true }));
  const planningWorkflows = createPlanningWorkflowStore({ stateRoot });
  const goals = createGoalStore({ stateRoot });
  const persistedCheckpoints = createRunCheckpointStore({ stateRoot });
  let failTerminalPersistence = true;
  const retryingCheckpoints: RunCheckpointStore = {
    ...persistedCheckpoints,
    async settleRun(args) {
      if (failTerminalPersistence) {
        failTerminalPersistence = false;
        throw new Error('terminal checkpoint persistence failed');
      }
      return await persistedCheckpoints.settleRun(args);
    },
  };
  const liveRunEvents = createLiveRunEventStore();
  const threadId = testThreadId(504);
  const runId = assertRunId('run-lifecycle-terminal-retry');
  const approvedPlanRef = await approvePlan(
    planningWorkflows,
    threadId,
    assertRunId('run-lifecycle-terminal-retry-proposal'),
  );
  const lifecycle = await createRunExecutionLifecycle({
    kind: 'initial',
    runId,
    threadId,
    prompt: 'Retry the same terminal truth',
    executionTemplate,
    planning: {
      requested: false,
      intensity: undefined,
      depth: undefined,
      approvedPlanRef,
    },
    goal: { requested: false },
    planningWorkflows,
    goals,
    runCheckpoints: retryingCheckpoints,
    liveRunEvents,
  });
  const delivered = startLiveDelivery({
    liveRunEvents,
    runCheckpoints: persistedCheckpoints,
    runId,
    threadId,
  });
  await lifecycle.beginDurableExecution({
    ...executionTemplate,
    ...lifecycle.checkpointBindings,
  });
  const done = {
    type: 'done',
    payload: { answer: 'durable success', ok: true },
  } as const;

  await assert.rejects(
    lifecycle.settleTerminal(done),
    /terminal checkpoint persistence failed/,
  );
  assert.equal(
    (await planningWorkflows.readThread(threadId))?.state,
    'completed',
  );
  assert.equal(
    await lifecycle.settleFailure({
      type: 'error',
      payload: { code: 'internal', message: 'must not replace success' },
    }),
    true,
  );
  const checkpoint = await persistedCheckpoints.readThread(threadId);
  assert.equal(checkpoint?.terminal?.event.type, 'done');
  assert.equal(delivered.at(-1)?.type, 'done');
});

void test('recovery reuses an exact execution claim and does not append a duplicate claim event already present in replay history', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'run-lifecycle-replay-'));
  t.after(async () => await rm(stateRoot, { recursive: true, force: true }));
  const planningWorkflows = createPlanningWorkflowStore({ stateRoot });
  const goals = createGoalStore({ stateRoot });
  const runCheckpoints = createRunCheckpointStore({ stateRoot });
  const threadId = testThreadId(505);
  const runId = assertRunId('run-lifecycle-replay');
  const approvedPlanRef = await approvePlan(
    planningWorkflows,
    threadId,
    assertRunId('run-lifecycle-replay-proposal'),
  );
  const request: RecoverableRunRequest = {
    ...executionTemplate,
    approvedPlanRef,
  };
  const started = await runCheckpoints.startRun({ runId, threadId, request });
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }

  const firstLiveEvents = createLiveRunEventStore();
  const firstLifecycle = await createRunExecutionLifecycle({
    kind: 'recovery',
    checkpoint: started.checkpoint,
    planningWorkflows,
    goals,
    runCheckpoints,
    liveRunEvents: firstLiveEvents,
  });
  startLiveDelivery({
    liveRunEvents: firstLiveEvents,
    runCheckpoints,
    runId,
    threadId,
    checkpoint: started.checkpoint,
  });
  await firstLifecycle.beginDurableExecution(request);
  await firstLiveEvents.flushRunEventHistory(runId);
  firstLiveEvents.finishRun(runId);

  const replayCheckpoint = await runCheckpoints.readThread(threadId);
  assert.ok(replayCheckpoint);
  assert.equal(replayCheckpoint.eventHistory.length, 1);
  const recoveredLiveEvents = createLiveRunEventStore();
  const replayed = startLiveDelivery({
    liveRunEvents: recoveredLiveEvents,
    runCheckpoints,
    runId,
    threadId,
    checkpoint: replayCheckpoint,
  });
  const recoveredLifecycle = await createRunExecutionLifecycle({
    kind: 'recovery',
    checkpoint: replayCheckpoint,
    planningWorkflows,
    goals,
    runCheckpoints,
    liveRunEvents: recoveredLiveEvents,
  });
  await recoveredLifecycle.beginDurableExecution(request);
  await recoveredLiveEvents.flushRunEventHistory(runId);

  assert.equal(
    (await runCheckpoints.readThread(threadId))?.eventHistory.length,
    1,
  );
  assert.deepEqual(
    replayed.map((event) => event.type),
    ['planning_workflow_updated'],
  );
  await recoveredLifecycle.settleTerminal({
    type: 'done',
    payload: { answer: 'recovered run finished', ok: true },
  });
  assert.equal(
    (await planningWorkflows.readThread(threadId))?.state,
    'completed',
  );
});

void test('recovery refuses a stale Goal checkpoint binding without claiming or settling anything', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'run-lifecycle-stale-goal-'));
  t.after(async () => await rm(stateRoot, { recursive: true, force: true }));
  const planningWorkflows = createPlanningWorkflowStore({ stateRoot });
  const goals = createGoalStore({ stateRoot });
  const runCheckpoints = createRunCheckpointStore({ stateRoot });
  const threadId = testThreadId(506);
  const runId = assertRunId('run-lifecycle-stale-goal');
  const started = await runCheckpoints.startRun({
    runId,
    threadId,
    request: {
      ...executionTemplate,
      goal: { goalId: 'goal-no-longer-current' },
    },
  });
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }

  await assert.rejects(
    createRunExecutionLifecycle({
      kind: 'recovery',
      checkpoint: started.checkpoint,
      planningWorkflows,
      goals,
      runCheckpoints,
      liveRunEvents: createLiveRunEventStore(),
    }),
    /Goal is no longer current/,
  );
  assert.equal((await runCheckpoints.readThread(threadId))?.status, 'running');
});

void test('failure settlement leaves both the plan and checkpoint recoverable while an interject is pending', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'run-lifecycle-interject-'));
  t.after(async () => await rm(stateRoot, { recursive: true, force: true }));
  const planningWorkflows = createPlanningWorkflowStore({ stateRoot });
  const goals = createGoalStore({ stateRoot });
  const runCheckpoints = createRunCheckpointStore({ stateRoot });
  const liveRunEvents = createLiveRunEventStore();
  const threadId = testThreadId(507);
  const runId = assertRunId('run-lifecycle-interject');
  const approvedPlanRef = await approvePlan(
    planningWorkflows,
    threadId,
    assertRunId('run-lifecycle-interject-proposal'),
  );
  const request: RecoverableRunRequest = {
    ...executionTemplate,
    approvedPlanRef,
  };
  const started = await runCheckpoints.startRun({ runId, threadId, request });
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  const lifecycle = await createRunExecutionLifecycle({
    kind: 'recovery',
    checkpoint: started.checkpoint,
    planningWorkflows,
    goals,
    runCheckpoints,
    liveRunEvents,
  });
  startLiveDelivery({
    liveRunEvents,
    runCheckpoints,
    runId,
    threadId,
    checkpoint: started.checkpoint,
  });
  await lifecycle.beginDurableExecution(request);
  const queued = await runCheckpoints.enqueueInterject({
    threadId,
    runId,
    interject: { text: 'include the pending correction', receivedSeq: 1 },
  });
  assert.equal(queued.ok, true);

  assert.equal(
    await lifecycle.settleFailure({
      type: 'error',
      payload: { code: 'internal', message: 'recover after interruption' },
    }),
    false,
  );
  assert.equal(
    (await planningWorkflows.readThread(threadId))?.state,
    'executing',
  );
  assert.equal((await runCheckpoints.readThread(threadId))?.status, 'running');
});

void test('recovered unavailable Goal terminates without model work and settles its paired approved plan', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'run-lifecycle-goal-stop-'));
  t.after(async () => await rm(stateRoot, { recursive: true, force: true }));
  const planningWorkflows = createPlanningWorkflowStore({ stateRoot });
  const beforeRestartGoals = createGoalStore({ stateRoot });
  const runCheckpoints = createRunCheckpointStore({ stateRoot });
  const liveRunEvents = createLiveRunEventStore();
  const threadId = testThreadId(508);
  const runId = assertRunId('run-lifecycle-goal-stop');
  const approvedPlanRef = await approvePlan(
    planningWorkflows,
    threadId,
    assertRunId('run-lifecycle-goal-stop-proposal'),
  );
  const goal = await beforeRestartGoals.enterOrResume({
    threadId,
    requested: true,
    objective: 'Recover Goal verification without guessing',
    executionTemplate,
  });
  assert.ok(goal);
  await beforeRestartGoals.requestVerification({
    threadId,
    goalId: goal.goalId,
    runId,
  });
  const request: RecoverableRunRequest = {
    ...executionTemplate,
    approvedPlanRef,
    goal: { goalId: goal.goalId },
  };
  const started = await runCheckpoints.startRun({ runId, threadId, request });
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  const recoveredGoals = createGoalStore({ stateRoot });
  const lifecycle = await createRunExecutionLifecycle({
    kind: 'recovery',
    checkpoint: started.checkpoint,
    planningWorkflows,
    goals: recoveredGoals,
    runCheckpoints,
    liveRunEvents,
  });
  const delivered = startLiveDelivery({
    liveRunEvents,
    runCheckpoints,
    runId,
    threadId,
    checkpoint: started.checkpoint,
  });
  await lifecycle.beginDurableExecution(request);

  assert.equal(await lifecycle.settleUnavailableGoalRecovery(), true);
  assert.equal(
    (await planningWorkflows.readThread(threadId))?.state,
    'execution_failed',
  );
  const checkpoint = await runCheckpoints.readThread(threadId);
  assert.equal(checkpoint?.terminal?.event.type, 'error');
  assert.deepEqual(
    delivered.map((event) =>
      event.type === 'planning_workflow_updated' ||
      event.type === 'goal_updated'
        ? `${event.type}:${event.payload.state}`
        : event.type,
    ),
    [
      'planning_workflow_updated:executing',
      'goal_updated:verification_unavailable',
      'planning_workflow_updated:execution_failed',
      'error',
    ],
  );
});
