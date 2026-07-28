import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HistoryItem } from '../llm/index.js';
import { processFunctionCalls } from './loop-tool-execution.js';
import { createDaemonContext, type DaemonContext } from '../context.js';
import { createDaemonRuntimeStateStore } from '../runtime-state-store.js';
import { readTranscriptEntries } from '../sessions/transcript-log.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import { testRunId } from '../../test-support/run-id.js';
import { makeRunContext } from '../../test-support/run-context.js';
import { testThreadId } from '../../test-support/thread-id.js';
import { createRunState } from './runtime/run-state.js';
import {
  createDeferred,
  makeExecutionRuntime,
  makeTestTool,
  registerOnce,
} from '../../test-support/loop-tool-execution-test-support.js';

function captureConsoleErrors(t: {
  after(fn: () => Promise<void> | void): void;
}): unknown[][] {
  const calls: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };
  t.after(() => {
    console.error = originalError;
  });
  return calls;
}

void test('processFunctionCalls executes same-round subagent launch batches in parallel when the tool metadata allows it', async () => {
  const threadId = testThreadId(51);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-spawn-parallel-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const history: HistoryItem[] = [];
  const events: string[] = [];
  const releaseTools = createDeferred<void>();
  const bothStarted = createDeferred<void>();
  let startedTools = 0;

  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'parallel_subagent_launch_tool',
      description: 'parallel subagent launch tool',
      sideEffectLevel: 'none',
      parallelBatchKind: 'subagent_launch',
      requiresApproval: false,
      async executeParsed() {
        startedTools += 1;
        if (startedTools === 2) {
          bothStarted.resolve();
        }
        await releaseTools.promise;
        return {
          ok: true,
          output: JSON.stringify({ ok: true, result: 'child complete' }),
        };
      },
    }),
  );

  const abortController = new AbortController();
  const processing = processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-agent-spawn-1',
        callId: 'call-agent-spawn-1',
        name: 'parallel_subagent_launch_tool',
        arguments:
          '{"task":"inspect arc A","subagent_type":"explorer","mode":"blocking"}',
      },
      {
        id: 'fc-agent-spawn-2',
        callId: 'call-agent-spawn-2',
        name: 'parallel_subagent_launch_tool',
        arguments:
          '{"task":"rewrite arc B","subagent_type":"worker","mode":"background"}',
      },
    ],
    round: 0,
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId: 'run-agent-spawn-parallel',
      approvalContext: makeApprovalContext({
        computerSessionId: 'session-agent-spawn-parallel',
      }),
      emit: (type) => {
        events.push(type);
      },
      signal: abortController.signal,
    }),
  });

  await bothStarted.promise;
  assert.equal(startedTools, 2);
  releaseTools.resolve();

  const result = await processing;
  assert.deepEqual(result, { ok: true, value: undefined });
  assert.deepEqual(events, [
    'tool_call',
    'tool_call',
    'tool_result',
    'tool_result',
  ]);
  assert.equal(history.length, 2);

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => entry.role),
    ['tool_call', 'tool_call', 'tool_result', 'tool_result'],
  );
});

