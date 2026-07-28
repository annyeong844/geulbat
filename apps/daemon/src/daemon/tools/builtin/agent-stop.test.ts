import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createAgentSpawnTool } from './agent-spawn.js';
import { agentStopTool } from './agent-stop.js';
import { createSubagentRunLauncher } from '../../agent/subagent-support.js';
import {
  createSubagentAdmissionController,
  createSubagentLaunchPromotionController,
} from '../../agent/subagent-concurrency.js';
import { createDaemonContext, type DaemonContext } from '../../context.js';
import { createDaemonRuntimeStateStore } from '../../runtime-state-store.js';
import { createRunState } from '../../agent/runtime/run-state.js';
import { testRunId } from '../../../test-support/run-id.js';
import { makeRunContext } from '../../../test-support/run-context.js';
import {
  TEST_AUTO_SUBAGENT_MODEL_ROUTING,
  TEST_CHILD_MODEL_REGISTRATION,
  TEST_INHERITED_SOL_MODEL_PIN,
} from '../../../test-support/subagent-model-routing.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { assertRunId, type RunId } from '@geulbat/protocol/ids';

void test('agent_stop declares restart-safe cancellation replay', () => {
  assert.equal(agentStopTool.recoveryStrategy, 'replay_safe');
});

async function waitForChildTerminal(args: {
  daemonContext: ReturnType<typeof createDaemonContext>;
  childRunId: RunId;
}): Promise<{
  status: string;
  reason: string | null | undefined;
}> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = args.daemonContext.childRuns.getChildRun(args.childRunId);
    if (
      snapshot &&
      (snapshot.status === 'completed' ||
        snapshot.status === 'failed' ||
        snapshot.status === 'cancelled')
    ) {
      return {
        status: snapshot.status,
        reason: snapshot.reason,
      };
    }
    await delay(10);
  }
  throw new Error(`child ${args.childRunId} did not become terminal`);
}

