import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { toApprovalClass } from '@geulbat/protocol/run-approval';

import { createAgentEvent, type AgentEvent } from './events.js';
import { executeFunctionCall } from './loop-tool-approval.js';
import {
  PTC_EXECUTE_CODE_POLICY_ID,
  PTC_EXECUTE_CODE_TOOL_NAME,
  type PtcExecuteCodeRuntime,
} from '../ptc/runtime/execute-code/execute-code-runtime-contract.js';
import { isRecord } from '../runtime-json.js';
import type { ToolExecutionContext } from '../tools/types.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import { registerOnce } from '../../test-support/loop-tool-execution-test-support.js';
import {
  createTestDaemonContext,
  makeApprovalResolvingEmitter,
  makeEmitter,
  makeExecutionRuntime,
  makePtcWriteCallbackSource,
  makeTestTool,
  startApprovalCheckpoint,
  withWriteCallbackKnob,
} from '../../test-support/loop-tool-approval.js';
import { testThreadId } from '../../test-support/thread-id.js';

void test('executeFunctionCall runs read-only tools without approval and forwards approvalGranted=false', async () => {
  const toolName = 'loop_tool_approval_read_test_tool';
  const daemonContext = createTestDaemonContext();
  let seenApprovalGranted: boolean | undefined;
  registerOnce(
    daemonContext,
    makeTestTool({
      name: toolName,
      description: 'read-only test tool',
      sideEffectLevel: 'read',
      requiresApproval: false,
      async executeParsed(_, ctx) {
        seenApprovalGranted = ctx.approvalGranted;
        return { ok: true, output: 'read-ok' };
      },
    }),
  );

  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-loop-approval-'));
  const threadId = testThreadId(81);
  const events: AgentEvent[] = [];

  const result = await executeFunctionCall({
    functionCall: {
      id: 'fc-read-only',
      callId: 'call-read-only',
      name: toolName,
      arguments: '{"path":"draft.md"}',
    },
    round: 0,
    toolArgs: { path: 'draft.md' },
    history: [],
    runtime: makeExecutionRuntime(daemonContext, {
      threadId,
      stateRoot: workspaceRoot,
      runId: 'run-read-only',
      approvalContext: makeApprovalContext(),
      emit: makeEmitter(events),
    }),
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      ok: true,
      output: 'read-ok',
    },
  });
  assert.equal(seenApprovalGranted, false);
  assert.deepEqual(events, []);
});

void test('executeFunctionCall auto-approves write tools in full_access mode', async () => {
  const toolName = 'loop_tool_approval_full_access_test_tool';
  const daemonContext = createTestDaemonContext();
  let seenApprovalGranted: boolean | undefined;
  registerOnce(
    daemonContext,
    makeTestTool({
      name: toolName,
      description: 'auto-approve write tool',
      sideEffectLevel: 'write',
      requiresApproval: true,
      async executeParsed(_, ctx) {
        seenApprovalGranted = ctx.approvalGranted;
        return { ok: true, output: 'write-ok' };
      },
    }),
  );

  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-loop-approval-'));
  const threadId = testThreadId(82);
  const events: AgentEvent[] = [];

  const result = await executeFunctionCall({
    functionCall: {
      id: 'fc-full-access',
      callId: 'call-full-access-tool',
      name: toolName,
      arguments: '{"path":"draft.md"}',
    },
    round: 0,
    toolArgs: { path: 'draft.md' },
    history: [],
    runtime: makeExecutionRuntime(daemonContext, {
      threadId,
      stateRoot: workspaceRoot,
      runId: 'run-full-access-tool',
      approvalContext: makeApprovalContext({
        computerSessionId: 'session-full-access-tool',
        permissionMode: 'full_access',
      }),
      emit: makeEmitter(events),
    }),
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      ok: true,
      output: 'write-ok',
    },
  });
  assert.equal(seenApprovalGranted, true);
  assert.deepEqual(events, []);
});