void test('processFunctionCalls runs builtin agent_spawn calls as a same-round launch wave', async () => {
  const threadId = testThreadId(155);
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-builtin-agent-spawn-wave-'),
  );
  const runtimeStateStore = await createDaemonRuntimeStateStore({
    homeStateRoot: workspaceRoot,
  });
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-builtin-agent-spawn-wave',
    runContext,
  });
  const history: HistoryItem[] = [];
  const events: string[] = [];
  const releaseLaunches = createDeferred<void>();
  const bothLaunchesStarted = createDeferred<void>();
  const startedTasks: string[] = [];
  const childRunIds: string[] = [];
  const childThreadIds: string[] = [];

  const daemonContext = createDaemonContext({
    subagentLaunchRequests: runtimeStateStore,
  });
  const runtimeServices: DaemonContext = {
    ...daemonContext,
    subagent: {
      ...daemonContext.subagent,
      runs: {
        async startBackgroundRun(args) {
          const childRunId = args.childRunId;
          const childThreadId = args.childThreadId;
          assert.ok(childRunId);
          assert.ok(childThreadId);
          assert.ok(
            runtimeStateStore.readSubagentLaunchRequest({
              parentRunId: testRunId('builtin-agent-spawn-wave'),
              toolCallId: 'call-builtin-agent-spawn-1',
            }),
          );
          assert.ok(
            runtimeStateStore.readSubagentLaunchRequest({
              parentRunId: testRunId('builtin-agent-spawn-wave'),
              toolCallId: 'call-builtin-agent-spawn-2',
            }),
          );

          childRunIds.push(childRunId);
          childThreadIds.push(childThreadId);
          startedTasks.push(args.task);
          if (startedTasks.length === 2) {
            bothLaunchesStarted.resolve();
          }
          await releaseLaunches.promise;
          args.launchReservation?.release();
          args.runtimeServices.subagent.launchRequests?.markSubagentLaunchStarted(
            childRunId,
          );

          return {
            ok: true,
            output: JSON.stringify({
              ok: true,
              childRunId,
              childThreadId,
              subagentType: args.subagentType,
              launchState: 'started',
            }),
          };
        },
      },
    },
  };

  const processing = processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-builtin-agent-spawn-1',
        callId: 'call-builtin-agent-spawn-1',
        name: 'agent_spawn',
        arguments: JSON.stringify({
          task: 'Inspect builtin spawn wave A',
          subagent_type: 'explorer',
        }),
      },
      {
        id: 'fc-builtin-agent-spawn-2',
        callId: 'call-builtin-agent-spawn-2',
        name: 'agent_spawn',
        arguments: JSON.stringify({
          task: 'Inspect builtin spawn wave B',
          subagent_type: 'explorer',
        }),
      },
    ],
    round: 0,
    history,
    runtime: makeExecutionRuntime(runtimeServices, {
      runContext,
      runId: 'run-builtin-agent-spawn-wave',
      approvalContext: makeApprovalContext({
        computerSessionId: 'session-builtin-agent-spawn-wave',
      }),
      emit: (type) => {
        events.push(type);
      },
      runState,
    }),
  });

  await bothLaunchesStarted.promise;
  assert.deepEqual(startedTasks, [
    'Inspect builtin spawn wave A',
    'Inspect builtin spawn wave B',
  ]);
  assert.equal(runState.backgroundChildLaunchReservationIds.size, 2);
  releaseLaunches.resolve();

  const result = await processing;
  assert.deepEqual(result, { ok: true, value: undefined });
  assert.equal(runState.backgroundChildLaunchReservationIds.size, 0);
  assert.deepEqual(events, [
    'tool_call',
    'tool_call',
    'tool_result',
    'tool_result',
  ]);

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => entry.role),
    ['tool_call', 'tool_call', 'tool_result', 'tool_result'],
  );
  const toolResults = transcript.filter(
    (entry) => entry.role === 'tool_result',
  );
  assert.equal(toolResults.length, 2);
  for (const [index, entry] of toolResults.entries()) {
    const parsed = JSON.parse(entry.content) as { output: string };
    const raw = JSON.parse(parsed.output) as {
      ok?: unknown;
      childRunId?: unknown;
    };
    assert.equal(raw.ok, true);
    assert.equal(raw.childRunId, childRunIds[index]);
  }
  assert.equal(
    runtimeStateStore.readSubagentLaunchRequest({
      parentRunId: testRunId('builtin-agent-spawn-wave'),
      toolCallId: 'call-builtin-agent-spawn-1',
    })?.launchState,
    'started',
  );
  assert.equal(
    runtimeStateStore.readSubagentLaunchRequest({
      parentRunId: testRunId('builtin-agent-spawn-wave'),
      toolCallId: 'call-builtin-agent-spawn-2',
    })?.launchState,
    'started',
  );
  runtimeStateStore.close();
});

