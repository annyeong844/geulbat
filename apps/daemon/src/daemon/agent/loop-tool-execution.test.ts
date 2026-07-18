import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile as readFsFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { HistoryItem } from '../llm/index.js';
import { buildHistoryFromTranscript } from './history/build-history-from-transcript.js';
import { recordToolResult } from './loop-tool-support.js';
import { processFunctionCalls } from './loop-tool-execution.js';
import {
  buildAgentToolExecutionContextBase,
  buildToolCallExecutionRuntime,
} from './loop-tool-runtime.js';
import { createDaemonContext } from '../context.js';
import { readFile } from '../files/read-file.js';
import {
  PTC_EXECUTE_CODE_POLICY_ID,
  PTC_EXECUTE_CODE_TOOL_NAME,
  PTC_EXECUTE_CODE_WAIT_TOOL_NAME,
  type PtcExecuteCodeRuntime,
} from '../ptc/runtime/execute-code/execute-code-runtime-contract.js';
import { readTranscriptEntries } from '../sessions/transcript-log.js';
import type {
  AnyTool,
  ExecuteResult,
  ToolExecutionContext,
  ToolParseResult,
} from '../tools/types.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import { testRunId } from '../../test-support/run-id.js';
import { makeRunContext } from '../../test-support/run-context.js';
import { testThreadId } from '../../test-support/thread-id.js';
import { createRunState } from './runtime/run-state.js';
import {
  isInterjectFlushRequested,
  pushPendingInterject,
  requestInterjectFlush,
} from '../sessions/active-run-interject-buffer.js';
import {
  TEST_AUTO_SUBAGENT_MODEL_ROUTING,
  TEST_INHERITED_SOL_MODEL_PIN,
} from '../../test-support/subagent-model-routing.js';

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
  mayMutateComputerFiles?: boolean;
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
    mayMutateComputerFiles: args.mayMutateComputerFiles ?? false,
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
    runContext: ReturnType<typeof makeRunContext>;
    runId: string;
    approvalContext: ReturnType<typeof makeApprovalContext>;
    emit: Parameters<typeof buildToolCallExecutionRuntime>[0]['emit'];
    currentFile?: string;
    selection?: ToolExecutionContext['selection'];
    signal?: AbortSignal;
    runState?: ReturnType<typeof createRunState>;
    computerFileRoot?: string;
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
      ...(args.computerFileRoot === undefined
        ? {}
        : { computerFileRoot: args.computerFileRoot }),
      memoryIndex: undefined,
      agentSpawnRuntime: daemonContext,
      providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
      subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
    }),
  });
}

async function startApprovalCheckpoint(
  daemonContext: ReturnType<typeof createDaemonContext>,
  threadId: ReturnType<typeof testThreadId>,
  runId: ReturnType<typeof testRunId>,
): Promise<void> {
  const result = await daemonContext.runCheckpoints.startRun({
    runId,
    threadId,
    request: { workingDirectory: '.', permissionMode: 'basic' },
  });
  assert.equal(result.ok, true);
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
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
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
  const liveOutput =
    history[0]?.kind === 'function_call_output' ? history[0].output : undefined;
  assert.equal(typeof liveOutput, 'string');
  const storedResult = JSON.parse(transcript[1]?.content ?? '{}') as {
    output?: unknown;
  };
  assert.equal(storedResult.output, liveOutput);
  const replayedHistory = buildHistoryFromTranscript(transcript);
  const replayedOutput = replayedHistory.find(
    (item) => item.kind === 'function_call_output',
  );
  assert.equal(replayedOutput?.kind, 'function_call_output');
  if (replayedOutput?.kind === 'function_call_output') {
    assert.equal(replayedOutput.output, liveOutput);
  }
});

