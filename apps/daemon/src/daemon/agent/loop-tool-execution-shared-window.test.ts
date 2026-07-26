import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HistoryItem } from '../llm/index.js';
import { processFunctionCalls } from './loop-tool-execution.js';
import { createDaemonContext } from '../context.js';
import { readTranscriptEntries } from '../sessions/transcript-log.js';
import type { AnyTool } from '../tools/types.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import { makeRunContext } from '../../test-support/run-context.js';
import { testThreadId } from '../../test-support/thread-id.js';
import { createRunState } from './runtime/run-state.js';
import {
  createDeferred,
  makeExecutionRuntime,
  makeTestTool,
  registerOnce,
} from '../../test-support/loop-tool-execution-test-support.js';

void test('processFunctionCalls executes independent read-only tools in parallel', async () => {
  const threadId = testThreadId(5);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-parallel-'));
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const history: HistoryItem[] = [];
  const events: string[] = [];
  const releaseTools = createDeferred<void>();
  const bothStarted = createDeferred<void>();
  let startedTools = 0;

  const makeBlockingReadTool = (name: string, output: string): AnyTool =>
    makeTestTool({
      name,
      description: 'read-only blocking tool',
      sideEffectLevel: 'read',
      requiresApproval: false,
      async executeParsed() {
        startedTools += 1;
        if (startedTools === 2) {
          bothStarted.resolve();
        }
        await releaseTools.promise;
        return { ok: true, output };
      },
    });

  registerOnce(
    daemonContext,
    makeBlockingReadTool('parallel_read_tool_one', 'first result'),
  );
  registerOnce(
    daemonContext,
    makeBlockingReadTool('parallel_read_tool_two', 'second result'),
  );

  const processing = processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-parallel-read-1',
        callId: 'call-parallel-read-1',
        name: 'parallel_read_tool_one',
        arguments: '{}',
      },
      {
        id: 'fc-parallel-read-2',
        callId: 'call-parallel-read-2',
        name: 'parallel_read_tool_two',
        arguments: '{}',
      },
    ],
    round: 0,
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId: 'run-parallel-read',
      approvalContext: makeApprovalContext({
        computerSessionId: 'session-parallel-read',
      }),
      emit: (type) => {
        events.push(type);
      },
      signal: new AbortController().signal,
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

void test('processFunctionCalls settles sibling results when a shared-window execution rejects unexpectedly', async () => {
  const threadId = testThreadId(5_1);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-shared-reject-settle-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const history: HistoryItem[] = [];
  const events: string[] = [];
  let siblingExecutions = 0;

  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'shared_registry_reject_tool',
      description: 'read-only tool whose registry lookup rejects at execution',
      sideEffectLevel: 'read',
      requiresApproval: false,
      async executeParsed() {
        return { ok: true, output: 'should not execute' };
      },
    }),
  );
  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'shared_registry_reject_sibling_tool',
      description: 'sibling read-only tool that must still settle',
      sideEffectLevel: 'read',
      requiresApproval: false,
      async executeParsed() {
        siblingExecutions += 1;
        return { ok: true, output: 'sibling completed' };
      },
    }),
  );

  const runtime = makeExecutionRuntime(daemonContext, {
    runContext,
    runId: 'run-shared-reject-settle',
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-shared-reject-settle',
    }),
    emit: (type) => {
      events.push(type);
    },
  });
  const originalGetToolExecutionHandle =
    runtime.toolRegistry.getToolExecutionHandle?.bind(runtime.toolRegistry);
  assert.ok(originalGetToolExecutionHandle);
  runtime.toolRegistry.getToolExecutionHandle = (name) => {
    if (name === 'shared_registry_reject_tool') {
      throw new Error('registry exploded with private path /tmp/secret');
    }
    return originalGetToolExecutionHandle(name);
  };

  const result = await processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-shared-reject',
        callId: 'call-shared-reject',
        name: 'shared_registry_reject_tool',
        arguments: '{}',
      },
      {
        id: 'fc-shared-reject-sibling',
        callId: 'call-shared-reject-sibling',
        name: 'shared_registry_reject_sibling_tool',
        arguments: '{}',
      },
    ],
    round: 0,
    history,
    runtime,
  });

  assert.deepEqual(result, { ok: true, value: undefined });
  assert.equal(siblingExecutions, 1);
  assert.deepEqual(events, [
    'tool_call',
    'tool_call',
    'tool_result',
    'tool_result',
  ]);
  assert.equal(history.length, 2);

  const rejectedOutput = JSON.parse(
    history[0]?.kind === 'function_call_output' ? history[0].output : '{}',
  ) as { ok?: boolean; errorCode?: string; error?: string };
  assert.equal(rejectedOutput.ok, false);
  assert.equal(rejectedOutput.errorCode, 'execution_failed');
  assert.equal(rejectedOutput.error, 'tool execution failed unexpectedly');

  assert.equal(
    history[1]?.kind === 'function_call_output' ? history[1].output : '',
    'sibling completed',
  );

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => entry.role),
    ['tool_call', 'tool_call', 'tool_result', 'tool_result'],
  );
});

