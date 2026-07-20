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
import { testThreadId } from '../../../test-support/thread-id.js';
import { testRunId } from '../../../test-support/run-id.js';
import { TEST_CHILD_MODEL_REGISTRATION } from '../../../test-support/subagent-model-routing.js';
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
  resolvePtcExecuteCodeToolSdkProjection,
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

void test('exec description does not imply host access when callbacks are disabled', () => {
  assert.match(executeCodeTool.description, /no direct host filesystem mount/u);
  assert.match(
    executeCodeTool.description,
    /call geulbat\.help\(\).*callbacks\.enabled/u,
  );
  assert.match(executeCodeTool.description, /do not infer/u);
  assert.match(
    executeCodeTool.description,
    /operator callback transport policy/u,
  );
});

void test('exec description shows the generated wrapper named require form', () => {
  assert.equal(
    executeCodeTool.description.includes(
      "const { readFile } = require('geulbat-sdk/files/readFile')",
    ),
    true,
  );
});

void test('exec description teaches the generated wrapper result envelope', () => {
  assert.match(
    executeCodeTool.description,
    /kind: "inline".*value.*ok: true.*output: string/u,
  );
  assert.match(executeCodeTool.description, /result\.value\.ok/u);
  assert.match(executeCodeTool.description, /result\.value\.output/u);
  assert.match(
    executeCodeTool.description,
    /preserve each request path or name.*errorCode.*error.*generic message/u,
  );
  assert.match(executeCodeTool.description, /payload\.hasMore === false/u);
  assert.match(executeCodeTool.description, /payload\.content/u);
  assert.match(executeCodeTool.description, /user-selected run cwd/u);
  assert.match(executeCodeTool.description, /do not assume a repository cwd/u);
});

void test('exec description separates the low-level callback result from the generated wrapper envelope', () => {
  assert.match(
    executeCodeTool.description,
    /Low-level geulbat\.callTool returns raw.*ok.*output.*errorCode.*error/u,
  );
  assert.match(
    executeCodeTool.description,
    /not the generated wrapper's kind\/value envelope/u,
  );
});

