import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { agentLoopKernelImplementation } from '@geulbat/agent-loop/kernel';
import { assertRunId, assertThreadId } from '@geulbat/protocol/ids';

import { createSubagentRunLauncher } from './subagent-support.js';
import { createRunState } from './runtime/run-state.js';
import { createDaemonContext } from '../context.js';
import { recoverDurableRunsAtDaemonStartup } from '../durable-run-execution.js';
import { createDaemonRuntimeStateStore } from '../runtime-state-store.js';
import type { RunCheckpoint } from '../sessions/run-checkpoint-persistence.js';
import {
  appendTranscriptEntry,
  readTranscriptEntries,
} from '../sessions/transcript-log.js';
import { createAgentSpawnTool } from '../tools/builtin/agent-spawn.js';
import { testRunId } from '../../test-support/run-id.js';
import { makeRunContext } from '../../test-support/run-context.js';
import {
  TEST_AUTO_SUBAGENT_MODEL_ROUTING,
  TEST_INHERITED_SOL_MODEL_PIN,
} from '../../test-support/subagent-model-routing.js';
import { testThreadId } from '../../test-support/thread-id.js';

void test('agent_spawn checkpoints the same child run before its loop executes', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-child-checkpoint-'));
  const ownerThreadId = testThreadId(802);
  const parentRunId = testRunId('child-checkpoint-parent');
  const store = await createDaemonRuntimeStateStore({
    homeStateRoot: stateRoot,
  });
  const daemonContext = createDaemonContext({
    homeStateRoot: stateRoot,
    subagentLaunchRequests: store,
    subagentTerminalDeliveries: store,
  });
  let observedCheckpoint: RunCheckpoint | null | undefined;
  let markLoopEntered!: () => void;
  const loopEntered = new Promise<void>((resolve) => {
    markLoopEntered = resolve;
  });
  const launcher = createSubagentRunLauncher({
    runAgentLoop: async (input) => {
      observedCheckpoint =
        await input.runtimeServices.runCheckpoints.readThread(
          input.runContext.threadId,
        );
      markLoopEntered();
      return { ok: true, finalProse: 'checkpointed child done' };
    },
  });
  daemonContext.subagent.runs = launcher;
  const agentSpawn = createAgentSpawnTool({
    startBackgroundRun: launcher.startBackgroundRun,
  });

  try {
    const result = await agentSpawn.execute(
      { task: 'inspect the durable child boundary', subagent_type: 'explorer' },
      {
        callId: 'call-child-checkpoint',
        stateRoot,
        workingDirectory: stateRoot,
        threadId: ownerThreadId,
        runId: parentRunId,
        runState: createRunState({
          runId: parentRunId,
          runContext: makeRunContext({ threadId: ownerThreadId, stateRoot }),
        }),
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        runtimeServices: daemonContext,
        computerSessionId: 'child-checkpoint-session',
        providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
        subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
      },
    );
    assert.equal(result.ok, true);
    const payload = JSON.parse(result.output) as {
      childRunId: string;
      childThreadId: string;
    };

    await loopEntered;

    assert.equal(observedCheckpoint?.status, 'running');
    assert.equal(observedCheckpoint?.runId, payload.childRunId);
    assert.equal(observedCheckpoint?.threadId, payload.childThreadId);
    const childThreadId = assertThreadId(payload.childThreadId);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        (await daemonContext.runCheckpoints.readThread(childThreadId))
          ?.status === 'terminal'
      ) {
        break;
      }
      await delay(10);
    }
    assert.equal(
      (await daemonContext.runCheckpoints.readThread(childThreadId))?.status,
      'terminal',
    );
  } finally {
    store.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('daemon replacement resumes one started child with the same run and thread identity', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-started-child-'));
  const ownerThreadId = testThreadId(803);
  const parentRunId = testRunId('started-child-replacement-parent');
  const firstStore = await createDaemonRuntimeStateStore({
    homeStateRoot: stateRoot,
  });
  const firstContext = createDaemonContext({
    homeStateRoot: stateRoot,
    subagentLaunchRequests: firstStore,
    subagentTerminalDeliveries: firstStore,
  });
  let firstModelPrompt = '';
  let markFirstLoopEntered!: () => void;
  const firstLoopEntered = new Promise<void>((resolve) => {
    markFirstLoopEntered = resolve;
  });
  const firstLauncher = createSubagentRunLauncher({
    runAgentLoop: async (input) => {
      firstModelPrompt = input.prompt;
      markFirstLoopEntered();
      return await new Promise<never>(() => {});
    },
  });
  firstContext.subagent.runs = firstLauncher;
  const agentSpawn = createAgentSpawnTool({
    startBackgroundRun: firstLauncher.startBackgroundRun,
  });
  let replacementStore:
    | Awaited<ReturnType<typeof createDaemonRuntimeStateStore>>
    | undefined;
  const recoveryFilePath = join(stateRoot, 'recovery-evidence.txt');
  await writeFile(recoveryFilePath, 'recovered exactly once\n', 'utf8');

  try {
    const launchResult = await agentSpawn.execute(
      { task: 'continue after daemon replacement', subagent_type: 'explorer' },
      {
        callId: 'call-started-child-replacement',
        stateRoot,
        workingDirectory: stateRoot,
        threadId: ownerThreadId,
        runId: parentRunId,
        runState: createRunState({
          runId: parentRunId,
          runContext: makeRunContext({ threadId: ownerThreadId, stateRoot }),
        }),
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        runtimeServices: firstContext,
        computerSessionId: 'stable-child-computer-session',
        providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
        subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
      },
    );
    assert.equal(launchResult.ok, true);
    const launched = JSON.parse(launchResult.output) as {
      childRunId: string;
      childThreadId: string;
    };
    const childRunId = assertRunId(launched.childRunId);
    const childThreadId = assertThreadId(launched.childThreadId);
    await firstLoopEntered;
    assert.equal(
      (await firstContext.runCheckpoints.readThread(childThreadId))?.status,
      'running',
    );
    await appendTranscriptEntry(stateRoot, childThreadId, {
      role: 'tool_call',
      content: JSON.stringify({
        id: 'item-child-recovery-read',
        callId: 'call-child-recovery-read',
        tool: 'read_file',
        args: { path: recoveryFilePath, limit: 10 },
        round: 1,
        recoveryStrategy: 'replay_safe',
      }),
      timestamp: '2026-07-28T00:00:01.000Z',
    });
    firstStore.close();

    replacementStore = await createDaemonRuntimeStateStore({
      homeStateRoot: stateRoot,
      deferSubagentRestartReconciliation: true,
    });
    assert.equal(
      replacementStore.readSubagentLaunchRequestByChildRunId(childRunId)
        ?.launchState,
      'started',
    );
    const replacementContext = createDaemonContext({
      homeStateRoot: stateRoot,
      subagentLaunchRequests: replacementStore,
      subagentTerminalDeliveries: replacementStore,
      subagentConcurrencyPolicy: { maxConcurrentChildren: 1 },
    });
    let replacementDispatchCount = 0;
    let recoveredRunId = '';
    let recoveredThreadId = '';
    let recoveredCapacityBlocked = false;
    let markReplacementLoopEntered!: () => void;
    const replacementLoopEntered = new Promise<void>((resolve) => {
      markReplacementLoopEntered = resolve;
    });
    let releaseReplacementLoop!: () => void;
    const replacementLoopReleased = new Promise<void>((resolve) => {
      releaseReplacementLoop = resolve;
    });
    const replacementLauncher = createSubagentRunLauncher({
      runAgentLoop: async (input) => {
        replacementDispatchCount += 1;
        recoveredRunId = input.runId;
        recoveredThreadId = input.runContext.threadId;
        assert.equal(input.prompt, firstModelPrompt);
        assert.ok(input.historyPort);
        assert.ok(input.runState);
        const nestedAdmission =
          replacementContext.subagent.admission.reserveSubagentLaunchSlots({
            runState: input.runState,
            requestedChildren: 1,
            ultraReasoning: false,
          });
        recoveredCapacityBlocked = !nestedAdmission.ok;
        if (nestedAdmission.ok) {
          nestedAdmission.reservation.release();
        }
        markReplacementLoopEntered();
        await replacementLoopReleased;
        return { ok: true, finalProse: 'continued child result' };
      },
    });
    replacementContext.subagent.runs = replacementLauncher;

    assert.equal(
      await recoverDurableRunsAtDaemonStartup(replacementContext),
      1,
    );
    await replacementLoopEntered;
    assert.equal(
      replacementContext.childRuns.getChildRun(childRunId)?.status,
      'running',
    );
    assert.equal(
      replacementContext.activeRuns.getRunById(childRunId)?.parentRunId,
      parentRunId,
    );
    assert.equal(recoveredCapacityBlocked, true);

    const acknowledgeTerminalEvent =
      replacementContext.runCheckpoints.acknowledgeTerminalEvent.bind(
        replacementContext.runCheckpoints,
      );
    let markChildAcknowledgementEntered!: () => void;
    const childAcknowledgementEntered = new Promise<void>((resolve) => {
      markChildAcknowledgementEntered = resolve;
    });
    let releaseChildAcknowledgement!: () => void;
    const childAcknowledgementReleased = new Promise<void>((resolve) => {
      releaseChildAcknowledgement = resolve;
    });
    replacementContext.runCheckpoints.acknowledgeTerminalEvent = async (
      args,
    ) => {
      if (args.runId === childRunId) {
        markChildAcknowledgementEntered();
        await childAcknowledgementReleased;
      }
      return await acknowledgeTerminalEvent(args);
    };

    releaseReplacementLoop();
    await childAcknowledgementEntered;

    const durableOutcome =
      replacementStore.readSubagentTerminalOutcomeByChildRunId(childRunId);
    assert.equal(replacementDispatchCount, 1);
    assert.equal(recoveredRunId, childRunId);
    assert.equal(recoveredThreadId, childThreadId);
    assert.equal(durableOutcome?.result.result, 'continued child result');
    assert.equal(
      replacementStore.readSubagentTerminalDeliveries(ownerThreadId).length,
      1,
    );
    const checkpointBeforeAcknowledgement =
      await replacementContext.runCheckpoints.readThread(childThreadId);
    assert.equal(checkpointBeforeAcknowledgement?.status, 'terminal');
    assert.equal(
      checkpointBeforeAcknowledgement?.terminal?.acknowledged,
      false,
    );

    releaseChildAcknowledgement();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const checkpoint =
        await replacementContext.runCheckpoints.readThread(childThreadId);
      if (
        checkpoint?.status === 'terminal' &&
        checkpoint.terminal?.acknowledged === true
      ) {
        break;
      }
      await delay(10);
    }
    const terminalCheckpoint =
      await replacementContext.runCheckpoints.readThread(childThreadId);
    assert.equal(terminalCheckpoint?.status, 'terminal');
    assert.equal(terminalCheckpoint?.terminal?.acknowledged, true);
    const recoveredToolResults = (
      await readTranscriptEntries(stateRoot, childThreadId)
    ).filter((entry) => {
      if (entry.role !== 'tool_result') {
        return false;
      }
      const content = JSON.parse(entry.content) as { callId?: string };
      return content.callId === 'call-child-recovery-read';
    });
    assert.equal(recoveredToolResults.length, 1);
    assert.equal(
      await recoverDurableRunsAtDaemonStartup(replacementContext),
      0,
    );
    assert.equal(replacementDispatchCount, 1);
    assert.equal(
      replacementStore.readSubagentTerminalDeliveries(ownerThreadId).length,
      1,
    );
  } finally {
    firstStore.close();
    replacementStore?.close();
    await delay(20);
    await rm(stateRoot, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  }
});

