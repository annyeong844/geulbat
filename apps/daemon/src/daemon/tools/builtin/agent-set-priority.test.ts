import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { agentSetPriorityTool } from './agent-set-priority.js';
import { createDaemonContext } from '../../context.js';
import { createDaemonRuntimeStateStore } from '../../runtime-state-store.js';
import { testRunId } from '../../../test-support/run-id.js';
import {
  TEST_AUTO_SUBAGENT_MODEL_ROUTING,
  TEST_INHERITED_SOL_MODEL_PIN,
} from '../../../test-support/subagent-model-routing.js';
import { testThreadId } from '../../../test-support/thread-id.js';

void test('agent_set_priority updates only a durably queued child and preserves its handle', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-set-priority-'),
  );
  const ownerThreadId = testThreadId(70);
  const runtimeStateStore = await createDaemonRuntimeStateStore({
    homeStateRoot: stateRoot,
  });
  const daemonContext = createDaemonContext({
    subagentLaunchRequests: runtimeStateStore,
  });
  const executionContext = {
    callId: 'call-set-priority',
    stateRoot,
    threadId: ownerThreadId,
    runId: testRunId('set-priority-parent'),
    runtimeServices: daemonContext,
  };

  try {
    const [queued] = runtimeStateStore.enqueueSubagentLaunchBatch([
      {
        toolCallId: 'call-queued-priority',
        task: 'queued priority child',
        subagentType: 'explorer',
        capabilities: [],
        parentRunId: testRunId('queued-priority-parent'),
        ownerThreadId,
        stateRoot,
        workingDirectory: stateRoot,
        modelPin: TEST_INHERITED_SOL_MODEL_PIN,
        subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
      },
    ]);
    assert.ok(queued);

    const updated = await agentSetPriorityTool.execute(
      { child_run_id: queued.childRunId, priority: 'high' },
      executionContext,
    );
    assert.equal(updated.ok, true);
    assert.deepEqual(JSON.parse(updated.output), {
      ok: true,
      childRunId: queued.childRunId,
      launchState: 'queued',
      priorityClass: 'high',
      updateState: 'updated',
    });
    assert.equal(
      runtimeStateStore.readSubagentLaunchRequestByChildRunId(queued.childRunId)
        ?.enqueueOrder,
      queued.enqueueOrder,
    );

    const unchanged = await agentSetPriorityTool.execute(
      { child_run_id: queued.childRunId, priority: 'high' },
      executionContext,
    );
    assert.equal(unchanged.ok, true);
    assert.equal(JSON.parse(unchanged.output).updateState, 'unchanged');

    runtimeStateStore.markSubagentLaunchStarting(queued.childRunId);
    const notQueued = await agentSetPriorityTool.execute(
      { child_run_id: queued.childRunId, priority: 'low' },
      executionContext,
    );
    assert.equal(notQueued.ok, true);
    assert.deepEqual(JSON.parse(notQueued.output), {
      ok: true,
      childRunId: queued.childRunId,
      launchState: 'starting',
      priorityClass: 'high',
      updateState: 'not_queued',
    });

    const foreign = await agentSetPriorityTool.execute(
      { child_run_id: queued.childRunId, priority: 'normal' },
      {
        ...executionContext,
        threadId: testThreadId(71),
      },
    );
    assert.equal(foreign.ok, false);
    assert.equal(foreign.errorCode, 'invalid_args');

    const unknown = await agentSetPriorityTool.execute(
      { child_run_id: testRunId('missing-priority-child'), priority: 'low' },
      executionContext,
    );
    assert.equal(unknown.ok, false);
    assert.equal(unknown.errorCode, 'invalid_args');
  } finally {
    runtimeStateStore.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('agent_set_priority rejects malformed requests before durable access', async () => {
  const invalidPriority = await agentSetPriorityTool.execute(
    { child_run_id: 'child-priority', priority: 'urgent' },
    { callId: 'call-invalid-priority' },
  );
  assert.equal(invalidPriority.ok, false);
  assert.equal(invalidPriority.errorCode, 'invalid_args');
  assert.match(invalidPriority.error ?? '', /priority must be one of/u);

  const unexpectedKey = await agentSetPriorityTool.execute(
    {
      child_run_id: 'child-priority',
      priority: 'normal',
      numeric_weight: 10,
    },
    { callId: 'call-unexpected-priority-key' },
  );
  assert.equal(unexpectedKey.ok, false);
  assert.equal(unexpectedKey.errorCode, 'invalid_args');
  assert.match(unexpectedKey.error ?? '', /unexpected keys/u);
});

void test('agent_set_priority reports an unavailable durable store without fallback', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-set-priority-'),
  );
  const ownerThreadId = testThreadId(72);
  const runtimeStateStore = await createDaemonRuntimeStateStore({
    homeStateRoot: stateRoot,
  });
  const daemonContext = createDaemonContext({
    subagentLaunchRequests: runtimeStateStore,
  });
  const [queued] = runtimeStateStore.enqueueSubagentLaunchBatch([
    {
      toolCallId: 'call-closed-priority',
      task: 'closed store child',
      subagentType: 'explorer',
      capabilities: [],
      parentRunId: testRunId('closed-priority-parent'),
      ownerThreadId,
      stateRoot,
      workingDirectory: stateRoot,
      modelPin: TEST_INHERITED_SOL_MODEL_PIN,
      subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
    },
  ]);
  assert.ok(queued);
  runtimeStateStore.close();

  try {
    const result = await agentSetPriorityTool.execute(
      { child_run_id: queued.childRunId, priority: 'high' },
      {
        callId: 'call-closed-priority',
        stateRoot,
        threadId: ownerThreadId,
        runId: testRunId('closed-priority-request'),
        runtimeServices: daemonContext,
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'persistence_unavailable');
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