void test('processFunctionCalls leaves zero durable rows when one same-round agent_spawn request is invalid', async () => {
  const threadId = testThreadId(158);
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-invalid-agent-spawn-wave-'),
  );
  const runtimeStateStore = await createDaemonRuntimeStateStore({
    homeStateRoot: workspaceRoot,
  });
  const runId = testRunId('invalid-agent-spawn-wave');
  const runContext = makeRunContext({ threadId, stateRoot: workspaceRoot });
  const runState = createRunState({ runId, runContext });
  let startCount = 0;
  const daemonContext = createDaemonContext({
    subagentLaunchRequests: runtimeStateStore,
  });
  const runtimeServices: DaemonContext = {
    ...daemonContext,
    subagent: {
      ...daemonContext.subagent,
      runs: {
        async startBackgroundRun() {
          startCount += 1;
          throw new Error('invalid batch must not start any child');
        },
      },
    },
  };

  try {
    const result = await processFunctionCalls({
      functionCalls: [
        {
          id: 'fc-valid-agent-spawn',
          callId: 'call-valid-agent-spawn',
          name: 'agent_spawn',
          arguments: JSON.stringify({
            task: 'valid sibling',
            subagent_type: 'explorer',
          }),
        },
        {
          id: 'fc-invalid-agent-spawn',
          callId: 'call-invalid-agent-spawn',
          name: 'agent_spawn',
          arguments: JSON.stringify({
            task: 'invalid sibling',
            subagent_type: 'worker',
            capabilities: ['ptc'],
          }),
        },
      ],
      round: 0,
      history: [],
      runtime: makeExecutionRuntime(runtimeServices, {
        runContext,
        runId,
        approvalContext: makeApprovalContext({
          computerSessionId: 'session-invalid-agent-spawn-wave',
        }),
        emit: () => {},
        runState,
      }),
    });

    assert.deepEqual(result, { ok: true, value: undefined });
    assert.equal(startCount, 0);
    assert.equal(
      runtimeStateStore.readSubagentLaunchRequest({
        parentRunId: runId,
        toolCallId: 'call-valid-agent-spawn',
      }),
      undefined,
    );
    assert.equal(
      runtimeStateStore.readSubagentLaunchRequest({
        parentRunId: runId,
        toolCallId: 'call-invalid-agent-spawn',
      }),
      undefined,
    );
  } finally {
    runtimeStateStore.close();
  }
});

void test('processFunctionCalls starts no child when same-round agent_spawn persistence fails', async (t) => {
  const threadId = testThreadId(159);
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-spawn-persistence-failure-'),
  );
  const persistenceFailure = new Error('simulated durable store failure');
  const loggedErrors = captureConsoleErrors(t);
  let startCount = 0;
  const daemonContext = createDaemonContext({
    subagentLaunchRequests: {
      enqueueSubagentLaunchBatch() {
        throw persistenceFailure;
      },
      readSubagentLaunchRequest() {
        return undefined;
      },
      readSubagentLaunchRequestByChildRunId() {
        return undefined;
      },
      readSubagentLaunchInput() {
        throw new Error('not used by persistence failure test');
      },
      readQueuedSubagentLaunchRequests() {
        return [];
      },
      markSubagentLaunchDeferredBatch() {
        throw new Error('not used by persistence failure test');
      },
      cancelQueuedSubagentLaunchRequest() {
        throw new Error('not used by persistence failure test');
      },
      updateQueuedSubagentLaunchPriority() {
        throw new Error('not used by persistence failure test');
      },
      retryInterruptedSubagentLaunch() {
        throw new Error('not used by persistence failure test');
      },
      markSubagentLaunchStarting() {},
      markSubagentLaunchStarted() {},
      markSubagentLaunchFailedToStart() {},
      recordSubagentRuntimeObservation() {},
    },
  });
  const runtimeServices: DaemonContext = {
    ...daemonContext,
    subagent: {
      ...daemonContext.subagent,
      runs: {
        async startBackgroundRun() {
          startCount += 1;
          throw new Error('persistence failure must prevent child launch');
        },
      },
    },
  };
  const runId = testRunId('agent-spawn-persistence-failure');
  const runContext = makeRunContext({ threadId, stateRoot: workspaceRoot });
  const runState = createRunState({ runId, runContext });
  const history: HistoryItem[] = [];

  const result = await processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-agent-spawn-persistence-failure-1',
        callId: 'call-agent-spawn-persistence-failure-1',
        name: 'agent_spawn',
        arguments: JSON.stringify({
          task: 'first durable launch',
          subagent_type: 'explorer',
        }),
      },
      {
        id: 'fc-agent-spawn-persistence-failure-2',
        callId: 'call-agent-spawn-persistence-failure-2',
        name: 'agent_spawn',
        arguments: JSON.stringify({
          task: 'second durable launch',
          subagent_type: 'explorer',
        }),
      },
    ],
    round: 0,
    history,
    runtime: makeExecutionRuntime(runtimeServices, {
      runContext,
      runId,
      approvalContext: makeApprovalContext({
        computerSessionId: 'session-agent-spawn-persistence-failure',
      }),
      emit: () => {},
      runState,
    }),
  });

  assert.deepEqual(result, { ok: true, value: undefined });
  assert.equal(startCount, 0);
  assert.equal(runState.backgroundChildLaunchReservationIds.size, 0);
  assert.equal(history.length, 2);
  for (const item of history) {
    const output = JSON.parse(
      item.kind === 'function_call_output' ? item.output : '{}',
    ) as { ok?: boolean; errorCode?: string; error?: string };
    assert.equal(output.ok, false);
    assert.equal(output.errorCode, 'persistence_unavailable');
    assert.match(output.error ?? '', /durably accepted/u);
    assert.doesNotMatch(output.error ?? '', /simulated durable store failure/u);
  }
  assert.equal(
    loggedErrors.some((args) => args.includes(persistenceFailure)),
    true,
    'launch persistence failure must retain the original operator cause',
  );
});

