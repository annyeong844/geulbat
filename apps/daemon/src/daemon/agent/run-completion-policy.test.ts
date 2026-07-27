import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { PlanDraftV1 } from '@geulbat/protocol/planning-workflow';

import { createDaemonContext } from '../context.js';
import {
  pushPendingInterject,
  takePendingInterject,
  type RunInterjectBuffer,
} from '../sessions/active-run-interject-buffer.js';
import type { RunExecutionAgentBindings } from '../sessions/run-execution-lifecycle.js';
import { updatePlanTool } from '../tools/builtin/update-plan.js';
import { makeRunContext } from '../../test-support/run-context.js';
import { testRunId } from '../../test-support/run-id.js';
import { testThreadId } from '../../test-support/thread-id.js';
import type { AgentEventEmitter } from './events.js';
import type { AgentLoopCompletionGapObservation } from './observer/agent-loop-observer.js';
import type { AgentNoProgressPolicy } from './no-progress-policy.js';
import { createAgentRunCompletionPolicy } from './run-completion-policy.js';
import { createRunState, type RunState } from './runtime/run-state.js';
import type { GoalSnapshot } from './contract.js';

const candidateResult = {
  ok: true as const,
  finalProse: 'candidate final answer',
};

const approvedPlanDraft: PlanDraftV1 = {
  schemaVersion: 'plan_draft_v1',
  outcome: 'Complete the approved work',
  steps: [
    {
      id: 'implement',
      text: 'Implement the approved change',
      acceptanceCriteria: ['The implementation is complete'],
    },
    {
      id: 'verify',
      text: 'Verify the approved change',
      acceptanceCriteria: ['The verification passes'],
    },
  ],
  decisions: [],
  assumptions: [],
  openQuestions: [],
};

interface PolicyOptions extends RunExecutionAgentBindings {
  runState?: RunState;
  emit?: AgentEventEmitter;
  observeCompletionGap?: (
    observation: AgentLoopCompletionGapObservation,
  ) => void;
  noProgressPolicy?: AgentNoProgressPolicy;
  planningWorkflows?: Parameters<
    typeof createAgentRunCompletionPolicy
  >[0]['planningWorkflows'];
  goals?: Parameters<typeof createAgentRunCompletionPolicy>[0]['goals'];
}

function createPolicy(args: {
  daemonContext: ReturnType<typeof createDaemonContext>;
  runId: ReturnType<typeof testRunId>;
  threadId: ReturnType<typeof testThreadId>;
  options?: PolicyOptions;
}) {
  const options = args.options ?? {};
  return createAgentRunCompletionPolicy({
    runId: args.runId,
    threadId: args.threadId,
    planningWorkflows:
      options.planningWorkflows ?? args.daemonContext.planningWorkflows,
    goals: options.goals ?? args.daemonContext.goals,
    emit: options.emit ?? (() => {}),
    ...(options.runState === undefined ? {} : { runState: options.runState }),
    ...(options.planningWorkflow === undefined
      ? {}
      : { planningWorkflow: options.planningWorkflow }),
    ...(options.approvedPlan === undefined
      ? {}
      : { approvedPlan: options.approvedPlan }),
    ...(options.goal === undefined ? {} : { goal: options.goal }),
    ...(options.observeCompletionGap === undefined
      ? {}
      : { observeCompletionGap: options.observeCompletionGap }),
    ...(options.noProgressPolicy === undefined
      ? {}
      : { noProgressPolicy: options.noProgressPolicy }),
  });
}

