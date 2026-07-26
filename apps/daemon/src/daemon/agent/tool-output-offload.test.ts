import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { FunctionCall } from '../llm/index.js';
import { createRunContext } from '../run-context.js';
import {
  buildToolOutputRef,
  buildToolOutputSnapshot,
  readToolOutputSnapshot,
  writeToolOutputSnapshot,
} from '../files/tool-output-store.js';
import { buildHostCommandOutputRef } from '../host-command-output-store.js';
import { testThreadId } from '../../test-support/thread-id.js';
import { createBuiltinToolRegistryStore } from '../tools/builtin/catalog.js';
import {
  PTC_EXECUTE_CODE_CELL_TERMINAL_RESULT_RUN_ID,
  PTC_EXECUTE_CODE_POLICY_ID,
  PTC_EXECUTE_CODE_TOOL_NAME,
} from '../ptc/runtime/execute-code/execute-code-runtime-contract.js';
import {
  createToolOutputProjectionRound,
  maybeOffloadToolResult,
  resolveToolOutputProjectionPolicyFromEnv,
} from './tool-output-offload.js';

const DEFAULT_PROJECTION_POLICY = resolveToolOutputProjectionPolicyFromEnv({});
const FORCE_OFFLOAD_POLICY = { inlineMaxBytes: 1 };
const builtinToolRegistry = createBuiltinToolRegistryStore();

void test('resolveToolOutputProjectionPolicyFromEnv owns the documented inline byte budget', () => {
  assert.deepEqual(DEFAULT_PROJECTION_POLICY, {
    inlineMaxBytes: 40 * 1024,
  });
  assert.deepEqual(
    resolveToolOutputProjectionPolicyFromEnv({
      GEULBAT_TOOL_OUTPUT_INLINE_MAX_BYTES: ' 8192 ',
    }),
    { inlineMaxBytes: 8192 },
  );
  assert.throws(
    () =>
      resolveToolOutputProjectionPolicyFromEnv({
        GEULBAT_TOOL_OUTPUT_INLINE_MAX_BYTES: '',
      }),
    /invalid GEULBAT_TOOL_OUTPUT_INLINE_MAX_BYTES: empty/,
  );
  assert.throws(
    () =>
      resolveToolOutputProjectionPolicyFromEnv({
        GEULBAT_TOOL_OUTPUT_INLINE_MAX_BYTES: '1.5',
      }),
    /expected positive integer/,
  );
  assert.throws(
    () =>
      resolveToolOutputProjectionPolicyFromEnv({
        GEULBAT_TOOL_OUTPUT_INLINE_MAX_BYTES: '0',
      }),
    /expected positive integer/,
  );
});

void test('maybeOffloadToolResult keeps a small same-round search_files result inline without creating a snapshot', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-state-'));
  const threadId = testThreadId(91);
  const callId = 'call-small-search-output';
  const runId = 'run-small-search-output';
  const output = JSON.stringify({
    root: 'computer',
    path: 'Users/sample/Downloads',
    query: 'small',
    total: 1,
    results: [{ path: 'src/app.ts', line: 1, text: 'small match' }],
  });

  const result = await maybeOffloadToolResult({
    ...projectedCall(searchFilesCall(callId)),
    runContext: createRunContext({
      threadId,
      stateRoot,
    }),
    runId,
    projectionPolicy: DEFAULT_PROJECTION_POLICY,
    projectionRound: createToolOutputProjectionRound({
      availableModelVisibleBytes: 100_000,
      resultCount: 1,
    }),
    measureModelVisibleResultBytes: measureResultOutputBytes,
    toolResult: { ok: true, output },
  });

  assert.deepEqual(result, { ok: true, output });
  const snapshot = await readToolOutputSnapshot({
    stateRoot,
    threadId,
    outputRef: buildToolOutputRef({ threadId, runId, callId }),
  });
  assert.deepEqual(snapshot, {
    ok: false,
    errorCode: 'not_found',
    message: 'tool output snapshot was not found.',
  });
});

void test('same-round projection budgets several individually small results before first visibility', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-round-budget-'));
  const threadId = testThreadId(191);
  const runId = 'run-round-budget';
  const outputs = [
    JSON.stringify({ result: 'a'.repeat(2_000) }),
    JSON.stringify({ result: 'b'.repeat(2_000) }),
    JSON.stringify({ result: 'c'.repeat(2_000) }),
  ];
  const projectionRound = createToolOutputProjectionRound({
    availableModelVisibleBytes: 1_800,
    resultCount: outputs.length,
  });

  const results = [];
  for (const [index, output] of outputs.entries()) {
    results.push(
      await maybeOffloadToolResult({
        ...projectedCall(searchFilesCall(`call-round-budget-${index}`)),
        runContext: createRunContext({ threadId, stateRoot }),
        runId,
        projectionPolicy: DEFAULT_PROJECTION_POLICY,
        projectionRound,
        measureModelVisibleResultBytes: measureResultOutputBytes,
        toolResult: { ok: true, output },
      }),
    );
  }

  for (const [index, result] of results.entries()) {
    assert.equal(result.ok, true);
    const projected = JSON.parse(result.output);
    assert.equal(projected.offloaded, true);
    const snapshot = await readToolOutputSnapshot({
      stateRoot,
      threadId,
      outputRef: projected.outputRef,
    });
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.value.output, outputs[index]);
  }
});

void test('same-round projection records an exact duplicate through its own durable ref', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-round-duplicate-'));
  const threadId = testThreadId(192);
  const runId = 'run-round-duplicate';
  const output = JSON.stringify({ result: 'same'.repeat(500) });
  const projectionRound = createToolOutputProjectionRound({
    availableModelVisibleBytes: 1_000,
    resultCount: 2,
  });
  const firstCallId = 'call-round-duplicate-first';
  const secondCallId = 'call-round-duplicate-second';

  const first = await maybeOffloadToolResult({
    ...projectedCall(searchFilesCall(firstCallId)),
    runContext: createRunContext({ threadId, stateRoot }),
    runId,
    projectionPolicy: DEFAULT_PROJECTION_POLICY,
    projectionRound,
    measureModelVisibleResultBytes: measureResultOutputBytes,
    toolResult: { ok: true, output },
  });
  const second = await maybeOffloadToolResult({
    ...projectedCall(searchFilesCall(secondCallId)),
    runContext: createRunContext({ threadId, stateRoot }),
    runId,
    projectionPolicy: DEFAULT_PROJECTION_POLICY,
    projectionRound,
    measureModelVisibleResultBytes: measureResultOutputBytes,
    toolResult: { ok: true, output },
  });

  const firstProjected = JSON.parse(first.output);
  assert.equal(firstProjected.offloaded, true);
  const duplicate = JSON.parse(second.output);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.duplicateOfCallId, firstCallId);
  assert.equal(duplicate.duplicateOfOutputRef, firstProjected.outputRef);
  assert.notEqual(duplicate.outputRef, firstProjected.outputRef);
  for (const outputRef of [
    duplicate.duplicateOfOutputRef,
    duplicate.outputRef,
  ]) {
    const snapshot = await readToolOutputSnapshot({
      stateRoot,
      threadId,
      outputRef,
    });
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.value.output, output);
  }
});

