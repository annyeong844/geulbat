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
import { testThreadId } from '../../test-support/thread-id.js';
import {
  PTC_EXECUTE_CODE_CELL_TERMINAL_RESULT_RUN_ID,
  PTC_EXECUTE_CODE_POLICY_ID,
  PTC_EXECUTE_CODE_TOOL_NAME,
} from '../ptc/runtime/execute-code/execute-code-runtime-contract.js';
import {
  maybeOffloadToolResult,
  resolveToolOutputProjectionPolicyFromEnv,
} from './tool-output-offload.js';

const DEFAULT_PROJECTION_POLICY = resolveToolOutputProjectionPolicyFromEnv({});
const FORCE_OFFLOAD_POLICY = { inlineMaxBytes: 1 };

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

void test('maybeOffloadToolResult keeps a small search_files result inline without creating a snapshot', async () => {
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
    functionCall: searchFilesCall(callId),
    runContext: createRunContext({
      threadId,
      stateRoot,
    }),
    runId,
    projectionPolicy: DEFAULT_PROJECTION_POLICY,
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

void test('maybeOffloadToolResult keeps tools outside the offload owner inline', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const output = 'inline read_file output';

  const result = await maybeOffloadToolResult({
    functionCall: readFileCall('call-read-file-inline'),
    runContext: createRunContext({
      threadId: testThreadId(92),
      stateRoot: workspaceRoot,
    }),
    runId: 'run-read-file-inline',
    toolResult: { ok: true, output },
  });

  assert.deepEqual(result, { ok: true, output });
});

void test('maybeOffloadToolResult applies the inline limit to UTF-8 bytes inclusively', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-offload-'));
  const threadId = testThreadId(104);
  const output = '한글';
  const outputBytes = Buffer.byteLength(output, 'utf8');

  const inlineResult = await maybeOffloadToolResult({
    functionCall: searchFilesCall('call-utf8-inline-boundary'),
    runContext: createRunContext({ threadId, stateRoot }),
    runId: 'run-utf8-inline-boundary',
    projectionPolicy: { inlineMaxBytes: outputBytes },
    toolResult: { ok: true, output },
  });
  assert.deepEqual(inlineResult, { ok: true, output });

  const offloadedResult = await maybeOffloadToolResult({
    functionCall: searchFilesCall('call-utf8-over-boundary'),
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
    functionCall: execCall('call-exec-inline'),
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
    functionCall: execCall('call-exec-recoverable-output'),
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
    timeoutMs: 1000,
    maxOutputBytesPerStream: 8192,
    outputLimitExceeded: null,
  });

  const result = await maybeOffloadToolResult({
    functionCall: execCommandCall('call-exec-command-recoverable-output'),
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
      functionCall: execCall('call-exec-record-failure'),
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
    functionCall: waitCall('call-wait-recoverable-output'),
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
    functionCall: waitCall('call-existing-durable-wait-output'),
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
    functionCall: searchMemoryIndexCall('call-memory-inline-no-recovery'),
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
    functionCall: searchFilesCall('call-search-without-preview-text'),
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
    functionCall: searchMemoryIndexCall('call-memory-index-offload', {
      query: 'memory provenance',
    }),
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
      functionCall: searchFilesCall('call-write-failure'),
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
    functionCall: fetchUrlCall('call-fetch-url-offload'),
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
    functionCall: listFilesCall('call-list-files-offload'),
    runContext: createRunContext({
      threadId,
      stateRoot: workspaceRoot,
    }),
    runId: 'run-list-files-offload',
    projectionPolicy: DEFAULT_PROJECTION_POLICY,
    toolResult: { ok: true, output },
  });

  assert.equal(result.ok, true);
  const slimOutput = JSON.parse(result.output);
  assert.equal(slimOutput.offloaded, true);
  assert.equal(slimOutput.tool, 'list_files');
  assert.equal(slimOutput.root, 'computer');
  assert.equal(slimOutput.path, 'Users/sample/Downloads');
  assert.equal(slimOutput.total, 800);
  assert.equal(Object.hasOwn(slimOutput, 'preview'), false);

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