async function createClaimedPlan(args: {
  daemonContext: ReturnType<typeof createDaemonContext>;
  runId: ReturnType<typeof testRunId>;
  proposalRunId: ReturnType<typeof testRunId>;
  threadId: ReturnType<typeof testThreadId>;
}) {
  await args.daemonContext.planningWorkflows.enterOrResume({
    threadId: args.threadId,
    requested: true,
    intensity: 'quiet',
    depth: 'standard',
    executionTemplate: {
      workingDirectory: '/workspace',
      permissionMode: 'basic',
    },
  });
  const proposed = await args.daemonContext.planningWorkflows.propose({
    threadId: args.threadId,
    proposalRunId: args.proposalRunId,
    draft: approvedPlanDraft,
  });
  const approved = await args.daemonContext.planningWorkflows.applyCommand({
    kind: 'approve',
    threadId: args.threadId,
    workflowId: proposed.workflowId,
    planId: proposed.planId,
    revision: proposed.revision,
    digest: proposed.digest,
  });
  assert.ok(approved.approvedPlanRef);
  await args.daemonContext.planningWorkflows.claimExecution({
    ref: approved.approvedPlanRef,
    threadId: args.threadId,
    executionRunId: args.runId,
  });
  return approved.approvedPlanRef;
}

function assertInterjectBufferOpen(buffer: RunInterjectBuffer): void {
  assert.equal(buffer.accepting, true);
}

void test('pending interject admission precedes stale planning and Goal state', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-run-completion-interject-'),
  );
  const threadId = testThreadId(1400);
  const runId = testRunId(1400);
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const runState = createRunState({
    runId,
    runContext: makeRunContext({ threadId, stateRoot }),
  });
  pushPendingInterject(runState.interject, 'revise before finishing');
  const policy = createPolicy({
    daemonContext,
    runId,
    threadId,
    options: {
      runState,
      planningWorkflow: {
        workflowId: 'missing-workflow',
        intensity: 'quiet',
        depth: 'standard',
      },
      goal: {
        goalId: 'missing-goal',
        objective: 'This stale state must not win over the pending interject',
      },
    },
  });

  const decision = await policy.resolveTerminalCandidate({
    source: 'structured_output',
    result: candidateResult,
  });

  assert.deepEqual(decision, {
    kind: 'continue',
    historyText: 'candidate final answer',
  });
  assertInterjectBufferOpen(runState.interject);
});

void test('collecting planning state rejects prose completion but admits a turn-ending planning tool', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-run-completion-planning-'),
  );
  const threadId = testThreadId(1401);
  const runId = testRunId(1401);
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const collecting = await daemonContext.planningWorkflows.enterOrResume({
    threadId,
    requested: true,
    intensity: 'quiet',
    depth: 'deep',
    executionTemplate: {
      workingDirectory: '/workspace',
      permissionMode: 'basic',
    },
  });
  assert.ok(collecting);
  const policy = createPolicy({
    daemonContext,
    runId,
    threadId,
    options: {
      planningWorkflow: {
        workflowId: collecting.workflowId,
        intensity: collecting.intensity,
        depth: collecting.depth,
      },
    },
  });

  const natural = await policy.resolveTerminalCandidate({
    source: 'natural',
    result: candidateResult,
  });
  assert.equal(natural.kind, 'continue');
  assert.match(
    natural.kind === 'continue' ? (natural.historyText ?? '') : '',
    /"kind":"planning_workflow_incomplete"/u,
  );

  const toolCompletion = await policy.resolveTerminalCandidate({
    source: 'tool_completion',
    result: candidateResult,
  });
  assert.deepEqual(toolCompletion, { kind: 'terminal' });
});

void test('stale planning correlation fails closed before terminal selection', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-run-completion-stale-plan-'),
  );
  const threadId = testThreadId(1402);
  const runId = testRunId(1402);
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const policy = createPolicy({
    daemonContext,
    runId,
    threadId,
    options: {
      planningWorkflow: {
        workflowId: 'stale-workflow',
        intensity: 'visual',
        depth: 'standard',
      },
    },
  });

  assert.deepEqual(
    await policy.resolveTerminalCandidate({
      source: 'natural',
      result: candidateResult,
    }),
    {
      kind: 'verification_unavailable',
      message: 'planning workflow completion verification is stale',
    },
  );
});