void test('large search_files output is offloaded and readable through its output ref', async () => {
  const threadId = testThreadId(80);
  const runId = 'run-search-offload';
  const callId = 'call-search-offload';
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-offload-'),
  );
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-search-offload-files-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
    workingDirectory: computerFileRoot,
  });

  for (let index = 0; index < 300; index += 1) {
    await writeFile(
      join(
        computerFileRoot,
        `MATCH_OFFLOAD_${String(index).padStart(3, '0')}_${'x'.repeat(
          120,
        )}.txt`,
      ),
      'filename search offload fixture\n',
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
          maxResults: 320,
          pattern: 'MATCH_OFFLOAD_*',
          type: 'filename',
        }),
      },
    ],
    round: 0,
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId,
      computerFileRoot,
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
  assert.doesNotMatch(history[0].output, /MATCH_OFFLOAD_299/);

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
  assert.match(snapshot.output, /MATCH_OFFLOAD_299/);

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
    hasMore?: boolean;
    totalChars?: number;
  };
  assert.equal(firstPage.hasMore, true);
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
  const runId = testRunId('denied');
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-approval-denied-'),
  );
  const daemonContext = createDaemonContext({
    homeStateRoot: join(workspaceRoot, 'daemon-home'),
  });
  await startApprovalCheckpoint(daemonContext, threadId, runId);
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

  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
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
      runId,
      approvalContext: makeApprovalContext({
        sessionId: 'session-denied',
      }),
      emit: (type) => {
        events.push(type);
        if (type === 'approval_required') {
          setTimeout(() => {
            void daemonContext.approvalGate.resolveApproval(
              'call-denied',
              runId,
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

void test('approval denial settles later same-round tool obligations before terminal failure', async () => {
  const threadId = testThreadId(2_1);
  const runId = testRunId('denied-later');
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-approval-denied-later-'),
  );
  const daemonContext = createDaemonContext({
    homeStateRoot: join(workspaceRoot, 'daemon-home'),
  });
  await startApprovalCheckpoint(daemonContext, threadId, runId);
  let laterReadExecutions = 0;
  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'approval_denial_barrier_tool',
      description: 'approval denial barrier tool',
      sideEffectLevel: 'write',
      requiresApproval: true,
      async executeParsed() {
        return { ok: true, output: 'should not run' };
      },
    }),
  );
  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'read_after_approval_denial_tool',
      description: 'read after approval denial',
      sideEffectLevel: 'read',
      requiresApproval: false,
      async executeParsed() {
        laterReadExecutions += 1;
        return { ok: true, output: 'should not run after denial' };
      },
    }),
  );

  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const history: HistoryItem[] = [];
  const events: string[] = [];

  const result = await processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-denied-barrier',
        callId: 'call-denied-barrier',
        name: 'approval_denial_barrier_tool',
        arguments: '{}',
      },
      {
        id: 'fc-read-after-denial',
        callId: 'call-read-after-denial',
        name: 'read_after_approval_denial_tool',
        arguments: '{}',
      },
    ],
    round: 0,
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId,
      approvalContext: makeApprovalContext({
        sessionId: 'session-denied-later',
      }),
      emit: (type) => {
        events.push(type);
        if (type === 'approval_required') {
          setTimeout(() => {
            void daemonContext.approvalGate.resolveApproval(
              'call-denied-barrier',
              runId,
              threadId,
              'denied',
            );
          }, 0);
        }
      },
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(laterReadExecutions, 0);
  assert.deepEqual(events, [
    'tool_call',
    'approval_required',
    'tool_result',
    'tool_call',
    'tool_result',
    'error',
  ]);
  assert.equal(history.length, 2);
  const laterOutput = JSON.parse(
    history[1]?.kind === 'function_call_output' ? history[1].output : '{}',
  ) as { ok?: boolean; errorCode?: string; error?: string };
  assert.equal(laterOutput.ok, false);
  assert.equal(laterOutput.errorCode, 'approval_denied');
  assert.match(laterOutput.error ?? '', /earlier call ended the run/u);

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => entry.role),
    ['tool_call', 'tool_result', 'tool_call', 'tool_result'],
  );
});

void test('approval-delayed write_file surfaces stale conflicts after external modification before resume', async () => {
  const threadId = testThreadId(22);
  const runId = testRunId('approval-stale');
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-approval-stale-'),
  );
  const daemonContext = createDaemonContext({
    homeStateRoot: join(workspaceRoot, 'daemon-home'),
  });
  await startApprovalCheckpoint(daemonContext, threadId, runId);
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-approval-stale-files-'),
  );
  const absolutePath = join(computerFileRoot, 'draft.md');
  await writeFile(absolutePath, 'hello\n', 'utf8');
  const file = await readFile(computerFileRoot, 'draft.md');
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
    workingDirectory: computerFileRoot,
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
      runId,
      computerFileRoot,
      approvalContext: makeApprovalContext({
        sessionId: 'session-approval-stale',
      }),
      emit: (type) => {
        events.push(type);
        if (type === 'approval_required') {
          setTimeout(() => {
            void (async () => {
              await writeFile(absolutePath, 'external\n', 'utf8');
              void daemonContext.approvalGate.resolveApproval(
                'call-approval-stale',
                runId,
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

void test('tool_result reports daemon-owned Computer file mutation signal', async () => {
  const threadId = testThreadId(21);
  const daemonContext = createDaemonContext();
  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'computer_file_mutation_signal_test_tool',
      description: 'writes a Computer file',
      sideEffectLevel: 'write',
      mayMutateComputerFiles: true,
      requiresApproval: false,
      async executeParsed() {
        return { ok: true, output: 'written' };
      },
    }),
  );

  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-computer-file-mutation-signal-'),
  );
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-computer-file-mutation-signal-files-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
    workingDirectory: computerFileRoot,
  });
  const emitted: Array<{ type: string; payload: unknown }> = [];

  const result = await processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-write-signal',
        callId: 'call-write-signal',
        name: 'computer_file_mutation_signal_test_tool',
        arguments: '{}',
      },
    ],
    round: 0,
    history: [],
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId: 'run-write-signal',
      computerFileRoot,
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
    tool: 'computer_file_mutation_signal_test_tool',
    ok: true,
    computerFilesMayHaveChanged: true,
    displayText: 'written',
    raw: 'written',
  });
});

