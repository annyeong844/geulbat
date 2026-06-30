import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDaemonContext } from '../../context.js';
import { createRunState } from '../../agent/runtime/run-state.js';
import {
  PTC_EXECUTE_CODE_FORBIDDEN_OLD_TOOL_NAME,
  PTC_EXECUTE_CODE_POLICY_ID,
  PTC_EXECUTE_CODE_TOOL_NAME,
  PTC_EXECUTE_CODE_WAIT_TOOL_NAME,
  type PtcExecuteCodePlacementResourceSnapshotRef,
  type PtcExecuteCodeRuntime,
} from '../../ptc/runtime/execute-code/execute-code-runtime-contract.js';
import { testProjectId } from '../../../test-support/project-id.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { executeCodeTool } from './execute-code.js';
import { waitTool } from './wait.js';
import {
  isToolObjectParameters,
  type CallbackToolDispatcher,
  type ToolExecutionResourceSnapshotRef,
} from '../types.js';
import {
  createPtcExecuteCodeToolCallbackHandler,
  createPtcExecuteCodeToolCallbackHelp,
  createPtcExecuteCodeToolCallbackSurface,
} from './execute-code-tool-callback.js';
import {
  isPtcExecuteCodeCallbackToolMetaAllowed,
  resolvePtcExecuteCodeCallbackToolSurface,
} from './ptc-callback-tool-surface.js';

function makeUnexpectedCallbackToolDispatcher(): CallbackToolDispatcher {
  return {
    async dispatch() {
      throw new Error('callback dispatch was not expected');
    },
  };
}

const waitForUnusedCell: PtcExecuteCodeRuntime['waitForCell'] = async () => ({
  ok: true,
  value: {
    ok: true,
    capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
    policyId: PTC_EXECUTE_CODE_POLICY_ID,
    executionSurface: 'node_via_lab_detached_cell',
    status: 'missing',
    cellId: 'ptc_cell_unused',
    remediation: 'start_a_new_exec',
  },
});

void test('exec description teaches the running-cell wait handoff', () => {
  assert.match(executeCodeTool.description, /status "running"/u);
  assert.match(executeCodeTool.description, /cellId/u);
  assert.match(executeCodeTool.description, /wait/u);
  assert.match(executeCodeTool.description, /cell_id/u);
});

void test('public exec and wait expose explicit PTC cell scheduler metadata', () => {
  assert.equal(executeCodeTool.sideEffectLevel, 'none');
  assert.equal(executeCodeTool.mayMutateWorkspaceFiles, false);
  assert.equal(executeCodeTool.requiresApproval, false);
  assert.equal(executeCodeTool.parallelBatchKind, 'ptc_cell');
  assert.equal(waitTool.sideEffectLevel, 'none');
  assert.equal(waitTool.mayMutateWorkspaceFiles, false);
  assert.equal(waitTool.requiresApproval, false);
  assert.equal(waitTool.parallelBatchKind, 'ptc_cell');
});

