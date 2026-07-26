import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HistoryItem } from '../llm/index.js';
import { processFunctionCalls } from './loop-tool-execution.js';
import { createDaemonContext, type DaemonContext } from '../context.js';
import { createResourceBudgetProvider } from './resource-budget-provider.js';
import { createSubagentAdmissionController } from './subagent-concurrency.js';
import {
  PTC_EXECUTE_CODE_POLICY_ID,
  PTC_EXECUTE_CODE_TOOL_NAME,
  PTC_EXECUTE_CODE_WAIT_TOOL_NAME,
  type PtcExecuteCodeRuntime,
} from '../ptc/runtime/execute-code/execute-code-runtime-contract.js';
import { readTranscriptEntries } from '../sessions/transcript-log.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import { makeRunContext } from '../../test-support/run-context.js';
import { testThreadId } from '../../test-support/thread-id.js';
import { createRunState } from './runtime/run-state.js';
import {
  createDeferred,
  makeExecutionRuntime,
  makeTestTool,
  registerOnce,
} from '../../test-support/loop-tool-execution-test-support.js';

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
        computerSessionId: 'session-ptc-cell-gate',
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
  const daemonContext = createDaemonContext();
  const runtimeServices: DaemonContext = {
    ...daemonContext,
    ptc: { ...daemonContext.ptc, executeCode: ptcExecuteCode },
  };

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
    runtime: makeExecutionRuntime(runtimeServices, {
      runContext,
      runId: 'run-public-ptc-cell-gate',
      approvalContext: makeApprovalContext({
        computerSessionId: 'session-public-ptc-cell-gate',
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
  const daemonContext = createDaemonContext();
  const runtimeServices: DaemonContext = {
    ...daemonContext,
    ptc: { ...daemonContext.ptc, executeCode: ptcExecuteCode },
  };

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
    runtime: makeExecutionRuntime(runtimeServices, {
      runContext,
      runId: 'run-public-ptc-terminate-wait',
      approvalContext: makeApprovalContext({
        computerSessionId: 'session-public-ptc-terminate-wait',
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
  const observedUltraReasoning: Array<boolean | undefined> = [];
  const originalResourceBudgetProvider = createResourceBudgetProvider();
  const originalSubagentAdmission = createSubagentAdmissionController({});
  const daemonContext = createDaemonContext();
  const runtimeServices: DaemonContext = {
    ...daemonContext,
    agent: {
      ...daemonContext.agent,
      resourceBudgetProvider: {
        captureSnapshot(args = {}) {
          events.push('resource-snapshot');
          assert.equal(args.runState, runState);
          const snapshot = originalResourceBudgetProvider.captureSnapshot(args);
          sharedResourceSnapshotId = snapshot.snapshotId;
          return snapshot;
        },
      },
    },
    subagent: {
      ...daemonContext.subagent,
      admission: {
        reserveSubagentLaunchSlots(args) {
          events.push('subagent-admission');
          observedUltraReasoning.push(args.ultraReasoning);
          return originalSubagentAdmission.reserveSubagentLaunchSlots(args);
        },
      },
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
    runtime: makeExecutionRuntime(runtimeServices, {
      runContext,
      runId: 'run-ptc-cell-window',
      approvalContext: makeApprovalContext({
        computerSessionId: 'session-ptc-cell-window',
      }),
      emit: () => {},
      runState,
      ultraReasoning: true,
    }),
  });

  await allToolsStarted.promise;
  assert.deepEqual(events.slice(0, 2), [
    'resource-snapshot',
    'subagent-admission',
  ]);
  assert.deepEqual(observedUltraReasoning, [true]);
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
  const originalResourceBudgetProvider = createResourceBudgetProvider();
  const originalSubagentAdmission = createSubagentAdmissionController({});
  const ptcExecuteCode: PtcExecuteCodeRuntime = {
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
  const daemonContext = createDaemonContext();
  const runtimeServices: DaemonContext = {
    ...daemonContext,
    agent: {
      ...daemonContext.agent,
      resourceBudgetProvider: {
        captureSnapshot(args = {}) {
          events.push('resource-snapshot');
          assert.equal(args.runState, runState);
          const snapshot = originalResourceBudgetProvider.captureSnapshot(args);
          sharedResourceSnapshotId = snapshot.snapshotId;
          return snapshot;
        },
      },
    },
    subagent: {
      ...daemonContext.subagent,
      admission: {
        reserveSubagentLaunchSlots(args) {
          events.push('subagent-admission');
          return originalSubagentAdmission.reserveSubagentLaunchSlots(args);
        },
      },
    },
    ptc: { ...daemonContext.ptc, executeCode: ptcExecuteCode },
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
    runtime: makeExecutionRuntime(runtimeServices, {
      runContext,
      runId: 'run-public-exec-resource-window',
      approvalContext: makeApprovalContext({
        computerSessionId: 'session-public-exec-resource-window',
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
