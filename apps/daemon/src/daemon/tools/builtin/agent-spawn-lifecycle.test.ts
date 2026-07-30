import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { assertRunId, assertThreadId } from '@geulbat/protocol/ids';

import { createRunState } from '../../agent/runtime/run-state.js';
import { createSubagentRunLauncher } from '../../agent/subagent-support.js';
import { createDaemonContext as createBaseDaemonContext } from '../../context.js';
import { createDaemonRuntimeStateStore } from '../../runtime-state-store.js';
import { threadFilePath } from '../../sessions/paths.js';
import { createAgentSpawnDaemonContext as createDaemonContext } from '../../../test-support/agent-spawn.js';
import { makeRunContext } from '../../../test-support/run-context.js';
import { testRunId } from '../../../test-support/run-id.js';
import {
  TEST_AUTO_SUBAGENT_MODEL_ROUTING,
  TEST_INHERITED_SOL_MODEL_PIN,
} from '../../../test-support/subagent-model-routing.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { createAgentSpawnTool } from './agent-spawn.js';

void test('agent_spawn restart recovery returns the original interrupted child handle without launching a duplicate', async (t) => {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-spawn-recovery-'),
  );
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const stateRoot = join(fixtureRoot, 'workspace-state');
  const parentRunId = testRunId('agent-spawn-recovery-parent');
  const ownerThreadId = testThreadId(190);
  const toolCallId = 'call-agent-spawn-recovery';
  const originalStore = await createDaemonRuntimeStateStore({ homeStateRoot });
  const [accepted] = originalStore.enqueueSubagentLaunchBatch([
    {
      toolCallId,
      task: 'recover the original child handle',
      subagentType: 'explorer',
      capabilities: [],
      parentRunId,
      ownerThreadId,
      stateRoot,
      workingDirectory: fixtureRoot,
      permissionMode: 'basic',
      ultraReasoning: false,
      modelPin: TEST_INHERITED_SOL_MODEL_PIN,
      subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
    },
  ]);
  assert.ok(accepted);
  originalStore.markSubagentLaunchStarting(accepted.childRunId);
  originalStore.markSubagentLaunchStarted(accepted.childRunId);
  originalStore.close();

  const replacementStore = await createDaemonRuntimeStateStore({
    homeStateRoot,
  });
  const daemonContext = createBaseDaemonContext({
    homeStateRoot,
    subagentLaunchRequests: replacementStore,
  });
  t.after(async () => {
    await daemonContext.subagent.launchPromotions?.close();
    replacementStore.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  });
  assert.equal(
    replacementStore.readSubagentLaunchRequestByChildRunId(accepted.childRunId)
      ?.launchState,
    'interrupted',
  );

  let launchCount = 0;
  const recoveringTool = createAgentSpawnTool({
    async startBackgroundRun() {
      launchCount += 1;
      throw new Error('interrupted child recovery must not launch a duplicate');
    },
  });
  const parentRunState = createRunState({
    runId: parentRunId,
    runContext: makeRunContext({
      threadId: ownerThreadId,
      stateRoot,
    }),
  });
  const result = await recoveringTool.execute(
    {
      task: 'recover the original child handle',
      subagent_type: 'explorer',
      model_id: 'retired-model-id',
    },
    {
      kind: 'agent',
      runOwnerKind: 'root_main',
      callId: toolCallId,
      stateRoot,
      workingDirectory: fixtureRoot,
      threadId: ownerThreadId,
      runId: parentRunId,
      runState: parentRunState,
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
      currentFile: undefined,
      selection: undefined,
      approvalGranted: false,
      runtimeServices: daemonContext,
      memoryIndex: undefined,
      emitAgentEvent: () => {},
      permissionMode: 'basic',
      ultraReasoning: false,
      computerSessionId: 'replacement-session',
    },
  );

  assert.equal(launchCount, 0);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.output), {
    ok: true,
    childRunId: accepted.childRunId,
    childThreadId: accepted.childThreadId,
    subagentType: 'explorer',
    launchState: 'started',
    modelId: TEST_INHERITED_SOL_MODEL_PIN.modelId,
    reasoningEffort:
      TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection.reasoningEffort,
    selectionSource: TEST_INHERITED_SOL_MODEL_PIN.selectionSource,
  });
});