void test('tool_result displayText preserves full tool output', async () => {
  const threadId = testThreadId(303);
  const daemonContext = createDaemonContext();
  const longOutput = 'x'.repeat(1_200);
  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'long_display_text_test_tool',
      description: 'test tool',
      sideEffectLevel: 'read',
      requiresApproval: false,
      async executeParsed() {
        return { ok: true, output: longOutput };
      },
    }),
  );

  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-long-display-text-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const history: HistoryItem[] = [];
  const emitted: Array<{ type: string; payload: unknown }> = [];

  const result = await processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-long-display-text',
        callId: 'call-long-display-text',
        name: 'long_display_text_test_tool',
        arguments: '{}',
      },
    ],
    round: 0,
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId: 'run-long-display-text',
      approvalContext: makeApprovalContext({
        sessionId: 'session-long-display-text',
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
    callId: 'call-long-display-text',
    step: 0,
    tool: 'long_display_text_test_tool',
    ok: true,
    computerFilesMayHaveChanged: false,
    displayText: longOutput,
    raw: longOutput,
  });
  assert.equal(history.length, 1);
  const historyItem = history[0];
  assert.equal(historyItem?.kind, 'function_call_output');
  if (historyItem?.kind === 'function_call_output') {
    assert.equal(historyItem.output, longOutput);
  }

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  const toolResultEntry = transcript.find(
    (entry) => entry.role === 'tool_result',
  );
  assert.equal(toolResultEntry?.role, 'tool_result');
  if (toolResultEntry?.role === 'tool_result') {
    const storedResult = JSON.parse(toolResultEntry.content) as {
      displayText: string;
      output: string;
    };
    assert.equal(storedResult.displayText, longOutput);
    assert.equal(storedResult.output, longOutput);
  }
});