void test('planning workflow clamp blocks full_access write tools before trusted approval', async () => {
  const toolName = 'loop_tool_plan_clamp_full_access_write_test_tool';
  const daemonContext = createTestDaemonContext();
  let executed = false;
  registerOnce(
    daemonContext,
    makeTestTool({
      name: toolName,
      description: 'plan clamp write test tool',
      sideEffectLevel: 'write',
      requiresApproval: true,
      async executeParsed() {
        executed = true;
        return { ok: true, output: 'must-not-run' };
      },
    }),
  );

  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-plan-clamp-'));
  const threadId = testThreadId(82_3);
  const events: AgentEvent[] = [];
  const result = await executeFunctionCall({
    functionCall: {
      id: 'fc-plan-clamp',
      callId: 'call-plan-clamp',
      name: toolName,
      arguments: '{"path":"draft.md"}',
    },
    round: 0,
    toolArgs: { path: 'draft.md' },
    history: [],
    runtime: makeExecutionRuntime(daemonContext, {
      threadId,
      stateRoot: workspaceRoot,
      runId: 'run-plan-clamp',
      approvalContext: makeApprovalContext({
        permissionMode: 'full_access',
      }),
      emit: makeEmitter(events),
      planningWorkflow: { workflowId: 'workflow-plan-clamp' },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(executed, false);
  if (!result.ok) {
    return;
  }
  assert.equal(result.value.ok, false);
  assert.equal(result.value.errorCode, 'approval_required');
  assert.match(result.value.error ?? '', /PLAN_APPROVAL_REQUIRED/);
  assert.match(result.value.error ?? '', /not the plan approval gate/u);
  assert.deepEqual(result.value.ok ? undefined : result.value.diagnostics, {
    phase: 'admission',
    reasonCode: 'plan_approval_required',
    retryHint:
      'Approve and publish the exact current plan revision, then retry the tool.',
    gate: {
      kind: 'plan_approval',
      effectivePermissionMode: 'full_access',
    },
  });
  assert.deepEqual(events, []);
});

void test('an explicit full_access approval upgrades the current run before its next destructive tool', async () => {
  const firstToolName = 'loop_tool_approval_upgrade_write_test_tool';
  const secondToolName = 'loop_tool_approval_upgrade_destructive_test_tool';
  const daemonContext = createTestDaemonContext();
  const executed: string[] = [];
  const executedPermissionModes: Array<'basic' | 'full_access' | undefined> =
    [];
  for (const [name, sideEffectLevel] of [
    [firstToolName, 'write'],
    [secondToolName, 'destructive'],
  ] as const) {
    registerOnce(
      daemonContext,
      makeTestTool({
        name,
        description: 'current-run permission upgrade test tool',
        sideEffectLevel,
        requiresApproval: true,
        async executeParsed(_, ctx) {
          executed.push(name);
          executedPermissionModes.push(ctx.permissionMode);
          return { ok: true, output: name };
        },
      }),
    );
  }

  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-loop-approval-'));
  const threadId = testThreadId(82_2);
  const runId = 'run-current-permission-upgrade';
  const events: AgentEvent[] = [];
  const approvalContext = makeApprovalContext({ permissionMode: 'basic' });
  await startApprovalCheckpoint(daemonContext, threadId, runId);
  const runtime = makeExecutionRuntime(daemonContext, {
    threadId,
    stateRoot: workspaceRoot,
    runId,
    approvalContext,
    emit: makeApprovalResolvingEmitter(
      events,
      daemonContext,
      'approved',
      undefined,
      'full_access',
    ),
  });

  for (const [index, name] of [firstToolName, secondToolName].entries()) {
    const result = await executeFunctionCall({
      functionCall: {
        id: `fc-permission-upgrade-${index}`,
        callId: `call-permission-upgrade-${index}`,
        name,
        arguments: '{}',
      },
      round: index,
      toolArgs: {},
      history: [],
      runtime,
    });
    assert.equal(result.ok, true);
  }

  assert.equal(approvalContext.permissionMode, 'full_access');
  assert.deepEqual(executed, [firstToolName, secondToolName]);
  assert.deepEqual(executedPermissionModes, ['full_access', 'full_access']);
  assert.equal(
    events.filter((event) => event.type === 'approval_required').length,
    1,
  );
  assert.equal(
    (await daemonContext.runCheckpoints.readThread(threadId))?.request
      .permissionMode,
    'full_access',
  );
});

void test('executeFunctionCall can auto-approve from an injected approval grant store', async () => {
  const toolName = 'loop_tool_approval_grant_store_test_tool';
  const daemonContext = createTestDaemonContext();
  let seenApprovalGranted: boolean | undefined;
  registerOnce(
    daemonContext,
    makeTestTool({
      name: toolName,
      description: 'approval grant injection test tool',
      sideEffectLevel: 'destructive',
      requiresApproval: true,
      async executeParsed(_, ctx) {
        seenApprovalGranted = ctx.approvalGranted;
        return { ok: true, output: 'grant-ok' };
      },
    }),
  );

  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-loop-approval-'));
  const threadId = testThreadId(82_1);
  const approvalContext = makeApprovalContext({
    computerSessionId: 'session-grant-store-tool',
    permissionMode: 'basic',
  });
  daemonContext.approvalGrants.registerApprovalGrant(
    {
      runId: 'run-grant-store-tool',
      computerSessionId: approvalContext.computerSessionId,
      approvalClass: toApprovalClass(toolName),
      sideEffectLevel: 'destructive',
      permissionMode: approvalContext.permissionMode,
    },
    'run',
  );

  const events: AgentEvent[] = [];
  const result = await executeFunctionCall({
    functionCall: {
      id: 'fc-grant-store',
      callId: 'call-grant-store-tool',
      name: toolName,
      arguments: '{"path":"draft.md"}',
    },
    round: 0,
    toolArgs: { path: 'draft.md' },
    history: [],
    runtime: makeExecutionRuntime(daemonContext, {
      threadId,
      stateRoot: workspaceRoot,
      runId: 'run-grant-store-tool',
      approvalContext,
      emit: makeEmitter(events),
    }),
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      ok: true,
      output: 'grant-ok',
    },
  });
  assert.equal(seenApprovalGranted, true);
  assert.deepEqual(events, []);
});

void test('executeFunctionCall admits an SDK-visible no-effect callback from exec', async () => {
  const nestedToolName = 'loop_tool_approval_ptc_callback_none_test_tool';
  const daemonContext = createTestDaemonContext();
  let nestedCtx: ToolExecutionContext | undefined;
  registerOnce(
    daemonContext,
    makeTestTool({
      name: nestedToolName,
      description: 'PTC callback no-effect test tool',
      sideEffectLevel: 'none',
      requiresApproval: false,
      exposure: {
        directHot: false,
        sdkVisible: true,
        inCellCallable: true,
        directOnly: false,
        effectClass: 'readOnly',
      },
      async executeParsed(_, ctx) {
        nestedCtx = ctx;
        return {
          ok: true,
          output: JSON.stringify({ content: 'nested-ok' }),
        };
      },
    }),
  );

  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-loop-ptc-'));
  const threadId = testThreadId(82_2);
  const events: AgentEvent[] = [];
  const history: Parameters<typeof executeFunctionCall>[0]['history'] = [];
  const ptcExecuteCode: PtcExecuteCodeRuntime = {
    async executeCode(args) {
      const handler = args.toolCallbackHandler;
      const sdkHelp = args.sdkHelp;
      assert.equal(typeof handler, 'function');
      assert.ok(sdkHelp);
      assert.equal(
        sdkHelp.callbackTools.some((tool) => tool.name === nestedToolName),
        true,
      );
      if (!handler) {
        throw new Error('expected callback handler');
      }
      const callbackResult = await handler({
        requestId: 'runtime-read-1',
        toolName: nestedToolName,
        args: { path: 'draft.md' },
        signal: new AbortController().signal,
        enterLongWait: () => true,
      });
      if (!callbackResult.ok) {
        throw new Error(callbackResult.message);
      }
      assert.equal(callbackResult.ok, true);
      if (
        !isRecord(callbackResult.result) ||
        typeof callbackResult.result.output !== 'string'
      ) {
        throw new Error('expected execute result output');
      }
      assert.deepEqual(JSON.parse(callbackResult.result.output), {
        content: 'nested-ok',
      });
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
          stdout: 'callback-ok\n',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
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
            callbackToolCount: sdkHelp.callbackTools.length,
          },
        },
      };
    },
    async waitForCell() {
      return {
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
      };
    },
    async closeAll() {
      return { ok: true };
    },
  };

  const result = await executeFunctionCall({
    functionCall: {
      id: 'fc-execute-code',
      callId: 'call-execute-code',
      name: PTC_EXECUTE_CODE_TOOL_NAME,
      arguments: JSON.stringify({ code: 'return 1' }),
    },
    round: 0,
    toolArgs: { code: 'return 1' },
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      threadId,
      stateRoot: workspaceRoot,
      runId: 'run-ptc-callback',
      approvalContext: makeApprovalContext(),
      emit: makeEmitter(events),
      runtimeServices: {
        ...daemonContext,
        ptc: { ...daemonContext.ptc, executeCode: ptcExecuteCode },
      },
    }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(history, []);
  assert.equal(nestedCtx?.callId, 'call-execute-code::nested-1');
  assert.deepEqual(
    events.map((event) => event.type),
    ['tool_call', 'tool_result'],
  );
  const [toolCall, toolResult] = events;
  assert.equal(toolCall?.type, 'tool_call');
  if (toolCall?.type === 'tool_call') {
    assert.deepEqual(toolCall.payload.source, {
      kind: 'ptc_callback',
      parentCallId: 'call-execute-code',
      runtimeToolCallId: 'runtime-read-1',
    });
  }
  assert.equal(toolResult?.type, 'tool_result');
  if (toolResult?.type === 'tool_result') {
    assert.equal(toolResult.payload.callId, 'call-execute-code::nested-1');
    assert.deepEqual(toolResult.payload.source, {
      kind: 'ptc_callback',
      parentCallId: 'call-execute-code',
      runtimeToolCallId: 'runtime-read-1',
    });
  }
});

void test('executeFunctionCall rejects PTC callback write dispatch before approval or execution', async () => {
  const toolName = 'loop_tool_approval_ptc_callback_write_test_tool';
  const daemonContext = createTestDaemonContext();
  let executionCount = 0;
  registerOnce(
    daemonContext,
    makeTestTool({
      name: toolName,
      description: 'PTC callback write test tool',
      sideEffectLevel: 'write',
      requiresApproval: true,
      async executeParsed() {
        executionCount += 1;
        return { ok: true, output: 'should-not-run' };
      },
    }),
  );

  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-ptc-write-'),
  );
  const threadId = testThreadId(82_3);
  const events: AgentEvent[] = [];
  const history: Parameters<typeof executeFunctionCall>[0]['history'] = [];

  await assert.rejects(
    () =>
      executeFunctionCall({
        functionCall: {
          id: 'fc-ptc-callback-write',
          callId: 'call-execute-code::nested-write',
          name: toolName,
          arguments: '{"path":"draft.md"}',
        },
        round: 0,
        toolArgs: { path: 'draft.md' },
        history,
        runtime: makeExecutionRuntime(daemonContext, {
          threadId,
          stateRoot: workspaceRoot,
          runId: 'run-ptc-callback-write',
          approvalContext: makeApprovalContext(),
          emit: makeEmitter(events),
        }),
        source: {
          kind: 'ptc_callback',
          parentToolCallId: 'call-execute-code',
          runtimeToolCallId: 'runtime-write-1',
          hostCallId: 'call-execute-code::nested-write',
        },
        denialMode: 'code_visible',
      }),
    /PTC callback dispatch rejected a tool outside the admitted callback surface/u,
  );

  assert.equal(executionCount, 0);
  assert.deepEqual(events, []);
  assert.deepEqual(history, []);
});