void test('processFunctionCalls executes read-only tools and subagent launches in the same shared window', async () => {
  const threadId = testThreadId(153);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-mixed-shared-window-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const history: HistoryItem[] = [];
  const events: string[] = [];
  const releaseTools = createDeferred<void>();
  const allStarted = createDeferred<void>();
  const startedTools: string[] = [];

  const markStarted = (name: string) => {
    startedTools.push(name);
    if (startedTools.length === 3) {
      allStarted.resolve();
    }
  };

  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'mixed_read_before_subagent_tool',
      description: 'read-only tool before subagent launch',
      sideEffectLevel: 'read',
      requiresApproval: false,
      async executeParsed() {
        markStarted('read-before');
        await releaseTools.promise;
        return { ok: true, output: 'read before complete' };
      },
    }),
  );
  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'mixed_subagent_launch_tool',
      description: 'subagent launch inside a mixed shared window',
      sideEffectLevel: 'none',
      parallelBatchKind: 'subagent_launch',
      requiresApproval: false,
      async executeParsed() {
        markStarted('subagent');
        await releaseTools.promise;
        return {
          ok: true,
          output: JSON.stringify({ ok: true, childRunId: 'child-started' }),
        };
      },
    }),
  );
  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'mixed_read_after_subagent_tool',
      description: 'read-only tool after subagent launch',
      sideEffectLevel: 'read',
      requiresApproval: false,
      async executeParsed() {
        markStarted('read-after');
        await releaseTools.promise;
        return { ok: true, output: 'read after complete' };
      },
    }),
  );

  const processing = processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-mixed-read-before',
        callId: 'call-mixed-read-before',
        name: 'mixed_read_before_subagent_tool',
        arguments: '{}',
      },
      {
        id: 'fc-mixed-subagent',
        callId: 'call-mixed-subagent',
        name: 'mixed_subagent_launch_tool',
        arguments: '{"task":"inspect mixed window","subagent_type":"explorer"}',
      },
      {
        id: 'fc-mixed-read-after',
        callId: 'call-mixed-read-after',
        name: 'mixed_read_after_subagent_tool',
        arguments: '{}',
      },
    ],
    round: 0,
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId: 'run-mixed-shared-window',
      approvalContext: makeApprovalContext({
        computerSessionId: 'session-mixed-shared-window',
      }),
      emit: (type) => {
        events.push(type);
      },
      signal: new AbortController().signal,
    }),
  });

  await allStarted.promise;
  assert.deepEqual([...startedTools].sort(), [
    'read-after',
    'read-before',
    'subagent',
  ]);
  releaseTools.resolve();

  const result = await processing;
  assert.deepEqual(result, { ok: true, value: undefined });
  assert.deepEqual(events, [
    'tool_call',
    'tool_call',
    'tool_call',
    'tool_result',
    'tool_result',
    'tool_result',
  ]);
  assert.equal(history.length, 3);

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
});