void test('same-round projection preserves mixed success and failure outcomes', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-round-mixed-'));
  const threadId = testThreadId(193);
  const runId = 'run-round-mixed';
  const projectionRound = createToolOutputProjectionRound({
    availableModelVisibleBytes: 800,
    resultCount: 2,
  });
  const success = await maybeOffloadToolResult({
    ...projectedCall(searchFilesCall('call-round-mixed-success')),
    runContext: createRunContext({ threadId, stateRoot }),
    runId,
    projectionRound,
    measureModelVisibleResultBytes: measureResultOutputBytes,
    toolResult: {
      ok: true,
      output: JSON.stringify({ result: 'success'.repeat(300) }),
    },
  });
  const failure = await maybeOffloadToolResult({
    ...projectedCall(searchFilesCall('call-round-mixed-failure')),
    runContext: createRunContext({ threadId, stateRoot }),
    runId,
    projectionRound,
    measureModelVisibleResultBytes: measureResultOutputBytes,
    toolResult: {
      ok: false,
      output: JSON.stringify({ diagnostic: 'failure'.repeat(300) }),
      errorCode: 'execution_failed',
      error: 'search failed',
    },
  });

  assert.equal(success.ok, true);
  assert.equal(JSON.parse(success.output).offloaded, true);
  assert.equal(failure.ok, false);
  assert.equal(failure.errorCode, 'execution_failed');
  assert.equal(failure.error, 'search failed');
  assert.equal(JSON.parse(failure.output).offloaded, true);
});

void test('maybeOffloadToolResult keeps a small read_file page inline without a snapshot', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const threadId = testThreadId(92);
  const callId = 'call-read-file-inline';
  const runId = 'run-read-file-inline';
  const output = JSON.stringify({
    path: 'notes.txt',
    content: 'small page\n',
    versionToken: 'sha256:small-page',
    totalLines: 1,
    pageLimit: 20,
    startLine: 1,
    endLine: 1,
    hasMore: false,
    nextOffset: null,
    root: 'computer',
  });

  const result = await maybeOffloadToolResult({
    ...projectedCall(readFileCall(callId)),
    runContext: createRunContext({
      threadId,
      stateRoot: workspaceRoot,
    }),
    runId,
    projectionPolicy: DEFAULT_PROJECTION_POLICY,
    toolResult: { ok: true, output },
  });

  assert.deepEqual(result, { ok: true, output });
  const snapshot = await readToolOutputSnapshot({
    stateRoot: workspaceRoot,
    threadId,
    outputRef: buildToolOutputRef({ threadId, runId, callId }),
  });
  assert.equal(snapshot.ok, false);
});

void test('maybeOffloadToolResult follows declared projection capability instead of tool-name membership', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const threadId = testThreadId(192);
  const unprojectedOutput = 'search output without registry capability';
  const unprojected = await maybeOffloadToolResult({
    functionCall: searchFilesCall('call-search-without-capability'),
    runContext: createRunContext({ threadId, stateRoot: workspaceRoot }),
    runId: 'run-capability-routing',
    projectionPolicy: FORCE_OFFLOAD_POLICY,
    toolResult: { ok: true, output: unprojectedOutput },
  });
  assert.deepEqual(unprojected, { ok: true, output: unprojectedOutput });

  const projectedOutput = JSON.stringify({ status: 'completed', value: 'ok' });
  const projected = await maybeOffloadToolResult({
    functionCall: {
      callId: 'call-plugin-capability',
      name: 'plugin_capability_tool',
      arguments: '{}',
    },
    resultProjection: {
      exactDurableRecovery: true,
      modelProjection: 'runtime_summary',
      snapshotFailure: 'inline',
    },
    runContext: createRunContext({ threadId, stateRoot: workspaceRoot }),
    runId: 'run-capability-routing',
    projectionPolicy: FORCE_OFFLOAD_POLICY,
    toolResult: { ok: true, output: projectedOutput },
  });
  assert.equal(JSON.parse(projected.output).offloaded, true);
  assert.equal(JSON.parse(projected.output).tool, 'plugin_capability_tool');
});

void test('maybeOffloadToolResult applies the inline limit to UTF-8 bytes inclusively', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const threadId = testThreadId(104);
  const output = '한글';
  const outputBytes = Buffer.byteLength(output, 'utf8');

  const inlineResult = await maybeOffloadToolResult({
    ...projectedCall(searchFilesCall('call-utf8-inline-boundary')),
    runContext: createRunContext({ threadId, stateRoot }),
    runId: 'run-utf8-inline-boundary',
    projectionPolicy: { inlineMaxBytes: outputBytes },
    toolResult: { ok: true, output },
  });
  assert.deepEqual(inlineResult, { ok: true, output });

  const offloadedResult = await maybeOffloadToolResult({
    ...projectedCall(searchFilesCall('call-utf8-over-boundary')),
    runContext: createRunContext({ threadId, stateRoot }),
    runId: 'run-utf8-over-boundary',
    projectionPolicy: { inlineMaxBytes: outputBytes - 1 },
    toolResult: { ok: true, output },
  });
  assert.equal(offloadedResult.ok, true);
  const projected = JSON.parse(offloadedResult.output);
  assert.equal(projected.offloaded, true);
  assert.equal(projected.fullOutputBytes, outputBytes);
});

void test('maybeOffloadToolResult keeps a small exec result inline', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const output = JSON.stringify({
    kind: 'ptc_execute_code_cell_running',
    status: 'running',
    cellId: 'cell-exec-inline',
    stdout: 'short output\n',
    stderr: '',
  });

  const result = await maybeOffloadToolResult({
    ...projectedCall(execCall('call-exec-inline')),
    runContext: createRunContext({
      threadId: testThreadId(105),
      stateRoot,
    }),
    runId: 'run-exec-inline',
    projectionPolicy: DEFAULT_PROJECTION_POLICY,
    toolResult: { ok: true, output },
  });

  assert.deepEqual(result, { ok: true, output });
});

