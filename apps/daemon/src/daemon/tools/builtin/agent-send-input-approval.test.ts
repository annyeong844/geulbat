import assert from 'node:assert/strict';
import test from 'node:test';

import { createSubagentRunLauncher } from '../../agent/subagent-support.js';
import { createAgentSendInputTestFixture } from '../../../test-support/agent-send-input-test-support.js';
import { testRunId } from '../../../test-support/run-id.js';
import {
  TEST_AUTO_SUBAGENT_MODEL_ROUTING,
  TEST_INHERITED_SOL_MODEL_PIN,
} from '../../../test-support/subagent-model-routing.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { createAgentSendInputTool } from './agent-send-input.js';

void test('agent_send_input forwards child approval events through the shared child runner path', async (t) => {
  const ownerThreadId = testThreadId(33);
  const seedParentRunId = testRunId('send-input-approval-seed-parent');
  const fixture = await createAgentSendInputTestFixture(t, {
    ownerThreadId,
    workspacePrefix: 'geulbat-agent-send-input-approval-',
  });
  const [durableLaunch] = fixture.runtimeStateStore.enqueueSubagentLaunchBatch([
    {
      toolCallId: 'call-send-input-approval-seed',
      task: 'seed approval child',
      subagentType: 'worker',
      capabilities: [],
      parentRunId: seedParentRunId,
      ownerThreadId,
      stateRoot: fixture.stateRoot,
      workingDirectory: fixture.stateRoot,
      modelPin: TEST_INHERITED_SOL_MODEL_PIN,
      subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
    },
  ]);
  assert.ok(durableLaunch);
  fixture.runtimeStateStore.markSubagentLaunchStarting(
    durableLaunch.childRunId,
  );
  fixture.runtimeStateStore.markSubagentLaunchStarted(durableLaunch.childRunId);
  const childRunId = durableLaunch.childRunId;
  const childThreadId = durableLaunch.childThreadId;
  fixture.registerChild({
    childRunId,
    childThreadId,
    parentRunId: seedParentRunId,
    subagentType: 'worker',
  });

  const emittedTypes: string[] = [];
  const emittedPayloads: Array<{ type: string; payload: unknown }> = [];
  const sendInputTool = createAgentSendInputTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async (input) => {
        input.onEvent({
          type: 'approval_required',
          payload: {
            callId: 'call-child-approval',
            runId: childRunId,
            threadId: childThreadId,
            toolName: 'write_file',
            approvalClass: 'write_file',
            permissionMode: 'basic',
            argumentsPreview: { path: 'draft.md' },
            sideEffectLevel: 'write',
          },
        });
        assert.equal(
          fixture.daemonContext.childRuns.getChildRun(childRunId)?.status,
          'approval_pending',
        );
        return { ok: true, finalProse: 'continued child answer' };
      },
    }).startBackgroundRun,
  });
  const parentRunId = testRunId('send-input-approval-parent');
  await fixture.startParentCheckpoint({
    runId: parentRunId,
    workingDirectory: 'workspace',
  });

  const continued = await sendInputTool.execute(
    { child_run_id: childRunId, task: 'continue child' },
    fixture.makeAgentContext({
      callId: 'call-continue-approval',
      runId: parentRunId,
      workingDirectory: 'workspace',
      computerSessionId: 'session-continue',
      emit(type, payload) {
        emittedTypes.push(type);
        emittedPayloads.push({ type, payload });
      },
    }),
  );

  assert.equal(continued.ok, true);
  await fixture.waitForChildStatus(childRunId, 'completed');
  await fixture.waitForChildCheckpointTerminal(childThreadId);
  assert.deepEqual(emittedTypes.slice(0, 3), [
    'subagent_spawned',
    'subagent_approval_required',
    'approval_required',
  ]);
  const approvalBridgeRuntime = (
    emittedPayloads[1]?.payload as {
      runtime?: { observedAt?: unknown };
    }
  ).runtime;
  const approvalBridgeObservedAt = approvalBridgeRuntime?.observedAt;
  assert.equal(typeof approvalBridgeObservedAt, 'string');
  assert.equal(
    Number.isNaN(Date.parse(approvalBridgeObservedAt as string)),
    false,
  );
  assert.deepEqual(emittedPayloads[1], {
    type: 'subagent_approval_required',
    payload: {
      parentRunId,
      childRunId,
      subagentType: 'worker',
      capabilities: [],
      toolSurface: 'worker',
      approval: {
        callId: 'call-child-approval',
        runId: childRunId,
        threadId: childThreadId,
        toolName: 'write_file',
        approvalClass: 'write_file',
        permissionMode: 'basic',
        argumentsPreview: { path: 'draft.md' },
        sideEffectLevel: 'write',
      },
      runtime: {
        phase: 'approval_pending',
        observedAt: approvalBridgeObservedAt,
        partialOutputAvailable: false,
        lastTool: {
          name: 'write_file',
          callId: 'call-child-approval',
          state: 'running',
        },
      },
    },
  });
});