void test('processFunctionCalls rejects only subagent launches when a mixed shared window exceeds child capacity', async () => {
  const threadId = testThreadId(154);
  const daemonContext = createDaemonContext({
    subagentConcurrencyPolicy: { maxConcurrentChildren: 1 },
  });
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-mixed-subagent-cap-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-mixed-subagent-cap',
    runContext,
  });
  const history: HistoryItem[] = [];
  let readExecutions = 0;
  let subagentExecutions = 0;

  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'mixed_cap_read_tool',
      description: 'read-only tool should not be rejected by child capacity',
      sideEffectLevel: 'read',
      requiresApproval: false,
      async executeParsed() {
        readExecutions += 1;
        return { ok: true, output: `read ${readExecutions}` };
      },
    }),
  );
  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'mixed_cap_subagent_tool',
      description: 'subagent launch that can be capacity rejected',
      sideEffectLevel: 'none',
      parallelBatchKind: 'subagent_launch',
      requiresApproval: false,
      async executeParsed() {
        subagentExecutions += 1;
        return {
          ok: true,
          output: JSON.stringify({ ok: true, childRunId: 'should-not-start' }),
        };
      },
    }),
  );

  const result = await processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-mixed-cap-read-1',
        callId: 'call-mixed-cap-read-1',
        name: 'mixed_cap_read_tool',
        arguments: '{}',
      },
      {
        id: 'fc-mixed-cap-subagent-1',
        callId: 'call-mixed-cap-subagent-1',
        name: 'mixed_cap_subagent_tool',
        arguments: '{"task":"inspect A","subagent_type":"explorer"}',
      },
      {
        id: 'fc-mixed-cap-subagent-2',
        callId: 'call-mixed-cap-subagent-2',
        name: 'mixed_cap_subagent_tool',
        arguments: '{"task":"inspect B","subagent_type":"worker"}',
      },
      {
        id: 'fc-mixed-cap-read-2',
        callId: 'call-mixed-cap-read-2',
        name: 'mixed_cap_read_tool',
        arguments: '{}',
      },
    ],
    round: 0,
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId: 'run-mixed-subagent-cap',
      approvalContext: makeApprovalContext({
        computerSessionId: 'session-mixed-subagent-cap',
      }),
      emit: () => {},
      runState,
    }),
  });

  assert.deepEqual(result, { ok: true, value: undefined });
  assert.equal(readExecutions, 2);
  assert.equal(subagentExecutions, 0);

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  const toolResults = transcript.filter(
    (entry) => entry.role === 'tool_result',
  );
  assert.equal(toolResults.length, 4);

  const firstRead = JSON.parse(toolResults[0]?.content ?? '{}') as {
    output: string;
  };
  assert.equal(firstRead.output, 'read 1');

  const firstRejection = JSON.parse(toolResults[1]?.content ?? '{}') as {
    output: string;
  };
  const firstRejectedPayload = JSON.parse(firstRejection.output) as {
    ok: boolean;
    errorCode: string;
    effectiveMax: number;
  };
  assert.equal(firstRejectedPayload.ok, false);
  assert.equal(firstRejectedPayload.errorCode, 'too_many_child_runs');
  assert.equal(firstRejectedPayload.effectiveMax, 1);

  const secondRejection = JSON.parse(toolResults[2]?.content ?? '{}') as {
    output: string;
  };
  const secondRejectedPayload = JSON.parse(secondRejection.output) as {
    ok: boolean;
    errorCode: string;
    effectiveMax: number;
  };
  assert.equal(secondRejectedPayload.ok, false);
  assert.equal(secondRejectedPayload.errorCode, 'too_many_child_runs');
  assert.equal(secondRejectedPayload.effectiveMax, 1);

  const secondRead = JSON.parse(toolResults[3]?.content ?? '{}') as {
    output: string;
  };
  assert.equal(secondRead.output, 'read 2');
});

