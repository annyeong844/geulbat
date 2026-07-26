import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { PlanDraftV1 } from '@geulbat/protocol/planning-workflow';

import { createDaemonContext } from '../context.js';
import {
  pushPendingInterject,
  type RunInterjectBuffer,
} from '../sessions/active-run-interject-buffer.js';
import type { RunExecutionAgentBindings } from '../sessions/run-execution-lifecycle.js';
import { updatePlanTool } from '../tools/builtin/update-plan.js';
import { makeRunContext } from '../../test-support/run-context.js';
import { testRunId } from '../../test-support/run-id.js';
import { testThreadId } from '../../test-support/thread-id.js';
import type { AgentEventEmitter } from './events.js';
import type { GoalCompletionVerifier } from './goal-completion-verifier.js';
import type { HistoryItem } from '../llm/index.js';
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
  history?: readonly HistoryItem[];
  runState?: RunState;
  goalCompletionVerifier?: GoalCompletionVerifier;
  emit?: AgentEventEmitter;
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
    history: options.history ?? [{ kind: 'user', text: 'finish the work' }],
    planningWorkflows: args.daemonContext.planningWorkflows,
    goals: args.daemonContext.goals,
    emit: options.emit ?? (() => {}),
    providerAuthRuntime: args.daemonContext.provider.authRuntime,
    providerWebSocketSessions: args.daemonContext.provider.webSocketSessions,
    providerRequestOptions: args.daemonContext.provider.requestOptions,
    ...(options.runState === undefined ? {} : { runState: options.runState }),
    ...(options.planningWorkflow === undefined
      ? {}
      : { planningWorkflow: options.planningWorkflow }),
    ...(options.approvedPlan === undefined
      ? {}
      : { approvedPlan: options.approvedPlan }),
    ...(options.goal === undefined ? {} : { goal: options.goal }),
    ...(options.goalCompletionVerifier === undefined
      ? {}
      : { goalCompletionVerifier: options.goalCompletionVerifier }),
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

void test('approved-plan completion precedes Goal verification and then admits verified completion', async () => {
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
    objective: 'Finish the approved plan and verify the Goal',
    executionTemplate: {
      workingDirectory: '/workspace',
      permissionMode: 'basic',
    },
  });
  assert.ok(goal);
  await daemonContext.goals.requestVerification({
    threadId,
    goalId: goal.goalId,
    runId,
  });
  let verifierCalls = 0;
  const goalStates: string[] = [];
  const policy = createPolicy({
    daemonContext,
    runId,
    threadId,
    options: {
      approvedPlan: { ref: approvedPlanRef, draft: approvedPlanDraft },
      goal: { goalId: goal.goalId, objective: goal.objective },
      goalCompletionVerifier: {
        async verify() {
          verifierCalls += 1;
          return {
            outcome: { kind: 'achieved' },
            votes: [
              { verdict: 'achieved' },
              { verdict: 'achieved' },
              {
                verdict: 'not_achieved',
                unmetRequirements: ['dissenting check'],
              },
            ],
          };
        },
      },
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
  assert.equal(verifierCalls, 0);

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

  const verified = await policy.resolveTerminalCandidate({
    source: 'natural',
    result: candidateResult,
  });
  assert.equal(verified.kind, 'continue');
  assert.match(
    verified.kind === 'continue' ? (verified.historyText ?? '') : '',
    /"kind":"goal_completion_verified"/u,
  );
  assert.equal(verifierCalls, 1);
  assert.deepEqual(goalStates, ['completed']);

  assert.deepEqual(
    await policy.resolveTerminalCandidate({
      source: 'natural',
      result: candidateResult,
    }),
    { kind: 'terminal' },
  );
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
