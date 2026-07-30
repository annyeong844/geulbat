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
  maybeOffloadToolResult,
  resolveToolOutputProjectionPolicyFromEnv,
} from './tool-output-offload.js';

const DEFAULT_PROJECTION_POLICY = resolveToolOutputProjectionPolicyFromEnv({});
const FORCE_OFFLOAD_POLICY = { inlineMaxBytes: 1 };
const builtinToolRegistry = createBuiltinToolRegistryStore();

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

function waitCall(callId: string): FunctionCall {
  return {
    id: `fc-${callId}`,
    callId,
    name: 'wait',
    arguments: '{}',
  };
}