void test('processFunctionCalls treats write tools as barriers without collapsing later read windows', async () => {
  const threadId = testThreadId(155);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-write-barrier-window-'),
  );
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-write-barrier-window-files-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
    workingDirectory: computerFileRoot,
  });
  const history: HistoryItem[] = [];
  const releaseFirstReads = createDeferred<void>();
  const releaseWrite = createDeferred<void>();
  const releaseSecondReads = createDeferred<void>();
  const firstReadsStarted = createDeferred<void>();
  const writeStarted = createDeferred<void>();
  const secondReadsStarted = createDeferred<void>();
  let firstReadStarts = 0;
  let secondReadStarts = 0;
  let writeHasStarted = false;

  const makeWindowReadTool = (name: string, windowName: 'first' | 'second') =>
    makeTestTool({
      name,
      description: `${windowName} read window tool`,
      sideEffectLevel: 'read',
      requiresApproval: false,
      async executeParsed() {
        if (windowName === 'first') {
          firstReadStarts += 1;
          if (firstReadStarts === 2) {
            firstReadsStarted.resolve();
          }
          await releaseFirstReads.promise;
          return { ok: true, output: `${name} complete` };
        }

        secondReadStarts += 1;
        if (secondReadStarts === 2) {
          secondReadsStarted.resolve();
        }
        await releaseSecondReads.promise;
        return { ok: true, output: `${name} complete` };
      },
    });

  registerOnce(
    daemonContext,
    makeWindowReadTool('barrier_first_read_one', 'first'),
  );
  registerOnce(
    daemonContext,
    makeWindowReadTool('barrier_first_read_two', 'first'),
  );
  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'barrier_write_tool',
      description: 'write tool barrier',
      sideEffectLevel: 'write',
      requiresApproval: false,
      async executeParsed() {
        writeHasStarted = true;
        writeStarted.resolve();
        await releaseWrite.promise;
        return { ok: true, output: 'write complete' };
      },
    }),
  );
  registerOnce(
    daemonContext,
    makeWindowReadTool('barrier_second_read_one', 'second'),
  );
  registerOnce(
    daemonContext,
    makeWindowReadTool('barrier_second_read_two', 'second'),
  );

  const processing = processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-barrier-read-1',
        callId: 'call-barrier-read-1',
        name: 'barrier_first_read_one',
        arguments: '{}',
      },
      {
        id: 'fc-barrier-read-2',
        callId: 'call-barrier-read-2',
        name: 'barrier_first_read_two',
        arguments: '{}',
      },
      {
        id: 'fc-barrier-write',
        callId: 'call-barrier-write',
        name: 'barrier_write_tool',
        arguments: '{}',
      },
      {
        id: 'fc-barrier-read-3',
        callId: 'call-barrier-read-3',
        name: 'barrier_second_read_one',
        arguments: '{}',
      },
      {
        id: 'fc-barrier-read-4',
        callId: 'call-barrier-read-4',
        name: 'barrier_second_read_two',
        arguments: '{}',
      },
    ],
    round: 0,
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId: 'run-write-barrier-window',
      computerFileRoot,
      approvalContext: makeApprovalContext({
        computerSessionId: 'session-write-barrier-window',
      }),
      emit: () => {},
    }),
  });

  await firstReadsStarted.promise;
  assert.equal(writeHasStarted, false);
  assert.equal(secondReadStarts, 0);

  releaseFirstReads.resolve();
  await writeStarted.promise;
  assert.equal(secondReadStarts, 0);

  releaseWrite.resolve();
  await secondReadsStarted.promise;
  assert.equal(secondReadStarts, 2);

  releaseSecondReads.resolve();
  const result = await processing;
  assert.deepEqual(result, { ok: true, value: undefined });
  assert.equal(history.length, 5);
});

