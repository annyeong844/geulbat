import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { PlanDraftV1 } from '@geulbat/protocol/planning-workflow';
import { assertRunId, assertThreadId } from '@geulbat/protocol/ids';
import {
  PLAN_APPROVAL_REQUIRED,
  PLAN_REVISION_APPROVAL_REQUIRED,
} from '../planning-approval.js';
import { updatePlanTool } from '../tools/builtin/update-plan.js';
import { createPlanningWorkflowStore } from './planning-workflow-store.js';

const threadId = assertThreadId('123e4567-e89b-42d3-a456-426614174026');
const proposalRunId = assertRunId('run-plan-proposal');
const executionRunId = assertRunId('run-plan-execution');
const draft: PlanDraftV1 = {
  schemaVersion: 'plan_draft_v1',
  outcome: 'Enforce exact plan approval',
  steps: [
    {
      id: 'daemon-owner',
      text: 'Add the daemon workflow owner',
      acceptanceCriteria: ['Restart preserves the same digest'],
    },
    {
      id: 'host-card',
      text: 'Render the trusted approval card',
      acceptanceCriteria: ['Approval echoes the daemon digest'],
    },
  ],
  decisions: [{ text: 'Use propose_plan', settledBy: 'agent' }],
  assumptions: ['The existing run channel remains the transport owner'],
  openQuestions: [],
};

function executionTemplate() {
  return {
    workingDirectory: '/workspace',
    permissionMode: 'basic' as const,
  };
}

void test('concurrent plan-mode entry requests create exactly one active workflow', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'planning-concurrent-'));
  let id = 0;
  const store = createPlanningWorkflowStore({
    stateRoot,
    createId: () => String(++id),
  });

  const [left, right] = await Promise.all([
    store.enterOrResume({
      threadId,
      requested: true,
      intensity: 'visual',
      depth: 'deep',
      executionTemplate: executionTemplate(),
    }),
    store.enterOrResume({
      threadId,
      requested: true,
      intensity: 'visual',
      depth: 'deep',
      executionTemplate: executionTemplate(),
    }),
  ]);

  assert.equal(left?.workflowId, right?.workflowId);
  assert.equal(
    (await store.readThread(threadId))?.workflowId,
    left?.workflowId,
  );
  assert.equal(id, 1);
});

void test('planning workflow persists exact approval and publishes stable update_plan ids', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'planning-workflow-'));
  let id = 0;
  let tick = 0;
  const store = createPlanningWorkflowStore({
    stateRoot,
    createId: () => String(++id),
    now: () => `2026-07-26T00:00:0${tick++}.000Z`,
  });

  const collecting = await store.enterOrResume({
    threadId,
    requested: true,
    intensity: 'visual',
    depth: 'deep',
    executionTemplate: executionTemplate(),
  });
  assert.equal(collecting?.state, 'collecting');
  assert.equal(collecting?.depth, 'deep');

  const proposed = await store.propose({
    threadId,
    proposalRunId,
    draft,
  });
  assert.equal(proposed.state, 'awaiting_approval');
  if (proposed.state !== 'awaiting_approval') {
    return;
  }

  const approved = await store.applyCommand({
    kind: 'approve',
    threadId,
    workflowId: proposed.workflowId,
    planId: proposed.planId,
    revision: proposed.revision,
    digest: proposed.digest,
  });
  assert.equal(approved.snapshot?.state, 'approved');
  assert.deepEqual(approved.approvedPlanRef, {
    workflowId: proposed.workflowId,
    planId: proposed.planId,
    revision: proposed.revision,
    digest: proposed.digest,
  });

  const published = JSON.parse(
    await readFile(
      join(
        stateRoot,
        '.geulbat',
        'tool-state',
        'update-plan',
        `${threadId}.json`,
      ),
      'utf8',
    ),
  ) as {
    items: Array<{ id: string; text: string }>;
    execution: { approvedPlanRef: unknown };
  };
  assert.deepEqual(
    published.items.map(({ id, text }) => ({ id, text })),
    draft.steps.map(({ id, text }) => ({ id, text })),
  );
  assert.deepEqual(
    published.execution.approvedPlanRef,
    approved.approvedPlanRef,
  );

  const restarted = createPlanningWorkflowStore({ stateRoot });
  assert.equal((await restarted.readThread(threadId))?.state, 'approved');
  assert.deepEqual(await restarted.readPendingExecution(threadId), {
    ref: approved.approvedPlanRef,
    executionTemplate: executionTemplate(),
  });
});

