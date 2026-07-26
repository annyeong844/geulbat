import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isApprovedPlanRef,
  isSamePlanRenderingStamp,
  isPlanDraftV1,
  isPlanningWorkflowSnapshot,
  isPlanWorkflowCommand,
} from './planning-workflow.js';

const draft = {
  schemaVersion: 'plan_draft_v1',
  outcome: 'Ship enforced planning',
  steps: [
    {
      id: 'workflow-store',
      text: 'Add the daemon owner',
      acceptanceCriteria: ['Restart preserves the draft'],
    },
  ],
  decisions: [{ text: 'Use propose_plan', settledBy: 'agent' }],
  assumptions: [],
  openQuestions: [],
} as const;

const approvedRef = {
  workflowId: 'workflow-1',
  planId: 'plan-1',
  revision: 1,
  digest: `sha256:${'a'.repeat(64)}`,
} as const;
const threadId = '123e4567-e89b-42d3-a456-426614174000';

void test('planning workflow guards accept the closed canonical contract', () => {
  assert.equal(isPlanDraftV1(draft), true);
  assert.equal(isApprovedPlanRef(approvedRef), true);
  assert.equal(
    isPlanWorkflowCommand({
      kind: 'approve',
      threadId,
      ...approvedRef,
    }),
    true,
  );
  assert.equal(
    isPlanWorkflowCommand({
      kind: 'retry_execution',
      threadId,
      ...approvedRef,
    }),
    true,
  );
  assert.equal(
    isPlanningWorkflowSnapshot({
      state: 'awaiting_approval',
      threadId,
      intensity: 'visual',
      depth: 'deep',
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:00:01.000Z',
      ...approvedRef,
      draft,
      proposalRunId: 'run-1',
    }),
    true,
  );
});

void test('plan rendering stamps compare every daemon-issued identity field', () => {
  assert.equal(isSamePlanRenderingStamp(approvedRef, approvedRef), true);
  assert.equal(
    isSamePlanRenderingStamp(approvedRef, {
      ...approvedRef,
      revision: approvedRef.revision + 1,
    }),
    false,
  );
});

void test('planning workflow guards reject duplicate step ids and stale-shaped commands', () => {
  assert.equal(
    isPlanDraftV1({
      ...draft,
      steps: [draft.steps[0], draft.steps[0]],
    }),
    false,
  );
  assert.equal(
    isPlanWorkflowCommand({
      kind: 'approve',
      threadId,
      ...approvedRef,
      decision: 'approved',
    }),
    false,
  );
  assert.equal(
    isPlanningWorkflowSnapshot({
      state: 'collecting',
      threadId,
      intensity: 'visual',
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:00:01.000Z',
      workflowId: 'workflow-1',
    }),
    false,
  );
});
