import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile as readFsFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { HistoryItem } from '../llm/index.js';
import { processFunctionCalls } from './loop-tool-execution.js';
import {
  buildAgentToolExecutionContextBase,
  buildToolCallExecutionRuntime,
} from './loop-tool-runtime.js';
import { createDaemonContext } from '../context.js';
import { DEFAULT_MAX_CONCURRENT_BACKGROUND_CHILDREN } from './subagent-concurrency.js';
import { readFile } from '../files/read-file.js';
import { readTranscriptEntries } from '../sessions/transcript-log.js';
import type {
  AnyTool,
  ExecuteResult,
  ToolExecutionContext,
  ToolParseResult,
} from '../tools/types.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import { testProjectId } from '../../test-support/project-id.js';
import { testRunId } from '../../test-support/run-id.js';
import { makeRunWorkspaceContext } from '../../test-support/run-workspace-context.js';
import { testThreadId } from '../../test-support/thread-id.js';
import { createRunState } from './runtime/run-state.js';

function registerOnce(
  daemonContext: ReturnType<typeof createDaemonContext>,
  tool: AnyTool,
): void {
  daemonContext.toolRegistry.registerTool(tool);
}

function parseObjectArgs<TArgs extends object>(
  raw: unknown,
): ToolParseResult<TArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'tool arguments must be an object.' };
  }
  return { ok: true, value: raw as TArgs };
}

function makeTestTool<TArgs extends object = Record<string, unknown>>(args: {
  name: string;
  description: string;
  sideEffectLevel: AnyTool['sideEffectLevel'];
  mayMutateWorkspaceFiles?: boolean;
  parallelBatchKind?: AnyTool['parallelBatchKind'];
  requiresApproval: boolean;
  parseArgs?: (raw: unknown) => ToolParseResult<TArgs>;
  executeParsed: (
    parsedArgs: TArgs,
    ctx: ToolExecutionContext,
  ) => Promise<ExecuteResult>;
}): AnyTool {
  return {
    name: args.name,
    description: args.description,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    strict: true,
    sideEffectLevel: args.sideEffectLevel,
    mayMutateWorkspaceFiles: args.mayMutateWorkspaceFiles ?? false,
    ...(args.parallelBatchKind
      ? { parallelBatchKind: args.parallelBatchKind }
      : {}),
    timeoutMs: 1_000,
    requiresApproval: args.requiresApproval,
    parseArgs: args.parseArgs ?? parseObjectArgs,
    executeParsed: args.executeParsed,
  };
}

function makeExecutionRuntime(
  daemonContext: ReturnType<typeof createDaemonContext>,
  args: {
    runContext: ReturnType<typeof makeRunWorkspaceContext>;
    runId: string;
    approvalContext: ReturnType<typeof makeApprovalContext>;
    emit: Parameters<typeof buildToolCallExecutionRuntime>[0]['emit'];
    currentFile?: string;
    selection?: ToolExecutionContext['selection'];
    signal?: AbortSignal;
    runState?: ReturnType<typeof createRunState>;
  },
) {
  return buildToolCallExecutionRuntime({
    approvalContext: args.approvalContext,
    emit: args.emit,
    toolRegistry: daemonContext.toolRegistry,
    approvalGate: daemonContext.approvalGate,
    approvalGrants: daemonContext.approvalGrants,
    executionContextBase: buildAgentToolExecutionContextBase({
      runContext: args.runContext,
      runId: args.runId,
      approvalContext: args.approvalContext,
      emit: args.emit,
      currentFile: args.currentFile,
      selection: args.selection,
      signal: args.signal,
      runState: args.runState,
      memoryIndex: undefined,
      agentSpawnRuntime: daemonContext,
    }),
  });
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

void test('invalid tool arguments persist tool_call and tool_result to transcript', async () => {
  const threadId = testThreadId(1);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-invalid-args-'));
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('project'),
    workspaceRoot,
  });
  const history: HistoryItem[] = [];
  const events: string[] = [];

  const result = await processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-invalid',
        callId: 'call-invalid',
        name: 'write_file',
        arguments: '{not-json',
      },
    ],
    round: 0,
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId: 'run-invalid',
      approvalContext: makeApprovalContext({
        sessionId: 'session-invalid',
      }),
      emit: (type) => {
        events.push(type);
      },
    }),
  });

  assert.deepEqual(result, { ok: true, value: undefined });
  assert.deepEqual(events, ['tool_call', 'tool_result']);
  assert.equal(history.length, 1);
  assert.equal(history[0]?.kind, 'function_call_output');

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => entry.role),
    ['tool_call', 'tool_result'],
  );
});