void test('approved-plan completion precedes Goal completion admission', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-run-completion-plan-goal-'),
  );
  const threadId = testThreadId(1403);
  const runId = testRunId(1403);
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const approvedPlanRef = await createClaimedPlan({
    daemonContext,
    runId,
    proposalRunId: testRunId(1404),
    threadId,
  });
  const goal = await daemonContext.goals.enterOrResume({
    threadId,
    requested: true,
    objective: 'Finish the approved plan before admitting the Goal',
    executionTemplate: {
      workingDirectory: '/workspace',
      permissionMode: 'basic',
    },
  });
  assert.ok(goal);
  await daemonContext.goals.requestCompletion({
    threadId,
    goalId: goal.goalId,
    runId,
  });
  const goalStates: string[] = [];
  const policy = createPolicy({
    daemonContext,
    runId,
    threadId,
    options: {
      approvedPlan: { ref: approvedPlanRef, draft: approvedPlanDraft },
      goal: { goalId: goal.goalId, objective: goal.objective },
      emit(type, payload) {
        if (type === 'goal_updated') {
          goalStates.push((payload as GoalSnapshot).state);
        }
      },
    },
  });

  const planBlocked = await policy.resolveTerminalCandidate({
    source: 'natural',
    result: candidateResult,
  });
  assert.equal(planBlocked.kind, 'continue');
  assert.match(
    planBlocked.kind === 'continue' ? (planBlocked.historyText ?? '') : '',
    /"obligation":"approved_plan_execution"/u,
  );

  const progress = await updatePlanTool.execute(
    {
      plan: approvedPlanDraft.steps.map((step) => ({
        id: step.id,
        step: step.text,
        status: 'completed' as const,
      })),
    },
    {
      callId: 'call-complete-approved-plan',
      stateRoot,
      threadId,
    },
  );
  assert.equal(progress.ok, true);

  const admitted = await policy.resolveTerminalCandidate({
    source: 'natural',
    result: candidateResult,
  });
  assert.equal(admitted.kind, 'continue');
  assert.match(
    admitted.kind === 'continue' ? (admitted.historyText ?? '') : '',
    /"kind":"goal_completion_admitted"/u,
  );
  assert.deepEqual(goalStates, ['completed']);

  assert.deepEqual(
    await policy.resolveTerminalCandidate({
      source: 'natural',
      result: candidateResult,
    }),
    { kind: 'terminal' },
  );
});

void test('completion policy observes repeated plan gaps without treating changed plan evidence as a repeat', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-run-completion-gap-observation-'),
  );
  const threadId = testThreadId(1405);
  const runId = testRunId(1405);
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const approvedPlanRef = await createClaimedPlan({
    daemonContext,
    runId,
    proposalRunId: testRunId(1406),
    threadId,
  });
  const observations: AgentLoopCompletionGapObservation[] = [];
  const policy = createPolicy({
    daemonContext,
    runId,
    threadId,
    options: {
      approvedPlan: { ref: approvedPlanRef, draft: approvedPlanDraft },
      observeCompletionGap(observation) {
        observations.push(observation);
      },
    },
  });

  await policy.resolveTerminalCandidate({
    source: 'natural',
    result: candidateResult,
  });
  await policy.resolveTerminalCandidate({
    source: 'natural',
    result: candidateResult,
  });

  const progress = await updatePlanTool.execute(
    {
      plan: approvedPlanDraft.steps.map((step, index) => ({
        id: step.id,
        step: step.text,
        status: index === 0 ? ('in_progress' as const) : ('pending' as const),
      })),
    },
    {
      callId: 'call-progress-approved-plan',
      stateRoot,
      threadId,
    },
  );
  assert.equal(progress.ok, true);

  await policy.resolveTerminalCandidate({
    source: 'natural',
    result: candidateResult,
  });

  assert.equal(observations.length, 3);
  const [first, repeated, progressed] = observations;
  assert.ok(first);
  assert.ok(repeated);
  assert.ok(progressed);
  assert.equal(first.repeatCount, 1);
  assert.equal(first.sameGapAndEvidenceAsPrevious, false);
  assert.equal(repeated.repeatCount, 2);
  assert.equal(repeated.sameGapAndEvidenceAsPrevious, true);
  assert.equal(repeated.gapFingerprint, first.gapFingerprint);
  assert.equal(repeated.evidenceRevision, first.evidenceRevision);
  assert.equal(progressed.repeatCount, 1);
  assert.equal(progressed.sameGapAndEvidenceAsPrevious, false);
  assert.equal(progressed.gapFingerprint, first.gapFingerprint);
  assert.notEqual(progressed.evidenceRevision, first.evidenceRevision);
});