void test('failed tool_result keeps structured event raw while history and transcript share one model output', async () => {
  const threadId = testThreadId(304);
  const rawFailure = {
    ok: false,
    status: 'failed',
    detail: 'structured failure detail',
  };

  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-structured-failure-raw-'),
  );
  const history: HistoryItem[] = [];
  const emitted: Array<{ type: string; payload: unknown }> = [];

  await recordToolResult({
    functionCall: {
      id: 'fc-structured-failure-raw',
      callId: 'call-structured-failure-raw',
      name: 'structured_failure_raw_test_tool',
      arguments: '{}',
    },
    round: 0,
    toolResult: {
      ok: false,
      output: JSON.stringify(rawFailure),
      errorCode: 'execution_failed',
      error: 'structured failure',
    },
    computerFilesMayHaveChanged: false,
    runContext: makeRunContext({ threadId, stateRoot: workspaceRoot }),
    runId: 'run-structured-failure-raw',
    history,
    emit: (type, payload) => {
      emitted.push({ type, payload });
    },
  });

  const toolResultEvent = emitted.find((event) => event.type === 'tool_result');
  assert.ok(toolResultEvent);
  assert.deepEqual(toolResultEvent.payload, {
    callId: 'call-structured-failure-raw',
    step: 0,
    tool: 'structured_failure_raw_test_tool',
    ok: false,
    computerFilesMayHaveChanged: false,
    displayText: 'structured failure',
    raw: rawFailure,
    errorCode: 'execution_failed',
    error: 'structured failure',
  });

  const liveOutput =
    history[0]?.kind === 'function_call_output' ? history[0].output : undefined;
  assert.equal(
    liveOutput,
    JSON.stringify({
      ok: false,
      errorCode: 'execution_failed',
      error: 'structured failure',
    }),
  );
  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  const storedResult = JSON.parse(transcript[0]?.content ?? '{}') as {
    output?: unknown;
  };
  assert.equal(storedResult.output, liveOutput);
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
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
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
        sessionId: 'session-batch-abort',
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
        sessionId: 'session-batch-flush',
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
        sessionId: 'session-shared-window-abort',
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
      sessionId: 'session-shared-reject-settle',
    }),
    emit: (type) => {
      events.push(type);
    },
  });
  const originalGetTool = runtime.toolRegistry.getTool.bind(
    runtime.toolRegistry,
  );
  runtime.toolRegistry.getTool = (name) => {
    if (name === 'shared_registry_reject_tool') {
      throw new Error('registry exploded with private path /tmp/secret');
    }
    return originalGetTool(name);
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

void test('processFunctionCalls runs builtin agent_spawn calls as a same-round launch wave', async () => {
  const threadId = testThreadId(155);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-builtin-agent-spawn-wave-'),
  );
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
  const childRunIds = [
    testRunId('builtin-wave-child-a'),
    testRunId('builtin-wave-child-b'),
  ] as const;
  const childThreadIds = [testThreadId(156), testThreadId(157)] as const;

  daemonContext.subagentRuns = {
    async startBackgroundRun(args) {
      const index = startedTasks.length;
      const childRunId = childRunIds[index];
      const childThreadId = childThreadIds[index];
      assert.ok(childRunId);
      assert.ok(childThreadId);

      startedTasks.push(args.task);
      if (startedTasks.length === 2) {
        bothLaunchesStarted.resolve();
      }
      await releaseLaunches.promise;
      args.launchReservation?.release();

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
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId: 'run-builtin-agent-spawn-wave',
      approvalContext: makeApprovalContext({
        sessionId: 'session-builtin-agent-spawn-wave',
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
});

void test('processFunctionCalls allows four same-round subagent launches under the default policy', async () => {
  const threadId = testThreadId(152);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-spawn-four-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
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
    assert.equal(raw.effectiveMax, 1);
  }
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
        sessionId: 'session-mixed-shared-window',
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
        sessionId: 'session-mixed-subagent-cap',
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
        sessionId: 'session-write-barrier-window',
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
          sessionId: `session-${scenario.id}`,
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

void test('processFunctionCalls keeps PTC none-effect tools exclusive until cell scheduling is explicit', async () => {
  const threadId = testThreadId(158);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-ptc-cell-gate-'));
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const history: HistoryItem[] = [];
  const releaseFirstReads = createDeferred<void>();
  const releaseExec = createDeferred<void>();
  const releaseWait = createDeferred<void>();
  const releaseSecondReads = createDeferred<void>();
  const firstReadsStarted = createDeferred<void>();
  const execStarted = createDeferred<void>();
  const waitStarted = createDeferred<void>();
  const secondReadsStarted = createDeferred<void>();
  let firstReadStarts = 0;
  let secondReadStarts = 0;
  let execHasStarted = false;
  let waitHasStarted = false;

  const makePtcGateReadTool = (name: string, windowName: 'first' | 'second') =>
    makeTestTool({
      name,
      description: `${windowName} PTC gate read tool`,
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
    makePtcGateReadTool('ptc_gate_first_read_one', 'first'),
  );
  registerOnce(
    daemonContext,
    makePtcGateReadTool('ptc_gate_first_read_two', 'first'),
  );
  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'ptc_gate_exec_tool',
      description: 'PTC exec-shaped tool without a live ptc_cell batch kind',
      sideEffectLevel: 'none',
      requiresApproval: false,
      async executeParsed() {
        execHasStarted = true;
        execStarted.resolve();
        await releaseExec.promise;
        return { ok: true, output: 'exec complete' };
      },
    }),
  );
  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'ptc_gate_wait_tool',
      description: 'PTC wait-shaped tool without a live ptc_cell batch kind',
      sideEffectLevel: 'none',
      requiresApproval: false,
      async executeParsed() {
        waitHasStarted = true;
        waitStarted.resolve();
        await releaseWait.promise;
        return { ok: true, output: 'wait complete' };
      },
    }),
  );
  registerOnce(
    daemonContext,
    makePtcGateReadTool('ptc_gate_second_read_one', 'second'),
  );
  registerOnce(
    daemonContext,
    makePtcGateReadTool('ptc_gate_second_read_two', 'second'),
  );

  const processing = processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-ptc-gate-read-1',
        callId: 'call-ptc-gate-read-1',
        name: 'ptc_gate_first_read_one',
        arguments: '{}',
      },
      {
        id: 'fc-ptc-gate-read-2',
        callId: 'call-ptc-gate-read-2',
        name: 'ptc_gate_first_read_two',
        arguments: '{}',
      },
      {
        id: 'fc-ptc-gate-exec',
        callId: 'call-ptc-gate-exec',
        name: 'ptc_gate_exec_tool',
        arguments: '{}',
      },
      {
        id: 'fc-ptc-gate-wait',
        callId: 'call-ptc-gate-wait',
        name: 'ptc_gate_wait_tool',
        arguments: '{}',
      },
      {
        id: 'fc-ptc-gate-read-3',
        callId: 'call-ptc-gate-read-3',
        name: 'ptc_gate_second_read_one',
        arguments: '{}',
      },
      {
        id: 'fc-ptc-gate-read-4',
        callId: 'call-ptc-gate-read-4',
        name: 'ptc_gate_second_read_two',
        arguments: '{}',
      },
    ],
    round: 0,
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId: 'run-ptc-cell-gate',
      approvalContext: makeApprovalContext({
        sessionId: 'session-ptc-cell-gate',
      }),
      emit: () => {},
    }),
  });

  await firstReadsStarted.promise;
  assert.equal(execHasStarted, false);
  assert.equal(waitHasStarted, false);
  assert.equal(secondReadStarts, 0);

  releaseFirstReads.resolve();
  await execStarted.promise;
  assert.equal(waitHasStarted, false);
  assert.equal(secondReadStarts, 0);

  releaseExec.resolve();
  await waitStarted.promise;
  assert.equal(secondReadStarts, 0);

  releaseWait.resolve();
  await secondReadsStarted.promise;
  assert.equal(secondReadStarts, 2);

  releaseSecondReads.resolve();
  const result = await processing;
  assert.deepEqual(result, { ok: true, value: undefined });
  assert.equal(history.length, 6);

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => entry.role),
    [
      'tool_call',
      'tool_call',
      'tool_result',
      'tool_result',
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_call',
      'tool_result',
      'tool_result',
    ],
  );
});