void test('large search_files output is offloaded and readable through its output ref', async () => {
  const threadId = testThreadId(80);
  const runId = 'run-search-offload';
  const callId = 'call-search-offload';
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-offload-'),
  );
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('search-offload'),
    workspaceRoot,
  });

  for (let index = 0; index < 60; index += 1) {
    await writeFile(
      join(workspaceRoot, `match-${String(index).padStart(2, '0')}.txt`),
      `MATCH_OFFLOAD_${index} ${'x'.repeat(300)}\n`,
      'utf8',
    );
  }

  const history: HistoryItem[] = [];
  const events: string[] = [];

  const result = await processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-search-offload',
        callId,
        name: 'search_files',
        arguments: JSON.stringify({
          maxResults: 80,
          pattern: 'MATCH_OFFLOAD_',
        }),
      },
    ],
    round: 0,
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId,
      approvalContext: makeApprovalContext({
        sessionId: 'session-search-offload',
      }),
      emit: (type) => {
        events.push(type);
      },
    }),
  });

  assert.deepEqual(result, { ok: true, value: undefined });
  assert.deepEqual(events, ['tool_call', 'tool_result']);
  assert.equal(history.length, 1);
  assert.equal(history[0]?.kind, 'function_call_output');
  if (history[0]?.kind !== 'function_call_output') {
    throw new Error('expected function_call_output history item');
  }

  const historyOutput = JSON.parse(history[0].output) as {
    offloaded?: boolean;
    outputRef?: string;
    tool?: string;
  };
  assert.equal(historyOutput.offloaded, true);
  assert.equal(historyOutput.tool, 'search_files');
  assert.equal(
    historyOutput.outputRef,
    `tool-output:${threadId}/${runId}/${callId}`,
  );
  assert.doesNotMatch(history[0].output, /MATCH_OFFLOAD_59/);

  const snapshotPath = join(
    workspaceRoot,
    '.geulbat',
    'tool-outputs',
    threadId,
    runId,
    `${callId}.json`,
  );
  const snapshot = JSON.parse(await readFsFile(snapshotPath, 'utf8')) as {
    output: string;
    outputRef: string;
    toolName: string;
  };
  assert.equal(snapshot.outputRef, historyOutput.outputRef);
  assert.equal(snapshot.toolName, 'search_files');
  assert.match(snapshot.output, /MATCH_OFFLOAD_0/);
  assert.match(snapshot.output, /MATCH_OFFLOAD_59/);

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  const toolResult = transcript.find((entry) => entry.role === 'tool_result');
  assert.ok(toolResult);
  const transcriptContent = JSON.parse(toolResult.content) as {
    output: string;
  };
  assert.deepEqual(JSON.parse(transcriptContent.output), historyOutput);

  const firstPageHistory: HistoryItem[] = [];
  const firstPageResult = await processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-read-output-first',
        callId: 'call-read-output-first',
        name: 'read_tool_output',
        arguments: JSON.stringify({
          outputRef: historyOutput.outputRef,
          limit: 2_000,
        }),
      },
    ],
    round: 1,
    history: firstPageHistory,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId,
      approvalContext: makeApprovalContext({
        sessionId: 'session-read-output-first',
      }),
      emit: () => {},
    }),
  });

  assert.deepEqual(firstPageResult, { ok: true, value: undefined });
  assert.equal(firstPageHistory[0]?.kind, 'function_call_output');
  if (firstPageHistory[0]?.kind !== 'function_call_output') {
    throw new Error('expected read_tool_output history item');
  }
  const firstPage = JSON.parse(firstPageHistory[0].output) as {
    content?: string;
    totalChars?: number;
    truncated?: boolean;
  };
  assert.equal(firstPage.truncated, true);
  assert.equal(firstPage.content, snapshot.output.slice(0, 2_000));
  assert.equal(typeof firstPage.totalChars, 'number');

  const tailHistory: HistoryItem[] = [];
  const tailOffset = Math.max(0, Number(firstPage.totalChars) - 1_200);
  const tailResult = await processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-read-output-tail',
        callId: 'call-read-output-tail',
        name: 'read_tool_output',
        arguments: JSON.stringify({
          outputRef: historyOutput.outputRef,
          offset: tailOffset,
          limit: 1_200,
        }),
      },
    ],
    round: 2,
    history: tailHistory,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId,
      approvalContext: makeApprovalContext({
        sessionId: 'session-read-output-tail',
      }),
      emit: () => {},
    }),
  });

  assert.deepEqual(tailResult, { ok: true, value: undefined });
  assert.equal(tailHistory[0]?.kind, 'function_call_output');
  if (tailHistory[0]?.kind !== 'function_call_output') {
    throw new Error('expected tail read_tool_output history item');
  }
  const tailPage = JSON.parse(tailHistory[0].output) as {
    content?: string;
  };
  assert.equal(tailPage.content, snapshot.output.slice(tailOffset));
});

