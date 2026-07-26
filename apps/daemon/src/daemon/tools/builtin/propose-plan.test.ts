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

  const result = await proposePlanTool.execute(
    {
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
    },
    toolContext,
  );

  assert.equal(result.ok, true);
  assert.equal(events.at(-1)?.type, 'planning_workflow_updated');
  assert.equal(
    (await runtimeServices.planningWorkflows.readThread(threadId))?.state,
    'awaiting_approval',
  );
});
