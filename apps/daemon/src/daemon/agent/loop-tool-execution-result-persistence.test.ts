import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile as readFsFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HistoryItem } from '../llm/index.js';
import { buildHistoryFromTranscript } from './history/build-history-from-transcript.js';
import { recordToolCall, recordToolResult } from './loop-tool-support.js';
import { processFunctionCalls } from './loop-tool-execution.js';
import type { ToolResultObservation } from './observer/agent-loop-observer.js';
import { createDaemonContext } from '../context.js';
import { readTranscriptEntries } from '../sessions/transcript-log.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import { makeRunContext } from '../../test-support/run-context.js';
import { testThreadId } from '../../test-support/thread-id.js';
import {
  makeExecutionRuntime,
  makeTestTool,
  registerOnce,
} from '../../test-support/loop-tool-execution-test-support.js';

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
        computerSessionId: 'session-invalid',
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

  const snapshotPath = join(
    workspaceRoot,
    '.geulbat',
    'tool-outputs',
    threadId,
    runId,
    `${callId}.json`,
  );
  const history: HistoryItem[] = [];
  const events: string[] = [];
  let snapshotExistedWhenToolResultWasEmitted = false;
  const observations: ToolResultObservation[] = [];

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
        computerSessionId: 'session-search-offload',
      }),
      emit: (type) => {
        events.push(type);
        if (type === 'tool_result') {
          snapshotExistedWhenToolResultWasEmitted = existsSync(snapshotPath);
        }
      },
    }),
    observeToolResult(observation) {
      observations.push(observation);
    },
  });

  assert.deepEqual(result, { ok: true, value: undefined });
  assert.deepEqual(events, ['tool_call', 'tool_result']);
  assert.equal(snapshotExistedWhenToolResultWasEmitted, true);
  assert.equal(observations.length, 1);
  assert.deepEqual(observations[0], {
    schemaVersion: 1,
    runId,
    threadId,
    callId,
    toolName: 'search_files',
    outcome: 'success',
    elapsedMs: observations[0]?.elapsedMs,
    fullOutputBytes: observations[0]?.fullOutputBytes,
    modelVisibleBytes: observations[0]?.modelVisibleBytes,
    parseQuality: 'structured_json',
    projection: 'summary_ref',
    exactDurableRecovery: true,
  });
  assert.equal(typeof observations[0]?.elapsedMs, 'number');
  assert.ok((observations[0]?.fullOutputBytes ?? 0) > 40 * 1024);
  assert.ok(
    (observations[0]?.modelVisibleBytes ?? Number.POSITIVE_INFINITY) <
      (observations[0]?.fullOutputBytes ?? 0),
  );
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
  const replayedHistory = buildHistoryFromTranscript(transcript);
  const replayedResult = replayedHistory.find(
    (item) => item.kind === 'function_call_output' && item.callId === callId,
  );
  assert.equal(replayedResult?.kind, 'function_call_output');
  if (replayedResult?.kind === 'function_call_output') {
    assert.equal(replayedResult.output, history[0].output);
  }

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
        computerSessionId: 'session-read-output-first',
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
        computerSessionId: 'session-read-output-tail',
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