void test('maybeOffloadToolResult returns a cache-stable exec ref above the configured inline budget', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const threadId = testThreadId(98);
  const output = JSON.stringify({
    kind: 'ptc_execute_code_cell_running',
    status: 'running',
    cellId: 'cell-exec-recoverable',
    stdout: 'exact stdout stays in the durable snapshot\n',
    stderr: '',
  });

  const result = await maybeOffloadToolResult({
    ...projectedCall(execCall('call-exec-recoverable-output')),
    runContext: createRunContext({
      threadId,
      stateRoot: workspaceRoot,
    }),
    runId: 'run-exec-recoverable-output',
    projectionPolicy: FORCE_OFFLOAD_POLICY,
    toolResult: { ok: true, output },
  });

  assert.equal(result.ok, true);
  const stableOutput = JSON.parse(result.output);
  assert.equal(stableOutput.offloaded, true);
  assert.equal(stableOutput.tool, 'exec');
  assert.equal(stableOutput.kind, 'ptc_execute_code_cell_running');
  assert.equal(stableOutput.status, 'running');
  assert.equal(stableOutput.cellId, 'cell-exec-recoverable');
  assert.equal(stableOutput.recoveryTool, 'read_tool_output');
  assert.equal(stableOutput.fullOutputChars, output.length);
  assert.equal(Object.hasOwn(stableOutput, 'stdout'), false);
  assert.equal(Object.hasOwn(stableOutput, 'stderr'), false);

  const snapshot = await readToolOutputSnapshot({
    stateRoot: workspaceRoot,
    threadId,
    outputRef: stableOutput.outputRef,
  });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.value.toolName, 'exec');
  assert.equal(snapshot.value.output, output);
});

void test('maybeOffloadToolResult returns a cache-stable exec_command ref above the configured inline budget', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const threadId = testThreadId(102);
  const output = JSON.stringify({
    command: 'node -e "process.stdout.write(\'ok\')"',
    cwd: workspaceRoot,
    status: 'exit',
    exitCode: 0,
    stdout: 'ok',
    stderr: '',
    durationMs: 12,
    firstOutputAfterMs: 3,
    timeoutMs: 1000,
    maxOutputBytesPerStream: 8192,
    outputLimitExceeded: null,
  });

  const result = await maybeOffloadToolResult({
    ...projectedCall(execCommandCall('call-exec-command-recoverable-output')),
    runContext: createRunContext({
      threadId,
      stateRoot: workspaceRoot,
    }),
    runId: 'run-exec-command-recoverable-output',
    projectionPolicy: FORCE_OFFLOAD_POLICY,
    toolResult: { ok: true, output },
  });

  assert.equal(result.ok, true);
  const stableOutput = JSON.parse(result.output);
  assert.equal(stableOutput.offloaded, true);
  assert.equal(stableOutput.tool, 'exec_command');
  assert.equal(stableOutput.status, 'exit');
  assert.equal(stableOutput.exitCode, 0);
  assert.equal(stableOutput.durationMs, 12);
  assert.equal(stableOutput.firstOutputAfterMs, 3);
  assert.equal(stableOutput.recoveryTool, 'read_tool_output');
  assert.equal(stableOutput.fullOutputChars, output.length);
  assert.equal(Object.hasOwn(stableOutput, 'stdout'), false);
  assert.equal(Object.hasOwn(stableOutput, 'stderr'), false);

  const snapshot = await readToolOutputSnapshot({
    stateRoot: workspaceRoot,
    threadId,
    outputRef: stableOutput.outputRef,
  });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.value.toolName, 'exec_command');
  assert.equal(snapshot.value.output, output);
});

void test('maybeOffloadToolResult preserves a failed exec_command outcome while offloading its exact diagnostic body', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const threadId = testThreadId(108);
  const callId = 'call-exec-command-failure-output';
  const runId = 'run-exec-command-failure-output';
  const output = JSON.stringify({
    command: 'missing-command',
    status: 'spawn_error',
    stdout: '',
    stderr: 'exact failure diagnostic\n'.repeat(20),
  });

  const result = await maybeOffloadToolResult({
    ...projectedCall(execCommandCall(callId)),
    runContext: createRunContext({ threadId, stateRoot }),
    runId,
    projectionPolicy: FORCE_OFFLOAD_POLICY,
    toolResult: {
      ok: false,
      output,
      errorCode: 'execution_failed',
      error: 'command could not be started',
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'execution_failed');
  assert.equal(result.error, 'command could not be started');
  const projection = JSON.parse(result.output);
  assert.equal(projection.ok, false);
  assert.equal(projection.offloaded, true);
  assert.equal(projection.tool, 'exec_command');
  assert.equal(projection.status, 'spawn_error');
  assert.equal(projection.fullOutputBytes, Buffer.byteLength(output, 'utf8'));
  assert.equal(projection.fullOutputChars, output.length);
  assert.equal(projection.recoveryTool, 'read_tool_output');
  assert.equal(Object.hasOwn(projection, 'stdout'), false);
  assert.equal(Object.hasOwn(projection, 'stderr'), false);

  const snapshot = await readToolOutputSnapshot({
    stateRoot,
    threadId,
    outputRef: projection.outputRef,
  });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.value.output, output);
});

