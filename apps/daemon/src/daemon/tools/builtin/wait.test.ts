import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PTC_EXECUTE_CODE_POLICY_ID,
  PTC_EXECUTE_CODE_TOOL_NAME,
  type PtcExecuteCodeRuntime,
} from '../../ptc/runtime/execute-code/execute-code-runtime-contract.js';
import { createDaemonContext } from '../../context.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { isToolObjectParameters } from '../types.js';
import { waitTool } from './wait.js';

void test('wait description teaches the exec running-cell protocol', () => {
  const parameters = waitTool.parameters;
  assert.ok(isToolObjectParameters(parameters));
  const cellIdProperty = parameters.properties.cell_id as {
    description?: string;
  };
  const yieldTimeProperty = parameters.properties['yield-time_ms'] as {
    description?: string;
  };

  assert.match(waitTool.description, /exec/u);
  assert.match(waitTool.description, /status "queued"/u);
  assert.match(waitTool.description, /status "running"/u);
  assert.match(waitTool.description, /cellId/u);
  assert.match(waitTool.description, /cell_id/u);
  assert.match(cellIdProperty.description ?? '', /cellId/u);
  assert.match(cellIdProperty.description ?? '', /cellId is not accepted/u);
  assert.match(cellIdProperty.description ?? '', /status "queued"/u);
  assert.match(cellIdProperty.description ?? '', /status "running"/u);
  assert.match(
    yieldTimeProperty.description ?? '',
    /yieldTimeMs is not accepted/u,
  );
});

void test('wait preserves a queued cell as visible scheduler state', async () => {
  const ptcExecuteCode: PtcExecuteCodeRuntime = {
    async executeCode() {
      throw new Error('exec was not expected');
    },
    async waitForCell() {
      return {
        ok: true,
        value: {
          ok: true,
          capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
          policyId: PTC_EXECUTE_CODE_POLICY_ID,
          executionSurface: 'node_via_lab_detached_cell',
          status: 'queued',
          cellId: 'ptc_cell_wait_queued',
          stdout: '',
          stderr: '',
        },
      };
    },
    async closeAll() {
      return { ok: true };
    },
  };

  const result = await waitTool.execute(
    { cell_id: 'ptc_cell_wait_queued', 'yield-time_ms': 1_000 },
    {
      callId: 'call-wait-queued',
      stateRoot: '/workspace/home-state',

      workingDirectory: 'project',
      threadId: testThreadId(920_1),
      agentSpawnRuntime: { ...createDaemonContext(), ptcExecuteCode },
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.output), {
    kind: 'ptc_execute_code_cell_wait',
    capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
    policyId: PTC_EXECUTE_CODE_POLICY_ID,
    executionSurface: 'node_via_lab_detached_cell',
    status: 'queued',
    cellId: 'ptc_cell_wait_queued',
    stdout: '',
    stderr: '',
  });
});