void test('processFunctionCalls mixes public exec and non-terminating wait with read windows', async () => {
  const threadId = testThreadId(160);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-public-ptc-cell-window-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const history: HistoryItem[] = [];
  const releaseSharedWindow = createDeferred<void>();
  const allCallsStarted = createDeferred<void>();
  const events: string[] = [];
  const markStarted = (event: string) => {
    events.push(event);
    if (events.length === 5) {
      allCallsStarted.resolve();
    }
  };
  const ptcExecuteCode: PtcExecuteCodeRuntime = {
    async executeCode() {
      markStarted('exec');
      await releaseSharedWindow.promise;
      return {
        ok: true,
        value: {
          ok: true,
          capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
          policyId: PTC_EXECUTE_CODE_POLICY_ID,
          labPolicyId: 'ptc_lab_local_docker_batch_command_v1',
          profile: 'lab',
          executionClass: 'lab_execute_code',
          executionSurface: 'node_via_lab_batch_command',
          exitCode: 0,
          stdout: 'exec complete\n',
          stderr: '',
          effectiveTimeoutMs: 60_000,
          durationMs: 1,
          toolCallbacks: {
            enabled: false,
            observed: 0,
          },
          sessionLifecycle: {
            mode: 'runtime_owned_reusable',
            retainedAfterExecution: true,
          },
          callbackHelp: {
            protocolVersion: 'ptc_execute_code_sdk_v1',
            helpAvailable: true,
            callbackToolCount: 0,
          },
        },
      };
    },
    async waitForCell(args) {
      assert.equal(args.request.terminate, undefined);
      markStarted('wait');
      await releaseSharedWindow.promise;
      return {
        ok: true,
        value: {
          ok: true,
          capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
          policyId: PTC_EXECUTE_CODE_POLICY_ID,
          executionSurface: 'node_via_lab_detached_cell',
          status: 'completed',
          cellId: 'ptc_cell_public_gate',
          exitCode: 0,
          stdout: 'wait complete\n',
          stderr: '',
        },
      };
    },
    async closeAll() {
      return { ok: true };
    },
  };
  daemonContext.ptcExecuteCode = ptcExecuteCode;

  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'public_ptc_read_before',
      description: 'read before public exec',
      sideEffectLevel: 'read',
      requiresApproval: false,
      async executeParsed() {
        markStarted('read-before');
        await releaseSharedWindow.promise;
        return { ok: true, output: 'read before complete' };
      },
    }),
  );
  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'public_ptc_read_between',
      description: 'read between public exec and wait',
      sideEffectLevel: 'read',
      requiresApproval: false,
      async executeParsed() {
        markStarted('read-between');
        await releaseSharedWindow.promise;
        return { ok: true, output: 'read between complete' };
      },
    }),
  );
  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'public_ptc_read_after',
      description: 'read after public wait',
      sideEffectLevel: 'read',
      requiresApproval: false,
      async executeParsed() {
        markStarted('read-after');
        await releaseSharedWindow.promise;
        return { ok: true, output: 'read after complete' };
      },
    }),
  );

  const processing = processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-public-ptc-read-before',
        callId: 'call-public-ptc-read-before',
        name: 'public_ptc_read_before',
        arguments: '{}',
      },
      {
        id: 'fc-public-ptc-exec',
        callId: 'call-public-ptc-exec',
        name: PTC_EXECUTE_CODE_TOOL_NAME,
        arguments: '{"code":"console.log(1)"}',
      },
      {
        id: 'fc-public-ptc-read-between',
        callId: 'call-public-ptc-read-between',
        name: 'public_ptc_read_between',
        arguments: '{}',
      },
      {
        id: 'fc-public-ptc-wait',
        callId: 'call-public-ptc-wait',
        name: PTC_EXECUTE_CODE_WAIT_TOOL_NAME,
        arguments: '{"cell_id":"ptc_cell_public_gate"}',
      },
      {
        id: 'fc-public-ptc-read-after',
        callId: 'call-public-ptc-read-after',
        name: 'public_ptc_read_after',
        arguments: '{}',
      },
    ],
    round: 0,
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId: 'run-public-ptc-cell-gate',
      approvalContext: makeApprovalContext({
        sessionId: 'session-public-ptc-cell-gate',
      }),
      emit: () => {},
    }),
  });

  await allCallsStarted.promise;
  // Shared-window transcript order remains input-stable below. Tool-local
  // async preflight may reach each implementation in a different order; the
  // concurrency contract is that every admitted call starts before release.
  assert.deepEqual(
    [...events].sort(),
    ['read-before', 'exec', 'read-between', 'wait', 'read-after'].sort(),
  );

  releaseSharedWindow.resolve();
  const result = await processing;
  assert.deepEqual(result, { ok: true, value: undefined });
  assert.equal(history.length, 5);

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => entry.role),
    [
      'tool_call',
      'tool_call',
      'tool_call',
      'tool_call',
      'tool_call',
      'tool_result',
      'tool_result',
      'tool_result',
      'tool_result',
      'tool_result',
    ],
  );
});