void test('daemon replacement settles a delivered child terminal checkpoint without redispatch', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-child-terminal-window-'),
  );
  const ownerThreadId = testThreadId(804);
  const parentRunId = testRunId('child-terminal-window-parent');
  let store = await createDaemonRuntimeStateStore({ homeStateRoot: stateRoot });
  const [launch] = store.enqueueSubagentLaunchBatch([
    {
      toolCallId: 'call-child-terminal-window',
      task: 'already completed before checkpoint settlement',
      subagentType: 'explorer',
      capabilities: [],
      parentRunId,
      ownerThreadId,
      stateRoot,
      workingDirectory: stateRoot,
      permissionMode: 'basic',
      ultraReasoning: false,
      modelPin: TEST_INHERITED_SOL_MODEL_PIN,
      subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
    },
  ]);
  assert.ok(launch);
  store.markSubagentLaunchStarting(launch.childRunId);
  store.markSubagentLaunchStarted(launch.childRunId);
  const beforeReplacement = createDaemonContext({
    homeStateRoot: stateRoot,
    subagentLaunchRequests: store,
    subagentTerminalDeliveries: store,
  });
  await beforeReplacement.runCheckpoints.startRun({
    runId: launch.childRunId,
    threadId: launch.childThreadId,
    request: {
      workingDirectory: stateRoot,
      permissionMode: 'basic',
      ultraReasoning: false,
      loopImplementation: {
        implementationId: agentLoopKernelImplementation.implementationId,
        contractVersion: agentLoopKernelImplementation.contractVersion,
      },
      providerModel:
        TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection.providerModel,
      reasoningEffort:
        TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection.reasoningEffort,
      subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
      toolSurface: {
        directRegistryNames: ['read_file'],
        allowedRegistryNames: ['read_file'],
      },
      backgroundChild: {
        parentRunId,
        ownerThreadId,
        computerSessionId: 'child-terminal-window-session',
      },
    },
  });
  store.recordSubagentTerminalDelivery({
    ownerThreadId,
    result: {
      deliveryId: randomUUID(),
      parentRunId,
      childRunId: launch.childRunId,
      childThreadId: launch.childThreadId,
      subagentType: 'explorer',
      capabilities: [],
      toolSurface: 'explorer',
      terminalState: 'completed',
      result: 'terminal already durable',
      completedAt: '2026-07-28T00:00:02.000Z',
      modelId: TEST_INHERITED_SOL_MODEL_PIN.modelId,
      reasoningEffort:
        TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection.reasoningEffort,
    },
  });
  store.close();

  try {
    store = await createDaemonRuntimeStateStore({
      homeStateRoot: stateRoot,
      deferSubagentRestartReconciliation: true,
    });
    const replacement = createDaemonContext({
      homeStateRoot: stateRoot,
      subagentLaunchRequests: store,
      subagentTerminalDeliveries: store,
    });
    let replacementDispatchCount = 0;
    replacement.subagent.runs = createSubagentRunLauncher({
      runAgentLoop: async () => {
        replacementDispatchCount += 1;
        return { ok: true, finalProse: 'must not run' };
      },
    });

    assert.equal(await recoverDurableRunsAtDaemonStartup(replacement), 1);
    assert.equal(replacementDispatchCount, 0);
    const checkpoint = await replacement.runCheckpoints.readThread(
      launch.childThreadId,
    );
    assert.equal(checkpoint?.status, 'terminal');
    assert.equal(checkpoint?.terminal?.acknowledged, true);
    assert.deepEqual(checkpoint?.terminal?.event, {
      type: 'done',
      payload: { answer: 'terminal already durable', ok: true },
    });
    assert.equal(
      store.readSubagentLaunchRequestByChildRunId(launch.childRunId)
        ?.launchState,
      'started',
    );
    assert.equal(await recoverDurableRunsAtDaemonStartup(replacement), 0);
    assert.equal(replacementDispatchCount, 0);
  } finally {
    store.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('daemon replacement terminalizes a queued child whose parent can no longer recover', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-orphaned-queued-child-'),
  );
  const ownerThreadId = testThreadId(808);
  const parentRunId = testRunId('orphaned-queued-child-parent');
  let store = await createDaemonRuntimeStateStore({ homeStateRoot: stateRoot });
  const [launch] = store.enqueueSubagentLaunchBatch([
    {
      toolCallId: 'call-orphaned-queued-child',
      task: 'must become terminal when its parent cannot recover',
      subagentType: 'explorer',
      capabilities: [],
      parentRunId,
      ownerThreadId,
      stateRoot,
      workingDirectory: stateRoot,
      permissionMode: 'basic',
      ultraReasoning: false,
      modelPin: TEST_INHERITED_SOL_MODEL_PIN,
      subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
    },
  ]);
  assert.ok(launch);
  store.close();

  try {
    store = await createDaemonRuntimeStateStore({
      homeStateRoot: stateRoot,
      deferSubagentRestartReconciliation: true,
    });
    const replacement = createDaemonContext({
      homeStateRoot: stateRoot,
      subagentLaunchRequests: store,
      subagentTerminalDeliveries: store,
    });

    assert.equal(await recoverDurableRunsAtDaemonStartup(replacement), 0);
    const interrupted = store.readSubagentLaunchRequestByChildRunId(
      launch.childRunId,
    );
    assert.equal(interrupted?.launchState, 'interrupted');
    assert.equal(interrupted?.deferReason, null);
    assert.equal(interrupted?.failureReason, 'daemon_restart_interrupted');

    const outcome = store.readSubagentTerminalOutcomeByChildRunId(
      launch.childRunId,
    );
    assert.ok(outcome);
    assert.equal(outcome.ownerThreadId, ownerThreadId);
    assert.equal(outcome.result.parentRunId, parentRunId);
    assert.equal(outcome.result.childThreadId, launch.childThreadId);
    assert.equal(outcome.result.terminalState, 'failed');
    assert.equal(outcome.result.reason, 'daemon_restart');
    assert.match(outcome.result.result, /parent run could not be recovered/u);
    assert.deepEqual(
      store.readPendingSubagentTerminalDeliveries(ownerThreadId),
      [outcome],
    );
  } finally {
    store.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('daemon replacement interrupts a child whose exact loop owner cannot be recovered', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-child-loop-mismatch-'),
  );
  const ownerThreadId = testThreadId(805);
  const parentRunId = testRunId('child-loop-mismatch-parent');
  let store = await createDaemonRuntimeStateStore({ homeStateRoot: stateRoot });
  const [launch] = store.enqueueSubagentLaunchBatch([
    {
      toolCallId: 'call-child-loop-mismatch',
      task: 'must not silently replay under another loop owner',
      subagentType: 'explorer',
      capabilities: [],
      parentRunId,
      ownerThreadId,
      stateRoot,
      workingDirectory: stateRoot,
      permissionMode: 'basic',
      ultraReasoning: false,
      modelPin: TEST_INHERITED_SOL_MODEL_PIN,
      subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
    },
  ]);
  assert.ok(launch);
  store.markSubagentLaunchStarting(launch.childRunId);
  store.markSubagentLaunchStarted(launch.childRunId);
  const beforeReplacement = createDaemonContext({
    homeStateRoot: stateRoot,
    subagentLaunchRequests: store,
    subagentTerminalDeliveries: store,
  });
  await beforeReplacement.runCheckpoints.startRun({
    runId: launch.childRunId,
    threadId: launch.childThreadId,
    request: {
      workingDirectory: stateRoot,
      permissionMode: 'basic',
      ultraReasoning: false,
      loopImplementation: {
        implementationId: 'missing.child-loop-owner',
        contractVersion: '1',
      },
      providerModel:
        TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection.providerModel,
      reasoningEffort:
        TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection.reasoningEffort,
      subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
      toolSurface: {
        directRegistryNames: ['read_file'],
        allowedRegistryNames: ['read_file'],
      },
      backgroundChild: {
        parentRunId,
        ownerThreadId,
        computerSessionId: 'child-loop-mismatch-session',
      },
    },
  });
  store.close();

  try {
    store = await createDaemonRuntimeStateStore({
      homeStateRoot: stateRoot,
      deferSubagentRestartReconciliation: true,
    });
    const replacement = createDaemonContext({
      homeStateRoot: stateRoot,
      subagentLaunchRequests: store,
      subagentTerminalDeliveries: store,
    });
    let replacementDispatchCount = 0;
    replacement.subagent.runs = createSubagentRunLauncher({
      runAgentLoop: async () => {
        replacementDispatchCount += 1;
        return { ok: true, finalProse: 'must not run' };
      },
    });

    assert.equal(await recoverDurableRunsAtDaemonStartup(replacement), 0);
    assert.equal(replacementDispatchCount, 0);
    const interrupted = store.readSubagentLaunchRequestByChildRunId(
      launch.childRunId,
    );
    assert.equal(interrupted?.launchState, 'interrupted');
    assert.equal(interrupted?.failureReason, 'daemon_restart_interrupted');
    assert.equal(
      store.readSubagentTerminalOutcomeByChildRunId(launch.childRunId)?.result
        .reason,
      'daemon_restart',
    );
    const checkpoint = await replacement.runCheckpoints.readThread(
      launch.childThreadId,
    );
    assert.equal(checkpoint?.status, 'terminal');
    assert.equal(checkpoint?.terminal?.acknowledged, true);
    assert.equal(checkpoint?.terminal?.event.type, 'done');
    if (checkpoint?.terminal?.event.type === 'done') {
      assert.equal(checkpoint.terminal.event.payload.ok, false);
      assert.match(
        checkpoint.terminal.event.payload.answer,
        /daemon restarted/u,
      );
    }
  } finally {
    store.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('daemon replacement recovers nested children in parent-before-child order', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-nested-child-'));
  const ownerThreadId = testThreadId(806);
  const rootRunId = testRunId('nested-recovery-root');
  let store = await createDaemonRuntimeStateStore({ homeStateRoot: stateRoot });
  const [parentLaunch] = store.enqueueSubagentLaunchBatch([
    {
      toolCallId: 'call-nested-parent',
      task: 'recover parent child',
      subagentType: 'explorer',
      capabilities: [],
      parentRunId: rootRunId,
      ownerThreadId,
      stateRoot,
      workingDirectory: stateRoot,
      permissionMode: 'basic',
      ultraReasoning: false,
      modelPin: TEST_INHERITED_SOL_MODEL_PIN,
      subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
    },
  ]);
  assert.ok(parentLaunch);
  const [grandchildLaunch] = store.enqueueSubagentLaunchBatch([
    {
      toolCallId: 'call-nested-grandchild',
      task: 'recover nested grandchild',
      subagentType: 'explorer',
      capabilities: [],
      parentRunId: parentLaunch.childRunId,
      ownerThreadId,
      stateRoot,
      workingDirectory: stateRoot,
      permissionMode: 'basic',
      ultraReasoning: false,
      modelPin: TEST_INHERITED_SOL_MODEL_PIN,
      subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
    },
  ]);
  assert.ok(grandchildLaunch);
  for (const launch of [parentLaunch, grandchildLaunch]) {
    store.markSubagentLaunchStarting(launch.childRunId);
    store.markSubagentLaunchStarted(launch.childRunId);
  }
  const beforeReplacement = createDaemonContext({
    homeStateRoot: stateRoot,
    subagentLaunchRequests: store,
    subagentTerminalDeliveries: store,
  });
  for (const [launch, parentRunId, prompt] of [
    [parentLaunch, rootRunId, 'recover parent child'],
    [grandchildLaunch, parentLaunch.childRunId, 'recover nested grandchild'],
  ] as const) {
    await beforeReplacement.runCheckpoints.startRun({
      runId: launch.childRunId,
      threadId: launch.childThreadId,
      request: {
        workingDirectory: stateRoot,
        permissionMode: 'basic',
        ultraReasoning: false,
        loopImplementation: {
          implementationId: agentLoopKernelImplementation.implementationId,
          contractVersion: agentLoopKernelImplementation.contractVersion,
        },
        providerModel:
          TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection.providerModel,
        reasoningEffort:
          TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection.reasoningEffort,
        subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
        toolSurface: {
          directRegistryNames: ['read_file'],
          allowedRegistryNames: ['read_file'],
        },
        backgroundChild: {
          parentRunId,
          ownerThreadId,
          computerSessionId: 'nested-recovery-session',
        },
      },
    });
    await appendTranscriptEntry(stateRoot, launch.childThreadId, {
      role: 'user',
      content: prompt,
      timestamp: '2026-07-28T00:00:00.000Z',
    });
  }
  store.close();

  try {
    store = await createDaemonRuntimeStateStore({
      homeStateRoot: stateRoot,
      deferSubagentRestartReconciliation: true,
    });
    const replacement = createDaemonContext({
      homeStateRoot: stateRoot,
      subagentLaunchRequests: store,
      subagentTerminalDeliveries: store,
      subagentConcurrencyPolicy: { maxConcurrentChildren: 2 },
    });
    const recoveryOrder: string[] = [];
    const launcher = createSubagentRunLauncher({
      runAgentLoop: async (input) => ({
        ok: true,
        finalProse: `recovered ${input.runId}`,
      }),
    });
    const recoverBackgroundRun = launcher.recoverBackgroundRun;
    assert.ok(recoverBackgroundRun);
    replacement.subagent.runs = {
      startBackgroundRun: launcher.startBackgroundRun,
      async recoverBackgroundRun(args) {
        recoveryOrder.push(args.checkpoint.runId);
        return await recoverBackgroundRun(args);
      },
    };

    assert.equal(await recoverDurableRunsAtDaemonStartup(replacement), 2);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        store.readSubagentTerminalOutcomeByChildRunId(
          parentLaunch.childRunId,
        ) &&
        store.readSubagentTerminalOutcomeByChildRunId(
          grandchildLaunch.childRunId,
        )
      ) {
        break;
      }
      await delay(10);
    }

    assert.deepEqual(recoveryOrder, [
      parentLaunch.childRunId,
      grandchildLaunch.childRunId,
    ]);
    assert.equal(
      store.readSubagentTerminalOutcomeByChildRunId(parentLaunch.childRunId)
        ?.result.result,
      `recovered ${parentLaunch.childRunId}`,
    );
    assert.equal(
      store.readSubagentTerminalOutcomeByChildRunId(grandchildLaunch.childRunId)
        ?.result.result,
      `recovered ${grandchildLaunch.childRunId}`,
    );
    assert.equal(store.readSubagentTerminalDeliveries(ownerThreadId).length, 2);
  } finally {
    store.close();
    await delay(20);
    await rm(stateRoot, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  }
});
