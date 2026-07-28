import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  isAgentRetryToolRaw,
  type AgentRetryToolRaw,
} from '@geulbat/protocol/run-events';
import { assertRunId } from '@geulbat/protocol/ids';

import { createRunState } from '../../agent/runtime/run-state.js';
import { createDaemonContext } from '../../context.js';
import { createDaemonRuntimeStateStore } from '../../runtime-state-store.js';
import type { SubagentLaunchRequestInput } from '../../subagent-runtime-contracts.js';
import { makeRunContext } from '../../../test-support/run-context.js';
import { testRunId } from '../../../test-support/run-id.js';
import { TEST_INHERITED_SOL_MODEL_PIN } from '../../../test-support/subagent-model-routing.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { createAgentRetryTool } from './agent-retry.js';
import { agentWaitTool } from './agent-wait.js';

void test('agent_retry launches one fresh approved attempt and preserves the interrupted handle', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-agent-retry-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const ownerThreadId = testThreadId(80);
  let store = await createDaemonRuntimeStateStore({ homeStateRoot });

  try {
    const originalInput: SubagentLaunchRequestInput = {
      toolCallId: 'call-original-worker',
      task: 'finish the bounded workspace edit',
      subagentType: 'worker',
      capabilities: [],
      parentRunId: testRunId('retry-original-parent'),
      ownerThreadId,
      stateRoot: '/tmp/original-state',
      workingDirectory: '/tmp/original-workspace',
      permissionMode: 'full_access',
      ultraReasoning: true,
      modelPin: TEST_INHERITED_SOL_MODEL_PIN,
      subagentModelRouting: { mode: 'auto' },
    };
    const [original] = store.enqueueSubagentLaunchBatch([originalInput]);
    assert.ok(original);
    store.markSubagentLaunchStarting(original.childRunId);
    store.markSubagentLaunchStarted(original.childRunId);
    store.close();
    store = await createDaemonRuntimeStateStore({ homeStateRoot });

    const daemonContext = createDaemonContext({
      homeStateRoot,
      subagentLaunchRequests: store,
      subagentTerminalDeliveries: store,
    });
    let launchCount = 0;
    const retryTool = createAgentRetryTool({
      startBackgroundRun: async (args) => {
        launchCount += 1;
        assert.equal(args.ultraReasoning, true);
        assert.ok(args.childRunId);
        assert.ok(args.childThreadId);
        store.markSubagentLaunchStarted(args.childRunId);
        return {
          ok: true,
          output: JSON.stringify({
            ok: true,
            childRunId: args.childRunId,
            childThreadId: args.childThreadId,
            subagentType: args.subagentType,
            launchState: 'started',
            modelId: args.modelPin.modelId,
            reasoningEffort: args.modelPin.providerRunSelection.reasoningEffort,
            selectionSource: args.modelPin.selectionSource,
          }),
        };
      },
    });
    assert.equal(retryTool.recoveryStrategy, 'reconcile_then_replay');
    const parentRunId = testRunId('retry-current-parent');
    const parentState = createRunState({
      runId: parentRunId,
      runContext: makeRunContext({
        threadId: ownerThreadId,
        stateRoot: '/tmp/retry-state',
      }),
    });
    const createExecutionContext = (callId: string) => ({
      kind: 'agent' as const,
      runOwnerKind: 'root_main' as const,
      callId,
      providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
      stateRoot: '/tmp/retry-state',
      workingDirectory: '/tmp/retry-workspace',
      threadId: ownerThreadId,
      runId: parentRunId,
      runState: parentState,
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
      currentFile: undefined,
      selection: undefined,
      approvalGranted: true,
      runtimeServices: daemonContext,
      memoryIndex: undefined,
      emitAgentEvent: () => {},
      permissionMode: 'full_access' as const,
      ultraReasoning: true as const,
      computerSessionId: 'retry-approval-session',
    });
    const execute = async (callId: string) =>
      retryTool.execute(
        { child_run_id: original.childRunId },
        createExecutionContext(callId),
      );

    assert.equal(retryTool.requiresApproval, true);
    assert.equal(retryTool.mayMutateComputerFiles, true);
    const first = await execute('call-agent-retry');
    assert.equal(first.ok, true);
    const firstRaw: unknown = JSON.parse(first.output);
    assert.equal(isAgentRetryToolRaw(firstRaw), true);
    const created = firstRaw as AgentRetryToolRaw;
    assert.equal(created.retryDisposition, 'created');
    assert.equal(created.previousChildRunId, original.childRunId);
    assert.notEqual(created.childRunId, original.childRunId);
    assert.equal(created.launchState, 'started');
    assert.equal(launchCount, 1);
    assert.equal(
      store.readSubagentLaunchRequestByChildRunId(original.childRunId)
        ?.launchState,
      'interrupted',
    );
    assert.ok(
      store.readSubagentTerminalOutcomeByChildRunId(original.childRunId),
    );
    assert.equal(
      store.readSubagentLaunchRequestByChildRunId(
        assertRunId(created.childRunId),
      )?.previousChildRunId,
      original.childRunId,
    );
    const retryRequest = store.readSubagentLaunchRequestByChildRunId(
      assertRunId(created.childRunId),
    );
    assert.ok(retryRequest);
    const wait = await agentWaitTool.execute(
      { child_run_ids: [created.childRunId] },
      createExecutionContext('call-wait-for-retry'),
    );
    assert.equal(wait.ok, true);
    assert.deepEqual(JSON.parse(wait.output), {
      ok: true,
      completed: [],
      pending: [],
      blocked: [],
      launches: [
        {
          childRunId: retryRequest.childRunId,
          childThreadId: retryRequest.childThreadId,
          previousChildRunId: original.childRunId,
          launchState: 'started',
          priorityClass: 'normal',
          enqueueOrder: retryRequest.enqueueOrder,
          createdAt: retryRequest.createdAt,
          updatedAt: retryRequest.updatedAt,
          runtime: retryRequest.runtime,
        },
      ],
    });

    const duplicate = await execute('call-agent-retry-again');
    assert.equal(duplicate.ok, true);
    const duplicateRaw: unknown = JSON.parse(duplicate.output);
    assert.equal(isAgentRetryToolRaw(duplicateRaw), true);
    const alreadyRetried = duplicateRaw as AgentRetryToolRaw;
    assert.equal(alreadyRetried.retryDisposition, 'already_retried');
    assert.equal(alreadyRetried.childRunId, created.childRunId);
    assert.equal(launchCount, 1);
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('agent_retry fails closed without approval-connected run context', async () => {
  const result = await createAgentRetryTool().execute(
    { child_run_id: testRunId('interrupted-child') },
    {
      callId: 'call-no-approval-runtime',
      stateRoot: '/tmp/retry-state',
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'execution_failed');
  assert.match(result.error ?? '', /approval-connected agent runtime/u);
});
