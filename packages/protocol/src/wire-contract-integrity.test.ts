import assert from 'node:assert/strict';
import test from 'node:test';

import { isDirectoryPreferencesResponse } from './files.js';
import { isPlanningWorkflowSnapshot } from './planning-workflow.js';
import { isRunChannelServerMessage } from './run-channel.js';
import { isRunRequest } from './run-contract.js';
import { isRunEvent } from './run-events.js';

const RUN_ID = 'run-contract-integrity-1';
const OTHER_RUN_ID = 'run-contract-integrity-2';
const THREAD_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_THREAD_ID = '22222222-2222-4222-8222-222222222222';
const CREATED_AT = '2026-07-26T00:00:00.000Z';
const UPDATED_AT = '2026-07-26T00:01:00.000Z';

const RUN_EVENT_ENVELOPE = {
  runId: RUN_ID,
  threadId: THREAD_ID,
  seq: 1,
  ts: UPDATED_AT,
} as const;

const PLANNING_SNAPSHOT = {
  state: 'collecting',
  workflowId: 'workflow-contract-integrity',
  threadId: THREAD_ID,
  intensity: 'visual',
  depth: 'standard',
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
} as const;

const GOAL_SNAPSHOT = {
  goalId: 'goal-contract-integrity',
  threadId: THREAD_ID,
  objective: 'Keep composite wire identities correlated.',
  state: 'working',
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
} as const;

void test('run events reject payload identities that disagree with their envelope', () => {
  const runAck = {
    ...RUN_EVENT_ENVELOPE,
    type: 'run_ack',
    payload: { runId: RUN_ID, threadId: THREAD_ID },
  } as const;
  assert.equal(isRunEvent(runAck), true);
  assert.equal(
    isRunEvent({
      ...runAck,
      payload: { ...runAck.payload, runId: OTHER_RUN_ID },
    }),
    false,
  );
  assert.equal(
    isRunEvent({
      ...runAck,
      payload: { ...runAck.payload, threadId: OTHER_THREAD_ID },
    }),
    false,
  );

  const interjectApplied = {
    ...RUN_EVENT_ENVELOPE,
    type: 'interject_applied',
    payload: { runId: RUN_ID, count: 1, receivedSeqs: [1] },
  } as const;
  assert.equal(isRunEvent(interjectApplied), true);
  assert.equal(
    isRunEvent({
      ...interjectApplied,
      payload: { ...interjectApplied.payload, runId: OTHER_RUN_ID },
    }),
    false,
  );

  const planningUpdated = {
    ...RUN_EVENT_ENVELOPE,
    type: 'planning_workflow_updated',
    payload: PLANNING_SNAPSHOT,
  } as const;
  assert.equal(isRunEvent(planningUpdated), true);
  assert.equal(
    isRunEvent({
      ...planningUpdated,
      payload: { ...PLANNING_SNAPSHOT, threadId: OTHER_THREAD_ID },
    }),
    false,
  );

  const goalUpdated = {
    ...RUN_EVENT_ENVELOPE,
    type: 'goal_updated',
    payload: GOAL_SNAPSHOT,
  } as const;
  assert.equal(isRunEvent(goalUpdated), true);
  assert.equal(
    isRunEvent({
      ...goalUpdated,
      payload: { ...GOAL_SNAPSHOT, threadId: OTHER_THREAD_ID },
    }),
    false,
  );
});

void test('direct planning and Goal projections reject mismatched thread identity', () => {
  assert.equal(
    isRunChannelServerMessage({
      type: 'plan.workflow',
      threadId: THREAD_ID,
      snapshot: PLANNING_SNAPSHOT,
    }),
    true,
  );
  assert.equal(
    isRunChannelServerMessage({
      type: 'plan.workflow',
      threadId: OTHER_THREAD_ID,
      snapshot: PLANNING_SNAPSHOT,
    }),
    false,
  );
  assert.equal(
    isRunChannelServerMessage({
      type: 'goal.state',
      threadId: THREAD_ID,
      snapshot: GOAL_SNAPSHOT,
    }),
    true,
  );
  assert.equal(
    isRunChannelServerMessage({
      type: 'goal.state',
      threadId: OTHER_THREAD_ID,
      snapshot: GOAL_SNAPSHOT,
    }),
    false,
  );
});

void test('planning snapshots reject unknown fields and noncanonical timestamps', () => {
  assert.equal(isPlanningWorkflowSnapshot(PLANNING_SNAPSHOT), true);
  assert.equal(
    isPlanningWorkflowSnapshot({
      ...PLANNING_SNAPSHOT,
      hiddenDaemonState: true,
    }),
    false,
  );

  for (const timestamp of [
    'not-a-timestamp',
    '2026-07-26T00:00:00Z',
    '2026-02-30T00:00:00.000Z',
  ]) {
    assert.equal(
      isPlanningWorkflowSnapshot({
        ...PLANNING_SNAPSHOT,
        updatedAt: timestamp,
      }),
      false,
      `accepted noncanonical planning timestamp: ${timestamp}`,
    );
  }
});

void test('daemon-issued approved-plan run starts require an existing thread identity', () => {
  const approvedPlanRef = {
    workflowId: 'workflow-contract-integrity',
    planId: 'plan-contract-integrity',
    revision: 1,
    digest: `sha256:${'a'.repeat(64)}`,
  };
  assert.equal(
    isRunRequest({
      prompt: 'Execute the approved plan.',
      approvedPlanRef,
    }),
    false,
  );
  assert.equal(
    isRunRequest({
      prompt: 'Execute the approved plan.',
      threadId: THREAD_ID,
      approvedPlanRef,
    }),
    true,
  );
});

void test('directory preferences reject blank selection and noncanonical entry time', () => {
  const preferences = {
    workingDirectory: 'workspace',
    favorites: [{ path: 'workspace', at: CREATED_AT }],
    recents: [{ path: 'workspace/docs', at: UPDATED_AT }],
  } as const;
  assert.equal(isDirectoryPreferencesResponse(preferences), true);
  assert.equal(
    isDirectoryPreferencesResponse({
      ...preferences,
      workingDirectory: '   ',
    }),
    false,
  );
  assert.equal(
    isDirectoryPreferencesResponse({
      ...preferences,
      recents: [{ path: 'workspace/docs', at: 'not-a-timestamp' }],
    }),
    false,
  );
  assert.equal(
    isDirectoryPreferencesResponse({
      ...preferences,
      recents: [{ path: 'workspace/docs', at: '2026-02-30T00:00:00.000Z' }],
    }),
    false,
  );
});
