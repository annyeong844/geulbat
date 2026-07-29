import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HistoryItem } from '../llm/index.js';
import { processFunctionCalls } from './loop-tool-execution.js';
import { createDaemonContext } from '../context.js';
import { readTranscriptEntries } from '../sessions/transcript-log.js';
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