void test('revision collection preserves the immediately previous canonical draft across restart', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'planning-revision-diff-'));
  const store = createPlanningWorkflowStore({
    stateRoot,
    createId: () => 'revision-diff',
  });
  await store.enterOrResume({
    threadId,
    requested: true,
    intensity: 'visual',
    depth: 'deep',
    executionTemplate: executionTemplate(),
  });
  const first = await store.propose({ threadId, proposalRunId, draft });
  const collecting = await store.applyCommand({
    kind: 'request_revision',
    threadId,
    workflowId: first.workflowId,
    planId: first.planId,
    revision: first.revision,
    digest: first.digest,
    feedback: '검증 단계를 별도 단계로 나눠주세요.',
  });
  assert.equal(collecting.snapshot?.state, 'collecting');
  assert.deepEqual(collecting.snapshot?.supersededPlan, {
    workflowId: first.workflowId,
    planId: first.planId,
    revision: first.revision,
    digest: first.digest,
    draft,
  });

  const restarted = createPlanningWorkflowStore({ stateRoot });
  const revisedDraft: PlanDraftV1 = {
    ...draft,
    outcome: 'Enforce exact plan approval and show revision changes',
    steps: [
      ...draft.steps,
      {
        id: 'verification',
        text: 'Verify the approved workflow',
        acceptanceCriteria: ['The previous revision remains comparable'],
      },
    ],
  };
  const revised = await restarted.propose({
    threadId,
    proposalRunId: assertRunId('run-plan-proposal-revision'),
    draft: revisedDraft,
  });
  assert.equal(revised.revision, first.revision + 1);
  assert.deepEqual(revised.supersededPlan, {
    workflowId: first.workflowId,
    planId: first.planId,
    revision: first.revision,
    digest: first.digest,
    draft,
  });
});

void test('planning workflow rejects mutation before approval and structural drift after publication', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'planning-clamp-'));
  const store = createPlanningWorkflowStore({
    stateRoot,
    createId: () => 'fixed',
  });
  await store.enterOrResume({
    threadId,
    requested: true,
    intensity: 'quiet',
    depth: 'standard',
    executionTemplate: executionTemplate(),
  });

  await assert.rejects(
    store.assertPlanUpdateAllowed(threadId, []),
    new RegExp(PLAN_APPROVAL_REQUIRED),
  );

  const proposed = await store.propose({ threadId, proposalRunId, draft });
  if (proposed.state !== 'awaiting_approval') {
    throw new Error('expected proposed plan');
  }
  await assert.rejects(
    store.applyCommand({
      kind: 'explain_visual',
      threadId,
      workflowId: proposed.workflowId,
      planId: proposed.planId,
      revision: proposed.revision,
      digest: proposed.digest,
    }),
    /quiet planning workflow/u,
  );
  await store.applyCommand({
    kind: 'approve',
    threadId,
    workflowId: proposed.workflowId,
    planId: proposed.planId,
    revision: proposed.revision,
    digest: proposed.digest,
  });

  await assert.rejects(
    store.assertPlanUpdateAllowed(threadId, [
      { id: 'changed', step: draft.steps[0]!.text, status: 'pending' },
      {
        id: draft.steps[1]!.id,
        step: draft.steps[1]!.text,
        status: 'pending',
      },
    ]),
    new RegExp(PLAN_REVISION_APPROVAL_REQUIRED),
  );
  await store.assertPlanUpdateAllowed(
    threadId,
    draft.steps.map((step, index) => ({
      id: step.id,
      step: step.text,
      status: index === 0 ? ('in_progress' as const) : ('pending' as const),
    })),
  );
});