void test('maybeOffloadToolResult keeps a recoverable exec inline when its snapshot cannot be recorded', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  await writeFile(join(workspaceRoot, '.geulbat'), 'not a directory', 'utf8');
  const output = JSON.stringify({
    ok: true,
    status: 'running',
    cellId: 'cell-exec-inline-on-record-failure',
    stdout: 'stdout still reaches the model\n',
    stderr: '',
  });
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];

  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  let result: Awaited<ReturnType<typeof maybeOffloadToolResult>>;
  try {
    result = await maybeOffloadToolResult({
      ...projectedCall(execCall('call-exec-record-failure')),
      runContext: createRunContext({
        threadId: testThreadId(100),
        stateRoot: workspaceRoot,
      }),
      runId: 'run-exec-record-failure',
      projectionPolicy: FORCE_OFFLOAD_POLICY,
      toolResult: { ok: true, output },
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(result.ok, true);
  const fallback = JSON.parse(result.output);
  assert.equal(fallback.offloaded, false);
  assert.equal(fallback.tool, 'exec');
  assert.equal(fallback.status, 'running');
  assert.equal(fallback.cellId, 'cell-exec-inline-on-record-failure');
  assert.equal(fallback.stdout, 'stdout still reaches the model\n');
  assert.equal(fallback.stderr, '');
  assert.deepEqual(fallback.outputSnapshot, {
    ok: false,
    errorCode: 'snapshot_write_failed',
  });
  assert.equal(fallback.recoveryTool, null);
  assert.match(fallback.summary, /exact tool result is retained inline/);
  assert.equal(warnings.length, 1);
  assert.match(
    String(warnings[0]?.[0]),
    /failed to offload tool output snapshot/,
  );
});

void test('maybeOffloadToolResult preserves a failed recoverable result inline when its snapshot cannot be recorded', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  await writeFile(join(stateRoot, '.geulbat'), 'not a directory', 'utf8');
  const output = JSON.stringify({
    status: 'spawn_error',
    stdout: '',
    stderr: 'failure detail remains available',
  });
  const originalWarn = console.warn;

  console.warn = () => {};
  let result: Awaited<ReturnType<typeof maybeOffloadToolResult>>;
  try {
    result = await maybeOffloadToolResult({
      ...projectedCall(execCommandCall('call-failed-exec-record-failure')),
      runContext: createRunContext({
        threadId: testThreadId(109),
        stateRoot,
      }),
      runId: 'run-failed-exec-record-failure',
      projectionPolicy: FORCE_OFFLOAD_POLICY,
      toolResult: {
        ok: false,
        output,
        errorCode: 'execution_failed',
        error: 'command could not be started',
      },
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'execution_failed');
  assert.equal(result.error, 'command could not be started');
  const fallback = JSON.parse(result.output);
  assert.equal(fallback.offloaded, false);
  assert.equal(fallback.tool, 'exec_command');
  assert.equal(fallback.status, 'spawn_error');
  assert.equal(fallback.stderr, 'failure detail remains available');
  assert.deepEqual(fallback.outputSnapshot, {
    ok: false,
    errorCode: 'snapshot_write_failed',
  });
  assert.equal(fallback.recoveryTool, null);
});

void test('maybeOffloadToolResult returns a cache-stable wait ref above the configured inline budget', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const threadId = testThreadId(99);
  const output = JSON.stringify({
    kind: 'ptc_execute_code_cell_wait',
    status: 'completed',
    cellId: 'cell-wait-recoverable',
    exitCode: 0,
    stdout: 'terminal stdout stays visible\n',
    stderr: 'terminal stderr stays visible\n',
  });

  const result = await maybeOffloadToolResult({
    ...projectedCall(waitCall('call-wait-recoverable-output')),
    runContext: createRunContext({
      threadId,
      stateRoot: workspaceRoot,
    }),
    runId: 'run-wait-recoverable-output',
    projectionPolicy: FORCE_OFFLOAD_POLICY,
    toolResult: { ok: true, output },
  });

  assert.equal(result.ok, true);
  const stableOutput = JSON.parse(result.output);
  assert.equal(stableOutput.offloaded, true);
  assert.equal(stableOutput.tool, 'wait');
  assert.equal(stableOutput.kind, 'ptc_execute_code_cell_wait');
  assert.equal(stableOutput.status, 'completed');
  assert.equal(stableOutput.cellId, 'cell-wait-recoverable');
  assert.equal(stableOutput.exitCode, 0);
  assert.equal(stableOutput.recoveryTool, 'read_tool_output');
  assert.equal(stableOutput.fullOutputChars, output.length);
  assert.equal(Object.hasOwn(stableOutput, 'stdout'), false);
  assert.equal(Object.hasOwn(stableOutput, 'stderr'), false);

  const snapshot = await readToolOutputSnapshot({
    stateRoot: workspaceRoot,
    threadId,
    outputRef: stableOutput.outputRef,
  });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.value.toolName, 'wait');
  assert.equal(snapshot.value.output, output);
});

void test('maybeOffloadToolResult keeps a concise agent_wait handoff inline', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const output = JSON.stringify({
    ok: true,
    completed: [
      {
        childRunId: 'run-child-completed',
        terminalState: 'completed',
        ok: true,
        result: 'concise child result',
      },
    ],
    pending: [],
    blocked: [],
  });

  const result = await maybeOffloadToolResult({
    ...projectedCall(agentWaitCall('call-agent-wait-inline')),
    runContext: createRunContext({
      threadId: testThreadId(107),
      stateRoot,
    }),
    runId: 'run-agent-wait-inline',
    projectionPolicy: DEFAULT_PROJECTION_POLICY,
    toolResult: { ok: true, output },
  });

  assert.deepEqual(result, { ok: true, output });
});

void test('maybeOffloadToolResult keeps a large agent_wait handoff recoverable without inlining child prose', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const threadId = testThreadId(106);
  const childResultMarker = 'large child evidence remains exact';
  const output = JSON.stringify({
    ok: true,
    completed: [
      {
        childRunId: 'run-child-completed',
        terminalState: 'completed',
        ok: true,
        result: `${childResultMarker}\n`.repeat(2_000),
      },
    ],
    pending: ['run-child-pending'],
    blocked: [
      {
        childRunId: 'run-child-blocked',
        blockedReason: 'approval_pending',
      },
    ],
    launches: [
      {
        childRunId: 'run-child-pending',
        childThreadId: testThreadId(107),
        launchState: 'queued',
        priorityClass: 'high',
        enqueueOrder: 1,
        createdAt: '2026-07-23T00:00:00.000Z',
        updatedAt: '2026-07-23T00:00:00.000Z',
      },
      {
        childRunId: 'run-child-starting',
        childThreadId: testThreadId(108),
        launchState: 'starting',
        priorityClass: 'normal',
        enqueueOrder: 2,
        createdAt: '2026-07-23T00:00:01.000Z',
        updatedAt: '2026-07-23T00:00:02.000Z',
      },
    ],
  });

  const result = await maybeOffloadToolResult({
    ...projectedCall(agentWaitCall('call-agent-wait-recoverable-output')),
    runContext: createRunContext({
      threadId,
      stateRoot,
    }),
    runId: 'run-agent-wait-recoverable-output',
    projectionPolicy: DEFAULT_PROJECTION_POLICY,
    toolResult: { ok: true, output },
  });

  assert.equal(result.ok, true);
  const stableOutput = JSON.parse(result.output);
  assert.equal(stableOutput.offloaded, true);
  assert.equal(stableOutput.tool, 'agent_wait');
  assert.equal(stableOutput.recoveryTool, 'read_tool_output');
  assert.equal(stableOutput.fullOutputChars, output.length);
  assert.match(stableOutput.summary, /1 completed, 1 pending, and 1 blocked/u);
  assert.match(
    stableOutput.summary,
    /2 handles, including 1 queued and 1 starting/u,
  );
  assert.doesNotMatch(result.output, new RegExp(childResultMarker, 'u'));

  const snapshot = await readToolOutputSnapshot({
    stateRoot,
    threadId,
    outputRef: stableOutput.outputRef,
  });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.value.toolName, 'agent_wait');
  assert.equal(snapshot.value.output, output);
});