void test('a configured no-progress stop ends the run once the same gap repeats to the threshold', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-run-completion-no-progress-stop-'),
  );
  const threadId = testThreadId(1408);
  const runId = testRunId(1408);
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const approvedPlanRef = await createClaimedPlan({
    daemonContext,
    runId,
    proposalRunId: testRunId(1409),
    threadId,
  });
  const policy = createPolicy({
    daemonContext,
    runId,
    threadId,
    options: {
      approvedPlan: { ref: approvedPlanRef, draft: approvedPlanDraft },
      noProgressPolicy: { repeatThreshold: 3, action: 'stop' },
    },
  });

  const first = await policy.resolveTerminalCandidate({
    source: 'natural',
    result: candidateResult,
  });
  const second = await policy.resolveTerminalCandidate({
    source: 'natural',
    result: candidateResult,
  });
  const third = await policy.resolveTerminalCandidate({
    source: 'natural',
    result: candidateResult,
  });

  assert.equal(first.kind, 'continue');
  assert.equal(second.kind, 'continue');
  assert.equal(third.kind, 'no_progress');
  assert.ok(third.kind === 'no_progress');
  assert.match(third.message, /approved_plan_execution/u);
  // The reason must tell the user what changes the outcome, not just that it
  // stopped.
  assert.match(third.message, /Revise the objective/u);
});

void test('an unconfigured no-progress policy keeps continuing no matter how often the gap repeats', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-run-completion-no-progress-unconfigured-'),
  );
  const threadId = testThreadId(1410);
  const runId = testRunId(1410);
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const approvedPlanRef = await createClaimedPlan({
    daemonContext,
    runId,
    proposalRunId: testRunId(1411),
    threadId,
  });
  const policy = createPolicy({
    daemonContext,
    runId,
    threadId,
    options: {
      approvedPlan: { ref: approvedPlanRef, draft: approvedPlanDraft },
    },
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const decision = await policy.resolveTerminalCandidate({
      source: 'natural',
      result: candidateResult,
    });
    assert.equal(decision.kind, 'continue');
  }
});

void test('real plan progress resets the no-progress count instead of consuming it', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-run-completion-no-progress-reset-'),
  );
  const threadId = testThreadId(1412);
  const runId = testRunId(1412);
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const approvedPlanRef = await createClaimedPlan({
    daemonContext,
    runId,
    proposalRunId: testRunId(1413),
    threadId,
  });
  const policy = createPolicy({
    daemonContext,
    runId,
    threadId,
    options: {
      approvedPlan: { ref: approvedPlanRef, draft: approvedPlanDraft },
      noProgressPolicy: { repeatThreshold: 3, action: 'stop' },
    },
  });

  await policy.resolveTerminalCandidate({
    source: 'natural',
    result: candidateResult,
  });
  await policy.resolveTerminalCandidate({
    source: 'natural',
    result: candidateResult,
  });

  const progress = await updatePlanTool.execute(
    {
      plan: approvedPlanDraft.steps.map((step, index) => ({
        id: step.id,
        step: step.text,
        status: index === 0 ? ('in_progress' as const) : ('pending' as const),
      })),
    },
    {
      callId: 'call-progress-no-progress-reset',
      stateRoot,
      threadId,
    },
  );
  assert.equal(progress.ok, true);

  // Canonical evidence moved, so the third observation starts a new count and
  // the run is not stopped even though it is the third unmet assessment.
  const afterProgress = await policy.resolveTerminalCandidate({
    source: 'natural',
    result: candidateResult,
  });
  assert.equal(afterProgress.kind, 'continue');
});

