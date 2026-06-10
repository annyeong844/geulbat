import test from 'node:test';
import assert from 'node:assert/strict';

import { brandRunId, brandThreadId } from '../lib/id-brand-helpers.js';
import { makeApprovalRequiredFixture } from '../test-support/protocol-fixtures.js';
import { createSubagentActivityEffect } from './run-session-subagent-effect.js';

const RUN_ID = brandRunId('run-1');
const THREAD_ID = brandThreadId('00000000-0000-4000-8000-000000000001');
const CHILD_RUN_ID = brandRunId('run-child-1');

void test('createSubagentActivityEffect maps spawned events to spawned transcript entries', () => {
  const effect = createSubagentActivityEffect({
    runId: RUN_ID,
    threadId: THREAD_ID,
    seq: 1,
    ts: '2026-04-18T00:00:00.000Z',
    type: 'subagent_spawned',
    payload: {
      parentRunId: RUN_ID,
      childRunId: CHILD_RUN_ID,
      childThreadId: THREAD_ID,
      subagentType: 'worker',
    },
  });

  assert.deepEqual(effect, {
    kind: 'subagent_activity_added',
    threadId: THREAD_ID,
    entry: {
      kind: 'subagent_activity',
      childRunId: CHILD_RUN_ID,
      subagentType: 'worker',
      state: 'spawned',
    },
  });
});

void test('createSubagentActivityEffect maps approval_required events to approval_required transcript entries', () => {
  const effect = createSubagentActivityEffect({
    runId: RUN_ID,
    threadId: THREAD_ID,
    seq: 2,
    ts: '2026-04-18T00:00:01.000Z',
    type: 'subagent_approval_required',
    payload: {
      parentRunId: RUN_ID,
      childRunId: CHILD_RUN_ID,
      subagentType: 'explorer',
      approval: makeApprovalRequiredFixture({
        runId: RUN_ID,
        threadId: THREAD_ID,
      }),
    },
  });

  assert.deepEqual(effect, {
    kind: 'subagent_activity_added',
    threadId: THREAD_ID,
    entry: {
      kind: 'subagent_activity',
      childRunId: CHILD_RUN_ID,
      subagentType: 'explorer',
      state: 'approval_required',
    },
  });
});

void test('createSubagentActivityEffect preserves terminal deliveryId, reason, and result', () => {
  const effect = createSubagentActivityEffect({
    runId: RUN_ID,
    threadId: THREAD_ID,
    seq: 3,
    ts: '2026-04-18T00:00:02.000Z',
    type: 'subagent_terminal',
    payload: {
      deliveryId: 'delivery-1',
      parentRunId: RUN_ID,
      childRunId: CHILD_RUN_ID,
      subagentType: 'worker',
      terminalState: 'failed',
      ok: false,
      reason: 'timeout',
      result: 'timed out',
    },
  });

  assert.deepEqual(effect, {
    kind: 'subagent_activity_added',
    threadId: THREAD_ID,
    entry: {
      kind: 'subagent_activity',
      deliveryId: 'delivery-1',
      childRunId: CHILD_RUN_ID,
      subagentType: 'worker',
      state: 'failed',
      reason: 'timeout',
      result: 'timed out',
    },
  });
});