void test('processFunctionCalls keeps public terminate wait exclusive after PTC cell wiring', async () => {
  const threadId = testThreadId(161);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-public-ptc-terminate-wait-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const history: HistoryItem[] = [];
  const releaseReadBefore = createDeferred<void>();
  const releaseWait = createDeferred<void>();
  const releaseReadAfter = createDeferred<void>();
  const readBeforeStarted = createDeferred<void>();
  const waitStarted = createDeferred<void>();
  const readAfterStarted = createDeferred<void>();
  const events: string[] = [];
  const ptcExecuteCode: PtcExecuteCodeRuntime = {
    async executeCode() {
      assert.fail('terminate wait test must not call exec');
    },
    async waitForCell(args) {
      assert.equal(args.request.terminate, true);
      events.push('wait-terminate');
      waitStarted.resolve();
      await releaseWait.promise;
      return {
        ok: true,
        value: {
          ok: true,
          capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
          policyId: PTC_EXECUTE_CODE_POLICY_ID,
          executionSurface: 'node_via_lab_detached_cell',
          status: 'completed',
          cellId: 'ptc_cell_public_terminate_gate',
          exitCode: 0,
          stdout: 'terminated\n',
          stderr: '',
        },
      };
    },
    async closeAll() {
      return { ok: true };
    },
  };
  daemonContext.ptcExecuteCode = ptcExecuteCode;

  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'public_ptc_terminate_read_before',
      description: 'read before public terminate wait',
      sideEffectLevel: 'read',
      requiresApproval: false,
      async executeParsed() {
        events.push('read-before');
        readBeforeStarted.resolve();
        await releaseReadBefore.promise;
        return { ok: true, output: 'read before complete' };
      },
    }),
  );
  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'public_ptc_terminate_read_after',
      description: 'read after public terminate wait',
      sideEffectLevel: 'read',
      requiresApproval: false,
      async executeParsed() {
        events.push('read-after');
        readAfterStarted.resolve();
        await releaseReadAfter.promise;
        return { ok: true, output: 'read after complete' };
      },
    }),
  );

  const processing = processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-public-ptc-terminate-read-before',
        callId: 'call-public-ptc-terminate-read-before',
        name: 'public_ptc_terminate_read_before',
        arguments: '{}',
      },
      {
        id: 'fc-public-ptc-terminate-wait',
        callId: 'call-public-ptc-terminate-wait',
        name: PTC_EXECUTE_CODE_WAIT_TOOL_NAME,
        arguments:
          '{"cell_id":"ptc_cell_public_terminate_gate","terminate":true}',
      },
      {
        id: 'fc-public-ptc-terminate-read-after',
        callId: 'call-public-ptc-terminate-read-after',
        name: 'public_ptc_terminate_read_after',
        arguments: '{}',
      },
    ],
    round: 0,
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId: 'run-public-ptc-terminate-wait',
      approvalContext: makeApprovalContext({
        sessionId: 'session-public-ptc-terminate-wait',
      }),
      emit: () => {},
    }),
  });

  await readBeforeStarted.promise;
  assert.deepEqual(events, ['read-before']);

  releaseReadBefore.resolve();
  await waitStarted.promise;
  assert.deepEqual(events, ['read-before', 'wait-terminate']);

  releaseWait.resolve();
  await readAfterStarted.promise;
  assert.deepEqual(events, ['read-before', 'wait-terminate', 'read-after']);

  releaseReadAfter.resolve();
  const result = await processing;
  assert.deepEqual(result, { ok: true, value: undefined });
  assert.equal(history.length, 3);

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => entry.role),
    [
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
    ],
  );
});

