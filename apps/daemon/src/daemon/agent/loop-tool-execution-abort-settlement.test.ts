import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HistoryItem } from '../llm/index.js';
import { processFunctionCalls } from './loop-tool-execution.js';
import { createDaemonContext } from '../context.js';
import { readTranscriptEntries } from '../sessions/transcript-log.js';
import type { ExecuteResult } from '../tools/types.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import { makeRunContext } from '../../test-support/run-context.js';
import { testThreadId } from '../../test-support/thread-id.js';
import { createRunState } from './runtime/run-state.js';
import {
  isInterjectFlushRequested,
  pushPendingInterject,
  requestInterjectFlush,
} from '../sessions/active-run-interject-buffer.js';
import {
  createDeferred,
  makeExecutionRuntime,
  makeTestTool,
  registerOnce,
} from '../../test-support/loop-tool-execution-test-support.js';

void test('processFunctionCalls records skipped results for later tools when the run is aborted mid-batch', async () => {
  const threadId = testThreadId(4);
  const daemonContext = createDaemonContext();
  const abortController = new AbortController();
  let secondToolExecutions = 0;

  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'batch_abort_first_tool',
      description: 'aborts the run after the first tool result',
      sideEffectLevel: 'read',
      requiresApproval: false,
      async executeParsed() {
        abortController.abort();
        return { ok: true, output: 'first tool finished' };
      },
    }),
  );
  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'batch_abort_second_tool',
      description:
        'must never execute after cancellation on the sequential path',
      sideEffectLevel: 'write',
      requiresApproval: false,
      async executeParsed() {
        secondToolExecutions += 1;
        return { ok: true, output: 'should not run' };
      },
    }),
  );

  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-batch-abort-'));
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const history: HistoryItem[] = [];
  const events: string[] = [];

  const result = await processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-batch-abort-1',
        callId: 'call-batch-abort-1',
        name: 'batch_abort_first_tool',
        arguments: '{}',
      },
      {
        id: 'fc-batch-abort-2',
        callId: 'call-batch-abort-2',
        name: 'batch_abort_second_tool',
        arguments: '{}',
      },
    ],
    round: 0,
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId: 'run-batch-abort',
      approvalContext: makeApprovalContext({
        computerSessionId: 'session-batch-abort',
      }),
      emit: (type) => {
        events.push(type);
      },
      signal: abortController.signal,
    }),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(events, [
    'tool_call',
    'tool_result',
    'tool_call',
    'tool_result',
    'error',
  ]);
  assert.equal(secondToolExecutions, 0);
  assert.equal(history.length, 2);
  const skippedOutput = JSON.parse(
    history[1]?.kind === 'function_call_output' ? history[1].output : '{}',
  ) as { ok?: boolean; errorCode?: string };
  assert.equal(skippedOutput.ok, false);
  assert.equal(skippedOutput.errorCode, 'aborted');
  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => entry.role),
    ['tool_call', 'tool_result', 'tool_call', 'tool_result'],
  );
});

void test('processFunctionCalls emits terminal abort only after write cleanup settles', async () => {
  const threadId = testThreadId(43);
  const daemonContext = createDaemonContext();
  const abortController = new AbortController();
  const executionStarted = createDeferred<void>();
  const cleanupStarted = createDeferred<void>();
  const releaseCleanup = createDeferred<void>();
  const timeline: string[] = [];

  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'cleanup_aware_write_tool',
      description: 'waits for owned cleanup after cancellation',
      sideEffectLevel: 'write',
      requiresApproval: false,
      async executeParsed(_args, ctx) {
        executionStarted.resolve();
        await new Promise<void>((resolve) => {
          ctx.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        timeline.push('cleanup_started');
        cleanupStarted.resolve();
        await releaseCleanup.promise;
        timeline.push('cleanup_settled');
        return {
          ok: false,
          output: '',
          errorCode: 'aborted',
          error: 'cleanup settled after cancellation',
        };
      },
    }),
  );

  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-write-cleanup-abort-'),
  );
  const processing = processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-cleanup-aware-write',
        callId: 'call-cleanup-aware-write',
        name: 'cleanup_aware_write_tool',
        arguments: '{}',
      },
    ],
    round: 0,
    history: [],
    runtime: makeExecutionRuntime(daemonContext, {
      runContext: makeRunContext({ threadId, stateRoot: workspaceRoot }),
      runId: 'run-cleanup-aware-write',
      approvalContext: makeApprovalContext({
        computerSessionId: 'session-cleanup-aware-write',
      }),
      emit: (type) => {
        timeline.push(type);
      },
      signal: abortController.signal,
    }),
  });

  await executionStarted.promise;
  abortController.abort();
  await cleanupStarted.promise;
  assert.deepEqual(timeline, ['tool_call', 'cleanup_started']);

  releaseCleanup.resolve();
  const result = await processing;

  assert.equal(result.ok, false);
  assert.deepEqual(timeline, [
    'tool_call',
    'cleanup_started',
    'cleanup_settled',
    'tool_result',
    'error',
  ]);
});