void test('approval denial persists tool_result to transcript before terminal failure', async () => {
  const threadId = testThreadId(2);
  const daemonContext = createDaemonContext();
  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'approval_transcript_test_tool',
      description: 'test tool',
      sideEffectLevel: 'write',
      requiresApproval: true,
      async executeParsed() {
        return { ok: true, output: 'should not run' };
      },
    }),
  );

  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-approval-denied-'),
  );
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('project'),
    workspaceRoot,
  });
  const history: HistoryItem[] = [];
  const events: string[] = [];

  const execution = processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-denied',
        callId: 'call-denied',
        name: 'approval_transcript_test_tool',
        arguments: '{}',
      },
    ],
    round: 0,
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId: 'run-denied',
      approvalContext: makeApprovalContext({
        sessionId: 'session-denied',
      }),
      emit: (type) => {
        events.push(type);
        if (type === 'approval_required') {
          setTimeout(() => {
            daemonContext.approvalGate.resolveApproval(
              'call-denied',
              'run-denied',
              threadId,
              'denied',
            );
          }, 0);
        }
      },
    }),
  });

  const result = await execution;
  assert.equal(result.ok, false);
  assert.deepEqual(events, [
    'tool_call',
    'approval_required',
    'tool_result',
    'error',
  ]);
  assert.equal(history.length, 1);
  const firstHistoryItem = history[0];
  assert.equal(firstHistoryItem?.kind, 'function_call_output');
  if (firstHistoryItem?.kind === 'function_call_output') {
    assert.match(firstHistoryItem.output, /approval_denied/);
  }

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => entry.role),
    ['tool_call', 'tool_result'],
  );
});