void test('exec exposes timeoutMs plus snake_case cell observation without aliases', async () => {
  const parameters = executeCodeTool.parameters;
  assert.ok(isToolObjectParameters(parameters));
  assert.deepEqual(Object.keys(parameters.properties), [
    'code',
    'timeoutMs',
    'yield_time_ms',
  ]);
  assert.deepEqual(parameters.required, ['code']);
  const timeoutProperty = parameters.properties.timeoutMs as {
    description?: string;
  };
  const yieldTimeProperty = parameters.properties.yield_time_ms as {
    description?: string;
  };
  assert.match(
    timeoutProperty.description ?? '',
    /timeout_ms is not accepted/u,
  );
  assert.match(
    yieldTimeProperty.description ?? '',
    /yieldTimeMs is not accepted/u,
  );

  const result = await executeCodeTool.execute(
    { code: 'return 1', timeout_ms: 1_000, yieldTimeMs: 1_000 },
    {
      callId: 'call-execute-code-schema-aliases',
      workspaceRoot: '/workspace/project',
      threadId: testThreadId(910),
      projectId: testProjectId('project'),
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /unexpected keys: timeout_ms/u);
  assert.match(result.error ?? '', /yieldTimeMs/u);
});

void test('exec requires an agent runtime service before executing code', async () => {
  const result = await executeCodeTool.execute(
    { code: 'console.log("hello")' },
    {
      callId: 'call-execute-code-no-runtime',
      workspaceRoot: '/workspace/project',
      threadId: testThreadId(911),
      projectId: testProjectId('project'),
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'execution_failed');
  assert.match(result.error ?? '', /runtime is required/u);
});

void test('exec returns compact runtime output without session identifiers', async () => {
  const daemonContext = createDaemonContext();
  let observedCode = '';
  let observedYieldTimeMs = 0;
  let observedPlacementResourceSnapshotId: string | undefined;
  let observedSdkToolNames: string[] = [];
  const ptcExecuteCode: PtcExecuteCodeRuntime = {
    async executeCode(args) {
      observedCode = args.request.code;
      observedYieldTimeMs = args.request.yieldTimeMs ?? 0;
      assert.equal(args.invocationId, 'call-execute-code-success');
      assert.equal(
        args.placementResourceSnapshotRef?.source,
        'agent_resource_budget_provider',
      );
      observedPlacementResourceSnapshotId =
        args.placementResourceSnapshotRef?.snapshotId;
      assert.equal(typeof args.toolCallbackHandler, 'function');
      observedSdkToolNames = (args.sdkHelp?.callbackTools ?? []).map(
        (tool) => tool.name,
      );
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
          stdout: '{"answer":42}\n',
          stderr: '',
          effectiveTimeoutMs: 60_000,
          durationMs: 12,
          toolCallbacks: {
            enabled: true,
            observed: 1,
          },
          sessionLifecycle: {
            mode: 'runtime_owned_reusable',
            retainedAfterExecution: true,
          },
          callbackHelp: {
            protocolVersion: 'ptc_execute_code_sdk_v1',
            helpAvailable: true,
            callbackToolCount: args.sdkHelp?.callbackTools.length ?? 0,
          },
        },
      };
    },
    waitForCell: waitForUnusedCell,
    async closeAll() {
      return { ok: true };
    },
  };
  const runState = createRunState({
    runId: 'run-execute-code-success',
    runContext: {
      threadId: testThreadId(912),
      projectId: testProjectId('project'),
      workspaceRoot: '/workspace/project',
    },
  });

  const result = await executeCodeTool.execute(
    { code: 'return { answer: 42 }', yield_time_ms: 1_000 },
    {
      callId: 'call-execute-code-success',
      workspaceRoot: '/workspace/project',
      threadId: runState.threadId,
      projectId: testProjectId('project'),
      runState,
      agentSpawnRuntime: { ...daemonContext, ptcExecuteCode },
      callbackToolDispatcher: makeUnexpectedCallbackToolDispatcher(),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(observedCode, 'return { answer: 42 }');
  assert.equal(observedYieldTimeMs, 1_000);
  assert.equal(typeof observedPlacementResourceSnapshotId, 'string');
  assert.notEqual(observedPlacementResourceSnapshotId, '');
  assert.equal(observedSdkToolNames.includes('read_file'), true);
  assert.equal(observedSdkToolNames.includes('list_files'), true);
  assert.equal(observedSdkToolNames.includes('search_files'), true);
  assert.equal(observedSdkToolNames.includes('web_fetch'), true);
  assert.equal(observedSdkToolNames.includes('browser_navigate'), false);
  assert.equal(
    observedSdkToolNames.includes('browser_page_load_evidence'),
    false,
  );
  assert.equal(observedSdkToolNames.includes('browser_text_evidence'), false);
  assert.equal(observedSdkToolNames.includes('write_file'), false);
  assert.equal(
    observedSdkToolNames.includes(PTC_EXECUTE_CODE_TOOL_NAME),
    false,
  );
  assert.equal(
    observedSdkToolNames.includes(PTC_EXECUTE_CODE_FORBIDDEN_OLD_TOOL_NAME),
    false,
  );
  assert.equal(
    observedSdkToolNames.includes(PTC_EXECUTE_CODE_WAIT_TOOL_NAME),
    false,
  );
  const output = JSON.parse(result.output) as Record<string, unknown>;
  assert.equal(output.kind, 'ptc_execute_code_result');
  assert.equal(output.capabilityId, PTC_EXECUTE_CODE_TOOL_NAME);
  assert.equal(output.exitCode, 0);
  assert.equal(output.stdout, '{"answer":42}\n');
  assert.deepEqual(output.toolCallbacks, {
    enabled: true,
    observed: 1,
  });
  assert.deepEqual(output.sessionLifecycle, {
    mode: 'runtime_owned_reusable',
    retainedAfterExecution: true,
  });
  const callbackHelp = output.callbackHelp as Record<string, unknown>;
  assert.equal(callbackHelp.protocolVersion, 'ptc_execute_code_sdk_v1');
  assert.equal(callbackHelp.helpAvailable, true);
  assert.equal(typeof callbackHelp.callbackToolCount, 'number');
  assert.equal(Object.hasOwn(output, 'sdk'), false);
  assert.equal(JSON.stringify(output).includes('container'), false);
  assert.equal(JSON.stringify(output).includes('labSessionId'), false);
});

void test('exec reuses a supplied resource snapshot ref before capturing a new one', async () => {
  const daemonContext = createDaemonContext();
  const suppliedResourceSnapshotRef = {
    snapshotId: 'resource-snapshot-from-shared-window',
  } satisfies ToolExecutionResourceSnapshotRef;
  let captureCalled = false;
  daemonContext.resourceBudgetProvider = {
    captureSnapshot() {
      captureCalled = true;
      throw new Error('exec should reuse the supplied resource snapshot ref');
    },
  };
  let observedResourceSnapshotRef:
    | PtcExecuteCodePlacementResourceSnapshotRef
    | undefined;
  const ptcExecuteCode: PtcExecuteCodeRuntime = {
    async executeCode(args) {
      observedResourceSnapshotRef = args.placementResourceSnapshotRef;
      return {
        ok: false,
        reasonCode: 'ptc_execute_code_invalid',
        message: 'expected test failure after observing placement ref',
      };
    },
    waitForCell: waitForUnusedCell,
    async closeAll() {
      return { ok: true };
    },
  };
  const runState = createRunState({
    runId: 'run-execute-code-shared-resource-snapshot',
    runContext: {
      threadId: testThreadId(912_1),
      projectId: testProjectId('project'),
      workspaceRoot: '/workspace/project',
    },
  });

  const result = await executeCodeTool.execute(
    { code: 'return 1' },
    {
      callId: 'call-execute-code-shared-resource-snapshot',
      workspaceRoot: '/workspace/project',
      threadId: runState.threadId,
      projectId: testProjectId('project'),
      runState,
      resourceSnapshotRef: suppliedResourceSnapshotRef,
      agentSpawnRuntime: { ...daemonContext, ptcExecuteCode },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(captureCalled, false);
  assert.deepEqual(observedResourceSnapshotRef, {
    snapshotId: suppliedResourceSnapshotRef.snapshotId,
    source: 'agent_resource_budget_provider',
  });
});

void test('exec callback handler dispatches admitted read-only tools and rejects mutating tools', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-execute-code-callback-tool-'),
  );
  const daemonContext = createDaemonContext();
  const threadId = testThreadId(915);
  const projectId = testProjectId('project');
  await writeFile(join(workspaceRoot, 'note.txt'), 'callback file\n');
  const dispatched: Parameters<CallbackToolDispatcher['dispatch']>[0][] = [];
  const callbackToolDispatcher: CallbackToolDispatcher = {
    async dispatch(args) {
      dispatched.push(args);
      return {
        ok: true,
        output: JSON.stringify({ content: 'callback file\n' }),
      };
    },
  };

  try {
    const handler = createPtcExecuteCodeToolCallbackHandler({
      callId: 'outer-execute-code-call',
      workspaceRoot,
      threadId,
      projectId,
      agentSpawnRuntime: daemonContext,
      callbackToolDispatcher,
    });
    assert.ok(handler);
    const help = createPtcExecuteCodeToolCallbackHelp({
      callId: 'outer-execute-code-call',
      workspaceRoot,
      threadId,
      projectId,
      agentSpawnRuntime: daemonContext,
      callbackToolDispatcher,
    });
    assert.ok(help);
    const callbackToolNames = help.callbackTools.map((tool) => tool.name);
    assert.equal(callbackToolNames.includes('read_file'), true);
    assert.equal(callbackToolNames.includes('agent_wait'), false);
    assert.equal(callbackToolNames.includes('browser_navigate'), false);
    assert.equal(
      callbackToolNames.includes('browser_page_load_evidence'),
      false,
    );
    assert.equal(callbackToolNames.includes('browser_text_evidence'), false);
    assert.equal(callbackToolNames.includes('write_file'), false);
    assert.equal(callbackToolNames.includes(PTC_EXECUTE_CODE_TOOL_NAME), false);
    assert.equal(
      callbackToolNames.includes(PTC_EXECUTE_CODE_FORBIDDEN_OLD_TOOL_NAME),
      false,
    );
    assert.equal(
      callbackToolNames.includes(PTC_EXECUTE_CODE_WAIT_TOOL_NAME),
      false,
    );
    const readFileCallbackTool = help.callbackTools.find(
      (tool) => tool.name === 'read_file',
    );
    assert.ok(readFileCallbackTool);
    assert.ok(isToolObjectParameters(readFileCallbackTool.parameters));
    assert.equal(readFileCallbackTool.parameters.additionalProperties, false);

    const readResult = await handler({
      requestId: 'read-1',
      toolName: 'read_file',
      args: { path: 'note.txt' },
      cellId: 'ptc_cell_callback_read',
      signal: new AbortController().signal,
      enterLongWait: () => true,
    });
    assert.equal(readResult.ok, true);
    if (readResult.ok) {
      const executeResult = assertExecuteResult(readResult.result);
      assert.equal(executeResult.ok, true);
      const output = JSON.parse(executeResult.output) as Record<
        string,
        unknown
      >;
      assert.equal(output.content, 'callback file\n');
    }
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]?.toolName, 'read_file');
    assert.deepEqual(dispatched[0]?.args, { path: 'note.txt' });
    assert.equal(dispatched[0]?.runtimeToolCallId, 'read-1');
    assert.equal(dispatched[0]?.cellId, 'ptc_cell_callback_read');

    const writeResult = await handler({
      requestId: 'write-1',
      toolName: 'write_file',
      args: { path: 'created.txt', content: 'nope' },
      cellId: 'ptc_cell_callback_write',
      signal: new AbortController().signal,
      enterLongWait: () => {
        assert.fail('write callback must not enter long wait before admission');
      },
    });
    assert.equal(dispatched.length, 1);
    assert.deepEqual(writeResult, {
      ok: false,
      errorCode: 'ptc_tool_not_callable',
      message:
        'PTC execute_code callback can only call read-only no-approval non-orchestration tools',
    });

    const agentWaitResult = await handler({
      requestId: 'agent-wait-1',
      toolName: 'agent_wait',
      args: { child_run_ids: ['00000000-0000-4000-8000-000000000001'] },
      signal: new AbortController().signal,
      enterLongWait: () => {
        assert.fail('agent callback must not enter long wait before admission');
      },
    });
    assert.equal(dispatched.length, 1);
    assert.deepEqual(agentWaitResult, {
      ok: false,
      errorCode: 'ptc_tool_not_callable',
      message:
        'PTC execute_code callback can only call read-only no-approval non-orchestration tools',
    });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test('exec callback handler fails closed before long wait when dispatcher is unavailable', async () => {
  const daemonContext = createDaemonContext();
  const handler = createPtcExecuteCodeToolCallbackHandler({
    callId: 'outer-execute-code-call',
    workspaceRoot: '/workspace/project',
    threadId: testThreadId(919),
    projectId: testProjectId('project'),
    agentSpawnRuntime: daemonContext,
  });
  assert.ok(handler);
  assert.equal(
    createPtcExecuteCodeToolCallbackHelp({
      callId: 'outer-execute-code-call',
      workspaceRoot: '/workspace/project',
      threadId: testThreadId(919),
      projectId: testProjectId('project'),
      agentSpawnRuntime: daemonContext,
    }),
    undefined,
  );

  const result = await handler({
    requestId: 'read-without-dispatcher',
    toolName: 'read_file',
    args: { path: 'note.txt' },
    signal: new AbortController().signal,
    enterLongWait: () => {
      assert.fail('dispatcher admission failure must not enter long wait');
    },
  });
  assert.deepEqual(result, {
    ok: false,
    errorCode: 'ptc_tool_dispatch_unavailable',
    message: 'PTC execute_code callback dispatcher is unavailable',
  });
});

void test('exec callback handler enters long wait after admission and before slow read execution', async () => {
  const daemonContext = createDaemonContext();
  let slowToolStarted = false;
  const callbackToolDispatcher: CallbackToolDispatcher = {
    async dispatch() {
      slowToolStarted = true;
      await delay(20);
      return { ok: true, output: 'slow-read-ok' };
    },
  };
  daemonContext.toolRegistry.registerTool({
    name: 'slow_read',
    description: 'Slow read-only callback test tool.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    strict: true,
    sideEffectLevel: 'read',
    mayMutateWorkspaceFiles: false,
    requiresApproval: false,
    parseArgs: () => ({ ok: true, value: {} }),
    async executeParsed() {
      return { ok: true, output: 'slow-read-ok' };
    },
  });
  const handler = createPtcExecuteCodeToolCallbackHandler({
    callId: 'outer-execute-code-call',
    workspaceRoot: '/workspace/project',
    threadId: testThreadId(918),
    projectId: testProjectId('project'),
    agentSpawnRuntime: daemonContext,
    callbackToolDispatcher,
  });
  assert.ok(handler);

  const events: string[] = [];
  const result = await handler({
    requestId: 'slow-read-1',
    toolName: 'slow_read',
    args: {},
    signal: new AbortController().signal,
    enterLongWait: () => {
      events.push(`enter:${slowToolStarted}`);
      return true;
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(events, ['enter:false']);
  assert.equal(slowToolStarted, true);
});

void test('exec callback surface defaults to the read-only callable registry snapshot', () => {
  const daemonContext = createDaemonContext();
  const surface = createPtcExecuteCodeToolCallbackSurface({
    callId: 'outer-execute-code-call',
    workspaceRoot: '/workspace/project',
    threadId: testThreadId(916),
    projectId: testProjectId('project'),
    agentSpawnRuntime: daemonContext,
  });
  assert.ok(surface);

  const expectedToolNames = daemonContext.toolRegistry
    .buildToolDefinitions()
    .filter((definition) => {
      const meta = daemonContext.toolRegistry.getToolMeta(definition.name);
      return (
        meta !== null &&
        isPtcExecuteCodeCallbackToolMetaAllowed(definition.name, meta)
      );
    })
    .map((definition) => definition.name);
  assert.deepEqual(
    surface.callbackTools.map((tool) => tool.name),
    expectedToolNames,
  );
  assert.equal(surface.allows('read_file'), true);
  assert.equal(surface.allows('agent_wait'), false);
  assert.equal(surface.allows(PTC_EXECUTE_CODE_TOOL_NAME), false);
  assert.equal(surface.allows(PTC_EXECUTE_CODE_FORBIDDEN_OLD_TOOL_NAME), false);
  assert.equal(surface.allows(PTC_EXECUTE_CODE_WAIT_TOOL_NAME), false);
});

void test('exec callback surface intersects run allowed tool names before help or execution', async () => {
  const daemonContext = createDaemonContext();
  let observedSdkToolNames: string[] | undefined;
  let observedDeniedCallback = false;
  const ptcExecuteCode: PtcExecuteCodeRuntime = {
    async executeCode(args) {
      observedSdkToolNames = (args.sdkHelp?.callbackTools ?? []).map(
        (tool) => tool.name,
      );
      assert.equal(typeof args.toolCallbackHandler, 'function');
      const denied = await args.toolCallbackHandler?.({
        requestId: 'read-denied-by-run-scope',
        toolName: 'read_file',
        args: { path: 'note.txt' },
        signal: new AbortController().signal,
      });
      assert.deepEqual(denied, {
        ok: false,
        errorCode: 'ptc_tool_not_callable',
        message:
          'PTC execute_code callback can only call read-only no-approval non-orchestration tools',
      });
      observedDeniedCallback = true;
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
          stdout: '',
          stderr: '',
          effectiveTimeoutMs: 60_000,
          durationMs: 1,
          toolCallbacks: {
            enabled: true,
            observed: 1,
          },
          sessionLifecycle: {
            mode: 'runtime_owned_reusable',
            retainedAfterExecution: true,
          },
          callbackHelp: {
            protocolVersion: 'ptc_execute_code_sdk_v1',
            helpAvailable: true,
            callbackToolCount: args.sdkHelp?.callbackTools.length ?? 0,
          },
        },
      };
    },
    waitForCell: waitForUnusedCell,
    async closeAll() {
      return { ok: true };
    },
  };

  const result = await executeCodeTool.execute(
    { code: 'return 1' },
    {
      callId: 'call-execute-code-restricted-surface',
      workspaceRoot: '/workspace/project',
      threadId: testThreadId(917),
      projectId: testProjectId('project'),
      allowedToolNames: [PTC_EXECUTE_CODE_TOOL_NAME],
      agentSpawnRuntime: { ...daemonContext, ptcExecuteCode },
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(observedSdkToolNames, []);
  assert.equal(observedDeniedCallback, true);
});

void test('exec callback surface predicate fails closed for incomplete or contradictory metadata', () => {
  assert.equal(
    isPtcExecuteCodeCallbackToolMetaAllowed('read_file', {
      sideEffectLevel: 'read',
      requiresApproval: false,
      mayMutateWorkspaceFiles: false,
    }),
    true,
  );
  assert.equal(
    isPtcExecuteCodeCallbackToolMetaAllowed('read_file', {
      sideEffectLevel: 'read',
      requiresApproval: false,
    }),
    false,
  );
  assert.equal(
    isPtcExecuteCodeCallbackToolMetaAllowed('read_file', {
      sideEffectLevel: 'read',
      requiresApproval: true,
      mayMutateWorkspaceFiles: false,
    }),
    false,
  );
  assert.equal(
    isPtcExecuteCodeCallbackToolMetaAllowed('read_file', {
      sideEffectLevel: 'read',
      requiresApproval: false,
      mayMutateWorkspaceFiles: true,
    }),
    false,
  );
  assert.equal(
    isPtcExecuteCodeCallbackToolMetaAllowed('agent_wait', {
      sideEffectLevel: 'read',
      requiresApproval: false,
      mayMutateWorkspaceFiles: false,
    }),
    false,
  );
  assert.equal(
    isPtcExecuteCodeCallbackToolMetaAllowed('agent_future_read', {
      sideEffectLevel: 'read',
      requiresApproval: false,
      mayMutateWorkspaceFiles: false,
    }),
    false,
  );
  assert.equal(
    isPtcExecuteCodeCallbackToolMetaAllowed(PTC_EXECUTE_CODE_TOOL_NAME, {
      sideEffectLevel: 'read',
      requiresApproval: false,
      mayMutateWorkspaceFiles: false,
    }),
    false,
  );
  assert.equal(
    isPtcExecuteCodeCallbackToolMetaAllowed(
      PTC_EXECUTE_CODE_FORBIDDEN_OLD_TOOL_NAME,
      {
        sideEffectLevel: 'read',
        requiresApproval: false,
        mayMutateWorkspaceFiles: false,
      },
    ),
    false,
  );
  assert.equal(
    isPtcExecuteCodeCallbackToolMetaAllowed(PTC_EXECUTE_CODE_WAIT_TOOL_NAME, {
      sideEffectLevel: 'read',
      requiresApproval: false,
      mayMutateWorkspaceFiles: false,
    }),
    false,
  );
  const surface = resolvePtcExecuteCodeCallbackToolSurface({
    registry: createDaemonContext().toolRegistry,
    allowedToolNames: [
      PTC_EXECUTE_CODE_TOOL_NAME,
      PTC_EXECUTE_CODE_FORBIDDEN_OLD_TOOL_NAME,
      PTC_EXECUTE_CODE_WAIT_TOOL_NAME,
    ],
  });
  assert.deepEqual(
    surface.callbackTools.map((tool) => tool.name),
    [],
  );
});

void test('exec strips unstable failure diagnostics from tool output', async () => {
  const daemonContext = createDaemonContext();
  const ptcExecuteCode: PtcExecuteCodeRuntime = {
    async executeCode() {
      return {
        ok: false,
        reasonCode: 'ptc_lab_session_unavailable',
        message: 'PTC lab session container is unavailable',
        diagnostics: {
          sessionReasonCode: 'container_create_failed',
          rawPath: '/tmp/geulbat-private/.geulbat/ptc/private',
        },
      };
    },
    waitForCell: waitForUnusedCell,
    async closeAll() {
      return { ok: true };
    },
  };

  const result = await executeCodeTool.execute(
    { code: 'console.log("nope")' },
    {
      callId: 'call-execute-code-failure',
      workspaceRoot: '/workspace/project',
      threadId: testThreadId(913),
      projectId: testProjectId('project'),
      agentSpawnRuntime: { ...daemonContext, ptcExecuteCode },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'execution_failed');
  assert.doesNotMatch(result.output, /geulbat-private|\.geulbat|private/u);
  assert.deepEqual(JSON.parse(result.output), {
    kind: 'ptc_execute_code_error',
    reasonCode: 'ptc_lab_session_unavailable',
    message: 'PTC lab session container is unavailable',
    diagnostics: {
      sessionReasonCode: 'container_create_failed',
    },
  });
});

function assertExecuteResult(value: unknown): {
  ok: boolean;
  output: string;
} {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  const record = value as Record<string, unknown>;
  const ok = record.ok;
  const output = record.output;
  if (typeof ok !== 'boolean' || typeof output !== 'string') {
    throw new Error('execute result shape is invalid');
  }
  return {
    ok,
    output,
  };
}

void test('exec rejects extra URL-shaped arguments before runtime invocation', async () => {
  const daemonContext = createDaemonContext();
  let invoked = false;
  const ptcExecuteCode: PtcExecuteCodeRuntime = {
    async executeCode() {
      invoked = true;
      throw new Error('runtime should not be invoked');
    },
    waitForCell: waitForUnusedCell,
    async closeAll() {
      return { ok: true };
    },
  };

  const result = await executeCodeTool.execute(
    { code: 'console.log("hello")', url: 'https://example.test' },
    {
      callId: 'call-execute-code-extra-field',
      workspaceRoot: '/workspace/project',
      threadId: testThreadId(914),
      projectId: testProjectId('project'),
      agentSpawnRuntime: { ...daemonContext, ptcExecuteCode },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.equal(invoked, false);
});