void test('agent_spawn returns launch-only ack and tracks child state in the registry', async () => {
  const threadId = testThreadId(5);
  const daemonContext = createDaemonContext();
  const parentState = createRunState({
    runId: 'top-run-background',
    runContext: makeRunContext({
      threadId,
      stateRoot: '/tmp/home-state',
    }),
  });
  let childStarted = false;
  let releaseChild!: () => void;
  const childFinished = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async () => {
        childStarted = true;
        await childFinished;
        return {
          ok: true,
          finalProse: 'child ok',
        };
      },
    }).startBackgroundRun,
  });

  const result = await testAgentSpawnTool.execute(
    {
      task: 'read files',
      subagent_type: 'explorer',
    },
    {
      callId: 'call-background',
      providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
      stateRoot: '/tmp/home-state',
      threadId,
      runId: 'top-run-background',
      runState: parentState,
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
      runtimeServices: daemonContext,
      computerSessionId: 'background-launch-session',
    },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    ok: boolean;
    childRunId: string;
    childThreadId: string;
    launchState: string;
  };
  const childRunId = assertRunId(payload.childRunId);
  assert.equal(payload.ok, true);
  assert.equal(payload.launchState, 'started');
  assert.equal(parentState.backgroundChildRunIds.has(childRunId), true);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (childStarted) {
      break;
    }
    await delay(10);
  }
  assert.equal(childStarted, true);
  assert.equal(
    daemonContext.childRuns.getChildRun(childRunId)?.status,
    'running',
  );

  releaseChild();

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!parentState.backgroundChildRunIds.has(childRunId)) {
      break;
    }
    await delay(10);
  }

  assert.equal(parentState.backgroundChildRunIds.has(childRunId), false);
  assert.equal(
    daemonContext.childRuns.getChildRun(childRunId)?.status,
    'completed',
  );
});

void test('agent_spawn logs child loop throws before publishing terminal failure', async () => {
  const threadId = testThreadId(20);
  const daemonContext = createDaemonContext();
  const parentState = createRunState({
    runId: 'top-run-child-throw',
    runContext: makeRunContext({
      threadId,
      stateRoot: '/tmp/home-state',
    }),
  });
  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async () => {
        throw new Error('child loop exploded');
      },
    }).startBackgroundRun,
  });
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  try {
    const result = await testAgentSpawnTool.execute(
      {
        task: 'read files',
        subagent_type: 'explorer',
      },
      {
        callId: 'call-child-loop-throw',
        providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
        stateRoot: '/tmp/home-state',
        threadId,
        runId: 'top-run-child-throw',
        runState: parentState,
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        runtimeServices: daemonContext,
        computerSessionId: 'throw-log-session',
      },
    );

    assert.equal(result.ok, true);
    const payload = JSON.parse(result.output) as {
      childRunId: string;
    };
    const childRunId = assertRunId(payload.childRunId);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        daemonContext.childRuns.getChildRun(childRunId)?.status === 'failed'
      ) {
        break;
      }
      await delay(20);
    }

    const childRun = daemonContext.childRuns.getChildRun(childRunId);
    assert.equal(childRun?.status, 'failed');
    assert.equal(childRun?.reason, 'child_error');

    const diagnostic = errors.find(([line]) =>
      String(line).includes('subagent runAgentLoop failed'),
    );
    assert.ok(diagnostic);
    assert.match(
      String(diagnostic[0]),
      /error \[agent\/subagent-support\] subagent runAgentLoop failed:/,
    );
    assert.equal(
      (diagnostic[1] as { childRunId?: unknown })?.childRunId,
      payload.childRunId,
    );
    assert.equal(
      (diagnostic[1] as { cause?: unknown })?.cause,
      'child loop exploded',
    );
  } finally {
    console.error = originalError;
  }
});

void test('agent_spawn uses child error event messages as terminal child results', async () => {
  const threadId = testThreadId(51);
  const daemonContext = createDaemonContext();
  const parentState = createRunState({
    runId: 'top-run-child-error-event',
    runContext: makeRunContext({
      threadId,
      stateRoot: '/tmp/home-state',
    }),
  });
  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async (input) => {
        input.onEvent({
          type: 'error',
          payload: {
            code: 'internal',
            message: 'child event failed',
          },
        });
        assert.equal(
          daemonContext.childRuns.getChildRun(assertRunId(input.runId))?.status,
          'running',
        );
        return {
          ok: false,
          finalProse: '',
        };
      },
    }).startBackgroundRun,
  });

  const result = await testAgentSpawnTool.execute(
    {
      task: 'read files',
      subagent_type: 'explorer',
    },
    {
      callId: 'call-child-error-event',
      providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
      stateRoot: '/tmp/home-state',
      threadId,
      runId: 'top-run-child-error-event',
      runState: parentState,
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
      runtimeServices: daemonContext,
      computerSessionId: 'child-error-event-session',
    },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    childRunId: string;
  };
  const childRunId = assertRunId(payload.childRunId);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (daemonContext.childRuns.getChildRun(childRunId)?.status === 'failed') {
      break;
    }
    await delay(20);
  }

  const childRun = daemonContext.childRuns.getChildRun(childRunId);
  assert.equal(childRun?.status, 'failed');
  assert.equal(childRun?.reason, 'child_error');
  assert.equal(childRun?.result, 'child event failed');
});