void test('executeFunctionCall routes a delegated external callback through interactive approval with the built-in write tier disabled', async () => {
  const toolName = 'mcp_external_approval_callback_test';
  const approvalClass = toApprovalClass('mcp:external-test-server');
  const daemonContext = createTestDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-external-callback-'),
  );
  const threadId = testThreadId(82_4);
  const events: AgentEvent[] = [];
  let executionCount = 0;
  registerOnce(
    daemonContext,
    makeTestTool({
      name: toolName,
      description: 'Delegated external approval callback test tool',
      sideEffectLevel: 'write',
      requiresApproval: true,
      approvalClass,
      mayMutateComputerFiles: true,
      exposure: {
        directHot: false,
        sdkVisible: true,
        inCellCallable: true,
        directOnly: false,
        effectClass: 'hostStateMutation',
      },
      async executeParsed() {
        executionCount += 1;
        return { ok: true, output: 'external-ok' };
      },
    }),
  );
  await startApprovalCheckpoint(
    daemonContext,
    threadId,
    'run-external-callback',
  );

  const result = await withWriteCallbackKnob('0', () =>
    executeFunctionCall({
      functionCall: {
        id: 'fc-external-callback',
        callId: 'call-execute-code::external-callback',
        name: toolName,
        arguments: JSON.stringify({ path: 'outside-workspace.txt' }),
      },
      round: 0,
      toolArgs: { path: 'outside-workspace.txt' },
      history: [],
      runtime: makeExecutionRuntime(daemonContext, {
        threadId,
        stateRoot: workspaceRoot,
        runId: 'run-external-callback',
        approvalContext: makeApprovalContext(),
        emit: makeApprovalResolvingEmitter(events, daemonContext, 'approved'),
      }),
      source: makePtcWriteCallbackSource('external-callback'),
      denialMode: 'code_visible',
    }),
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value, { ok: true, output: 'external-ok' });
  }
  assert.equal(executionCount, 1);
  assert.deepEqual(
    events.map((event) => event.type),
    ['approval_required'],
  );
  const approvalEvent = events[0];
  assert.equal(approvalEvent?.type, 'approval_required');
  if (approvalEvent?.type === 'approval_required') {
    assert.equal(approvalEvent.payload.approvalClass, approvalClass);
    assert.equal(approvalEvent.payload.runId, 'run-external-callback');
    assert.equal(approvalEvent.payload.threadId, threadId);
  }
});