void test('processFunctionCalls requires explicit shared-safe metadata before a call enters a shared window', async () => {
  const scenarios = [
    {
      id: 'conflicting_subagent_write',
      description: 'subagent batch marker with write side effects',
      sideEffectLevel: 'write' as const,
      requiresApproval: false,
      parallelBatchKind: 'subagent_launch' as const,
    },
    {
      id: 'conflicting_subagent_read',
      description: 'subagent batch marker with read side effects',
      sideEffectLevel: 'read' as const,
      requiresApproval: false,
      parallelBatchKind: 'subagent_launch' as const,
    },
    {
      id: 'conflicting_ptc_cell_read',
      description: 'PTC cell batch marker with read side effects',
      sideEffectLevel: 'read' as const,
      requiresApproval: false,
      parallelBatchKind: 'ptc_cell' as const,
    },
    {
      id: 'approval_flagged_read',
      description: 'read tool with approval metadata',
      sideEffectLevel: 'read' as const,
      requiresApproval: true,
    },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    const threadId = testThreadId(156 + index);
    const daemonContext = createDaemonContext();
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), `geulbat-metadata-gate-${scenario.id}-`),
    );
    const runContext = makeRunContext({
      threadId,
      stateRoot: workspaceRoot,
    });
    const history: HistoryItem[] = [];

    registerOnce(
      daemonContext,
      makeTestTool({
        name: `${scenario.id}_first_tool`,
        description: scenario.description,
        sideEffectLevel: scenario.sideEffectLevel,
        requiresApproval: scenario.requiresApproval,
        ...(scenario.parallelBatchKind
          ? { parallelBatchKind: scenario.parallelBatchKind }
          : {}),
        async executeParsed() {
          return { ok: true, output: 'first complete' };
        },
      }),
    );
    registerOnce(
      daemonContext,
      makeTestTool({
        name: `${scenario.id}_second_read_tool`,
        description: 'explicitly shared-safe follow-up read',
        sideEffectLevel: 'read',
        requiresApproval: false,
        async executeParsed() {
          return { ok: true, output: 'second complete' };
        },
      }),
    );

    const result = await processFunctionCalls({
      functionCalls: [
        {
          id: `fc-${scenario.id}-first`,
          callId: `call-${scenario.id}-first`,
          name: `${scenario.id}_first_tool`,
          arguments: '{}',
        },
        {
          id: `fc-${scenario.id}-second`,
          callId: `call-${scenario.id}-second`,
          name: `${scenario.id}_second_read_tool`,
          arguments: '{}',
        },
      ],
      round: 0,
      history,
      runtime: makeExecutionRuntime(daemonContext, {
        runContext,
        runId: `run-${scenario.id}`,
        approvalContext: makeApprovalContext({
          computerSessionId: `session-${scenario.id}`,
          permissionMode: 'full_access',
        }),
        emit: () => {},
      }),
    });

    assert.deepEqual(result, { ok: true, value: undefined });
    assert.equal(history.length, 2);

    const transcript = await readTranscriptEntries(workspaceRoot, threadId);
    assert.deepEqual(
      transcript.map((entry) => entry.role),
      ['tool_call', 'tool_result', 'tool_call', 'tool_result'],
    );
  }
});

void test('processFunctionCalls keeps write tools on the sequential path', async () => {
  const threadId = testThreadId(6);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-write-sequential-'),
  );
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-write-sequential-files-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
    workingDirectory: computerFileRoot,
  });
  const history: HistoryItem[] = [];
  const releaseFirstTool = createDeferred<void>();
  const firstToolStarted = createDeferred<void>();
  let firstStarted = false;
  let secondStarted = false;

  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'sequential_write_gate_tool',
      description: 'write tool should keep sequential order',
      sideEffectLevel: 'write',
      requiresApproval: false,
      async executeParsed() {
        firstStarted = true;
        firstToolStarted.resolve();
        await releaseFirstTool.promise;
        return { ok: true, output: 'write finished' };
      },
    }),
  );
  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'sequential_followup_read_tool',
      description: 'should not start until write completes',
      sideEffectLevel: 'read',
      requiresApproval: false,
      async executeParsed() {
        secondStarted = true;
        return { ok: true, output: 'read finished' };
      },
    }),
  );

  const processing = processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-sequential-write-1',
        callId: 'call-sequential-write-1',
        name: 'sequential_write_gate_tool',
        arguments: '{}',
      },
      {
        id: 'fc-sequential-write-2',
        callId: 'call-sequential-write-2',
        name: 'sequential_followup_read_tool',
        arguments: '{}',
      },
    ],
    round: 0,
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId: 'run-sequential-write',
      computerFileRoot,
      approvalContext: makeApprovalContext({
        computerSessionId: 'session-sequential-write',
      }),
      emit: () => {},
    }),
  });

  await firstToolStarted.promise;
  assert.equal(firstStarted, true);
  assert.equal(secondStarted, false);

  releaseFirstTool.resolve();
  const result = await processing;
  assert.deepEqual(result, { ok: true, value: undefined });
  assert.equal(secondStarted, true);
  assert.equal(history.length, 2);
});