void test('maybeOffloadToolResult reuses an existing durable wait ref without wrapping it', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const threadId = testThreadId(103);
  const existingOutputRef = buildToolOutputRef({
    threadId,
    runId: PTC_EXECUTE_CODE_CELL_TERMINAL_RESULT_RUN_ID,
    callId: 'ptc_cell_existing_durable_result',
  });
  const exactTerminalOutput = JSON.stringify({
    kind: 'ptc_execute_code_cell_wait',
    capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
    policyId: PTC_EXECUTE_CODE_POLICY_ID,
    executionSurface: 'node_via_lab_detached_cell',
    status: 'completed',
    cellId: 'ptc_cell_existing_durable_result',
    exitCode: 0,
    stdout: 'exact durable terminal output\n',
    stderr: '',
  });
  const existingSnapshot = buildToolOutputSnapshot({
    outputRef: existingOutputRef,
    threadId,
    runId: PTC_EXECUTE_CODE_CELL_TERMINAL_RESULT_RUN_ID,
    callId: 'ptc_cell_existing_durable_result',
    toolName: 'wait',
    output: exactTerminalOutput,
  });
  await writeToolOutputSnapshot({ stateRoot, snapshot: existingSnapshot });
  const output = JSON.stringify({
    kind: 'ptc_execute_code_cell_wait',
    capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
    policyId: PTC_EXECUTE_CODE_POLICY_ID,
    executionSurface: 'node_via_lab_detached_cell',
    status: 'completed',
    cellId: 'ptc_cell_existing_durable_result',
    exitCode: 0,
    offloaded: true,
    outputRef: existingOutputRef,
    fullOutputBytes: existingSnapshot.fullOutputBytes,
    fullOutputChars: existingSnapshot.fullOutputChars,
    recoveryTool: 'read_tool_output',
    summary: 'Exact output is already durable.',
  });

  const result = await maybeOffloadToolResult({
    ...projectedCall(waitCall('call-existing-durable-wait-output')),
    runContext: createRunContext({ threadId, stateRoot }),
    runId: 'run-that-must-not-wrap-the-existing-ref',
    toolResult: { ok: true, output },
  });

  assert.deepEqual(result, { ok: true, output });
  const retainedSnapshot = await readToolOutputSnapshot({
    stateRoot,
    threadId,
    outputRef: existingOutputRef,
  });
  assert.equal(retainedSnapshot.ok, true);
  assert.equal(retainedSnapshot.value.output, exactTerminalOutput);

  const wrapperSnapshot = await readToolOutputSnapshot({
    stateRoot,
    threadId,
    outputRef: buildToolOutputRef({
      threadId,
      runId: 'run-that-must-not-wrap-the-existing-ref',
      callId: 'call-existing-durable-wait-output',
    }),
  });
  assert.deepEqual(wrapperSnapshot, {
    ok: false,
    errorCode: 'not_found',
    message: 'tool output snapshot was not found.',
  });
});

void test('maybeOffloadToolResult reuses exec_command and write_stdin durable refs without wrapping them', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const threadId = testThreadId(104);
  const existingOutputRef = buildHostCommandOutputRef({
    threadId,
    sessionId: '00000000-0000-4000-8000-000000000104',
  });
  const cases = [
    {
      call: execCommandCall('call-existing-exec-command-output'),
      output: JSON.stringify({
        status: 'running',
        outputRef: existingOutputRef,
        stdout: null,
        stderr: null,
      }),
    },
    {
      call: writeStdinCall('call-existing-write-stdin-output'),
      output: JSON.stringify({
        snapshot: {
          status: 'exit',
          outputRef: existingOutputRef,
        },
        page: null,
      }),
    },
  ] as const;

  for (const [index, item] of cases.entries()) {
    const runId = `run-existing-command-output-${String(index)}`;
    const result = await maybeOffloadToolResult({
      ...projectedCall(item.call),
      runContext: createRunContext({ threadId, stateRoot }),
      runId,
      projectionPolicy: FORCE_OFFLOAD_POLICY,
      toolResult: { ok: true, output: item.output },
    });

    assert.deepEqual(result, { ok: true, output: item.output });
    const wrapperSnapshot = await readToolOutputSnapshot({
      stateRoot,
      threadId,
      outputRef: buildToolOutputRef({
        threadId,
        runId,
        callId: item.call.callId,
      }),
    });
    assert.deepEqual(wrapperSnapshot, {
      ok: false,
      errorCode: 'not_found',
      message: 'tool output snapshot was not found.',
    });
  }
});

void test('maybeOffloadToolResult keeps memory search inline when output recovery is not available', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const output = JSON.stringify({
    ok: true,
    total: 1,
    stale: false,
    results: [
      {
        chunkId: 'memory-hit-inline',
        path: 'docs/memory.md',
        title: 'Memory Hit',
        lineStart: 1,
        lineEnd: 2,
        excerpt: 'inline memory excerpt remains reachable',
      },
    ],
  });

  const result = await maybeOffloadToolResult({
    ...projectedCall(searchMemoryIndexCall('call-memory-inline-no-recovery')),
    runContext: createRunContext({
      threadId: testThreadId(101),
      stateRoot: workspaceRoot,
    }),
    runId: 'run-memory-inline-no-recovery',
    toolOutputRecoveryAvailable: false,
    toolResult: { ok: true, output },
  });

  assert.deepEqual(result, { ok: true, output });
  assert.match(result.output, /inline memory excerpt remains reachable/);
});

void test('maybeOffloadToolResult offloads search_files without partial preview text', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const threadId = testThreadId(93);
  const output = JSON.stringify({
    query: 'needle',
    total: 2,
    results: [
      {
        path: 'src/app.ts',
        line: 12,
        text: 'const needle = true;',
      },
      'malformed-result',
      {
        path: 123,
        line: 'not-a-line',
        text: 'fallback fields still normalize',
      },
    ],
    padding: 'x'.repeat(5000),
  });

  const result = await maybeOffloadToolResult({
    ...projectedCall(searchFilesCall('call-search-without-preview-text')),
    runContext: createRunContext({
      threadId,
      stateRoot: workspaceRoot,
    }),
    runId: 'run-search-without-preview-text',
    projectionPolicy: FORCE_OFFLOAD_POLICY,
    toolResult: { ok: true, output },
  });

  assert.equal(result.ok, true);
  const slimOutput = JSON.parse(result.output);
  assert.equal(Object.hasOwn(slimOutput, 'preview'), false);
  assert.equal(slimOutput.recoveryTool, 'read_tool_output');
  assert.deepEqual(slimOutput.previewResults, []);
  assert.equal(slimOutput.previewResultCount, 0);
  assert.equal(slimOutput.previewHasMore, true);
  assert.doesNotMatch(result.output, /const needle = true/);
  assert.doesNotMatch(result.output, /fallback fields still normalize/);

  const snapshot = await readToolOutputSnapshot({
    stateRoot: workspaceRoot,
    threadId,
    outputRef: slimOutput.outputRef,
  });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.value.output, output);
  assert.deepEqual(snapshot.value.source, { query: 'needle' });
});