void test('overlapping broad read_file pages keep exact snapshots while reducing model-visible bytes', async () => {
  const threadId = testThreadId(81);
  const runId = 'run-read-file-overlap';
  const firstCallId = 'call-read-file-overlap-first';
  const secondCallId = 'call-read-file-overlap-second';
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-read-file-overlap-'),
  );
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-read-file-overlap-files-'),
  );
  const lines = Array.from(
    { length: 200 },
    (_, index) =>
      `LINE_${String(index).padStart(3, '0')}_${'한글'.repeat(200)}`,
  );
  await writeFile(
    join(computerFileRoot, 'overlap.txt'),
    `${lines.join('\n')}\n`,
    'utf8',
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
    workingDirectory: computerFileRoot,
  });
  const history: HistoryItem[] = [];
  const observations: ToolResultObservation[] = [];

  const result = await processFunctionCalls({
    functionCalls: [
      {
        id: 'fc-read-file-overlap-first',
        callId: firstCallId,
        name: 'read_file',
        arguments: JSON.stringify({
          path: 'overlap.txt',
          offset: 0,
          limit: 100,
        }),
      },
      {
        id: 'fc-read-file-overlap-second',
        callId: secondCallId,
        name: 'read_file',
        arguments: JSON.stringify({
          path: 'overlap.txt',
          offset: 50,
          limit: 100,
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
        computerSessionId: 'session-read-file-overlap',
      }),
      emit: () => {},
    }),
    observeToolResult(observation) {
      observations.push(observation);
    },
  });

  assert.deepEqual(result, { ok: true, value: undefined });
  assert.equal(history.length, 2);
  assert.equal(observations.length, 2);
  assert.equal(
    observations.every(
      (observation) =>
        observation.projection === 'summary_ref' &&
        observation.exactDurableRecovery,
    ),
    true,
  );
  const fullOutputBytes = observations.reduce(
    (sum, observation) => sum + observation.fullOutputBytes,
    0,
  );
  const modelVisibleBytes = observations.reduce(
    (sum, observation) => sum + observation.modelVisibleBytes,
    0,
  );
  assert.ok(fullOutputBytes > 200_000);
  assert.ok(modelVisibleBytes < fullOutputBytes / 10);

  const outputs = new Map(
    history.map((item) => {
      assert.equal(item.kind, 'function_call_output');
      if (item.kind !== 'function_call_output') {
        throw new Error('expected read_file function_call_output history item');
      }
      return [
        item.callId,
        JSON.parse(item.output) as {
          content?: unknown;
          offloaded?: boolean;
          outputRef?: string;
          startLine?: number;
          endLine?: number;
          nextOffset?: number;
          versionToken?: string;
        },
      ] as const;
    }),
  );
  const firstOutput = outputs.get(firstCallId);
  const secondOutput = outputs.get(secondCallId);
  assert.ok(firstOutput);
  assert.ok(secondOutput);
  assert.equal(firstOutput.offloaded, true);
  assert.equal(secondOutput.offloaded, true);
  assert.equal(Object.hasOwn(firstOutput, 'content'), false);
  assert.equal(Object.hasOwn(secondOutput, 'content'), false);
  assert.equal(firstOutput.startLine, 1);
  assert.equal(firstOutput.endLine, 100);
  assert.equal(firstOutput.nextOffset, 100);
  assert.equal(secondOutput.startLine, 51);
  assert.equal(secondOutput.endLine, 150);
  assert.equal(secondOutput.nextOffset, 150);
  assert.equal(secondOutput.versionToken, firstOutput.versionToken);
  assert.notEqual(secondOutput.outputRef, firstOutput.outputRef);

  for (const [callId, expectedFirstLine, expectedLastLine] of [
    [firstCallId, lines[0], lines[99]],
    [secondCallId, lines[50], lines[149]],
  ] as const) {
    const snapshot = JSON.parse(
      await readFsFile(
        join(
          workspaceRoot,
          '.geulbat',
          'tool-outputs',
          threadId,
          runId,
          `${callId}.json`,
        ),
        'utf8',
      ),
    ) as { output: string };
    const exactPage = JSON.parse(snapshot.output) as { content: string };
    const exactLines = exactPage.content.trimEnd().split('\n');
    assert.equal(exactLines[0], expectedFirstLine);
    assert.equal(exactLines.at(-1), expectedLastLine);
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
        computerSessionId: 'session-write-signal',
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
        computerSessionId: 'session-long-display-text',
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
      diagnostics: {
        phase: 'content_scan',
        reasonCode: 'ripgrep_exit_nonzero',
        retryHint: 'Correct the search pattern, then retry.',
      },
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
    diagnostics: {
      phase: 'content_scan',
      reasonCode: 'ripgrep_exit_nonzero',
      retryHint: 'Correct the search pattern, then retry.',
    },
  });

  const liveOutput =
    history[0]?.kind === 'function_call_output' ? history[0].output : undefined;
  assert.equal(
    liveOutput,
    JSON.stringify({
      ok: false,
      errorCode: 'execution_failed',
      error: 'structured failure',
      diagnostics: {
        phase: 'content_scan',
        reasonCode: 'ripgrep_exit_nonzero',
        retryHint: 'Correct the search pattern, then retry.',
      },
      details: rawFailure,
    }),
  );
  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  const storedResult = JSON.parse(transcript[0]?.content ?? '{}') as {
    output?: unknown;
  };
  assert.equal(storedResult.output, liveOutput);
});

