import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { assertRunId, assertThreadId } from '@geulbat/protocol/ids';
import type { AgentEvent } from '../../runtime-contracts.js';
import { createDaemonContext } from '../../context.js';
import type { ToolExecutionContext } from '../types.js';
import { proposePlanTool } from './propose-plan.js';

void test('propose_plan stores the canonical draft and emits the daemon snapshot', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'propose-plan-'));
  const runtimeServices = createDaemonContext({ homeStateRoot: stateRoot });
  const threadId = assertThreadId('123e4567-e89b-42d3-a456-426614174027');
  const runId = assertRunId('run-propose-plan');
  const events: AgentEvent[] = [];
  const toolArgs = {
    outcome: 'Approve an exact plan',
    steps: [
      {
        id: 'draft',
        text: 'Store the draft',
        acceptanceCriteria: ['Digest survives restart'],
      },
    ],
    decisions: [],
    assumptions: [],
    openQuestions: [],
  };
  await runtimeServices.planningWorkflows.enterOrResume({
    threadId,
    requested: true,
    intensity: 'visual',
    depth: 'standard',
    executionTemplate: {
      workingDirectory: '/workspace',
      permissionMode: 'basic',
    },
  });

  const toolContext = {
    kind: 'agent',
    callId: 'call-propose-plan',
    signal: undefined,
    runSignal: undefined,
    currentFile: undefined,
    selection: undefined,
    approvalGranted: false,
    computerSessionId: 'session-propose-plan',
    permissionMode: 'basic',
    stateRoot,
    threadId,
    runId,
    runOwnerKind: 'root_main',
    workingDirectory: '/workspace',
    runState: undefined,
    memoryIndex: runtimeServices.memoryIndex,
    runtimeServices,
    emitAgentEvent: (event: AgentEvent) => events.push(event),
  } satisfies ToolExecutionContext;

  assert.equal(proposePlanTool.recoveryStrategy, 'reconcile_then_replay');
  const result = await proposePlanTool.execute(toolArgs, toolContext);

  assert.equal(result.ok, true);
  assert.equal(events.at(-1)?.type, 'planning_workflow_updated');
  const firstSnapshot =
    await runtimeServices.planningWorkflows.readThread(threadId);
  assert.equal(firstSnapshot?.state, 'awaiting_approval');

  const reconciled = await proposePlanTool.execute(toolArgs, toolContext);

  assert.deepEqual(reconciled, result);
  assert.deepEqual(
    await runtimeServices.planningWorkflows.readThread(threadId),
    firstSnapshot,
  );

  const conflicting = await proposePlanTool.execute(
    { ...toolArgs, outcome: 'Replace the durable plan' },
    toolContext,
  );
  assert.equal(conflicting.ok, false);
  assert.match(
    conflicting.error,
    /plan can be proposed only while the workflow is collecting/u,
  );
});