void test('maybeOffloadToolResult includes a maximal complete search_files result prefix within the model-visible budget', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const threadId = testThreadId(201);
  const modelVisibleBudgetBytes = 2_048;
  const completeResults = Array.from({ length: 300 }, (_, index) => ({
    path: `src/file-${String(index).padStart(3, '0')}.ts`,
    line: index + 1,
    text: `needle-${String(index).padStart(3, '0')}-${'x'.repeat(200)}`,
  }));
  const output = JSON.stringify({
    root: 'computer',
    path: 'project',
    backend: 'ripgrep',
    query: 'needle',
    total: completeResults.length,
    truncated: false,
    results: completeResults,
  });
  assert.ok(
    Buffer.byteLength(output, 'utf8') >
      DEFAULT_PROJECTION_POLICY.inlineMaxBytes,
  );

  const result = await maybeOffloadToolResult({
    ...projectedCall(searchFilesCall('call-search-with-preview-results')),
    runContext: createRunContext({
      threadId,
      stateRoot: workspaceRoot,
    }),
    runId: 'run-search-with-preview-results',
    projectionPolicy: DEFAULT_PROJECTION_POLICY,
    projectionRound: createToolOutputProjectionRound({
      availableModelVisibleBytes: modelVisibleBudgetBytes,
      resultCount: 1,
    }),
    measureModelVisibleResultBytes: measureResultOutputBytes,
    toolResult: { ok: true, output },
  });

  assert.equal(result.ok, true);
  const slimOutput = JSON.parse(result.output);
  assert.equal(slimOutput.offloaded, true);
  assert.equal(slimOutput.tool, 'search_files');
  assert.equal(slimOutput.root, 'computer');
  assert.equal(slimOutput.path, 'project');
  assert.equal(slimOutput.total, completeResults.length);
  assert.equal(slimOutput.truncated, false);
  assert.equal(slimOutput.recoveryTool, 'read_tool_output');
  assert.ok(slimOutput.previewResultCount > 0);
  assert.ok(slimOutput.previewResultCount < completeResults.length);
  assert.equal(slimOutput.previewResultCount, slimOutput.previewResults.length);
  assert.equal(slimOutput.previewHasMore, true);
  assert.deepEqual(
    slimOutput.previewResults,
    completeResults.slice(0, slimOutput.previewResultCount),
  );
  assert.ok(
    Buffer.byteLength(result.output, 'utf8') <= modelVisibleBudgetBytes,
  );
  assert.match(
    slimOutput.summary,
    new RegExp(
      `first ${String(slimOutput.previewResultCount)} results are included`,
      'u',
    ),
  );
  const nextPreviewResult = completeResults[slimOutput.previewResultCount];
  assert.ok(nextPreviewResult);
  assert.ok(
    Buffer.byteLength(
      JSON.stringify({
        ...slimOutput,
        previewResults: [...slimOutput.previewResults, nextPreviewResult],
        previewResultCount: slimOutput.previewResultCount + 1,
      }),
      'utf8',
    ) > modelVisibleBudgetBytes,
  );

  const snapshot = await readToolOutputSnapshot({
    stateRoot: workspaceRoot,
    threadId,
    outputRef: slimOutput.outputRef,
  });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.value.toolName, 'search_files');
  assert.equal(snapshot.value.output, output);
  assert.deepEqual(snapshot.value.source, {
    root: 'computer',
    path: 'project',
    query: 'needle',
  });
});

void test('maybeOffloadToolResult keeps an oversized first search_files match out of the preview instead of clipping its text', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const threadId = testThreadId(202);
  const oversizedText = `needle-${'x'.repeat(5_000)}`;
  const output = JSON.stringify({
    root: 'computer',
    path: 'project',
    backend: 'ripgrep',
    query: 'needle',
    total: 1,
    truncated: false,
    results: [{ path: 'src/large.ts', line: 1, text: oversizedText }],
  });

  const result = await maybeOffloadToolResult({
    ...projectedCall(searchFilesCall('call-search-oversized-first-match')),
    runContext: createRunContext({
      threadId,
      stateRoot: workspaceRoot,
    }),
    runId: 'run-search-oversized-first-match',
    projectionPolicy: DEFAULT_PROJECTION_POLICY,
    projectionRound: createToolOutputProjectionRound({
      availableModelVisibleBytes: 1_024,
      resultCount: 1,
    }),
    measureModelVisibleResultBytes: measureResultOutputBytes,
    toolResult: { ok: true, output },
  });

  assert.equal(result.ok, true);
  const slimOutput = JSON.parse(result.output);
  assert.deepEqual(slimOutput.previewResults, []);
  assert.equal(slimOutput.previewResultCount, 0);
  assert.equal(slimOutput.previewHasMore, true);
  assert.doesNotMatch(result.output, /needle-x{20}/u);

  const snapshot = await readToolOutputSnapshot({
    stateRoot: workspaceRoot,
    threadId,
    outputRef: slimOutput.outputRef,
  });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.value.output, output);
});

void test('maybeOffloadToolResult offloads search_memory_index without partial preview text', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const threadId = testThreadId(95);
  const output = JSON.stringify({
    ok: true,
    generationId: 'memory-generation',
    indexGeneratedAt: '2026-06-21T00:00:00.000Z',
    sourceIndexVersionToken: 'fresh-token',
    stale: false,
    total: 52,
    truncated: false,
    results: Array.from({ length: 52 }, (_, index) => ({
      chunkId: `memory-hit-${String(index).padStart(2, '0')}`,
      path: `docs/memory-${String(index).padStart(2, '0')}.md`,
      sourceVersionToken: 'source-token',
      title: `Memory Hit ${String(index).padStart(2, '0')}`,
      lineStart: 1,
      lineEnd: 1,
      excerpt: `memory excerpt ${String(index).padStart(2, '0')}`,
    })),
  });

  const result = await maybeOffloadToolResult({
    ...projectedCall(
      searchMemoryIndexCall('call-memory-index-offload', {
        query: 'memory provenance',
      }),
    ),
    runContext: createRunContext({
      threadId,
      stateRoot: workspaceRoot,
    }),
    runId: 'run-memory-index-offload',
    projectionPolicy: FORCE_OFFLOAD_POLICY,
    toolResult: { ok: true, output },
  });

  assert.equal(result.ok, true);
  const slimOutput = JSON.parse(result.output);
  assert.equal(slimOutput.offloaded, true);
  assert.equal(slimOutput.tool, 'search_memory_index');
  assert.equal(slimOutput.total, 52);
  assert.equal(slimOutput.stale, false);
  assert.equal(Object.hasOwn(slimOutput, 'preview'), false);
  assert.doesNotMatch(result.output, /memory excerpt 51/);

  const snapshot = await readToolOutputSnapshot({
    stateRoot: workspaceRoot,
    threadId,
    outputRef: slimOutput.outputRef,
  });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.value.toolName, 'search_memory_index');
  assert.equal(snapshot.value.output, output);
  assert.deepEqual(snapshot.value.source, { query: 'memory provenance' });
  assert.match(snapshot.value.output, /memory excerpt 51/);
});