void test('a pending interject drops the previous gap so a changed objective does not inherit its count', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-run-completion-no-progress-interject-'),
  );
  const threadId = testThreadId(1414);
  const runId = testRunId(1414);
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const approvedPlanRef = await createClaimedPlan({
    daemonContext,
    runId,
    proposalRunId: testRunId(1415),
    threadId,
  });
  const runState = createRunState({
    runId,
    runContext: makeRunContext({ threadId, stateRoot }),
  });
  const observations: AgentLoopCompletionGapObservation[] = [];
  const policy = createPolicy({
    daemonContext,
    runId,
    threadId,
    options: {
      approvedPlan: { ref: approvedPlanRef, draft: approvedPlanDraft },
      runState,
      noProgressPolicy: { repeatThreshold: 3, action: 'stop' },
      observeCompletionGap(observation) {
        observations.push(observation);
      },
    },
  });

  await policy.resolveTerminalCandidate({
    source: 'natural',
    result: candidateResult,
  });
  await policy.resolveTerminalCandidate({
    source: 'natural',
    result: candidateResult,
  });

  pushPendingInterject(runState.interject, 'Change the objective');
  const steered = await policy.resolveTerminalCandidate({
    source: 'natural',
    result: candidateResult,
  });
  assert.equal(steered.kind, 'continue');
  // The steer wins the round outright, so no gap is observed for it.
  assert.equal(observations.length, 2);

  // The model round consumes the steer, so the next assessment observes again.
  // It must start from one rather than stopping at the threshold, because the
  // user may have changed what the run is trying to do.
  takePendingInterject(runState.interject);
  const afterSteer = await policy.resolveTerminalCandidate({
    source: 'natural',
    result: candidateResult,
  });
  assert.equal(afterSteer.kind, 'continue');
  assert.equal(observations.length, 3);
  const latest = observations.at(-1);
  assert.ok(latest);
  assert.equal(latest.repeatCount, 1);
  assert.equal(latest.sameGapAndEvidenceAsPrevious, false);
});

void test('an infrastructure failure neither consumes nor triggers the no-progress count', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-run-completion-no-progress-infra-'),
  );
  const threadId = testThreadId(1416);
  const runId = testRunId(1416);
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const approvedPlanRef = await createClaimedPlan({
    daemonContext,
    runId,
    proposalRunId: testRunId(1417),
    threadId,
  });
  // The real planning-workflow store is used for every call except one. A store
  // read failure cannot be produced from the real boundary without corrupting
  // durable state, so exactly one call is made to throw and the rest stay real.
  let failNextAssessment = false;
  const policy = createPolicy({
    daemonContext,
    runId,
    threadId,
    options: {
      approvedPlan: { ref: approvedPlanRef, draft: approvedPlanDraft },
      noProgressPolicy: { repeatThreshold: 3, action: 'stop' },
      planningWorkflows: {
        readThread: (readThreadId) =>
          daemonContext.planningWorkflows.readThread(readThreadId),
        assessExecutionCompletion: async (assessArgs) => {
          if (failNextAssessment) {
            throw new Error('planning workflow store read failed');
          }
          return await daemonContext.planningWorkflows.assessExecutionCompletion(
            assessArgs,
          );
        },
      },
    },
  });

  await policy.resolveTerminalCandidate({
    source: 'natural',
    result: candidateResult,
  });
  await policy.resolveTerminalCandidate({
    source: 'natural',
    result: candidateResult,
  });

  failNextAssessment = true;
  const infrastructureFailure = await policy.resolveTerminalCandidate({
    source: 'natural',
    result: candidateResult,
  });
  // An unavailable obligation is not evidence of a stalled agent.
  assert.equal(infrastructureFailure.kind, 'verification_unavailable');

  failNextAssessment = false;
  const resumed = await policy.resolveTerminalCandidate({
    source: 'natural',
    result: candidateResult,
  });
  // The failed round did not advance the count past the threshold, and it did
  // not reset it either: this is the third real observation, so it stops here.
  assert.equal(resumed.kind, 'no_progress');
});