void test('agent_spawn preserves child success when assistant transcript persistence fails', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-spawn-transcript-'),
  );
  const threadId = testThreadId(52);
  const childResultText = 'child completed despite transcript failure';
  const daemonContext = createDaemonContext();
  const parentState = createRunState({
    runId: 'top-run-transcript-failure',
    runContext: makeRunContext({
      threadId,
      stateRoot,
    }),
  });
  const diagnostics: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    diagnostics.push(args);
  };

  try {
    const testAgentSpawnTool = createAgentSpawnTool({
      startBackgroundRun: createSubagentRunLauncher({
        runAgentLoop: async (input) => {
          const transcriptPath = threadFilePath(
            input.runContext.stateRoot,
            input.runContext.threadId,
          );
          await rm(transcriptPath, { recursive: true, force: true });
          await mkdir(transcriptPath, { recursive: true });
          return { ok: true, finalProse: childResultText };
        },
      }).startBackgroundRun,
    });

    const result = await testAgentSpawnTool.execute(
      {
        task: 'write result',
        subagent_type: 'explorer',
      },
      {
        callId: 'call-transcript-persistence-failure',
        providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
        stateRoot,
        threadId,
        runId: 'top-run-transcript-failure',
        runState: parentState,
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        runtimeServices: daemonContext,
        computerSessionId: 'transcript-failure-session',
      },
    );

    assert.equal(result.ok, true);
    const payload = JSON.parse(result.output) as { childRunId: string };
    const childRunId = assertRunId(payload.childRunId);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (
        daemonContext.childRuns.getChildRun(childRunId)?.status !== 'running'
      ) {
        break;
      }
      await delay(10);
    }

    const childRun = daemonContext.childRuns.getChildRun(childRunId);
    assert.equal(childRun?.status, 'completed');
    assert.equal(childRun?.result, childResultText);

    const backgroundResults =
      daemonContext.backgroundNotifications.consumeThreadBackgroundResults(
        threadId,
      );
    assert.equal(backgroundResults.length, 1);
    assert.equal(backgroundResults[0]?.terminalState, 'completed');
    assert.equal(backgroundResults[0]?.result, childResultText);
    const diagnostic = diagnostics.find((entry) =>
      String(entry[0]).includes(
        'child assistant transcript persistence failed',
      ),
    );
    assert.ok(diagnostic);
    assert.equal(
      (diagnostic[1] as { parentRunId?: unknown })?.parentRunId,
      'top-run-transcript-failure',
    );
    assert.equal(
      (diagnostic[1] as { childRunId?: unknown })?.childRunId,
      childRunId,
    );
    assert.equal(
      (diagnostic[1] as { subagentType?: unknown })?.subagentType,
      'explorer',
    );
  } finally {
    console.error = originalError;
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('agent_spawn catches async publish failures without leaking unhandled rejections', async () => {
  const threadId = testThreadId(6);
  const daemonContext = createDaemonContext();
  const parentState = createRunState({
    runId: 'top-run-notify',
    runContext: makeRunContext({
      threadId,
      stateRoot: '/tmp/home-state',
    }),
  });
  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async () => ({
        ok: false,
        finalProse: '',
      }),
    }).startBackgroundRun,
  });
  const originalEnqueue =
    daemonContext.backgroundNotifications.enqueueThreadBackgroundResult;
  daemonContext.backgroundNotifications.enqueueThreadBackgroundResult = (() => {
    throw new Error('queue unavailable');
  }) as typeof daemonContext.backgroundNotifications.enqueueThreadBackgroundResult;

  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  process.on('unhandledRejection', onUnhandledRejection);

  try {
    const result = await testAgentSpawnTool.execute(
      {
        task: 'read files',
        subagent_type: 'explorer',
      },
      {
        callId: 'call-notify',
        providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
        stateRoot: '/tmp/home-state',
        threadId,
        runId: 'top-run-notify',
        runState: parentState,
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        runtimeServices: daemonContext,
        computerSessionId: 'publish-failure-session',
      },
    );

    assert.equal(result.ok, true);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        parentState.backgroundChildRunIds.size === 0 &&
        parentState.childRunIds.size === 0
      ) {
        break;
      }
      await delay(20);
    }

    assert.equal(parentState.backgroundChildRunIds.size, 0);
    assert.equal(parentState.childRunIds.size, 0);
    assert.deepEqual(unhandledRejections, []);
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
    daemonContext.backgroundNotifications.enqueueThreadBackgroundResult =
      originalEnqueue;
  }
});