void test('planning workflow binds one execution run to the approved revision', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'planning-execution-'));
  const store = createPlanningWorkflowStore({
    stateRoot,
    createId: () => 'fixed',
  });
  await store.enterOrResume({
    threadId,
    requested: true,
    intensity: 'visual',
    depth: 'standard',
    executionTemplate: executionTemplate(),
  });
  const proposed = await store.propose({ threadId, proposalRunId, draft });
  if (proposed.state !== 'awaiting_approval') {
    throw new Error('expected proposed plan');
  }
  const command = {
    kind: 'approve' as const,
    threadId,
    workflowId: proposed.workflowId,
    planId: proposed.planId,
    revision: proposed.revision,
    digest: proposed.digest,
  };
  const approved = await store.applyCommand(command);
  const ref = approved.approvedPlanRef;
  if (ref === undefined) {
    throw new Error('expected approved plan ref');
  }
  assert.equal(approved.executionTemplate?.workingDirectory, '/workspace');
  assert.equal(
    (await store.applyCommand(command)).executionTemplate,
    undefined,
    'a duplicate approval must not schedule another execution run',
  );

  const claimed = await store.claimExecution({
    ref,
    threadId,
    executionRunId,
  });
  assert.equal(claimed.snapshot.state, 'executing');
  assert.equal(
    (
      await store.claimExecution({
        ref,
        threadId,
        executionRunId,
      })
    ).snapshot.state,
    'executing',
  );
  assert.deepEqual(
    await store.assessExecutionCompletion({
      ref,
      threadId,
      executionRunId,
    }),
    {
      kind: 'incomplete',
      items: draft.steps.map((step) => ({
        id: step.id,
        text: step.text,
        status: 'pending',
      })),
    },
  );
  const progress = await updatePlanTool.execute(
    {
      plan: draft.steps.map((step) => ({
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
  assert.deepEqual(
    await store.assessExecutionCompletion({
      ref,
      threadId,
      executionRunId,
    }),
    { kind: 'complete' },
  );
  await assert.rejects(
    store.claimExecution({
      ref,
      threadId,
      executionRunId: assertRunId('run-other'),
    }),
    /already claimed/,
  );
  assert.equal(
    (
      await store.completeExecution({
        ref,
        threadId,
        executionRunId,
        ok: true,
      })
    ).state,
    'completed',
  );
});

void test('failed publication stays visible and the same approval retries it', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'planning-publish-retry-'));
  const store = createPlanningWorkflowStore({
    stateRoot,
    createId: () => 'retry',
  });
  await store.enterOrResume({
    threadId,
    requested: true,
    intensity: 'visual',
    depth: 'standard',
    executionTemplate: executionTemplate(),
  });
  const proposed = await store.propose({ threadId, proposalRunId, draft });
  const command = {
    kind: 'approve' as const,
    threadId,
    workflowId: proposed.workflowId,
    planId: proposed.planId,
    revision: proposed.revision,
    digest: proposed.digest,
  };
  const publishPath = join(
    stateRoot,
    '.geulbat',
    'tool-state',
    'update-plan',
    `${threadId}.json`,
  );
  await mkdir(publishPath, { recursive: true });

  await assert.rejects(store.applyCommand(command));
  assert.equal(
    (await store.readThread(threadId))?.state,
    'approved_pending_publish',
  );

  await rm(publishPath, { recursive: true });
  const retried = await store.applyCommand(command);
  assert.equal(retried.snapshot?.state, 'approved');
  assert.deepEqual(retried.approvedPlanRef, {
    workflowId: proposed.workflowId,
    planId: proposed.planId,
    revision: proposed.revision,
    digest: proposed.digest,
  });
  assert.equal(retried.executionTemplate?.workingDirectory, '/workspace');
});