void test('agent_stop cancels a running child with explicit_stop reason', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-agent-stop-'));
  const threadId = testThreadId(41);
  const runtimeStateStore = await createDaemonRuntimeStateStore({
    homeStateRoot: stateRoot,
  });
  const daemonContext = createDaemonContext({
    subagentLaunchRequests: runtimeStateStore,
  });

  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async ({ signal }) => {
        if (!signal) {
          throw new Error('expected child run signal');
        }
        if (signal.aborted) {
          throw new Error('child aborted');
        }
        return new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () =>
              resolve({
                ok: false,
                finalProse: 'run cancelled',
              }),
            { once: true },
          );
        });
      },
    }).startBackgroundRun,
  });

  try {
    const parentState = createRunState({
      runId: 'top-run-stop',
      runContext: makeRunContext({
        threadId,
        stateRoot,
      }),
    });
    const spawned = await testAgentSpawnTool.execute(
      {
        task: 'long running child',
        subagent_type: 'explorer',
      },
      {
        callId: 'call-spawn-stop',
        providerRunSelection:
          TEST_CHILD_MODEL_REGISTRATION.modelPin.providerRunSelection,
        stateRoot,
        threadId,
        runId: 'top-run-stop',
        runState: parentState,
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        computerSessionId: 'agent-stop-session',
        runtimeServices: daemonContext,
      },
    );

    assert.equal(spawned.ok, true);
    const spawnPayload = JSON.parse(spawned.output) as {
      childRunId: string;
    };
    const childRunId = assertRunId(spawnPayload.childRunId);

    const stopped = await agentStopTool.execute(
      {
        child_run_id: spawnPayload.childRunId,
      },
      {
        callId: 'call-stop-child',
        stateRoot,
        threadId,
        runId: 'top-run-stop-2',
        runtimeServices: daemonContext,
      },
    );

    assert.equal(stopped.ok, true);
    const stopPayload = JSON.parse(stopped.output) as {
      childRunId: string;
      stopState: string;
    };
    assert.equal(stopPayload.childRunId, spawnPayload.childRunId);
    assert.equal(stopPayload.stopState, 'stopping');

    const terminal = await waitForChildTerminal({
      daemonContext,
      childRunId,
    });
    assert.equal(terminal.status, 'cancelled');
    assert.equal(terminal.reason, 'explicit_stop');
  } finally {
    runtimeStateStore.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('agent_stop atomically cancels a durably queued child before start', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-agent-stop-'));
  const ownerThreadId = testThreadId(60);
  const runtimeStateStore = await createDaemonRuntimeStateStore({
    homeStateRoot: stateRoot,
  });
  const admission = createSubagentAdmissionController({});
  const launchPromotions = createSubagentLaunchPromotionController({
    admission,
    launchRequests: runtimeStateStore,
  });
  const forgottenLaunches: RunId[] = [];
  const daemonContext = createDaemonContext({
    subagentLaunchRequests: runtimeStateStore,
  });
  const runtimeServices: DaemonContext = {
    ...daemonContext,
    subagent: {
      ...daemonContext.subagent,
      admission,
      launchPromotions: {
        ...launchPromotions,
        forgetLaunch(childRunId) {
          forgottenLaunches.push(childRunId);
          launchPromotions.forgetLaunch(childRunId);
        },
      },
    },
  };

  try {
    const [queued] = runtimeStateStore.enqueueSubagentLaunchBatch([
      {
        toolCallId: 'call-stop-queued',
        task: 'queued child',
        subagentType: 'explorer',
        capabilities: [],
        parentRunId: testRunId('stop-queued-parent'),
        ownerThreadId,
        stateRoot,
        workingDirectory: stateRoot,
        modelPin: TEST_INHERITED_SOL_MODEL_PIN,
        subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
      },
    ]);
    assert.ok(queued);

    const foreignResult = await agentStopTool.execute(
      { child_run_id: queued.childRunId },
      {
        callId: 'call-stop-queued-foreign',
        stateRoot,
        threadId: testThreadId(61),
        runId: testRunId('stop-queued-foreign'),
        runtimeServices: runtimeServices,
      },
    );
    assert.equal(foreignResult.ok, false);
    assert.equal(foreignResult.errorCode, 'invalid_args');

    const stopped = await agentStopTool.execute(
      { child_run_id: queued.childRunId },
      {
        callId: 'call-stop-queued',
        stateRoot,
        threadId: ownerThreadId,
        runId: testRunId('stop-queued-request'),
        runtimeServices: runtimeServices,
      },
    );
    assert.equal(stopped.ok, true);
    assert.deepEqual(JSON.parse(stopped.output), {
      ok: true,
      childRunId: queued.childRunId,
      stopState: 'cancelled_before_start',
    });
    assert.equal(
      runtimeStateStore.readSubagentLaunchRequestByChildRunId(queued.childRunId)
        ?.launchState,
      'cancelled',
    );
    assert.deepEqual(forgottenLaunches, [queued.childRunId]);

    const repeated = await agentStopTool.execute(
      { child_run_id: queued.childRunId },
      {
        callId: 'call-stop-queued-again',
        stateRoot,
        threadId: ownerThreadId,
        runId: testRunId('stop-queued-again'),
        runtimeServices: runtimeServices,
      },
    );
    assert.equal(repeated.ok, true);
    assert.equal(JSON.parse(repeated.output).stopState, 'already_terminal');
  } finally {
    runtimeStateStore.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('agent_stop exposes a starting transition race instead of claiming cancellation', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-agent-stop-'));
  const ownerThreadId = testThreadId(62);
  const runtimeStateStore = await createDaemonRuntimeStateStore({
    homeStateRoot: stateRoot,
  });
  const daemonContext = createDaemonContext({
    subagentLaunchRequests: runtimeStateStore,
  });

  try {
    const [starting] = runtimeStateStore.enqueueSubagentLaunchBatch([
      {
        toolCallId: 'call-stop-starting',
        task: 'starting child',
        subagentType: 'explorer',
        capabilities: [],
        parentRunId: testRunId('stop-starting-parent'),
        ownerThreadId,
        stateRoot,
        workingDirectory: stateRoot,
        modelPin: TEST_INHERITED_SOL_MODEL_PIN,
        subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
      },
    ]);
    assert.ok(starting);
    runtimeStateStore.markSubagentLaunchStarting(starting.childRunId);

    const stopped = await agentStopTool.execute(
      { child_run_id: starting.childRunId },
      {
        callId: 'call-stop-starting',
        stateRoot,
        threadId: ownerThreadId,
        runId: testRunId('stop-starting-request'),
        runtimeServices: daemonContext,
      },
    );
    assert.equal(stopped.ok, false);
    assert.equal(stopped.errorCode, 'execution_failed');
    assert.match(stopped.error ?? '', /retry cancellation/u);
    assert.equal(
      runtimeStateStore.readSubagentLaunchRequestByChildRunId(
        starting.childRunId,
      )?.launchState,
      'starting',
    );

    runtimeStateStore.markSubagentLaunchStarted(starting.childRunId);
    const missingStartedHandle = await agentStopTool.execute(
      { child_run_id: starting.childRunId },
      {
        callId: 'call-stop-started-without-handle',
        stateRoot,
        threadId: ownerThreadId,
        runId: testRunId('stop-started-without-handle'),
        runtimeServices: daemonContext,
      },
    );
    assert.equal(missingStartedHandle.ok, false);
    assert.equal(missingStartedHandle.errorCode, 'execution_failed');
    assert.match(missingStartedHandle.error ?? '', /handle is unavailable/u);
  } finally {
    runtimeStateStore.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('agent_stop returns already_terminal after durable terminal publication unloads the registry body', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-agent-stop-'));
  const ownerThreadId = testThreadId(63);
  const runtimeStateStore = await createDaemonRuntimeStateStore({
    homeStateRoot: stateRoot,
  });
  const daemonContext = createDaemonContext({
    subagentLaunchRequests: runtimeStateStore,
    subagentTerminalDeliveries: runtimeStateStore,
  });

  try {
    const [started] = runtimeStateStore.enqueueSubagentLaunchBatch([
      {
        toolCallId: 'call-stop-durable-terminal',
        task: 'already completed child',
        subagentType: 'worker',
        capabilities: [],
        parentRunId: testRunId('stop-durable-terminal-parent'),
        ownerThreadId,
        stateRoot,
        workingDirectory: stateRoot,
        modelPin: TEST_INHERITED_SOL_MODEL_PIN,
        subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
      },
    ]);
    assert.ok(started);
    runtimeStateStore.markSubagentLaunchStarting(started.childRunId);
    runtimeStateStore.markSubagentLaunchStarted(started.childRunId);
    runtimeStateStore.recordSubagentTerminalDelivery({
      ownerThreadId,
      result: {
        deliveryId: 'delivery-stop-durable-terminal',
        parentRunId: testRunId('stop-durable-terminal-parent'),
        childRunId: started.childRunId,
        childThreadId: testThreadId(64),
        subagentType: 'worker',
        terminalState: 'completed',
        result: 'completed before stop',
        completedAt: '2026-07-26T10:00:00.000Z',
      },
    });
    assert.equal(
      daemonContext.childRuns.getChildRun(started.childRunId),
      undefined,
    );

    const stopped = await agentStopTool.execute(
      { child_run_id: started.childRunId },
      {
        callId: 'call-stop-durable-terminal',
        stateRoot,
        threadId: ownerThreadId,
        runId: testRunId('stop-durable-terminal-request'),
        runtimeServices: daemonContext,
      },
    );

    assert.equal(stopped.ok, true);
    assert.deepEqual(JSON.parse(stopped.output), {
      ok: true,
      childRunId: started.childRunId,
      stopState: 'already_terminal',
    });
  } finally {
    runtimeStateStore.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('agent_stop returns already_terminal for a completed child', async () => {
  const daemonContext = createDaemonContext();
  const ownerThreadId = testThreadId(43);
  const childRunId = testRunId('child-terminal');
  daemonContext.childRuns.registerChildRun({
    ...TEST_CHILD_MODEL_REGISTRATION,
    childRunId,
    childThreadId: testThreadId(47),
    parentRunId: testRunId('parent-run'),
    ownerThreadId,
    subagentType: 'explorer',
  });
  daemonContext.childRuns.markChildTerminal({
    childRunId,
    terminalState: 'completed',
    result: 'done',
  });

  const stopped = await agentStopTool.execute(
    {
      child_run_id: childRunId,
    },
    {
      callId: 'call-stop-terminal',
      stateRoot: '/tmp/home-state',
      threadId: ownerThreadId,
      runId: 'parent-run-2',
      runtimeServices: daemonContext,
    },
  );

  assert.equal(stopped.ok, true);
  const payload = JSON.parse(stopped.output) as {
    childRunId: string;
    stopState: string;
  };
  assert.equal(payload.childRunId, childRunId);
  assert.equal(payload.stopState, 'already_terminal');
});

void test('agent_stop rejects unknown child handles as an outer tool failure', async () => {
  const daemonContext = createDaemonContext();
  const ownerThreadId = testThreadId(44);

  const stopped = await agentStopTool.execute(
    {
      child_run_id: 'missing-child',
    },
    {
      callId: 'call-stop-missing',
      stateRoot: '/tmp/home-state',
      threadId: ownerThreadId,
      runId: 'parent-run',
      runtimeServices: daemonContext,
    },
  );

  assert.equal(stopped.ok, false);
  assert.equal(stopped.errorCode, 'invalid_args');
  assert.match(stopped.error ?? '', /unknown child run/);
  assert.equal(stopped.output, '');
});

void test('agent_stop keeps terminal child handles addressable', async () => {
  const ownerThreadId = testThreadId(48);
  const childRunId = testRunId('stop-terminal-child');
  const daemonContext = createDaemonContext();

  daemonContext.childRuns.registerChildRun({
    ...TEST_CHILD_MODEL_REGISTRATION,
    childRunId,
    childThreadId: testThreadId(49),
    parentRunId: testRunId('stop-terminal-parent'),
    ownerThreadId,
    subagentType: 'explorer',
  });
  daemonContext.childRuns.markChildTerminal({
    childRunId,
    terminalState: 'completed',
    result: 'done',
  });

  const stopped = await agentStopTool.execute(
    {
      child_run_id: childRunId,
    },
    {
      callId: 'call-stop-terminal',
      stateRoot: '/tmp/home-state',
      threadId: ownerThreadId,
      runId: testRunId('stop-terminal-top'),
      runtimeServices: daemonContext,
    },
  );

  assert.equal(stopped.ok, true);
  const payload = JSON.parse(stopped.output) as {
    childRunId: string;
    stopState: string;
  };
  assert.equal(payload.childRunId, childRunId);
  assert.equal(payload.stopState, 'already_terminal');
});

void test('agent_stop rejects child handles owned by another thread as an outer tool failure', async () => {
  const daemonContext = createDaemonContext();
  const childRunId = testRunId('foreign-child');
  daemonContext.childRuns.registerChildRun({
    ...TEST_CHILD_MODEL_REGISTRATION,
    childRunId,
    childThreadId: testThreadId(47),
    parentRunId: testRunId('foreign-parent'),
    ownerThreadId: testThreadId(45),
    subagentType: 'worker',
  });

  const stopped = await agentStopTool.execute(
    {
      child_run_id: childRunId,
    },
    {
      callId: 'call-stop-foreign',
      stateRoot: '/tmp/home-state',
      threadId: testThreadId(46),
      runId: 'parent-run',
      runtimeServices: daemonContext,
    },
  );

  assert.equal(stopped.ok, false);
  assert.equal(stopped.errorCode, 'invalid_args');
  assert.match(stopped.error ?? '', /does not belong to current owner thread/);
  assert.equal(stopped.output, '');
});