void test('processFunctionCalls preserves failed deferral and rejection-settlement causes', async (t) => {
  const threadId = testThreadId(160);
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-spawn-deferral-failure-'),
  );
  const runtimeStateStore = await createDaemonRuntimeStateStore({
    homeStateRoot: workspaceRoot,
  });
  t.after(() => {
    runtimeStateStore.close();
  });
  const deferralFailure = new Error('simulated deferral persistence failure');
  const settlementFailure = new Error(
    'simulated rejection settlement persistence failure',
  );
  const loggedErrors = captureConsoleErrors(t);
  const daemonContext = createDaemonContext({
    subagentConcurrencyPolicy: { maxConcurrentChildren: 1 },
    subagentLaunchRequests: {
      ...runtimeStateStore,
      markSubagentLaunchDeferredBatch() {
        throw deferralFailure;
      },
      markSubagentLaunchFailedToStart() {
        throw settlementFailure;
      },
    },
  });
  let startCount = 0;
  const runtimeServices: DaemonContext = {
    ...daemonContext,
    subagent: {
      ...daemonContext.subagent,
      runs: {
        async startBackgroundRun() {
          startCount += 1;
          throw new Error('admission failure must prevent child launch');
        },
      },
    },
  };
  const runId = testRunId('agent-spawn-deferral-failure');
  const runContext = makeRunContext({ threadId, stateRoot: workspaceRoot });
  const runState = createRunState({ runId, runContext });
  const history: HistoryItem[] = [];

  const result = await processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-agent-spawn-deferral-failure-1',
        callId: 'call-agent-spawn-deferral-failure-1',
        name: 'agent_spawn',
        arguments: JSON.stringify({
          task: 'first over-capacity launch',
          subagent_type: 'explorer',
        }),
      },
      {
        id: 'fc-agent-spawn-deferral-failure-2',
        callId: 'call-agent-spawn-deferral-failure-2',
        name: 'agent_spawn',
        arguments: JSON.stringify({
          task: 'second over-capacity launch',
          subagent_type: 'explorer',
        }),
      },
    ],
    round: 0,
    history,
    runtime: makeExecutionRuntime(runtimeServices, {
      runContext,
      runId,
      approvalContext: makeApprovalContext({
        computerSessionId: 'session-agent-spawn-deferral-failure',
      }),
      emit: () => {},
      runState,
    }),
  });

  assert.deepEqual(result, { ok: true, value: undefined });
  assert.equal(startCount, 0);
  assert.equal(history.length, 2);
  assert.equal(
    loggedErrors.some((args) => args.includes(deferralFailure)),
    true,
    'deferral persistence failure must retain the original operator cause',
  );
  assert.equal(
    loggedErrors.filter((args) => args.includes(settlementFailure)).length,
    2,
    'each failed durable rejection settlement must retain its operator cause',
  );
});