void test('agent_spawn settles the child checkpoint after a transient terminal-store publish failure', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-child-terminal-retry-'),
  );
  const threadId = testThreadId(21);
  const store = await createDaemonRuntimeStateStore({
    homeStateRoot: stateRoot,
  });
  const originalRecord = store.recordSubagentTerminalDelivery;
  let recordAttempts = 0;
  store.recordSubagentTerminalDelivery = (args) => {
    recordAttempts += 1;
    if (recordAttempts === 1) {
      throw new Error('transient terminal store failure');
    }
    return originalRecord(args);
  };
  const daemonContext = createDaemonContext({
    homeStateRoot: stateRoot,
    subagentTerminalDeliveries: store,
  });
  const parentRunId = testRunId('top-run-terminal-retry');
  const parentState = createRunState({
    runId: parentRunId,
    runContext: makeRunContext({
      threadId,
      stateRoot,
    }),
  });
  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async () => ({
        ok: true,
        finalProse: 'terminal retry completed',
      }),
    }).startBackgroundRun,
  });

  try {
    const result = await testAgentSpawnTool.execute(
      {
        task: 'finish despite one rejected terminal write',
        subagent_type: 'explorer',
      },
      {
        callId: 'call-terminal-retry',
        providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
        stateRoot,
        workingDirectory: stateRoot,
        threadId,
        runId: parentRunId,
        runState: parentState,
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        runtimeServices: daemonContext,
        computerSessionId: 'terminal-retry-session',
      },
    );
    assert.equal(result.ok, true);
    const payload = JSON.parse(result.output) as {
      childRunId: string;
      childThreadId: string;
    };
    const childRunId = assertRunId(payload.childRunId);
    const childThreadId = assertThreadId(payload.childThreadId);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const checkpoint =
        await daemonContext.runCheckpoints.readThread(childThreadId);
      if (
        checkpoint?.status === 'terminal' &&
        checkpoint.terminal?.acknowledged === true
      ) {
        break;
      }
      await delay(10);
    }

    assert.equal(recordAttempts, 2);
    const checkpoint =
      await daemonContext.runCheckpoints.readThread(childThreadId);
    assert.equal(checkpoint?.status, 'terminal');
    assert.equal(checkpoint?.terminal?.acknowledged, true);
    assert.equal(
      store.readSubagentTerminalOutcomeByChildRunId(childRunId)?.result.result,
      'terminal retry completed',
    );
    assert.equal(daemonContext.childRuns.getChildRun(childRunId), undefined);
    const [pending] =
      daemonContext.backgroundNotifications.readThreadBackgroundResults(
        threadId,
      );
    assert.equal(pending?.childRunId, childRunId);
    assert.equal(pending?.result, 'terminal retry completed');
  } finally {
    store.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('agent_spawn keeps terminal notification independent from registry publish failure', async () => {
  const threadId = testThreadId(19);
  const daemonContext = createDaemonContext();
  const parentState = createRunState({
    runId: 'top-run-terminal-sink',
    runContext: makeRunContext({
      threadId,
      stateRoot: '/tmp/home-state',
    }),
  });
  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async () => ({
        ok: false,
        finalProse: '',
      }),
    }).startBackgroundRun,
  });
  const originalMarkChildTerminal = daemonContext.childRuns.markChildTerminal;
  daemonContext.childRuns.markChildTerminal = (() => {
    throw new Error('registry unavailable');
  }) as typeof daemonContext.childRuns.markChildTerminal;

  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  process.on('unhandledRejection', onUnhandledRejection);

  try {
    const result = await testAgentSpawnTool.execute(
      {
        task: 'read files',
        subagent_type: 'explorer',
      },
      {
        callId: 'call-terminal-sink',
        providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
        stateRoot: '/tmp/home-state',
        threadId,
        runId: 'top-run-terminal-sink',
        runState: parentState,
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        runtimeServices: daemonContext,
        computerSessionId: 'registry-publish-failure-session',
      },
    );

    assert.equal(result.ok, true);

    let backgroundResults =
      daemonContext.backgroundNotifications.consumeThreadBackgroundResults(
        threadId,
      );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        parentState.backgroundChildRunIds.size === 0 &&
        backgroundResults.length > 0
      ) {
        break;
      }
      await delay(20);
      backgroundResults =
        daemonContext.backgroundNotifications.consumeThreadBackgroundResults(
          threadId,
        );
    }

    assert.equal(parentState.backgroundChildRunIds.size, 0);
    assert.equal(parentState.childRunIds.size, 0);
    assert.deepEqual(unhandledRejections, []);
    assert.equal(backgroundResults.length, 1);
    assert.equal(backgroundResults[0]?.terminalState, 'failed');
    assert.equal(backgroundResults[0]?.reason, 'child_error');
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
    daemonContext.childRuns.markChildTerminal = originalMarkChildTerminal;
  }
});