void test('processFunctionCalls skips the remaining batch when an interject flush is requested mid-round', async () => {
  const threadId = testThreadId(42);
  const daemonContext = createDaemonContext();
  let secondToolExecutions = 0;

  const runContextSeed = makeRunContext({
    threadId,
    stateRoot: await mkdtemp(join(tmpdir(), 'geulbat-batch-flush-state-')),
  });
  const runState = createRunState({
    runId: 'run-batch-flush',
    runContext: runContextSeed,
  });
  pushPendingInterject(runState.interject, 'queued steer');

  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'batch_flush_first_tool',
      description: 'requests an interject flush after finishing',
      sideEffectLevel: 'read',
      requiresApproval: false,
      async executeParsed() {
        requestInterjectFlush(runState.interject);
        return { ok: true, output: 'first tool finished' };
      },
    }),
  );
  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'batch_flush_second_tool',
      description: 'must be skipped once the flush is requested',
      sideEffectLevel: 'write',
      requiresApproval: false,
      async executeParsed() {
        secondToolExecutions += 1;
        return { ok: true, output: 'should not run' };
      },
    }),
  );

  const history: HistoryItem[] = [];
  const events: string[] = [];

  const result = await processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-batch-flush-1',
        callId: 'call-batch-flush-1',
        name: 'batch_flush_first_tool',
        arguments: '{}',
      },
      {
        id: 'fc-batch-flush-2',
        callId: 'call-batch-flush-2',
        name: 'batch_flush_second_tool',
        arguments: '{}',
      },
    ],
    round: 0,
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext: runContextSeed,
      runId: 'run-batch-flush',
      approvalContext: makeApprovalContext({
        computerSessionId: 'session-batch-flush',
      }),
      emit: (type) => {
        events.push(type);
      },
      runState,
    }),
  });

  // 라운드는 정상 종료(continue)해야 다음 라운드에서 인터젝트가 소비된다
  assert.equal(result.ok, true);
  assert.equal(secondToolExecutions, 0);
  assert.deepEqual(events, [
    'tool_call',
    'tool_result',
    'tool_call',
    'tool_result',
  ]);
  assert.equal(history.length, 2);
  const skippedRawOutput =
    history[1]?.kind === 'function_call_output' ? history[1].output : '{}';
  const skippedOutput = JSON.parse(skippedRawOutput) as {
    ok?: boolean;
    errorCode?: string;
  };
  assert.equal(skippedOutput.ok, false);
  assert.equal(skippedOutput.errorCode, 'aborted');
  assert.match(skippedRawOutput, /apply a pending message immediately/);
  // 플러시 플래그는 소비 시점(run-agent-loop)에서 지워지므로 여기선 유지
  assert.equal(isInterjectFlushRequested(runState.interject), true);
});

void test('processFunctionCalls settles shared-window tool results before terminal abort', async () => {
  const threadId = testThreadId(41);
  const daemonContext = createDaemonContext();
  const abortController = new AbortController();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-shared-window-abort-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const history: HistoryItem[] = [];
  const events: string[] = [];
  const bothStarted = createDeferred<void>();
  let startedTools = 0;

  const makeAbortableReadTool = (name: string) =>
    makeTestTool({
      name,
      description: 'read-only tool waiting for run cancellation',
      sideEffectLevel: 'read',
      requiresApproval: false,
      async executeParsed() {
        startedTools += 1;
        if (startedTools === 2) {
          bothStarted.resolve();
        }
        return await new Promise<ExecuteResult>(() => {});
      },
    });

  registerOnce(daemonContext, makeAbortableReadTool('abort_read_one'));
  registerOnce(daemonContext, makeAbortableReadTool('abort_read_two'));

  const processing = processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-abort-read-1',
        callId: 'call-abort-read-1',
        name: 'abort_read_one',
        arguments: '{}',
      },
      {
        id: 'fc-abort-read-2',
        callId: 'call-abort-read-2',
        name: 'abort_read_two',
        arguments: '{}',
      },
    ],
    round: 0,
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId: 'run-shared-window-abort',
      approvalContext: makeApprovalContext({
        computerSessionId: 'session-shared-window-abort',
      }),
      emit: (type) => {
        events.push(type);
      },
      signal: abortController.signal,
    }),
  });

  await bothStarted.promise;
  abortController.abort();

  const result = await processing;
  assert.equal(result.ok, false);
  assert.deepEqual(events, [
    'tool_call',
    'tool_call',
    'tool_result',
    'tool_result',
    'error',
  ]);
  assert.equal(history.length, 2);
  for (const item of history) {
    assert.equal(item.kind, 'function_call_output');
    if (item.kind === 'function_call_output') {
      const output = JSON.parse(item.output) as {
        ok?: boolean;
        errorCode?: string;
      };
      assert.equal(output.ok, false);
      assert.equal(output.errorCode, 'aborted');
    }
  }

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => entry.role),
    ['tool_call', 'tool_call', 'tool_result', 'tool_result'],
  );
});