void test('executeFunctionCall resolves interactive approval against the owner run/thread target before execution', async () => {
  const toolName = 'loop_tool_approval_interactive_test_tool';
  const daemonContext = createTestDaemonContext();
  let seenApprovalGranted: boolean | undefined;
  registerOnce(
    daemonContext,
    makeTestTool({
      name: toolName,
      description: 'interactive approval test tool',
      sideEffectLevel: 'write',
      requiresApproval: true,
      async executeParsed(_, ctx) {
        seenApprovalGranted = ctx.approvalGranted;
        return { ok: true, output: 'approved-write-ok' };
      },
    }),
  );

  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-loop-approval-'));
  const threadId = testThreadId(83);
  const ownerThreadId = testThreadId(84);
  const history: Array<{
    kind: 'function_call_output';
    callId: string;
    output: string;
  }> = [];
  const events: AgentEvent[] = [];
  await startApprovalCheckpoint(daemonContext, ownerThreadId, 'run-owner');

  const result = await executeFunctionCall({
    functionCall: {
      id: 'fc-interactive',
      callId: 'call-interactive-tool',
      name: toolName,
      arguments: '{"path":"draft.md"}',
    },
    round: 0,
    toolArgs: { path: 'draft.md' },
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      threadId,
      stateRoot: workspaceRoot,
      runId: 'run-visible',
      approvalContext: makeApprovalContext({
        computerSessionId: 'session-interactive-tool',
        ownerRunId: 'run-owner',
        ownerThreadId,
      }),
      emit: (type, payload) => {
        const event: AgentEvent = createAgentEvent(type, payload);
        events.push(event);
        if (event.type === 'approval_required') {
          setTimeout(() => {
            void daemonContext.approvalGate.resolveApproval(
              event.payload.callId,
              event.payload.runId,
              event.payload.threadId,
              'approved',
            );
          }, 0);
        }
      },
    }),
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      ok: true,
      output: 'approved-write-ok',
    },
  });
  assert.equal(seenApprovalGranted, true);
  assert.deepEqual(
    events.map((event) => event.type),
    ['approval_required'],
  );
  const firstEvent = events[0];
  assert.equal(firstEvent?.type, 'approval_required');
  if (firstEvent?.type === 'approval_required') {
    assert.equal(firstEvent.payload.runId, 'run-owner');
    assert.equal(firstEvent.payload.threadId, ownerThreadId);
  }
  assert.deepEqual(history, []);
});