void test('maybeOffloadToolResult fails visibly when snapshot write fails', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  await writeFile(join(workspaceRoot, '.geulbat'), 'not a directory', 'utf8');
  const output = 'output that cannot be snapshotted';
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];

  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  let result: Awaited<ReturnType<typeof maybeOffloadToolResult>>;
  try {
    result = await maybeOffloadToolResult({
      ...projectedCall(searchFilesCall('call-write-failure')),
      runContext: createRunContext({
        threadId: testThreadId(94),
        stateRoot: workspaceRoot,
      }),
      runId: 'run-write-failure',
      projectionPolicy: FORCE_OFFLOAD_POLICY,
      toolResult: { ok: true, output },
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'internal');
  assert.equal(result.output, '');
  assert.match(result.error, /failed to offload tool output/i);
  assert.equal(warnings.length, 1);
  assert.match(
    String(warnings[0]?.[0]),
    /failed to offload tool output snapshot/,
  );
  assert.deepEqual(warnings[0]?.[1], {
    callId: 'call-write-failure',
    runId: 'run-write-failure',
    threadId: testThreadId(94),
    toolName: 'search_files',
  });
});

void test('maybeOffloadToolResult offloads a large fetch_url result and preserves exact snapshot', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const threadId = testThreadId(96);
  const output = JSON.stringify({
    ok: true,
    url: 'https://example.com/',
    finalUrl: 'https://example.com/final',
    status: 200,
    contentType: 'text/html; charset=utf-8',
    title: 'Example',
    content: 'x'.repeat(DEFAULT_PROJECTION_POLICY.inlineMaxBytes + 1),
    untrusted: true,
  });
  assert.ok(
    Buffer.byteLength(output, 'utf8') >
      DEFAULT_PROJECTION_POLICY.inlineMaxBytes,
  );

  const result = await maybeOffloadToolResult({
    ...projectedCall(fetchUrlCall('call-fetch-url-offload')),
    runContext: createRunContext({
      threadId,
      stateRoot: workspaceRoot,
    }),
    runId: 'run-fetch-url-offload',
    projectionPolicy: DEFAULT_PROJECTION_POLICY,
    toolResult: { ok: true, output },
  });

  assert.equal(result.ok, true);
  const slimOutput = JSON.parse(result.output);
  assert.equal(slimOutput.offloaded, true);
  assert.equal(slimOutput.tool, 'fetch_url');
  assert.equal(slimOutput.finalUrl, 'https://example.com/final');
  assert.equal(Object.hasOwn(slimOutput, 'preview'), false);

  const snapshot = await readToolOutputSnapshot({
    stateRoot: workspaceRoot,
    threadId,
    outputRef: slimOutput.outputRef,
  });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.value.toolName, 'fetch_url');
  assert.equal(snapshot.value.output, output);
  assert.deepEqual(snapshot.value.source, {
    url: 'https://example.com/',
    finalUrl: 'https://example.com/final',
  });
});

void test('maybeOffloadToolResult offloads a large list_files result and preserves exact snapshot', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const threadId = testThreadId(97);
  const modelVisibleBudgetBytes = 2_048;
  const output = JSON.stringify({
    root: 'computer',
    path: 'Users/sample/Downloads',
    total: 800,
    entries: Array.from({ length: 800 }, (_, index) => ({
      name: `entry-${String(index).padStart(3, '0')}.txt`,
      path: `entry-${String(index).padStart(3, '0')}.txt`,
      type: 'file',
    })),
  });
  assert.ok(
    Buffer.byteLength(output, 'utf8') >
      DEFAULT_PROJECTION_POLICY.inlineMaxBytes,
  );

  const result = await maybeOffloadToolResult({
    ...projectedCall(listFilesCall('call-list-files-offload')),
    runContext: createRunContext({
      threadId,
      stateRoot: workspaceRoot,
    }),
    runId: 'run-list-files-offload',
    projectionPolicy: DEFAULT_PROJECTION_POLICY,
    projectionRound: createToolOutputProjectionRound({
      availableModelVisibleBytes: modelVisibleBudgetBytes,
      resultCount: 1,
    }),
    measureModelVisibleResultBytes: measureResultOutputBytes,
    toolResult: { ok: true, output },
  });

  assert.equal(result.ok, true);
  const slimOutput = JSON.parse(result.output);
  assert.equal(slimOutput.offloaded, true);
  assert.equal(slimOutput.tool, 'list_files');
  assert.equal(slimOutput.root, 'computer');
  assert.equal(slimOutput.path, 'Users/sample/Downloads');
  assert.equal(slimOutput.total, 800);
  assert.equal(slimOutput.recoveryTool, 'read_tool_output');
  assert.ok(Array.isArray(slimOutput.previewEntries));
  assert.ok(slimOutput.previewEntries.length > 0);
  assert.ok(slimOutput.previewEntries.length < slimOutput.total);
  assert.equal(slimOutput.previewEntryCount, slimOutput.previewEntries.length);
  assert.equal(slimOutput.previewHasMore, true);
  assert.deepEqual(slimOutput.previewEntries[0], {
    name: 'entry-000.txt',
    path: 'entry-000.txt',
    type: 'file',
  });
  assert.ok(
    Buffer.byteLength(result.output, 'utf8') <= modelVisibleBudgetBytes,
  );
  assert.match(
    slimOutput.summary,
    new RegExp(
      `first ${String(slimOutput.previewEntryCount)} entries are included`,
      'u',
    ),
  );
  const completeOutput = JSON.parse(output) as {
    entries: Array<{ name: string; path: string; type: string }>;
  };
  const nextPreviewEntry = completeOutput.entries[slimOutput.previewEntryCount];
  assert.ok(nextPreviewEntry);
  assert.ok(
    Buffer.byteLength(
      JSON.stringify({
        ...slimOutput,
        previewEntries: [...slimOutput.previewEntries, nextPreviewEntry],
        previewEntryCount: slimOutput.previewEntryCount + 1,
      }),
      'utf8',
    ) > modelVisibleBudgetBytes,
  );

  const snapshot = await readToolOutputSnapshot({
    stateRoot: workspaceRoot,
    threadId,
    outputRef: slimOutput.outputRef,
  });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.value.toolName, 'list_files');
  assert.equal(snapshot.value.output, output);
  assert.deepEqual(snapshot.value.source, {
    root: 'computer',
    path: 'Users/sample/Downloads',
  });
});