void test('agent_send_input lets a continued worker inherit current parent permission mode', async (t) => {
  const ownerThreadId = testThreadId(34);
  const childThreadId = testThreadId(35);
  const childRunId = testRunId('send-input-permission-child');
  const fixture = await createAgentSendInputTestFixture(t, {
    ownerThreadId,
    workspacePrefix: 'geulbat-agent-send-input-permission-',
  });
  const seeded = fixture.registerChild({
    childRunId,
    childThreadId,
    parentRunId: testRunId('send-input-permission-seed-parent'),
    subagentType: 'worker',
  });
  assert.equal(seeded?.status, 'completed');

  let capturedApprovalContext:
    | {
        computerSessionId: string;
        permissionMode: 'basic' | 'full_access';
        ownerRunId?: string;
        ownerThreadId?: string;
      }
    | undefined;
  const sendInputTool = createAgentSendInputTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async (input) => {
        capturedApprovalContext = input.approvalContext;
        return { ok: true, finalProse: 'continued child answer' };
      },
    }).startBackgroundRun,
  });
  const parentRunId = testRunId('send-input-permission-parent');
  await fixture.startParentCheckpoint({
    runId: parentRunId,
    workingDirectory: 'workspace',
    permissionMode: 'full_access',
  });

  const continued = await sendInputTool.execute(
    { child_run_id: childRunId, task: 'continue child' },
    fixture.makeAgentContext({
      callId: 'call-continue-permission',
      runId: parentRunId,
      workingDirectory: 'workspace',
      computerSessionId: 'session-continue-permission',
      permissionMode: 'full_access',
    }),
  );

  assert.equal(continued.ok, true);
  await fixture.waitForChildStatus(childRunId, 'completed');
  await fixture.waitForChildCheckpointTerminal(childThreadId);
  assert.deepEqual(capturedApprovalContext, {
    computerSessionId: 'session-continue-permission',
    permissionMode: 'full_access',
    ownerRunId: parentRunId,
    ownerThreadId,
  });
});

void test('agent_send_input rejects standalone worker continuation without approval routing', async (t) => {
  const childRunId = testRunId('send-input-standalone-worker-child');
  const fixture = await createAgentSendInputTestFixture(t, {
    ownerThreadId: testThreadId(35),
    workspacePrefix: 'geulbat-agent-send-input-standalone-worker-',
  });
  const seeded = fixture.registerChild({
    childRunId,
    childThreadId: testThreadId(36),
    parentRunId: testRunId('send-input-standalone-worker-parent'),
    subagentType: 'worker',
  });
  assert.equal(seeded?.status, 'completed');

  let startCalled = false;
  const sendInputTool = createAgentSendInputTool({
    startBackgroundRun: async () => {
      startCalled = true;
      throw new Error('startBackgroundRun should not be called');
    },
  });
  const rejected = await sendInputTool.execute(
    {
      child_run_id: childRunId,
      task: 'continue worker from standalone context',
    },
    fixture.makeStandaloneContext({
      callId: 'call-continue-standalone-worker',
      runId: testRunId('send-input-standalone-worker-parent-2'),
      permissionMode: 'full_access',
      computerSessionId: 'session-standalone-worker',
    }),
  );

  assert.equal(rejected.ok, false);
  assert.equal(rejected.errorCode, 'execution_failed');
  assert.match(rejected.error, /approval event routing/);
  assert.equal(startCalled, false);
});