void test('executeFunctionCall returns terminal failure when approval is denied and does not execute the tool', async () => {
  const toolName = 'loop_tool_approval_denied_test_tool';
  const daemonContext = createTestDaemonContext();
  let executionCount = 0;
  registerOnce(
    daemonContext,
    makeTestTool({
      name: toolName,
      description: 'denied approval test tool',
      sideEffectLevel: 'write',
      requiresApproval: true,
      async executeParsed() {
        executionCount += 1;
        return { ok: true, output: 'should-not-run' };
      },
    }),
  );

  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-loop-approval-'));
  const threadId = testThreadId(85);
  const history: Array<{
    kind: 'function_call_output';
    callId: string;
    output: string;
  }> = [];
  const events: AgentEvent[] = [];
  await startApprovalCheckpoint(
    daemonContext,
    threadId,
    'run-denied-orchestration',
  );

  const result = await executeFunctionCall({
    functionCall: {
      id: 'fc-denied-orchestration',
      callId: 'call-denied-orchestration',
      name: toolName,
      arguments: '{"path":"draft.md"}',
    },
    round: 0,
    toolArgs: { path: 'draft.md' },
    history,
    runtime: makeExecutionRuntime(daemonContext, {
      threadId,
      stateRoot: workspaceRoot,
      runId: 'run-denied-orchestration',
      approvalContext: makeApprovalContext({
        computerSessionId: 'session-denied-orchestration',
      }),
      emit: (type, payload) => {
        const event: AgentEvent = createAgentEvent(type, payload);
        events.push(event);
        if (event.type === 'approval_required') {
          setTimeout(() => {
            void daemonContext.approvalGate.resolveApproval(
              event.payload.callId,
              event.payload.runId,
              event.payload.threadId,
              'denied',
            );
          }, 0);
        }
      },
    }),
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.result, { ok: false, finalProse: '' });
  }
  assert.equal(executionCount, 0);
  assert.deepEqual(
    events.map((event) => event.type),
    ['approval_required', 'tool_result', 'error'],
  );
  assert.equal(history.length, 1);
  assert.match(history[0]?.output ?? '', /approval_denied/);
});