void test('maybeOffloadToolResult keeps list_files preview empty when the model-visible budget is unavailable', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const threadId = testThreadId(199);
  const output = JSON.stringify({
    root: 'computer',
    path: 'Users/sample/Documents',
    total: 2,
    entries: [
      {
        name: 'first.txt',
        path: 'first.txt',
        type: 'file',
      },
      {
        name: 'second.txt',
        path: 'second.txt',
        type: 'file',
      },
    ],
  });

  const result = await maybeOffloadToolResult({
    ...projectedCall(listFilesCall('call-list-files-no-budget')),
    runContext: createRunContext({
      threadId,
      stateRoot: workspaceRoot,
    }),
    runId: 'run-list-files-no-budget',
    projectionPolicy: FORCE_OFFLOAD_POLICY,
    toolResult: { ok: true, output },
  });

  assert.equal(result.ok, true);
  const slimOutput = JSON.parse(result.output);
  assert.equal(slimOutput.offloaded, true);
  assert.equal(slimOutput.recoveryTool, 'read_tool_output');
  assert.deepEqual(slimOutput.previewEntries, []);
  assert.equal(slimOutput.previewEntryCount, 0);
  assert.equal(slimOutput.previewHasMore, true);
  assert.doesNotMatch(result.output, /first\.txt|second\.txt/u);
});

void test('maybeOffloadToolResult caps list_files preview at the configured inline limit', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const threadId = testThreadId(200);
  const inlineMaxBytes = 1_024;
  const output = JSON.stringify({
    root: 'computer',
    path: 'Users/sample/Documents',
    total: 200,
    entries: Array.from({ length: 200 }, (_, index) => ({
      name: `bounded-entry-${String(index).padStart(3, '0')}.txt`,
      path: `bounded-entry-${String(index).padStart(3, '0')}.txt`,
      type: 'file',
    })),
  });

  const result = await maybeOffloadToolResult({
    ...projectedCall(listFilesCall('call-list-files-inline-cap')),
    runContext: createRunContext({
      threadId,
      stateRoot: workspaceRoot,
    }),
    runId: 'run-list-files-inline-cap',
    projectionPolicy: { inlineMaxBytes },
    projectionRound: createToolOutputProjectionRound({
      availableModelVisibleBytes: 100_000,
      resultCount: 1,
    }),
    measureModelVisibleResultBytes: measureResultOutputBytes,
    toolResult: { ok: true, output },
  });

  assert.equal(result.ok, true);
  const slimOutput = JSON.parse(result.output);
  assert.ok(slimOutput.previewEntryCount > 0);
  assert.ok(slimOutput.previewEntryCount < slimOutput.total);
  assert.ok(Buffer.byteLength(result.output, 'utf8') <= inlineMaxBytes);
});

void test('maybeOffloadToolResult projects a multibyte read_file page with exact paging metadata', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const threadId = testThreadId(198);
  const callId = 'call-read-file-multibyte';
  const runId = 'run-read-file-multibyte';
  const content = `${'한글'.repeat(14_000)}\n`;
  const output = JSON.stringify({
    path: 'notes/large.txt',
    content,
    versionToken: 'sha256:large-page',
    totalLines: 900,
    pageLimit: 300,
    startLine: 301,
    endLine: 600,
    hasMore: true,
    nextOffset: 600,
    root: 'computer',
  });
  assert.ok(content.length < DEFAULT_PROJECTION_POLICY.inlineMaxBytes);
  assert.ok(
    Buffer.byteLength(output, 'utf8') >
      DEFAULT_PROJECTION_POLICY.inlineMaxBytes,
  );

  const result = await maybeOffloadToolResult({
    ...projectedCall(readFileCall(callId)),
    runContext: createRunContext({ threadId, stateRoot: workspaceRoot }),
    runId,
    projectionPolicy: DEFAULT_PROJECTION_POLICY,
    toolResult: { ok: true, output },
  });

  assert.equal(result.ok, true);
  const slimOutput = JSON.parse(result.output) as Record<string, unknown>;
  assert.deepEqual(slimOutput, {
    ok: true,
    offloaded: true,
    tool: 'read_file',
    callId,
    outputRef: `tool-output:${threadId}/${runId}/${callId}`,
    summary:
      'read_file returned lines 301-600 of 900 for notes/large.txt. Exact page output is available through read_tool_output with explicit offset and limit. The source has more lines at nextOffset 600.',
    fullOutputBytes: Buffer.byteLength(output, 'utf8'),
    fullOutputChars: output.length,
    recoveryTool: 'read_tool_output',
    root: 'computer',
    path: 'notes/large.txt',
    versionToken: 'sha256:large-page',
    totalLines: 900,
    pageLimit: 300,
    startLine: 301,
    endLine: 600,
    hasMore: true,
    nextOffset: 600,
  });
  assert.equal(Object.hasOwn(slimOutput, 'content'), false);

  const snapshot = await readToolOutputSnapshot({
    stateRoot: workspaceRoot,
    threadId,
    outputRef: String(slimOutput['outputRef']),
  });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.value.output, output);
});

function listFilesCall(callId: string): FunctionCall {
  return {
    id: `fc-${callId}`,
    callId,
    name: 'list_files',
    arguments: '{}',
  };
}

function searchFilesCall(callId: string): FunctionCall {
  return {
    id: `fc-${callId}`,
    callId,
    name: 'search_files',
    arguments: '{}',
  };
}

function projectedCall(functionCall: FunctionCall) {
  const resultProjection = builtinToolRegistry.getToolMeta(
    functionCall.name,
  )?.resultProjection;
  assert.ok(resultProjection);
  return { functionCall, resultProjection };
}

function agentWaitCall(callId: string): FunctionCall {
  return {
    id: `fc-${callId}`,
    callId,
    name: 'agent_wait',
    arguments: '{}',
  };
}

function searchMemoryIndexCall(
  callId: string,
  args: Record<string, unknown> = {},
): FunctionCall {
  return {
    id: `fc-${callId}`,
    callId,
    name: 'search_memory_index',
    arguments: JSON.stringify(args),
  };
}

function execCall(callId: string): FunctionCall {
  return {
    id: `fc-${callId}`,
    callId,
    name: 'exec',
    arguments: '{}',
  };
}

function execCommandCall(callId: string): FunctionCall {
  return {
    id: `fc-${callId}`,
    callId,
    name: 'exec_command',
    arguments: '{}',
  };
}

function writeStdinCall(callId: string): FunctionCall {
  return {
    id: `fc-${callId}`,
    callId,
    name: 'write_stdin',
    arguments: '{}',
  };
}

function readFileCall(callId: string): FunctionCall {
  return {
    id: `fc-${callId}`,
    callId,
    name: 'read_file',
    arguments: '{}',
  };
}

function waitCall(callId: string): FunctionCall {
  return {
    id: `fc-${callId}`,
    callId,
    name: 'wait',
    arguments: '{}',
  };
}

function fetchUrlCall(callId: string): FunctionCall {
  return {
    id: `fc-${callId}`,
    callId,
    name: 'fetch_url',
    arguments: '{}',
  };
}

function measureResultOutputBytes(result: { output: string }): number {
  return Buffer.byteLength(result.output, 'utf8');
}