void test('processFunctionCalls mixes explicit PTC cells with read and subagent shared windows after a resource snapshot', async () => {
  const threadId = testThreadId(159);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-cell-window-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-ptc-cell-window',
    runContext,
  });
  const history: HistoryItem[] = [];
  const releaseSharedWindow = createDeferred<void>();
  const allToolsStarted = createDeferred<void>();
  const startedTools: string[] = [];
  const events: string[] = [];
  let sharedResourceSnapshotId: string | undefined;
  const ptcResourceSnapshotIds: string[] = [];
  const originalResourceBudgetProvider = daemonContext.resourceBudgetProvider;
  const originalSubagentAdmission = daemonContext.subagentAdmission;

  daemonContext.resourceBudgetProvider = {
    captureSnapshot(args = {}) {
      events.push('resource-snapshot');
      assert.equal(args.runState, runState);
      const snapshot = originalResourceBudgetProvider.captureSnapshot(args);
      sharedResourceSnapshotId = snapshot.snapshotId;
      return snapshot;
    },
  };
  daemonContext.subagentAdmission = {
    reserveSubagentLaunchSlots(args) {
      events.push('subagent-admission');
      return originalSubagentAdmission.reserveSubagentLaunchSlots(args);
    },
  };

  const markStarted = (name: string) => {
    startedTools.push(name);
    if (startedTools.length === 5) {
      allToolsStarted.resolve();
    }
  };

  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'ptc_window_read_before',
      description: 'read before explicit PTC cell window',
      sideEffectLevel: 'read',
      requiresApproval: false,
      async executeParsed() {
        markStarted('read-before');
        await releaseSharedWindow.promise;
        return { ok: true, output: 'read before complete' };
      },
    }),
  );
  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'ptc_window_subagent',
      description: 'subagent launch inside explicit PTC cell window',
      sideEffectLevel: 'none',
      parallelBatchKind: 'subagent_launch',
      requiresApproval: false,
      async executeParsed() {
        markStarted('subagent');
        await releaseSharedWindow.promise;
        return {
          ok: true,
          output: JSON.stringify({ ok: true, childRunId: 'child-ptc-window' }),
        };
      },
    }),
  );
  for (const name of ['ptc_window_cell_one', 'ptc_window_cell_two']) {
    registerOnce(
      daemonContext,
      makeTestTool({
        name,
        description: 'explicit PTC cell shared-window test tool',
        sideEffectLevel: 'none',
        parallelBatchKind: 'ptc_cell',
        requiresApproval: false,
        async executeParsed(_args, ctx) {
          ptcResourceSnapshotIds.push(
            ctx.resourceSnapshotRef?.snapshotId ?? '',
          );
          markStarted(name);
          await releaseSharedWindow.promise;
          return { ok: true, output: `${name} complete` };
        },
      }),
    );
  }
  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'ptc_window_read_after',
      description: 'read after explicit PTC cell window',
      sideEffectLevel: 'read',
      requiresApproval: false,
      async executeParsed() {
        markStarted('read-after');
        await releaseSharedWindow.promise;
        return { ok: true, output: 'read after complete' };
      },
    }),
  );

  const processing = processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-ptc-window-read-before',
        callId: 'call-ptc-window-read-before',
        name: 'ptc_window_read_before',
        arguments: '{}',
      },
      {
        id: 'fc-ptc-window-subagent',
        callId: 'call-ptc-window-subagent',
        name: 'ptc_window_subagent',
        arguments: '{"task":"inspect PTC window","subagent_type":"worker"}',
      },
      {
        id: 'fc-ptc-window-cell-one',
        callId: 'call-ptc-window-cell-one',
        name: 'ptc_window_cell_one',
        arguments: '{}',
      },
      {
        id: 'fc-ptc-window-cell-two',
        callId: 'call-ptc-window-cell-two',
        name: 'ptc_window_cell_two',
        arguments: '{}',
      },
      {
        id: 'fc-ptc-window-read-after',
        callId: 'call-ptc-window-read-after',
        name: 'ptc_window_read_after',
        arguments: '{}',
      },
    ],
    round: 0,
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId: 'run-ptc-cell-window',
      approvalContext: makeApprovalContext({
        sessionId: 'session-ptc-cell-window',
      }),
      emit: () => {},
      runState,
    }),
  });

  await allToolsStarted.promise;
  assert.deepEqual(events.slice(0, 2), [
    'resource-snapshot',
    'subagent-admission',
  ]);
  assert.deepEqual([...startedTools].sort(), [
    'ptc_window_cell_one',
    'ptc_window_cell_two',
    'read-after',
    'read-before',
    'subagent',
  ]);
  assert.equal(typeof sharedResourceSnapshotId, 'string');
  assert.deepEqual(
    ptcResourceSnapshotIds.sort(),
    [sharedResourceSnapshotId, sharedResourceSnapshotId].sort(),
  );

  releaseSharedWindow.resolve();
  const result = await processing;
  assert.deepEqual(result, { ok: true, value: undefined });
  assert.equal(history.length, 5);

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => entry.role),
    [
      'tool_call',
      'tool_call',
      'tool_call',
      'tool_call',
      'tool_call',
      'tool_result',
      'tool_result',
      'tool_result',
      'tool_result',
      'tool_result',
    ],
  );
});