void test('approval-delayed write_file surfaces stale conflicts after external modification before resume', async () => {
  const threadId = testThreadId(22);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-approval-stale-'),
  );
  const absolutePath = join(workspaceRoot, 'draft.md');
  await writeFile(absolutePath, 'hello\n', 'utf8');
  const file = await readFile(workspaceRoot, 'draft.md');
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('project'),
    workspaceRoot,
  });
  const history: HistoryItem[] = [];
  const events: string[] = [];

  const result = await processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-approval-stale',
        callId: 'call-approval-stale',
        name: 'write_file',
        arguments: JSON.stringify({
          path: 'draft.md',
          content: 'updated\n',
          versionToken: file.versionToken,
        }),
      },
    ],
    round: 0,
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId: 'run-approval-stale',
      approvalContext: makeApprovalContext({
        sessionId: 'session-approval-stale',
      }),
      emit: (type) => {
        events.push(type);
        if (type === 'approval_required') {
          setTimeout(() => {
            void (async () => {
              await writeFile(absolutePath, 'external\n', 'utf8');
              daemonContext.approvalGate.resolveApproval(
                'call-approval-stale',
                'run-approval-stale',
                threadId,
                'approved',
              );
            })();
          }, 0);
        }
      },
    }),
  });

  assert.deepEqual(result, { ok: true, value: undefined });
  assert.deepEqual(events, ['tool_call', 'approval_required', 'tool_result']);
  assert.equal(history.length, 1);
  const firstHistoryItem = history[0];
  assert.equal(firstHistoryItem?.kind, 'function_call_output');
  if (firstHistoryItem?.kind === 'function_call_output') {
    assert.match(firstHistoryItem.output, /conflict_stale_write/);
  }

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => entry.role),
    ['tool_call', 'tool_result'],
  );
  const toolResultEntry = transcript[1];
  assert.equal(toolResultEntry?.role, 'tool_result');
  if (toolResultEntry?.role === 'tool_result') {
    const storedResult = JSON.parse(toolResultEntry.content) as {
      ok: boolean;
      errorCode?: string;
    };
    assert.equal(storedResult.ok, false);
    assert.equal(storedResult.errorCode, 'conflict_stale_write');
  }
});

void test('tool_result reports daemon-owned workspace mutation signal', async () => {
  const threadId = testThreadId(21);
  const daemonContext = createDaemonContext();
  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'workspace_mutation_signal_test_tool',
      description: 'writes a workspace file',
      sideEffectLevel: 'write',
      mayMutateWorkspaceFiles: true,
      requiresApproval: false,
      async executeParsed() {
        return { ok: true, output: 'written' };
      },
    }),
  );

  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-workspace-mutation-signal-'),
  );
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('project'),
    workspaceRoot,
  });
  const emitted: Array<{ type: string; payload: unknown }> = [];

  const result = await processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-write-signal',
        callId: 'call-write-signal',
        name: 'workspace_mutation_signal_test_tool',
        arguments: '{}',
      },
    ],
    round: 0,
    history: [],
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId: 'run-write-signal',
      approvalContext: makeApprovalContext({
        sessionId: 'session-write-signal',
      }),
      emit: (type, payload) => {
        emitted.push({ type, payload });
      },
    }),
  });

  assert.deepEqual(result, { ok: true, value: undefined });
  const toolResultEvent = emitted.find((event) => event.type === 'tool_result');
  assert.ok(toolResultEvent);
  assert.deepEqual(toolResultEvent.payload, {
    callId: 'call-write-signal',
    step: 0,
    tool: 'workspace_mutation_signal_test_tool',
    ok: true,
    workspaceFilesMayHaveChanged: true,
    displayText: 'written',
    raw: 'written',
  });
});

void test('full_access auto-approved write skips prompt and executes successfully', async () => {
  const threadId = testThreadId(3);
  const daemonContext = createDaemonContext();
  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'approval_full_access_test_tool',
      description: 'test tool',
      sideEffectLevel: 'write',
      requiresApproval: true,
      async executeParsed() {
        return { ok: true, output: 'executed' };
      },
    }),
  );

  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-full-access-'));
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('project'),
    workspaceRoot,
  });
  const history: HistoryItem[] = [];
  const events: string[] = [];

  const result = await processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-full-access',
        callId: 'call-full-access',
        name: 'approval_full_access_test_tool',
        arguments: '{}',
      },
    ],
    round: 0,
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId: 'run-full-access',
      approvalContext: makeApprovalContext({
        sessionId: 'session-full-access',
        permissionMode: 'full_access',
      }),
      emit: (type) => {
        events.push(type);
      },
    }),
  });

  assert.deepEqual(result, { ok: true, value: undefined });
  assert.deepEqual(events, ['tool_call', 'tool_result']);
  assert.equal(history.length, 1);
  const historyItem = history[0];
  assert.equal(historyItem?.kind, 'function_call_output');
  if (historyItem?.kind === 'function_call_output') {
    assert.equal(historyItem.output, 'executed');
  }

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => entry.role),
    ['tool_call', 'tool_result'],
  );
  const toolResultEntry = transcript[1];
  assert.equal(toolResultEntry?.role, 'tool_result');
  if (toolResultEntry?.role === 'tool_result') {
    const storedResult = JSON.parse(toolResultEntry.content) as {
      ok: boolean;
      output: string;
    };
    assert.equal(storedResult.ok, true);
    assert.equal(storedResult.output, 'executed');
  }
});