void test('failed execution retries the exact approved revision without republishing it', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'planning-execution-retry-'));
  const store = createPlanningWorkflowStore({
    stateRoot,
    createId: () => 'execution-retry',
  });
  await store.enterOrResume({
    threadId,
    requested: true,
    intensity: 'visual',
    depth: 'deep',
    executionTemplate: executionTemplate(),
  });
  const proposed = await store.propose({ threadId, proposalRunId, draft });
  const approved = await store.applyCommand({
    kind: 'approve',
    threadId,
    workflowId: proposed.workflowId,
    planId: proposed.planId,
    revision: proposed.revision,
    digest: proposed.digest,
  });
  if (approved.approvedPlanRef === undefined) {
    throw new Error('expected approved plan ref');
  }
  const ref = approved.approvedPlanRef;
  await store.claimExecution({ ref, threadId, executionRunId });
  await store.completeExecution({
    ref,
    threadId,
    executionRunId,
    ok: false,
  });

  const retried = await store.applyCommand({
    kind: 'retry_execution',
    threadId,
    ...ref,
  });
  assert.equal(retried.snapshot?.state, 'approved');
  assert.deepEqual(retried.approvedPlanRef, ref);
  assert.equal(retried.executionTemplate?.workingDirectory, '/workspace');
  assert.equal(
    (
      await store.applyCommand({
        kind: 'retry_execution',
        threadId,
        ...ref,
      })
    ).executionTemplate,
    undefined,
    'a duplicate retry must not schedule another execution run',
  );

  const nextRunId = assertRunId('run-execution-retry-next');
  const claimed = await store.claimExecution({
    ref,
    threadId,
    executionRunId: nextRunId,
  });
  assert.equal(claimed.snapshot.state, 'executing');
  assert.equal(claimed.snapshot.executionRunId, nextRunId);
  assert.equal(
    (
      await store.applyCommand({
        kind: 'retry_execution',
        threadId,
        ...ref,
      })
    ).executionTemplate,
    undefined,
    'a delayed duplicate retry must not schedule another execution run',
  );
});

void test('failed publication can be explicitly cancelled', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'planning-publish-cancel-'));
  const store = createPlanningWorkflowStore({
    stateRoot,
    createId: () => 'cancel',
  });
  await store.enterOrResume({
    threadId,
    requested: true,
    intensity: 'quiet',
    depth: 'standard',
    executionTemplate: executionTemplate(),
  });
  const proposed = await store.propose({ threadId, proposalRunId, draft });
  const publishPath = join(
    stateRoot,
    '.geulbat',
    'tool-state',
    'update-plan',
    `${threadId}.json`,
  );
  await mkdir(publishPath, { recursive: true });
  await assert.rejects(
    store.applyCommand({
      kind: 'approve',
      threadId,
      workflowId: proposed.workflowId,
      planId: proposed.planId,
      revision: proposed.revision,
      digest: proposed.digest,
    }),
  );

  const cancelled = await store.applyCommand({
    kind: 'cancel',
    threadId,
    workflowId: proposed.workflowId,
    planId: proposed.planId,
    revision: proposed.revision,
  });
  assert.equal(cancelled.snapshot, null);
  assert.equal(await store.readThread(threadId), null);
});

void test('v1 workflow state migrates once to standard planning depth', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'planning-v1-migration-'));
  const workflowDirectory = join(stateRoot, '.geulbat', 'planning-workflows');
  const workflowPath = join(workflowDirectory, `${threadId}.json`);
  await mkdir(workflowDirectory, { recursive: true });
  await writeFile(
    workflowPath,
    `${JSON.stringify({
      schemaVersion: 1,
      current: {
        snapshot: {
          state: 'collecting',
          workflowId: 'workflow-v1',
          threadId,
          intensity: 'quiet',
          createdAt: '2026-07-26T00:00:00.000Z',
          updatedAt: '2026-07-26T00:00:00.000Z',
        },
        executionTemplate: executionTemplate(),
      },
      approvals: [],
    })}\n`,
  );

  const store = createPlanningWorkflowStore({ stateRoot });
  assert.equal((await store.readThread(threadId))?.depth, 'standard');
  const migrated = JSON.parse(await readFile(workflowPath, 'utf8')) as {
    schemaVersion?: unknown;
    current?: { snapshot?: { depth?: unknown } };
  };
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.current?.snapshot?.depth, 'standard');
});
