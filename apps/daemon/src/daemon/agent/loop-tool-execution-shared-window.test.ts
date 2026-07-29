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