void test('active Goal continues on prose and closes the interject seam on tool completion', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-run-completion-active-goal-'),
  );
  const threadId = testThreadId(1405);
  const runId = testRunId(1405);
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const goal = await daemonContext.goals.enterOrResume({
    threadId,
    requested: true,
    objective: 'Keep working until evidence is complete',
    executionTemplate: {
      workingDirectory: '/workspace',
      permissionMode: 'basic',
    },
  });
  assert.ok(goal);
  const runState = createRunState({
    runId,
    runContext: makeRunContext({ threadId, stateRoot }),
  });
  const policy = createPolicy({
    daemonContext,
    runId,
    threadId,
    options: {
      runState,
      goal: { goalId: goal.goalId, objective: goal.objective },
    },
  });

  const natural = await policy.resolveTerminalCandidate({
    source: 'natural',
    result: candidateResult,
  });
  assert.equal(natural.kind, 'continue');
  assert.match(
    natural.kind === 'continue' ? (natural.historyText ?? '') : '',
    /"kind":"goal_incomplete"/u,
  );
  assertInterjectBufferOpen(runState.interject);

  assert.deepEqual(
    await policy.resolveTerminalCandidate({
      source: 'tool_completion',
      result: candidateResult,
    }),
    { kind: 'terminal' },
  );
  assert.equal(runState.interject.accepting, false);
});

void test('pending interject beats Goal completed terminal and keeps admission open', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-run-completion-goal-completed-interject-'),
  );
  const threadId = testThreadId(1420);
  const runId = testRunId(1420);
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const goal = await daemonContext.goals.enterOrResume({
    threadId,
    requested: true,
    objective: 'Finish the Goal then accept a late steer',
    executionTemplate: {
      workingDirectory: '/workspace',
      permissionMode: 'basic',
    },
  });
  assert.ok(goal);
  await daemonContext.goals.requestCompletion({
    threadId,
    goalId: goal.goalId,
    runId,
  });
  await daemonContext.goals.admitCompletion({
    threadId,
    goalId: goal.goalId,
    runId,
  });
  const runState = createRunState({
    runId,
    runContext: makeRunContext({ threadId, stateRoot }),
  });
  pushPendingInterject(runState.interject, 'revise after Goal completed');
  const policy = createPolicy({
    daemonContext,
    runId,
    threadId,
    options: {
      runState,
      goal: { goalId: goal.goalId, objective: goal.objective },
    },
  });

  const decision = await policy.resolveTerminalCandidate({
    source: 'natural',
    result: candidateResult,
  });
  assert.deepEqual(decision, { kind: 'continue' });
  assertInterjectBufferOpen(runState.interject);
});

void test('pending interject beats Goal tool_completion terminal', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-run-completion-goal-tool-interject-'),
  );
  const threadId = testThreadId(1421);
  const runId = testRunId(1421);
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const goal = await daemonContext.goals.enterOrResume({
    threadId,
    requested: true,
    objective: 'Stay active until the user steers',
    executionTemplate: {
      workingDirectory: '/workspace',
      permissionMode: 'basic',
    },
  });
  assert.ok(goal);
  const runState = createRunState({
    runId,
    runContext: makeRunContext({ threadId, stateRoot }),
  });
  pushPendingInterject(runState.interject, 'steer instead of tool end');
  const policy = createPolicy({
    daemonContext,
    runId,
    threadId,
    options: {
      runState,
      goal: { goalId: goal.goalId, objective: goal.objective },
    },
  });

  const decision = await policy.resolveTerminalCandidate({
    source: 'tool_completion',
    result: candidateResult,
  });
  assert.deepEqual(decision, { kind: 'continue' });
  assertInterjectBufferOpen(runState.interject);
});