void test('processFunctionCalls passes shared resource snapshot refs into public exec placement', async () => {
  const threadId = testThreadId(162);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-public-exec-resource-window-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-public-exec-resource-window',
    runContext,
  });
  const history: HistoryItem[] = [];
  const releaseSharedWindow = createDeferred<void>();
  const allToolsStarted = createDeferred<void>();
  const startedTools: string[] = [];
  const events: string[] = [];
  let sharedResourceSnapshotId: string | undefined;
  let observedExecResourceSnapshotId: string | undefined;
  const originalResourceBudgetProvider = daemonContext.resourceBudgetProvider;
  const originalSubagentAdmission = daemonContext.subagentAdmission;

  daemonContext.resourceBudgetProvider = {
    captureSnapshot(args = {}) {
      events.push('resource-snapshot');
      assert.equal(args.runState, runState);
      const snapshot = originalResourceBudgetProvider.captureSnapshot(args);
      sharedResourceSnapshotId = snapshot.snapshotId;
      return snapshot;
    },
  };
  daemonContext.subagentAdmission = {
    reserveSubagentLaunchSlots(args) {
      events.push('subagent-admission');
      return originalSubagentAdmission.reserveSubagentLaunchSlots(args);
    },
  };
  daemonContext.ptcExecuteCode = {
    async executeCode(args) {
      observedExecResourceSnapshotId =
        args.placementResourceSnapshotRef?.snapshotId;
      startedTools.push('exec');
      if (startedTools.length === 2) {
        allToolsStarted.resolve();
      }
      await releaseSharedWindow.promise;
      return {
        ok: true,
        value: {
          ok: true,
          capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
          policyId: PTC_EXECUTE_CODE_POLICY_ID,
          labPolicyId: 'ptc_lab_local_docker_batch_command_v1',
          profile: 'lab',
          executionClass: 'lab_execute_code',
          executionSurface: 'node_via_lab_batch_command',
          exitCode: 0,
          stdout: 'exec complete\n',
          stderr: '',
          effectiveTimeoutMs: 60_000,
          durationMs: 1,
          toolCallbacks: {
            enabled: false,
            observed: 0,
          },
          sessionLifecycle: {
            mode: 'runtime_owned_reusable',
            retainedAfterExecution: true,
          },
          callbackHelp: {
            protocolVersion: 'ptc_execute_code_sdk_v1',
            helpAvailable: true,
            callbackToolCount: 0,
          },
        },
      };
    },
    async waitForCell() {
      assert.fail('public exec resource snapshot test must not call wait');
    },
    async closeAll() {
      return { ok: true };
    },
  };

  registerOnce(
    daemonContext,
    makeTestTool({
      name: 'public_exec_resource_subagent',
      description: 'subagent launch inside public exec shared window',
      sideEffectLevel: 'none',
      parallelBatchKind: 'subagent_launch',
      requiresApproval: false,
      async executeParsed() {
        startedTools.push('subagent');
        if (startedTools.length === 2) {
          allToolsStarted.resolve();
        }
        await releaseSharedWindow.promise;
        return {
          ok: true,
          output: JSON.stringify({
            ok: true,
            childRunId: 'child-public-exec-resource-window',
          }),
        };
      },
    }),
  );

  const processing = processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-public-exec-resource',
        callId: 'call-public-exec-resource',
        name: PTC_EXECUTE_CODE_TOOL_NAME,
        arguments: '{"code":"console.log(1)"}',
      },
      {
        id: 'fc-public-exec-resource-subagent',
        callId: 'call-public-exec-resource-subagent',
        name: 'public_exec_resource_subagent',
        arguments: '{"task":"inspect public exec resource window"}',
      },
    ],
    round: 0,
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      runContext,
      runId: 'run-public-exec-resource-window',
      approvalContext: makeApprovalContext({
        sessionId: 'session-public-exec-resource-window',
      }),
      emit: () => {},
      runState,
    }),
  });

  await allToolsStarted.promise;
  assert.deepEqual(events.slice(0, 2), [
    'resource-snapshot',
    'subagent-admission',
  ]);
  assert.equal(
    events.filter((event) => event === 'resource-snapshot').length,
    1,
  );
  assert.deepEqual([...startedTools].sort(), ['exec', 'subagent']);
  assert.equal(typeof sharedResourceSnapshotId, 'string');
  assert.equal(observedExecResourceSnapshotId, sharedResourceSnapshotId);

  releaseSharedWindow.resolve();
  const result = await processing;
  assert.deepEqual(result, { ok: true, value: undefined });
  assert.equal(history.length, 2);

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => entry.role),
    ['tool_call', 'tool_call', 'tool_result', 'tool_result'],
  );
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
