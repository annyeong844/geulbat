import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assertRunId } from '@geulbat/protocol/ids';
import { createDaemonContext } from '../../context.js';
import type { AgentEvent } from '../../runtime-contracts.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { updateGoalTool } from './update-goal.js';

void test('update_goal requests host completion admission and fails closed after daemon replacement', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'update-goal-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const threadId = testThreadId(1_410);
  const runId = assertRunId('run-update-goal');
  const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
  const goal = await daemonContext.goals.enterOrResume({
    threadId,
    requested: true,
    objective: 'Check host obligations before completion',
    executionTemplate: {
      workingDirectory: '/workspace',
      permissionMode: 'basic',
    },
  });
  assert.ok(goal);
  const events: AgentEvent[] = [];

  const result = await updateGoalTool.execute(
    { status: 'complete' },
    {
      kind: 'agent',
      runOwnerKind: 'root_main',
      callId: 'call-update-goal',
      runId,
      stateRoot,
      workingDirectory: '/workspace',
      threadId,
      runState: undefined,
      signal: undefined,
      runSignal: undefined,
      currentFile: undefined,
      selection: undefined,
      approvalGranted: false,
      runtimeServices: daemonContext,
      memoryIndex: undefined,
      emitAgentEvent(event) {
        events.push(event);
      },
      permissionMode: 'basic',
      computerSessionId: 'session-update-goal',
    },
  );

  assert.equal(result.ok, true);
  assert.match(result.output, /"status":"completion_requested"/u);
  assert.equal(
    (await daemonContext.goals.readThread(threadId))?.state,
    'verifying',
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ['goal_updated'],
  );
  assert.equal(updateGoalTool.recoveryStrategy, 'reconcile_then_replay');

  const replacement = createDaemonContext({ homeStateRoot: stateRoot });
  const replacementEvents: AgentEvent[] = [];
  const recovered = await updateGoalTool.execute(
    { status: 'complete' },
    {
      kind: 'agent',
      runOwnerKind: 'root_main',
      callId: 'call-update-goal',
      runId,
      stateRoot,
      workingDirectory: '/workspace',
      threadId,
      runState: undefined,
      signal: undefined,
      runSignal: undefined,
      currentFile: undefined,
      selection: undefined,
      approvalGranted: false,
      runtimeServices: replacement,
      memoryIndex: undefined,
      emitAgentEvent(event) {
        replacementEvents.push(event);
      },
      permissionMode: 'basic',
      computerSessionId: 'replacement-session-update-goal',
    },
  );

  assert.equal(recovered.ok, false);
  assert.equal(recovered.errorCode, 'execution_failed');
  assert.match(recovered.error ?? '', /no active Goal/u);
  assert.equal(
    (await replacement.goals.readThread(threadId))?.state,
    'verification_unavailable',
  );
  assert.deepEqual(replacementEvents, []);
});