void test('wait exposes snake_case model-facing cell arguments without camelCase aliases', async () => {
  const parameters = waitTool.parameters;
  assert.ok(isToolObjectParameters(parameters));
  assert.deepEqual(Object.keys(parameters.properties), [
    'cell_id',
    'terminate',
    'yield-time_ms',
  ]);
  assert.deepEqual(parameters.required, ['cell_id']);

  const result = await waitTool.execute(
    { cellId: 'ptc_cell_camel_case' },
    {
      callId: 'call-wait-camel-case',
      stateRoot: '/workspace/home-state',

      workingDirectory: 'project',
      threadId: testThreadId(919),
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /cell_id is required/u);
  assert.match(result.error ?? '', /unexpected keys: cellId/u);

  const wrongYieldCase = await waitTool.execute(
    { cell_id: 'ptc_cell_snake_case', yieldTimeMs: 1_000 },
    {
      callId: 'call-wait-yield-camel-case',
      stateRoot: '/workspace/home-state',

      workingDirectory: 'project',
      threadId: testThreadId(918),
    },
  );

  assert.equal(wrongYieldCase.ok, false);
  assert.equal(wrongYieldCase.errorCode, 'invalid_args');
  assert.match(wrongYieldCase.error ?? '', /unexpected keys: yieldTimeMs/u);
});

void test('wait rejects blank cell_id at the parser boundary', async () => {
  const result = await waitTool.execute(
    { cell_id: '   ' },
    {
      callId: 'call-wait-blank-cell',
      stateRoot: '/workspace/home-state',

      workingDirectory: 'project',
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /cell_id is required/u);
});

void test('wait requires an agent runtime service before reading a cell', async () => {
  const result = await waitTool.execute(
    { cell_id: 'ptc_cell_missing' },
    {
      callId: 'call-wait-no-runtime',
      stateRoot: '/workspace/home-state',

      workingDirectory: 'project',
      threadId: testThreadId(920),
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'execution_failed');
  assert.match(result.error ?? '', /runtime is required/u);
});

void test('wait reads exec cell results through the current thread runtime', async () => {
  let observedThreadId = '';
  let observedCellId = '';
  let observedTerminate = false;
  let observedYieldTimeMs = 0;
  const ptcExecuteCode: PtcExecuteCodeRuntime = {
    async executeCode() {
      throw new Error('exec was not expected');
    },
    async waitForCell(args) {
      observedThreadId = args.runContext.threadId;
      observedCellId = args.request.cellId;
      observedTerminate = args.request.terminate === true;
      observedYieldTimeMs = args.request.yieldTimeMs ?? 0;
      return {
        ok: true,
        value: {
          ok: true,
          capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
          policyId: PTC_EXECUTE_CODE_POLICY_ID,
          executionSurface: 'node_via_lab_detached_cell',
          status: 'completed',
          cellId: 'ptc_cell_done',
          exitCode: 0,
          stdout: 'done\n',
          stderr: '',
          store: {
            committedKeys: ['note'],
            revisions: { note: 1 },
          },
        },
      };
    },
    async closeAll() {
      return { ok: true };
    },
  };

  const result = await waitTool.execute(
    { cell_id: 'ptc_cell_done', terminate: true, 'yield-time_ms': 1_000 },
    {
      callId: 'call-wait-completed',
      stateRoot: '/workspace/home-state',

      workingDirectory: 'project',
      threadId: testThreadId(921),
      agentSpawnRuntime: { ...createDaemonContext(), ptcExecuteCode },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(observedThreadId, testThreadId(921));
  assert.equal(observedCellId, 'ptc_cell_done');
  assert.equal(observedTerminate, true);
  assert.equal(observedYieldTimeMs, 1_000);
  assert.deepEqual(JSON.parse(result.output), {
    kind: 'ptc_execute_code_cell_wait',
    capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
    policyId: 'ptc_lab_execute_code_batch_node_v1',
    executionSurface: 'node_via_lab_detached_cell',
    status: 'completed',
    cellId: 'ptc_cell_done',
    exitCode: 0,
    stdout: 'done\n',
    stderr: '',
    store: {
      committedKeys: ['note'],
      revisions: { note: 1 },
    },
  });
});

void test('wait preserves detached-cell store commit conflicts as code-visible failures', async () => {
  const ptcExecuteCode: PtcExecuteCodeRuntime = {
    async executeCode() {
      throw new Error('exec was not expected');
    },
    async waitForCell() {
      return {
        ok: false,
        reasonCode: 'ptc_execute_code_store_commit_conflict',
        message: 'store revision changed',
        store: { discardedWrites: 1 },
        storeError: {
          errorCode: 'StoreCommitConflict',
          message: 'store revision changed',
          remediation: 'Read the current revision and re-apply the change.',
        },
      };
    },
    async closeAll() {
      return { ok: true };
    },
  };

  const result = await waitTool.execute(
    { cell_id: 'ptc_cell_store_conflict' },
    {
      callId: 'call-wait-store-conflict',
      stateRoot: '/workspace/home-state',

      workingDirectory: 'project',
      threadId: testThreadId(924),
      agentSpawnRuntime: { ...createDaemonContext(), ptcExecuteCode },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'execution_failed');
  assert.deepEqual(JSON.parse(result.output), {
    kind: 'ptc_execute_code_cell_wait_error',
    reasonCode: 'ptc_execute_code_store_commit_conflict',
    message: 'store revision changed',
    store: { discardedWrites: 1 },
    storeError: {
      errorCode: 'StoreCommitConflict',
      message: 'store revision changed',
      remediation: 'Read the current revision and re-apply the change.',
    },
  });
});

void test('wait maps runtime cancellation to an aborted tool result', async () => {
  const ptcExecuteCode: PtcExecuteCodeRuntime = {
    async executeCode() {
      throw new Error('exec was not expected');
    },
    async waitForCell() {
      return {
        ok: false,
        reasonCode: 'ptc_execute_code_cell_wait_cancelled',
        message: 'cell wait cancelled',
      };
    },
    async closeAll() {
      return { ok: true };
    },
  };

  const result = await waitTool.execute(
    { cell_id: 'ptc_cell_cancelled', 'yield-time_ms': 1_000 },
    {
      callId: 'call-wait-cancelled',
      stateRoot: '/workspace/home-state',

      workingDirectory: 'project',
      threadId: testThreadId(922),
      agentSpawnRuntime: { ...createDaemonContext(), ptcExecuteCode },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'aborted');
  assert.match(result.error ?? '', /cancelled/u);
});

void test('wait reports expired retained cell results distinctly from missing cells', async () => {
  let observedHasYieldTimeMs = true;
  const ptcExecuteCode: PtcExecuteCodeRuntime = {
    async executeCode() {
      throw new Error('exec was not expected');
    },
    async waitForCell(args) {
      observedHasYieldTimeMs = Object.hasOwn(args.request, 'yieldTimeMs');
      return {
        ok: true,
        value: {
          ok: true,
          capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
          policyId: PTC_EXECUTE_CODE_POLICY_ID,
          executionSurface: 'node_via_lab_detached_cell',
          status: 'expired',
          cellId: 'ptc_cell_expired',
          remediation: 'start_a_new_exec',
        },
      };
    },
    async closeAll() {
      return { ok: true };
    },
  };

  const result = await waitTool.execute(
    { cell_id: 'ptc_cell_expired' },
    {
      callId: 'call-wait-expired',
      stateRoot: '/workspace/home-state',

      workingDirectory: 'project',
      threadId: testThreadId(923),
      agentSpawnRuntime: { ...createDaemonContext(), ptcExecuteCode },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(observedHasYieldTimeMs, false);
  assert.deepEqual(JSON.parse(result.output), {
    kind: 'ptc_execute_code_cell_wait',
    capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
    policyId: 'ptc_lab_execute_code_batch_node_v1',
    executionSurface: 'node_via_lab_detached_cell',
    status: 'expired',
    cellId: 'ptc_cell_expired',
    remediation: 'start_a_new_exec',
  });
});