void test('large failed tool_result stores exact diagnostics before one replay-stable model projection', async () => {
  const threadId = testThreadId(305);
  const runId = 'run-large-structured-failure';
  const callId = 'call-large-structured-failure';
  const rawFailure = JSON.stringify({
    status: 'spawn_error',
    stdout: '',
    stderr: 'exact structured failure detail\n'.repeat(2_000),
  });
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-large-structured-failure-'),
  );
  const runContext = makeRunContext({ threadId, stateRoot });
  const snapshotPath = join(
    stateRoot,
    '.geulbat',
    'tool-outputs',
    threadId,
    runId,
    `${callId}.json`,
  );
  const functionCall = {
    id: 'fc-large-structured-failure',
    callId,
    name: 'exec_command',
    arguments: JSON.stringify({ cmd: 'missing-command' }),
  };
  const history: HistoryItem[] = [];
  let snapshotExistedWhenToolResultWasEmitted = false;
  const emit = (type: string): void => {
    if (type === 'tool_result') {
      snapshotExistedWhenToolResultWasEmitted = existsSync(snapshotPath);
    }
  };

  await recordToolCall({
    functionCall,
    round: 0,
    toolArgs: { cmd: 'missing-command' },
    runContext,
    emit,
  });
  await recordToolResult({
    functionCall,
    round: 0,
    toolResult: {
      ok: false,
      output: rawFailure,
      errorCode: 'execution_failed',
      error: 'command could not be started',
      diagnostics: {
        phase: 'command_start',
        reasonCode: 'runtime_closed',
        retryHint: 'Restart the command runtime, then retry.',
      },
    },
    resultProjection: {
      exactDurableRecovery: true,
      modelProjection: 'runtime_summary',
      snapshotFailure: 'inline',
    },
    computerFilesMayHaveChanged: false,
    runContext,
    runId,
    history,
    emit,
  });

  assert.equal(snapshotExistedWhenToolResultWasEmitted, true);
  assert.equal(history[0]?.kind, 'function_call_output');
  if (history[0]?.kind !== 'function_call_output') {
    throw new Error('expected function_call_output');
  }
  const failureEnvelope = JSON.parse(history[0].output) as {
    ok?: boolean;
    errorCode?: string;
    error?: string;
    diagnostics?: {
      phase?: string;
      reasonCode?: string;
      retryHint?: string;
    };
    details?: {
      ok?: boolean;
      offloaded?: boolean;
      outputRef?: string;
      fullOutputBytes?: number;
      recoveryTool?: string;
    };
  };
  assert.equal(failureEnvelope.ok, false);
  assert.equal(failureEnvelope.errorCode, 'execution_failed');
  assert.equal(failureEnvelope.error, 'command could not be started');
  assert.deepEqual(failureEnvelope.diagnostics, {
    phase: 'command_start',
    reasonCode: 'runtime_closed',
    retryHint: 'Restart the command runtime, then retry.',
  });
  assert.equal(failureEnvelope.details?.ok, false);
  assert.equal(failureEnvelope.details?.offloaded, true);
  assert.equal(
    failureEnvelope.details?.outputRef,
    `tool-output:${threadId}/${runId}/${callId}`,
  );
  assert.equal(
    failureEnvelope.details?.fullOutputBytes,
    Buffer.byteLength(rawFailure, 'utf8'),
  );
  assert.equal(failureEnvelope.details?.recoveryTool, 'read_tool_output');
  assert.doesNotMatch(history[0].output, /exact structured failure detail/);

  const snapshot = JSON.parse(await readFsFile(snapshotPath, 'utf8')) as {
    output?: string;
  };
  assert.equal(snapshot.output, rawFailure);

  const transcript = await readTranscriptEntries(stateRoot, threadId);
  const persistedResult = transcript.find(
    (entry) => entry.role === 'tool_result',
  );
  assert.ok(persistedResult);
  const persistedOutput = JSON.parse(persistedResult.content) as {
    output?: string;
  };
  assert.equal(persistedOutput.output, history[0].output);
  const replayedHistory = buildHistoryFromTranscript(transcript);
  const replayedResult = replayedHistory.find(
    (item) => item.kind === 'function_call_output' && item.callId === callId,
  );
  assert.equal(replayedResult?.kind, 'function_call_output');
  if (replayedResult?.kind === 'function_call_output') {
    assert.equal(replayedResult.output, history[0].output);
  }
});