void test('interject arriving during Goal read wins over terminal close (TOCTOU)', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-run-completion-goal-read-toctou-'),
  );
  const threadId = testThreadId(1422);
  const runId = testRunId(1422);
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const goal = await daemonContext.goals.enterOrResume({
    threadId,
    requested: true,
    objective: 'Complete before a late steer arrives',
    executionTemplate: {
      workingDirectory: '/workspace',
      permissionMode: 'basic',
    },
  });
  assert.ok(goal);
  await daemonContext.goals.requestCompletion({
    threadId,
    goalId: goal.goalId,
    runId,
  });
  await daemonContext.goals.admitCompletion({
    threadId,
    goalId: goal.goalId,
    runId,
  });
  const runState = createRunState({
    runId,
    runContext: makeRunContext({ threadId, stateRoot }),
  });
  let releaseRead!: () => void;
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const policy = createPolicy({
    daemonContext,
    runId,
    threadId,
    options: {
      runState,
      goal: { goalId: goal.goalId, objective: goal.objective },
      goals: {
        async readForRun(input) {
          queueMicrotask(() => {
            pushPendingInterject(
              runState.interject,
              'late steer during Goal read',
            );
            releaseRead();
          });
          await readGate;
          return await daemonContext.goals.readForRun(input);
        },
        admitCompletion(input) {
          return daemonContext.goals.admitCompletion(input);
        },
      },
    },
  });

  const decision = await policy.resolveTerminalCandidate({
    source: 'natural',
    result: candidateResult,
  });
  assert.deepEqual(decision, { kind: 'continue' });
  assertInterjectBufferOpen(runState.interject);
  assert.equal(runState.interject.items.length, 1);
});

void test('interject arriving during plan assessment wins over no_progress hard stop', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-run-completion-plan-assess-toctou-'),
  );
  const threadId = testThreadId(1423);
  const runId = testRunId(1423);
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const approvedPlanRef = await createClaimedPlan({
    daemonContext,
    runId,
    proposalRunId: testRunId(1424),
    threadId,
  });
  const runState = createRunState({
    runId,
    runContext: makeRunContext({ threadId, stateRoot }),
  });
  let releaseAssess!: () => void;
  const assessGate = new Promise<void>((resolve) => {
    releaseAssess = resolve;
  });
  let assessCalls = 0;
  const policy = createPolicy({
    daemonContext,
    runId,
    threadId,
    options: {
      runState,
      approvedPlan: { ref: approvedPlanRef, draft: approvedPlanDraft },
      noProgressPolicy: { repeatThreshold: 2, action: 'stop' },
      planningWorkflows: {
        readThread(id) {
          return daemonContext.planningWorkflows.readThread(id);
        },
        async assessExecutionCompletion(input) {
          assessCalls += 1;
          // On the second observation, inject after the hard-stop threshold is
          // already armed so only the post-await re-check can keep the run open.
          if (assessCalls === 2) {
            queueMicrotask(() => {
              pushPendingInterject(
                runState.interject,
                'steer during plan assessment',
              );
              releaseAssess();
            });
            await assessGate;
          }
          return await daemonContext.planningWorkflows.assessExecutionCompletion(
            input,
          );
        },
      },
    },
  });

  const first = await policy.resolveTerminalCandidate({
    source: 'natural',
    result: candidateResult,
  });
  assert.equal(first.kind, 'continue');

  const decision = await policy.resolveTerminalCandidate({
    source: 'natural',
    result: candidateResult,
  });
  assert.deepEqual(decision, { kind: 'continue' });
  assertInterjectBufferOpen(runState.interject);
});

void test('interject arriving during stale planning read wins over verification_unavailable', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-run-completion-planning-stale-toctou-'),
  );
  const threadId = testThreadId(1425);
  const runId = testRunId(1425);
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const runState = createRunState({
    runId,
    runContext: makeRunContext({ threadId, stateRoot }),
  });
  let releaseRead!: () => void;
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const policy = createPolicy({
    daemonContext,
    runId,
    threadId,
    options: {
      runState,
      planningWorkflow: {
        workflowId: 'missing-workflow',
        intensity: 'quiet',
        depth: 'standard',
      },
      planningWorkflows: {
        async readThread(id) {
          queueMicrotask(() => {
            pushPendingInterject(
              runState.interject,
              'steer during stale planning read',
            );
            releaseRead();
          });
          await readGate;
          return await daemonContext.planningWorkflows.readThread(id);
        },
        assessExecutionCompletion(input) {
          return daemonContext.planningWorkflows.assessExecutionCompletion(
            input,
          );
        },
      },
    },
  });

  const decision = await policy.resolveTerminalCandidate({
    source: 'natural',
    result: candidateResult,
  });
  assert.deepEqual(decision, { kind: 'continue' });
  assertInterjectBufferOpen(runState.interject);
});