void test('exec surfaces capacity pressure as a queued cell handoff', async () => {
  const daemonContext = createDaemonContext();
  const ptcExecuteCode: PtcExecuteCodeRuntime = {
    async executeCode(args) {
      assert.equal(args.runContext.ownerKind, 'root_main');
      assert.equal(args.placementContinuityProvenance, undefined);
      return {
        ok: true,
        value: {
          ok: true,
          capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
          policyId: PTC_EXECUTE_CODE_POLICY_ID,
          labPolicyId: 'ptc_lab_local_docker_batch_command_v1',
          profile: 'lab',
          executionClass: 'lab_execute_code',
          executionSurface: 'node_via_lab_detached_cell',
          status: 'queued',
          cellId: 'ptc_cell_tool_queued',
          stdout: '',
          stderr: '',
          effectiveTimeoutMs: 60_000,
          durationMs: 0,
          toolCallbacks: { enabled: true, observed: 0 },
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
    runId: 'run-execute-code-queued',
    runContext: {
      threadId: testThreadId(912_1),
      stateRoot: '/workspace/home-state',
      workingDirectory: 'project',
    },
  });

  const result = await executeCodeTool.execute(
    { code: 'return 1' },
    {
      callId: 'call-execute-code-queued',
      stateRoot: '/workspace/home-state',

      workingDirectory: 'project',
      threadId: runState.threadId,
      runState,
      agentSpawnRuntime: { ...daemonContext, ptcExecuteCode },
      callbackToolDispatcher: makeUnexpectedCallbackToolDispatcher(),
    },
  );

  assert.equal(result.ok, true);
  const output = JSON.parse(result.output) as Record<string, unknown>;
  assert.equal(output.kind, 'ptc_execute_code_cell_queued');
  assert.equal(output.status, 'queued');
  assert.equal(output.cellId, 'ptc_cell_tool_queued');
  assert.equal(output.stdout, '');
  assert.equal(output.stderr, '');
});

void test('explorer child exec receives daemon-owned read-only independence provenance', async () => {
  const daemonContext = createDaemonContext();
  const childRunId = testRunId('execute-code-explorer-child');
  const childThreadId = testThreadId(912_2);
  daemonContext.childRuns.registerChildRun({
    ...TEST_CHILD_MODEL_REGISTRATION,
    childRunId,
    childThreadId,
    parentRunId: testRunId('execute-code-explorer-parent'),
    ownerThreadId: testThreadId(912_3),
    subagentType: 'explorer',
  });
  const ptcExecuteCode: PtcExecuteCodeRuntime = {
    async executeCode(args) {
      assert.equal(args.runContext.ownerKind, 'child');
      assert.deepEqual(args.placementContinuityProvenance, {
        independenceProof: { reason: 'read_only_analysis' },
      });
      return {
        ok: false,
        reasonCode: 'ptc_lab_session_unavailable',
        message: 'test completed after provenance capture',
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
      kind: 'agent',
      runOwnerKind: 'child',
      runId: childRunId,
      callId: 'call-execute-code-explorer-child',
      signal: undefined,
      runSignal: undefined,
      currentFile: undefined,
      selection: undefined,
      approvalGranted: false,
      approvalSessionId: 'approval-execute-code-explorer-child',
      permissionMode: 'basic',
      stateRoot: '/workspace/home-state',
      workingDirectory: 'project',
      threadId: childThreadId,
      runState: undefined,
      emitAgentEvent: () => undefined,
      memoryIndex: undefined,
      agentSpawnRuntime: { ...daemonContext, ptcExecuteCode },
      callbackToolDispatcher: makeUnexpectedCallbackToolDispatcher(),
    },
  );

  assert.equal(result.ok, false);
});

void test('public exec and wait expose explicit PTC cell scheduler metadata', () => {
  assert.equal(executeCodeTool.sideEffectLevel, 'none');
  assert.equal(executeCodeTool.mayMutateComputerFiles, false);
  assert.equal(executeCodeTool.requiresApproval, false);
  assert.equal(executeCodeTool.parallelBatchKind, 'ptc_cell');
  assert.equal(waitTool.sideEffectLevel, 'none');
  assert.equal(waitTool.mayMutateComputerFiles, false);
  assert.equal(waitTool.requiresApproval, false);
  assert.equal(waitTool.parallelBatchKind, 'ptc_cell');
});

void test('exec exposes moduleFormat, timeoutMs, and yield-time_ms without aliases', async () => {
  const rejectedSnakeCaseYieldKey = ['yield', 'time', 'ms'].join('_');
  const parameters = executeCodeTool.parameters;
  assert.ok(isToolObjectParameters(parameters));
  assert.deepEqual(Object.keys(parameters.properties), [
    'code',
    'moduleFormat',
    'timeoutMs',
    'yield-time_ms',
  ]);
  assert.deepEqual(parameters.required, ['code']);
  const moduleFormatProperty = parameters.properties.moduleFormat as {
    description?: string;
    enum?: unknown[];
  };
  const timeoutProperty = parameters.properties.timeoutMs as {
    description?: string;
  };
  const yieldTimeProperty = parameters.properties['yield-time_ms'] as {
    description?: string;
  };
  assert.match(
    moduleFormatProperty.description ?? '',
    /static import.*top-level await/u,
  );
  assert.deepEqual(moduleFormatProperty.enum, ['commonjs', 'esm']);
  assert.match(
    timeoutProperty.description ?? '',
    /timeout_ms is not accepted/u,
  );
  assert.match(
    yieldTimeProperty.description ?? '',
    /exactly "yield-time_ms", with a hyphen/u,
  );
  assert.match(yieldTimeProperty.description ?? '', /status "queued"/u);

  const result = await executeCodeTool.execute(
    {
      code: 'return 1',
      module_format: 'esm',
      timeout_ms: 1_000,
      yield_time_ms: 1_000,
      yieldTimeMs: 1_000,
    },
    {
      callId: 'call-execute-code-schema-aliases',
      stateRoot: '/workspace/home-state',

      workingDirectory: 'project',
      threadId: testThreadId(910),
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(
    result.error ?? '',
    /unexpected keys:.*module_format.*timeout_ms/u,
  );
  assert.match(result.error ?? '', new RegExp(rejectedSnakeCaseYieldKey, 'u'));
  assert.match(result.error ?? '', /yieldTimeMs/u);
});

void test('exec requires an agent runtime service before executing code', async () => {
  const result = await executeCodeTool.execute(
    { code: 'console.log("hello")' },
    {
      callId: 'call-execute-code-no-runtime',
      stateRoot: '/workspace/home-state',

      workingDirectory: 'project',
      threadId: testThreadId(911),
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'execution_failed');
  assert.match(result.error ?? '', /runtime is required/u);
});

void test('exec returns compact runtime output without session identifiers', async () => {
  const daemonContext = createDaemonContext();
  let observedCode = '';
  let observedModuleFormat: string | undefined;
  let observedYieldTimeMs = 0;
  let observedPlacementResourceSnapshotId: string | undefined;
  let observedSdkToolNames: string[] = [];
  const ptcExecuteCode: PtcExecuteCodeRuntime = {
    async executeCode(args) {
      observedCode = args.request.code;
      observedModuleFormat = args.request.moduleFormat;
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
      stateRoot: '/workspace/home-state',
      workingDirectory: 'project',
    },
  });

  const result = await executeCodeTool.execute(
    {
      code: 'process.stdout.write(JSON.stringify({ answer: 42 }))',
      moduleFormat: 'esm',
      'yield-time_ms': 1_000,
    },
    {
      callId: 'call-execute-code-success',
      stateRoot: '/workspace/home-state',

      workingDirectory: 'project',
      threadId: runState.threadId,
      runState,
      agentSpawnRuntime: { ...daemonContext, ptcExecuteCode },
      callbackToolDispatcher: makeUnexpectedCallbackToolDispatcher(),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(
    observedCode,
    'process.stdout.write(JSON.stringify({ answer: 42 }))',
  );
  assert.equal(observedModuleFormat, 'esm');
  assert.equal(observedYieldTimeMs, 1_000);
  assert.equal(typeof observedPlacementResourceSnapshotId, 'string');
  assert.notEqual(observedPlacementResourceSnapshotId, '');
  assert.equal(observedSdkToolNames.includes('read_file'), true);
  assert.equal(observedSdkToolNames.includes('list_files'), true);
  assert.equal(observedSdkToolNames.includes('search_files'), true);
  assert.equal(observedSdkToolNames.includes('fetch_url'), true);
  assert.equal(observedSdkToolNames.includes('search_memory_index'), true);
  assert.equal(observedSdkToolNames.includes('web_fetch'), false);
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
      stateRoot: '/workspace/home-state',
      workingDirectory: 'project',
    },
  });

  const result = await executeCodeTool.execute(
    { code: 'return 1' },
    {
      callId: 'call-execute-code-shared-resource-snapshot',
      stateRoot: '/workspace/home-state',

      workingDirectory: 'project',
      threadId: runState.threadId,
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
  const computerFileRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-execute-code-callback-tool-'),
  );
  const daemonContext = createDaemonContext();
  const threadId = testThreadId(915);
  await writeFile(join(computerFileRoot, 'note.txt'), 'callback file\n');
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
      computerFileRoot,
      stateRoot: daemonContext.homeStateRoot,
      workingDirectory: '',
      threadId,
      agentSpawnRuntime: daemonContext,
      callbackToolDispatcher,
    });
    assert.ok(handler);
    const help = createPtcExecuteCodeToolCallbackHelp({
      callId: 'outer-execute-code-call',
      computerFileRoot,
      stateRoot: daemonContext.homeStateRoot,
      workingDirectory: '',
      threadId,
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
    assert.equal(callbackToolNames.includes('skill_search'), false);
    assert.equal(callbackToolNames.includes('tool_search'), false);
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
    await rm(computerFileRoot, { recursive: true, force: true });
  }
});

void test('exec resolves Home-owned SDK wrappers independently of cwd and rejects byte drift', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-execute-code-sdk-projection-'),
  );
  const workingDirectory = await mkdtemp(
    join(tmpdir(), 'geulbat-execute-code-working-directory-'),
  );
  const daemonContext = createDaemonContext();
  const threadId = testThreadId(9151);
  const callbackToolDispatcher = makeUnexpectedCallbackToolDispatcher();

  try {
    const resolved =
      await daemonContext.toolLibraryProjection.resolveProjection({
        stateRoot,
        threadId,
      });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) {
      assert.fail('expected PTC SDK projection to resolve');
    }
    const ctx = {
      callId: 'outer-execute-code-sdk-call',
      workingDirectory,
      stateRoot,
      threadId,
      agentSpawnRuntime: daemonContext,
      callbackToolDispatcher,
      toolLibraryProjectionIdentity: {
        sdkVersion: resolved.pin.sdkVersion,
        sdkProjectionHash: resolved.pin.sdkProjectionHash,
        policyId: resolved.pin.policyId,
      },
    };
    const sdk = await resolvePtcExecuteCodeToolSdkProjection(ctx);
    assert.equal(sdk.ok, true);
    if (!sdk.ok || sdk.projection === undefined) {
      assert.fail('expected executable multi-tool SDK projection');
    }
    assert.equal(sdk.projection.importSpecifier, 'geulbat-sdk');
    assert.equal(
      sdk.projection.runtimeCompatibilityRange,
      'ptc_execute_code_sdk_v1',
    );
    assert.deepEqual(
      sdk.projection.modules.map((module) => ({
        specifier: module.specifier,
        exportName: module.exportName,
      })),
      [
        {
          specifier: 'geulbat-sdk/tools/fetch-url',
          exportName: 'fetchUrl',
        },
        {
          specifier: 'geulbat-sdk/files/listFiles',
          exportName: 'listFiles',
        },
        {
          specifier: 'geulbat-sdk/files/readFile',
          exportName: 'readFile',
        },
        {
          specifier: 'geulbat-sdk/tools/read-tool-output',
          exportName: 'readToolOutput',
        },
        {
          specifier: 'geulbat-sdk/files/searchFiles',
          exportName: 'searchFiles',
        },
        {
          specifier: 'geulbat-sdk/tools/search-memory-index',
          exportName: 'searchMemoryIndex',
        },
      ],
    );
    const readFileModule = sdk.projection.modules.find(
      (module) => module.exportName === 'readFile',
    );
    assert.equal(readFileModule?.modulePath, 'files/readFile.js');
    assert.match(readFileModule?.sourceHash ?? '', /^sha256:[0-9a-f]{64}$/u);
    assert.match(sdk.projection.manifestSourceHash, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(
      sdk.projection.mount.hostRootPath,
      resolved.mount.projectionRootPath,
    );

    const readFileTool = resolved.projection.tools.find(
      (tool) => tool.publicName === 'read_file',
    );
    assert.ok(readFileTool);
    await writeFile(
      join(resolved.projection.rootPath, readFileTool.wrapperModule),
      'export const tampered = true;\n',
      'utf8',
    );
    assert.deepEqual(await resolvePtcExecuteCodeToolSdkProjection(ctx), {
      ok: false,
      message: 'The pinned PTC SDK projection could not be rehydrated',
    });
  } finally {
    await Promise.all([
      rm(stateRoot, { recursive: true, force: true }),
      rm(workingDirectory, { recursive: true, force: true }),
    ]);
  }
});

void test('exec fails closed when a pinned SDK projection lacks its runtime prerequisites', async () => {
  const result = await resolvePtcExecuteCodeToolSdkProjection({
    callId: 'outer-execute-code-sdk-runtime-unavailable',
    stateRoot: '/workspace/home-state',

    workingDirectory: 'project',
    threadId: testThreadId(9152),
    toolLibraryProjectionIdentity: {
      sdkVersion: 'geulbat-tool-library-sdk-v1',
      sdkProjectionHash:
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      policyId: 'ptc-sdk-read-tools-v1',
    },
  });

  assert.deepEqual(result, {
    ok: false,
    message: 'The pinned PTC SDK projection runtime is unavailable',
  });
});

void test('exec callback handler fails closed before long wait when dispatcher is unavailable', async () => {
  const daemonContext = createDaemonContext();
  const handler = createPtcExecuteCodeToolCallbackHandler({
    callId: 'outer-execute-code-call',
    stateRoot: '/workspace/home-state',

    workingDirectory: 'project',
    threadId: testThreadId(919),
    agentSpawnRuntime: daemonContext,
  });
  assert.ok(handler);
  assert.equal(
    createPtcExecuteCodeToolCallbackHelp({
      callId: 'outer-execute-code-call',
      stateRoot: '/workspace/home-state',

      workingDirectory: 'project',
      threadId: testThreadId(919),
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
    mayMutateComputerFiles: false,
    requiresApproval: false,
    exposure: {
      directHot: false,
      sdkVisible: true,
      inCellCallable: true,
      directOnly: false,
      effectClass: 'readOnly',
    },
    parseArgs: () => ({ ok: true, value: {} }),
    async executeParsed() {
      return { ok: true, output: 'slow-read-ok' };
    },
  });
  const handler = createPtcExecuteCodeToolCallbackHandler({
    callId: 'outer-execute-code-call',
    stateRoot: '/workspace/home-state',

    workingDirectory: 'project',
    threadId: testThreadId(918),
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
    stateRoot: '/workspace/home-state',

    workingDirectory: 'project',
    threadId: testThreadId(916),
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
  assert.equal(surface.allows('read_tool_output'), true);
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
      stateRoot: '/workspace/home-state',

      workingDirectory: 'project',
      threadId: testThreadId(917),
      allowedRegistryNames: [PTC_EXECUTE_CODE_TOOL_NAME],
      agentSpawnRuntime: { ...daemonContext, ptcExecuteCode },
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(observedSdkToolNames, []);
  assert.equal(observedDeniedCallback, true);
});

void test('exec callback surface predicate fails closed for incomplete or contradictory metadata', () => {
  const callableReadMeta = {
    sideEffectLevel: 'read',
    requiresApproval: false,
    mayMutateComputerFiles: false,
    exposure: {
      directHot: false,
      sdkVisible: true,
      inCellCallable: true,
      directOnly: false,
      effectClass: 'readOnly',
    },
  } as const;
  assert.equal(
    isPtcExecuteCodeCallbackToolMetaAllowed('read_file', callableReadMeta),
    true,
  );
  assert.equal(
    isPtcExecuteCodeCallbackToolMetaAllowed('search_memory_index', {
      ...callableReadMeta,
      sideEffectLevel: 'none',
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
      ...callableReadMeta,
      requiresApproval: true,
    }),
    false,
  );
  assert.equal(
    isPtcExecuteCodeCallbackToolMetaAllowed('read_file', {
      ...callableReadMeta,
      mayMutateComputerFiles: true,
    }),
    false,
  );
  assert.equal(
    isPtcExecuteCodeCallbackToolMetaAllowed('agent_wait', callableReadMeta),
    false,
  );
  assert.equal(
    isPtcExecuteCodeCallbackToolMetaAllowed(
      'agent_future_read',
      callableReadMeta,
    ),
    false,
  );
  assert.equal(
    isPtcExecuteCodeCallbackToolMetaAllowed(
      PTC_EXECUTE_CODE_TOOL_NAME,
      callableReadMeta,
    ),
    false,
  );
  assert.equal(
    isPtcExecuteCodeCallbackToolMetaAllowed(
      PTC_EXECUTE_CODE_FORBIDDEN_OLD_TOOL_NAME,
      callableReadMeta,
    ),
    false,
  );
  assert.equal(
    isPtcExecuteCodeCallbackToolMetaAllowed(
      PTC_EXECUTE_CODE_WAIT_TOOL_NAME,
      callableReadMeta,
    ),
    false,
  );
  const surface = resolvePtcExecuteCodeCallbackToolSurface({
    registry: createDaemonContext().toolRegistry,
    allowedRegistryNames: [
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
      stateRoot: '/workspace/home-state',

      workingDirectory: 'project',
      threadId: testThreadId(913),
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

void test('exec projects opt-in store commit summaries and structured conflict remediation', async () => {
  const daemonContext = createDaemonContext();
  let invocationCount = 0;
  const completedExecution = {
    ok: true as const,
    capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
    policyId: PTC_EXECUTE_CODE_POLICY_ID,
    labPolicyId: 'ptc_lab_local_docker_batch_command_v1',
    profile: 'lab' as const,
    executionClass: 'lab_execute_code' as const,
    executionSurface: 'node_via_lab_batch_command' as const,
    exitCode: 0,
    stdout: '',
    stderr: '',
    effectiveTimeoutMs: 60_000,
    durationMs: 12,
    toolCallbacks: { enabled: false, observed: 0 },
    sessionLifecycle: {
      mode: 'runtime_owned_reusable' as const,
      retainedAfterExecution: true as const,
    },
    callbackHelp: {
      protocolVersion: 'ptc_execute_code_sdk_v1' as const,
      helpAvailable: true,
      callbackToolCount: 0,
    },
  };
  const ptcExecuteCode: PtcExecuteCodeRuntime = {
    async executeCode() {
      invocationCount += 1;
      if (invocationCount === 1) {
        return {
          ok: true,
          value: {
            ...completedExecution,
            store: {
              committedKeys: ['note'],
              revisions: { note: 2 },
            },
          },
        };
      }
      return {
        ok: false,
        reasonCode: 'ptc_execute_code_store_commit_conflict',
        message: 'The PTC store write set conflicts with a newer revision',
        store: { discardedWrites: 1 },
        storeError: {
          errorCode: 'StoreCommitConflict',
          message: 'The PTC store write set conflicts with a newer revision',
          remediation:
            'Call geulbat.store.get("note"), re-apply the change, then call geulbat.store.set again.',
          details: {
            conflicts: [
              {
                key: 'note',
                baseRevision: 1,
                currentRevision: 2,
                lastWriterExecutionId: 'ptc_exec_winner',
              },
            ],
          },
        },
        execution: completedExecution,
      };
    },
    waitForCell: waitForUnusedCell,
    async closeAll() {
      return { ok: true };
    },
  };
  const toolContext = {
    stateRoot: '/workspace/home-state',

    workingDirectory: 'project',
    threadId: testThreadId(914),
    agentSpawnRuntime: { ...daemonContext, ptcExecuteCode },
  };

  const committed = await executeCodeTool.execute(
    { code: "await geulbat.store.set('note', 2)" },
    { ...toolContext, callId: 'call-execute-code-store-commit' },
  );
  assert.equal(committed.ok, true);
  assert.deepEqual(
    (JSON.parse(committed.output) as { store?: unknown }).store,
    {
      committedKeys: ['note'],
      revisions: { note: 2 },
    },
  );

  const conflict = await executeCodeTool.execute(
    { code: "await geulbat.store.set('note', 3)" },
    { ...toolContext, callId: 'call-execute-code-store-conflict' },
  );
  assert.equal(conflict.ok, false);
  assert.equal(conflict.errorCode, 'conflict');
  const conflictOutput = JSON.parse(conflict.output) as {
    store?: unknown;
    storeError?: { errorCode?: string; remediation?: string };
    execution?: { exitCode?: number };
  };
  assert.deepEqual(conflictOutput.store, { discardedWrites: 1 });
  assert.equal(conflictOutput.storeError?.errorCode, 'StoreCommitConflict');
  assert.match(conflictOutput.storeError?.remediation ?? '', /store\.get/u);
  assert.equal(conflictOutput.execution?.exitCode, 0);
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
      stateRoot: '/workspace/home-state',

      workingDirectory: 'project',
      threadId: testThreadId(914),
      agentSpawnRuntime: { ...daemonContext, ptcExecuteCode },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.equal(invoked, false);
});