void test('processFunctionCalls stops before the next tool when the run is aborted mid-batch', async () => {
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
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('project'),
    workspaceRoot,
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
        sessionId: 'session-batch-abort',
      }),
      emit: (type) => {
        events.push(type);
      },
      signal: abortController.signal,
    }),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(events, ['tool_call', 'tool_result', 'error']);
  assert.equal(secondToolExecutions, 0);
  assert.equal(history.length, 1);
  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => entry.role),
    ['tool_call', 'tool_result'],
  );
});

void test('processFunctionCalls executes independent read-only tools in parallel', async () => {
  const threadId = testThreadId(5);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-read-parallel-'));
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('project'),
    workspaceRoot,
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
        sessionId: 'session-parallel-read',
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

void test('processFunctionCalls executes same-round subagent launch batches in parallel when the tool metadata allows it', async () => {
  const threadId = testThreadId(51);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-spawn-parallel-'),
  );
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('project'),
    workspaceRoot,
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
        sessionId: 'session-agent-spawn-parallel',
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

void test('processFunctionCalls allows four same-round subagent launches under the default cap', async () => {
  const threadId = testThreadId(152);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-spawn-four-'),
  );
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('project'),
    workspaceRoot,
  });
  const history: HistoryItem[] = [];
  let executeCount = 0;
  const runState = createRunState({
    runId: 'run-agent-spawn-four',
    runContext,
  });

  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'parallel_four_subagent_launch_tool',
      description: 'parallel four subagent launch tool',
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
    functionCalls: Array.from({ length: 4 }, (_, index) => ({
      id: `fc-agent-four-${index + 1}`,
      callId: `call-agent-four-${index + 1}`,
      name: 'parallel_four_subagent_launch_tool',
      arguments: JSON.stringify({
        task: `inspect ${index + 1}`,
        subagent_type: index % 2 === 0 ? 'explorer' : 'worker',
      }),
    })),
    round: 0,
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId: 'run-agent-spawn-four',
      approvalContext: makeApprovalContext({
        sessionId: 'session-agent-spawn-four',
      }),
      emit: () => {},
      runState,
    }),
  });

  assert.deepEqual(result, { ok: true, value: undefined });
  assert.equal(executeCount, 4);
  assert.equal(runState.backgroundChildLaunchReservationIds.size, 0);

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => entry.role),
    [
      'tool_call',
      'tool_call',
      'tool_call',
      'tool_call',
      'tool_result',
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
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-spawn-cap-'),
  );
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('project'),
    workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-agent-spawn-cap',
    runContext,
  });
  for (
    let index = 0;
    index < DEFAULT_MAX_CONCURRENT_BACKGROUND_CHILDREN - 1;
    index += 1
  ) {
    runState.backgroundChildRunIds.add(testRunId(`existing-child-${index}`));
  }
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
        sessionId: 'session-agent-spawn-cap',
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
    assert.equal(raw.effectiveMax, DEFAULT_MAX_CONCURRENT_BACKGROUND_CHILDREN);
  }
});

void test('processFunctionCalls keeps write tools on the sequential path', async () => {
  const threadId = testThreadId(6);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-write-sequential-'),
  );
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('project'),
    workspaceRoot,
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
      approvalContext: makeApprovalContext({
        sessionId: 'session-sequential-write',
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