void test('processFunctionCalls allows three same-round subagent launches under the default policy', async () => {
  const threadId = testThreadId(152);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-spawn-three-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const history: HistoryItem[] = [];
  let executeCount = 0;
  const runState = createRunState({
    runId: 'run-agent-spawn-three',
    runContext,
  });

  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'parallel_three_subagent_launch_tool',
      description: 'parallel three subagent launch tool',
      sideEffectLevel: 'none',
      parallelBatchKind: 'subagent_launch',
      requiresApproval: false,
      async executeParsed() {
        executeCount += 1;
        return {
          ok: true,
          output: JSON.stringify({ ok: true, childRunId: 'started-child' }),
        };
      },
    }),
  );

  const result = await processFunctionCalls({
    functionCalls: Array.from({ length: 3 }, (_, index) => ({
      id: `fc-agent-three-${index + 1}`,
      callId: `call-agent-three-${index + 1}`,
      name: 'parallel_three_subagent_launch_tool',
      arguments: JSON.stringify({
        task: `inspect ${index + 1}`,
        subagent_type: index % 2 === 0 ? 'explorer' : 'worker',
      }),
    })),
    round: 0,
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId: 'run-agent-spawn-three',
      approvalContext: makeApprovalContext({
        computerSessionId: 'session-agent-spawn-three',
      }),
      emit: () => {},
      runState,
    }),
  });

  assert.deepEqual(result, { ok: true, value: undefined });
  assert.equal(executeCount, 3);
  assert.equal(runState.backgroundChildLaunchReservationIds.size, 0);

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => entry.role),
    [
      'tool_call',
      'tool_call',
      'tool_call',
      'tool_result',
      'tool_result',
      'tool_result',
    ],
  );
  const toolResults = transcript.filter(
    (entry) => entry.role === 'tool_result',
  );
  for (const entry of toolResults) {
    const parsed = JSON.parse(entry.content) as { output: string };
    const raw = JSON.parse(parsed.output) as { ok: boolean };
    assert.equal(raw.ok, true);
  }
});

void test('processFunctionCalls atomically rejects same-round subagent launch batches over the child cap', async () => {
  const threadId = testThreadId(52);
  const daemonContext = createDaemonContext({
    subagentConcurrencyPolicy: { maxConcurrentChildren: 1 },
  });
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-spawn-cap-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-agent-spawn-cap',
    runContext,
  });
  const history: HistoryItem[] = [];
  const events: string[] = [];
  let executeCount = 0;

  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'parallel_subagent_launch_tool',
      description: 'parallel subagent launch tool',
      sideEffectLevel: 'none',
      parallelBatchKind: 'subagent_launch',
      requiresApproval: false,
      async executeParsed() {
        executeCount += 1;
        return {
          ok: true,
          output: JSON.stringify({ ok: true, childRunId: 'never-called' }),
        };
      },
    }),
  );

  const result = await processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-agent-cap-1',
        callId: 'call-agent-cap-1',
        name: 'parallel_subagent_launch_tool',
        arguments: '{"task":"inspect A","subagent_type":"explorer"}',
      },
      {
        id: 'fc-agent-cap-2',
        callId: 'call-agent-cap-2',
        name: 'parallel_subagent_launch_tool',
        arguments: '{"task":"inspect B","subagent_type":"worker"}',
      },
    ],
    round: 0,
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId: 'run-agent-spawn-cap',
      approvalContext: makeApprovalContext({
        computerSessionId: 'session-agent-spawn-cap',
      }),
      emit: (type) => {
        events.push(type);
      },
      runState,
    }),
  });

  assert.deepEqual(result, { ok: true, value: undefined });
  assert.equal(executeCount, 0);
  assert.deepEqual(events, [
    'tool_call',
    'tool_call',
    'tool_result',
    'tool_result',
  ]);

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => entry.role),
    ['tool_call', 'tool_call', 'tool_result', 'tool_result'],
  );
  const toolResults = transcript.filter(
    (entry) => entry.role === 'tool_result',
  );
  assert.equal(toolResults.length, 2);
  for (const entry of toolResults) {
    const parsed = JSON.parse(entry.content) as { output: string };
    const raw = JSON.parse(parsed.output) as {
      ok: boolean;
      errorCode: string;
      effectiveMax: number;
    };
    assert.equal(raw.ok, false);
    assert.equal(raw.errorCode, 'too_many_child_runs');
    assert.equal(raw.effectiveMax, 1);
  }
});
