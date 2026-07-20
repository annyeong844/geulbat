import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { toApprovalClass } from '@geulbat/protocol/run-approval';
import { assertRunId } from '@geulbat/protocol/ids';
import { createCallbackToolDispatcher } from './callback-tool-dispatcher.js';
import { threadFilePath } from '../sessions/paths.js';
import { readTranscriptEntries } from '../sessions/transcript-log.js';

import {
  createAgentEvent,
  type AgentEvent,
  type AgentEventEmitter,
} from './events.js';
import { executeFunctionCall } from './loop-tool-approval.js';
import {
  buildAgentToolExecutionContextBase,
  buildToolCallExecutionRuntime,
} from './loop-tool-runtime.js';
import { createDaemonContext } from '../context.js';
import {
  completeRun,
  createRunState,
  type RunState,
} from './runtime/run-state.js';
import {
  PTC_EXECUTE_CODE_POLICY_ID,
  PTC_EXECUTE_CODE_TOOL_NAME,
  type PtcExecuteCodeRuntime,
} from '../ptc/runtime/execute-code/execute-code-runtime-contract.js';
import { isRecord } from '../runtime-json.js';
import type {
  AnyTool,
  ExecuteResult,
  ToolExecutionContext,
  ToolParseResult,
} from '../tools/types.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import { createSymlinkOrSkip } from '../../test-support/symlink-test.js';
import { makeRunContext } from '../../test-support/run-context.js';
import { testThreadId } from '../../test-support/thread-id.js';

function createTestDaemonContext(): ReturnType<typeof createDaemonContext> {
  return createDaemonContext({
    homeStateRoot: join(tmpdir(), `geulbat-loop-approval-home-${randomUUID()}`),
  });
}

async function startApprovalCheckpoint(
  daemonContext: ReturnType<typeof createDaemonContext>,
  threadId: ReturnType<typeof testThreadId>,
  runId: string,
): Promise<void> {
  const result = await daemonContext.runCheckpoints.startRun({
    runId: assertRunId(runId),
    threadId,
    request: { workingDirectory: 'stories', permissionMode: 'basic' },
  });
  assert.equal(result.ok, true);
}

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
  requiresApproval: boolean;
  mayMutateComputerFiles?: boolean;
  exposure?: AnyTool['exposure'];
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
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    strict: true,
    sideEffectLevel: args.sideEffectLevel,
    mayMutateComputerFiles: args.mayMutateComputerFiles ?? false,
    timeoutMs: 1_000,
    requiresApproval: args.requiresApproval,
    ...(args.exposure === undefined ? {} : { exposure: args.exposure }),
    parseArgs: args.parseArgs ?? parseObjectArgs,
    executeParsed: args.executeParsed,
  };
}

function makeEmitter(events: AgentEvent[]): AgentEventEmitter {
  return (type, payload) => {
    events.push(createAgentEvent(type, payload));
  };
}

function makeExecutionRuntime(
  daemonContext: ReturnType<typeof createDaemonContext>,
  args: {
    threadId: ReturnType<typeof testThreadId>;
    stateRoot: string;
    computerFileRoot?: string;
    workingDirectory?: string;
    runId: string;
    approvalContext: ReturnType<typeof makeApprovalContext>;
    emit: ReturnType<typeof makeEmitter>;
    agentSpawnRuntime?: ReturnType<typeof createDaemonContext>;
    signal?: AbortSignal;
    runState?: RunState;
  },
) {
  return buildToolCallExecutionRuntime({
    approvalContext: args.approvalContext,
    emit: args.emit,
    toolRegistry: daemonContext.toolRegistry,
    approvalGate: daemonContext.approvalGate,
    approvalGrants: daemonContext.approvalGrants,
    executionContextBase: buildAgentToolExecutionContextBase({
      runContext: makeRunContext({
        threadId: args.threadId,
        stateRoot: args.stateRoot,
        workingDirectory: args.workingDirectory ?? '',
      }),
      runId: args.runId,
      approvalContext: args.approvalContext,
      emit: args.emit,
      currentFile: undefined,
      selection: undefined,
      signal: args.signal,
      runState: args.runState,
      ...(args.computerFileRoot === undefined
        ? {}
        : { computerFileRoot: args.computerFileRoot }),
      memoryIndex: undefined,
      agentSpawnRuntime: args.agentSpawnRuntime,
    }),
  });
}

// W2 helper: resolve the pending approval from the emitted event, like the
// web-shell would. Returns the emitter to pass into makeExecutionRuntime.
function makeApprovalResolvingEmitter(
  events: AgentEvent[],
  daemonContext: ReturnType<typeof createDaemonContext>,
  decision: 'approved' | 'denied',
  onApprovalRequired?: () => void | Promise<void>,
): AgentEventEmitter {
  return (type, payload) => {
    events.push(createAgentEvent(type, payload));
    if (type === 'approval_required') {
      const approval = payload as {
        callId: string;
        runId: string;
        threadId: string;
      };
      setTimeout(() => {
        void (async () => {
          await onApprovalRequired?.();
          void daemonContext.approvalGate.resolveApproval(
            approval.callId,
            approval.runId,
            approval.threadId,
            decision,
          );
        })();
      }, 0);
    }
  };
}

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
        sessionId: 'session-full-access-tool',
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
    sessionId: 'session-grant-store-tool',
    permissionMode: 'basic',
  });
  daemonContext.approvalGrants.registerApprovalGrant(
    {
      runId: 'run-grant-store-tool',
      sessionId: approvalContext.sessionId,
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
      agentSpawnRuntime: { ...daemonContext, ptcExecuteCode },
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
    /PTC callback dispatch currently supports only read-only no-approval tools/u,
  );

  assert.equal(executionCount, 0);
  assert.deepEqual(events, []);
  assert.deepEqual(history, []);
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
        sessionId: 'session-interactive-tool',
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
        sessionId: 'session-denied-orchestration',
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

async function withWriteCallbackKnob<T>(
  value: string,
  run: () => Promise<T>,
): Promise<T> {
  const envName = 'GEULBAT_PTC_WRITE_CALLBACK_ENABLED';
  const previous = process.env[envName];
  process.env[envName] = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env[envName];
    } else {
      process.env[envName] = previous;
    }
  }
}

function makePtcWriteCallbackSource(runtimeToolCallId: string) {
  return {
    kind: 'ptc_callback' as const,
    parentToolCallId: 'call-execute-code',
    runtimeToolCallId,
    hostCallId: `call-execute-code::${runtimeToolCallId}`,
  };
}

void test('W1: full_access auto-approves an admitted PTC write callback and mutates Computer files', async () => {
  const daemonContext = createTestDaemonContext();
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-w1-fullaccess-'));
  const threadId = testThreadId(84_1);
  const events: AgentEvent[] = [];

  await withWriteCallbackKnob('1', async () => {
    const result = await executeFunctionCall({
      functionCall: {
        id: 'fc-w1-full-access',
        callId: 'call-execute-code::nested-w1-1',
        name: 'manage_files',
        arguments: JSON.stringify({ operation: 'create', path: 'w1.txt' }),
      },
      round: 0,
      toolArgs: { operation: 'create', path: 'w1.txt' },
      history: [],
      runtime: makeExecutionRuntime(daemonContext, {
        threadId,
        stateRoot: workspaceRoot,
        computerFileRoot: workspaceRoot,
        workingDirectory: workspaceRoot,
        runId: 'run-w1-full-access',
        approvalContext: makeApprovalContext({ permissionMode: 'full_access' }),
        emit: makeEmitter(events),
      }),
      source: makePtcWriteCallbackSource('runtime-w1-1'),
      denialMode: 'code_visible',
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.ok, true);
    }
    const created = await stat(join(workspaceRoot, 'w1.txt'));
    assert.equal(created.isFile(), true);
    assert.equal(
      events.some((event) => event.type === 'approval_required'),
      false,
    );
  });
});

void test('W2: needs-approval PTC write callback waits and maps denial to a code-visible result', async () => {
  const daemonContext = createTestDaemonContext();
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-w2-denied-'));
  const threadId = testThreadId(84_2);
  const events: AgentEvent[] = [];
  await startApprovalCheckpoint(daemonContext, threadId, 'run-w2-denied');

  await withWriteCallbackKnob('1', async () => {
    const result = await executeFunctionCall({
      functionCall: {
        id: 'fc-w2-denied',
        callId: 'call-execute-code::nested-w2-2',
        name: 'manage_files',
        arguments: JSON.stringify({ operation: 'create', path: 'w2.txt' }),
      },
      round: 0,
      toolArgs: { operation: 'create', path: 'w2.txt' },
      history: [],
      runtime: makeExecutionRuntime(daemonContext, {
        threadId,
        stateRoot: workspaceRoot,
        computerFileRoot: workspaceRoot,
        workingDirectory: workspaceRoot,
        runId: 'run-w2-denied',
        approvalContext: makeApprovalContext(),
        emit: makeApprovalResolvingEmitter(events, daemonContext, 'denied'),
      }),
      source: makePtcWriteCallbackSource('runtime-w2-2'),
      denialMode: 'code_visible',
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.ok, false);
      assert.equal(result.value.errorCode, 'approval_denied');
    }
    assert.deepEqual(
      events.map((event) => event.type),
      ['approval_required'],
    );
    await assert.rejects(() => stat(join(workspaceRoot, 'w2.txt')));
    assert.equal(
      daemonContext.approvalGate.hasPendingApprovalEntry(
        'call-execute-code::nested-w2-2',
        'run-w2-denied',
        threadId,
      ),
      false,
    );
  });
});

void test('W2: granted PTC write callback executes once and mutates Computer files', async () => {
  const daemonContext = createTestDaemonContext();
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-w2-granted-'));
  const threadId = testThreadId(84_7);
  const events: AgentEvent[] = [];
  await startApprovalCheckpoint(daemonContext, threadId, 'run-w2-granted');

  await withWriteCallbackKnob('1', async () => {
    const result = await executeFunctionCall({
      functionCall: {
        id: 'fc-w2-granted',
        callId: 'call-execute-code::nested-w2-7',
        name: 'manage_files',
        arguments: JSON.stringify({ operation: 'create', path: 'w2.txt' }),
      },
      round: 0,
      toolArgs: { operation: 'create', path: 'w2.txt' },
      history: [],
      runtime: makeExecutionRuntime(daemonContext, {
        threadId,
        stateRoot: workspaceRoot,
        computerFileRoot: workspaceRoot,
        workingDirectory: workspaceRoot,
        runId: 'run-w2-granted',
        approvalContext: makeApprovalContext(),
        emit: makeApprovalResolvingEmitter(events, daemonContext, 'approved'),
      }),
      source: makePtcWriteCallbackSource('runtime-w2-7'),
      denialMode: 'code_visible',
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.ok, true);
    }
    assert.deepEqual(
      events.map((event) => event.type),
      ['approval_required'],
    );
    const created = await stat(join(workspaceRoot, 'w2.txt'));
    assert.equal(created.isFile(), true);
  });
});

void test('W2: aborted approval wait returns a code-visible aborted result and leaves no pending entry', async () => {
  const daemonContext = createTestDaemonContext();
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-w2-aborted-'));
  const threadId = testThreadId(84_8);
  const events: AgentEvent[] = [];
  const controller = new AbortController();
  await startApprovalCheckpoint(daemonContext, threadId, 'run-w2-aborted');
  const emit: AgentEventEmitter = (type, payload) => {
    events.push(createAgentEvent(type, payload));
    if (type === 'approval_required') {
      setTimeout(() => controller.abort(), 0);
    }
  };

  await withWriteCallbackKnob('1', async () => {
    const result = await executeFunctionCall({
      functionCall: {
        id: 'fc-w2-aborted',
        callId: 'call-execute-code::nested-w2-8',
        name: 'manage_files',
        arguments: JSON.stringify({ operation: 'create', path: 'w2.txt' }),
      },
      round: 0,
      toolArgs: { operation: 'create', path: 'w2.txt' },
      history: [],
      runtime: makeExecutionRuntime(daemonContext, {
        threadId,
        stateRoot: workspaceRoot,
        computerFileRoot: workspaceRoot,
        workingDirectory: workspaceRoot,
        runId: 'run-w2-aborted',
        approvalContext: makeApprovalContext(),
        emit,
        signal: controller.signal,
      }),
      source: makePtcWriteCallbackSource('runtime-w2-8'),
      denialMode: 'code_visible',
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.ok, false);
      assert.equal(result.value.errorCode, 'aborted');
    }
    assert.equal(
      daemonContext.approvalGate.hasPendingApprovalEntry(
        'call-execute-code::nested-w2-8',
        'run-w2-aborted',
        threadId,
      ),
      false,
    );
    await assert.rejects(() => stat(join(workspaceRoot, 'w2.txt')));
  });
});

void test('W2: class-only grants from direct approvals do not auto-approve PTC write callbacks', async () => {
  const daemonContext = createTestDaemonContext();
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-w1-grant-'));
  const threadId = testThreadId(84_3);
  const events: AgentEvent[] = [];
  const approvalContext = makeApprovalContext();
  const grantContext = {
    runId: 'run-w1-class-grant',
    threadId,
    sessionId: approvalContext.sessionId,
    approvalClass: toApprovalClass('manage_files:create'),
    sideEffectLevel: 'write' as const,
    permissionMode: approvalContext.permissionMode,
  };
  daemonContext.approvalGrants.registerApprovalGrant(grantContext, 'run');
  assert.equal(
    daemonContext.approvalGrants.hasApprovalGrant(grantContext),
    true,
  );
  await startApprovalCheckpoint(daemonContext, threadId, 'run-w1-class-grant');

  await withWriteCallbackKnob('1', async () => {
    const result = await executeFunctionCall({
      functionCall: {
        id: 'fc-w1-class-grant',
        callId: 'call-execute-code::nested-w1-3',
        name: 'manage_files',
        arguments: JSON.stringify({ operation: 'create', path: 'w1.txt' }),
      },
      round: 0,
      toolArgs: { operation: 'create', path: 'w1.txt' },
      history: [],
      runtime: makeExecutionRuntime(daemonContext, {
        threadId,
        stateRoot: workspaceRoot,
        computerFileRoot: workspaceRoot,
        workingDirectory: workspaceRoot,
        runId: 'run-w1-class-grant',
        approvalContext,
        emit: makeApprovalResolvingEmitter(events, daemonContext, 'denied'),
      }),
      source: makePtcWriteCallbackSource('runtime-w1-3'),
      denialMode: 'code_visible',
    });

    // The stored class grant is not consumed: the callback still had to go
    // through the interactive wait and the user's denial stands.
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.ok, false);
      assert.equal(result.value.errorCode, 'approval_denied');
    }
    assert.deepEqual(
      events.map((event) => event.type),
      ['approval_required'],
    );
    await assert.rejects(() => stat(join(workspaceRoot, 'w1.txt')));
  });
});

void test('W2: an interactive grant is not reused as auto-approval for the next PTC write callback', async () => {
  const daemonContext = createTestDaemonContext();
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-w2-noreuse-'));
  const threadId = testThreadId(84_9);
  const approvalContext = makeApprovalContext();
  await startApprovalCheckpoint(daemonContext, threadId, 'run-w2-noreuse');

  await withWriteCallbackKnob('1', async () => {
    const firstEvents: AgentEvent[] = [];
    // First callback: user approves with a run-scoped "always allow" grant.
    const first = await executeFunctionCall({
      functionCall: {
        id: 'fc-w2-noreuse-1',
        callId: 'call-execute-code::nested-w2-9a',
        name: 'manage_files',
        arguments: JSON.stringify({ operation: 'create', path: 'first.txt' }),
      },
      round: 0,
      toolArgs: { operation: 'create', path: 'first.txt' },
      history: [],
      runtime: makeExecutionRuntime(daemonContext, {
        threadId,
        stateRoot: workspaceRoot,
        computerFileRoot: workspaceRoot,
        workingDirectory: workspaceRoot,
        runId: 'run-w2-noreuse',
        approvalContext,
        emit: (type, payload) => {
          firstEvents.push(createAgentEvent(type, payload));
          if (type === 'approval_required') {
            const approval = payload as {
              callId: string;
              runId: string;
              threadId: string;
            };
            setTimeout(() => {
              void daemonContext.approvalGate.resolveApproval(
                approval.callId,
                approval.runId,
                approval.threadId,
                'approved',
                'run',
              );
            }, 0);
          }
        },
      }),
      source: makePtcWriteCallbackSource('runtime-w2-9a'),
      denialMode: 'code_visible',
    });
    assert.equal(first.ok, true);
    if (first.ok) {
      assert.equal(first.value.ok, true);
    }

    // Second callback in the same run/class: the recorded grant must not be
    // consumed as auto-approval evidence — it waits again and denial stands.
    const secondEvents: AgentEvent[] = [];
    const second = await executeFunctionCall({
      functionCall: {
        id: 'fc-w2-noreuse-2',
        callId: 'call-execute-code::nested-w2-9b',
        name: 'manage_files',
        arguments: JSON.stringify({ operation: 'create', path: 'second.txt' }),
      },
      round: 0,
      toolArgs: { operation: 'create', path: 'second.txt' },
      history: [],
      runtime: makeExecutionRuntime(daemonContext, {
        threadId,
        stateRoot: workspaceRoot,
        computerFileRoot: workspaceRoot,
        workingDirectory: workspaceRoot,
        runId: 'run-w2-noreuse',
        approvalContext,
        emit: makeApprovalResolvingEmitter(
          secondEvents,
          daemonContext,
          'denied',
        ),
      }),
      source: makePtcWriteCallbackSource('runtime-w2-9b'),
      denialMode: 'code_visible',
    });
    assert.equal(second.ok, true);
    if (second.ok) {
      assert.equal(second.value.ok, false);
      assert.equal(second.value.errorCode, 'approval_denied');
    }
    assert.deepEqual(
      secondEvents.map((event) => event.type),
      ['approval_required'],
    );
    await assert.rejects(() => stat(join(workspaceRoot, 'second.txt')));
  });
});

void test('W2: mutation is re-validated after the approval wait (symlink swap is rejected)', async (t) => {
  const daemonContext = createTestDaemonContext();
  const outerRoot = await mkdtemp(join(tmpdir(), 'geulbat-w2-toctou-'));
  const workspaceRoot = join(outerRoot, 'workspace');
  const escapeRoot = join(outerRoot, 'outside');
  await mkdir(join(workspaceRoot, 'sub'), { recursive: true });
  await mkdir(escapeRoot, { recursive: true });
  const threadId = testThreadId(85_0);
  const events: AgentEvent[] = [];
  let symlinkCreated = true;
  await startApprovalCheckpoint(daemonContext, threadId, 'run-w2-toctou');

  await withWriteCallbackKnob('1', async () => {
    const result = await executeFunctionCall({
      functionCall: {
        id: 'fc-w2-toctou',
        callId: 'call-execute-code::nested-w2-10',
        name: 'manage_files',
        arguments: JSON.stringify({
          operation: 'create',
          path: 'sub/w2.txt',
        }),
      },
      round: 0,
      toolArgs: { operation: 'create', path: 'sub/w2.txt' },
      history: [],
      runtime: makeExecutionRuntime(daemonContext, {
        threadId,
        stateRoot: workspaceRoot,
        computerFileRoot: workspaceRoot,
        workingDirectory: workspaceRoot,
        runId: 'run-w2-toctou',
        approvalContext: makeApprovalContext(),
        emit: makeApprovalResolvingEmitter(
          events,
          daemonContext,
          'approved',
          async () => {
            // While the approval waits, the admitted parent directory is
            // swapped for a symlink escaping ComputerFileScope.
            await rm(join(workspaceRoot, 'sub'), {
              recursive: true,
              force: true,
            });
            symlinkCreated = await createSymlinkOrSkip(
              t,
              escapeRoot,
              join(workspaceRoot, 'sub'),
            );
          },
        ),
      }),
      source: makePtcWriteCallbackSource('runtime-w2-10'),
      denialMode: 'code_visible',
    });

    if (!symlinkCreated) {
      return;
    }
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.ok, false);
    }
    await assert.rejects(() => stat(join(escapeRoot, 'w2.txt')));
  });
});

void test('W1: write tools outside the allowlist and destructive operations stay rejected with the knob on', async () => {
  const daemonContext = createTestDaemonContext();
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-w1-reject-'));
  const threadId = testThreadId(84_4);
  const events: AgentEvent[] = [];

  await withWriteCallbackKnob('1', async () => {
    const runtime = makeExecutionRuntime(daemonContext, {
      threadId,
      stateRoot: workspaceRoot,
      computerFileRoot: workspaceRoot,
      workingDirectory: workspaceRoot,
      runId: 'run-w1-reject',
      approvalContext: makeApprovalContext({ permissionMode: 'full_access' }),
      emit: makeEmitter(events),
    });

    await assert.rejects(
      () =>
        executeFunctionCall({
          functionCall: {
            id: 'fc-w1-write-file',
            callId: 'call-execute-code::nested-w1-4',
            name: 'write_file',
            arguments: JSON.stringify({ path: 'w1.txt', content: 'nope' }),
          },
          round: 0,
          toolArgs: { path: 'w1.txt', content: 'nope' },
          history: [],
          runtime,
          source: makePtcWriteCallbackSource('runtime-w1-4'),
          denialMode: 'code_visible',
        }),
      /PTC callback dispatch rejected a tool outside the admitted callback surface/u,
    );

    await assert.rejects(
      () =>
        executeFunctionCall({
          functionCall: {
            id: 'fc-w1-delete',
            callId: 'call-execute-code::nested-w1-5',
            name: 'manage_files',
            arguments: JSON.stringify({ operation: 'delete', path: 'w1.txt' }),
          },
          round: 0,
          toolArgs: { operation: 'delete', path: 'w1.txt' },
          history: [],
          runtime,
          source: makePtcWriteCallbackSource('runtime-w1-5'),
          denialMode: 'code_visible',
        }),
      /PTC callback dispatch rejected a tool outside the admitted callback surface/u,
    );

    assert.deepEqual(events, []);
  });
});

void test('W1: full_access preserves host-wide Computer paths for PTC write callbacks', async () => {
  const daemonContext = createTestDaemonContext();
  const outerRoot = await mkdtemp(join(tmpdir(), 'geulbat-w1-boundary-'));
  const workspaceRoot = join(outerRoot, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  const threadId = testThreadId(84_5);
  const events: AgentEvent[] = [];

  await withWriteCallbackKnob('1', async () => {
    const result = await executeFunctionCall({
      functionCall: {
        id: 'fc-w1-boundary',
        callId: 'call-execute-code::nested-w1-6',
        name: 'manage_files',
        arguments: JSON.stringify({
          operation: 'create',
          path: '../escape.txt',
        }),
      },
      round: 0,
      toolArgs: { operation: 'create', path: '../escape.txt' },
      history: [],
      runtime: makeExecutionRuntime(daemonContext, {
        threadId,
        stateRoot: workspaceRoot,
        computerFileRoot: workspaceRoot,
        workingDirectory: workspaceRoot,
        runId: 'run-w1-boundary',
        approvalContext: makeApprovalContext({ permissionMode: 'full_access' }),
        emit: makeEmitter(events),
      }),
      source: makePtcWriteCallbackSource('runtime-w1-6'),
      denialMode: 'code_visible',
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.ok, true);
    }
    const created = await stat(join(outerRoot, 'escape.txt'));
    assert.equal(created.isFile(), true);
    assert.equal(
      events.some((event) => event.type === 'approval_required'),
      false,
    );
  });
});

void test('W1: callback dispatcher reports changed-files on successful writes and audits the approval class', async () => {
  const daemonContext = createTestDaemonContext();
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-w1-audit-'));
  const threadId = testThreadId(84_6);
  const events: AgentEvent[] = [];
  const runtime = makeExecutionRuntime(daemonContext, {
    threadId,
    stateRoot: workspaceRoot,
    computerFileRoot: workspaceRoot,
    workingDirectory: workspaceRoot,
    runId: 'run-w1-audit',
    approvalContext: makeApprovalContext(),
    emit: makeEmitter(events),
  });

  const canned = new Map<string, ExecuteResult>([
    ['manage_files', { ok: true, output: 'created' }],
    [
      'apply_patch',
      {
        ok: false,
        output: '',
        errorCode: 'approval_denied',
        error: 'approval denied',
      },
    ],
    ['read_file', { ok: true, output: 'read-ok' }],
  ]);
  const dispatcher = createCallbackToolDispatcher({
    runtime,
    history: [],
    parentRound: 0,
    parentToolCallId: 'call-execute-code',
    dispatchFunctionCall: async ({ functionCall }) => {
      const result = canned.get(functionCall.name);
      assert.ok(result);
      return { ok: true, value: result };
    },
  });

  const writeOk = await dispatcher.dispatch({
    toolName: 'manage_files',
    args: { operation: 'create', path: 'a.txt' },
    runtimeToolCallId: 'rt-write-1',
    signal: new AbortController().signal,
  });
  assert.equal(writeOk.ok, true);

  const writeDenied = await dispatcher.dispatch({
    toolName: 'apply_patch',
    args: { path: 'a.txt' },
    runtimeToolCallId: 'rt-write-2',
    signal: new AbortController().signal,
  });
  assert.equal(writeDenied.ok, false);

  const readOk = await dispatcher.dispatch({
    toolName: 'read_file',
    args: { path: 'a.txt' },
    runtimeToolCallId: 'rt-read-1',
    signal: new AbortController().signal,
  });
  assert.equal(readOk.ok, true);

  const toolResults = events.filter((event) => event.type === 'tool_result');
  assert.equal(toolResults.length, 3);
  const changedFlags = toolResults.map((event) =>
    event.type === 'tool_result'
      ? event.payload.computerFilesMayHaveChanged
      : undefined,
  );
  assert.deepEqual(changedFlags, [true, false, false]);

  const transcript = await readFile(
    threadFilePath(workspaceRoot, threadId),
    'utf8',
  );
  const writeCallLine = transcript
    .split('\n')
    .find(
      (line) => line.includes('"tool_call"') && line.includes('rt-write-1'),
    );
  assert.ok(writeCallLine);
  assert.match(writeCallLine, /approvalClass/u);
  assert.match(writeCallLine, /manage_files:create/u);
  const readCallLine = transcript
    .split('\n')
    .find((line) => line.includes('"tool_call"') && line.includes('rt-read-1'));
  assert.ok(readCallLine);
  assert.equal(readCallLine.includes('approvalClass'), false);
});

void test('PTC read_tool_output keeps the page code-visible while audit records only its immutable range', async () => {
  const daemonContext = createTestDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-read-output-audit-'),
  );
  const threadId = testThreadId(84_7);
  const events: AgentEvent[] = [];
  const pageContent = `AUDIT_PAGE_CONTENT_MUST_NOT_REPEAT_${'x'.repeat(256)}`;
  const outputRef = `tool-output:${threadId}/run-read-output/source-call`;
  const pageOutput = JSON.stringify({
    ok: true,
    outputRef,
    toolName: 'search_files',
    contentType: 'application/json',
    offset: 0,
    limit: 4_000,
    endOffset: pageContent.length,
    totalChars: pageContent.length,
    hasMore: false,
    nextOffset: null,
    content: pageContent,
  });
  const runtime = makeExecutionRuntime(daemonContext, {
    threadId,
    stateRoot: workspaceRoot,
    computerFileRoot: workspaceRoot,
    workingDirectory: workspaceRoot,
    runId: 'run-read-output-audit',
    approvalContext: makeApprovalContext(),
    emit: makeEmitter(events),
  });
  const dispatcher = createCallbackToolDispatcher({
    runtime,
    history: [],
    parentRound: 0,
    parentToolCallId: 'call-execute-code-read-output',
    dispatchFunctionCall: async () => ({
      ok: true,
      value: { ok: true, output: pageOutput },
    }),
  });

  try {
    const cellResult = await dispatcher.dispatch({
      toolName: 'read_tool_output',
      args: { outputRef, offset: 0, limit: 4_000 },
      runtimeToolCallId: 'rt-read-output-1',
      signal: new AbortController().signal,
    });
    assert.deepEqual(cellResult, { ok: true, output: pageOutput });

    const resultEvent = events.find(
      (event) =>
        event.type === 'tool_result' &&
        event.payload.tool === 'read_tool_output',
    );
    assert.ok(resultEvent?.type === 'tool_result');
    assert.ok(isRecord(resultEvent.payload.raw));
    assert.equal(resultEvent.payload.raw['content'], undefined);
    assert.equal(
      resultEvent.payload.raw['auditProjection'],
      'read_tool_output_page_ref_v1',
    );
    assert.equal(resultEvent.payload.raw['contentChars'], pageContent.length);
    assert.equal(
      resultEvent.payload.raw['contentBytes'],
      Buffer.byteLength(pageContent, 'utf8'),
    );
    assert.match(resultEvent.payload.displayText, /content omitted/u);
    assert.doesNotMatch(
      resultEvent.payload.displayText,
      /AUDIT_PAGE_CONTENT_MUST_NOT_REPEAT_/u,
    );

    const transcript = await readFile(
      threadFilePath(workspaceRoot, threadId),
      'utf8',
    );
    assert.doesNotMatch(transcript, /AUDIT_PAGE_CONTENT_MUST_NOT_REPEAT_/u);
    assert.match(transcript, /read_tool_output_page_ref_v1/u);
    const transcriptEntries = await readTranscriptEntries(
      workspaceRoot,
      threadId,
    );
    assert.equal(transcriptEntries.length, 2);
    for (const entry of transcriptEntries) {
      const record: unknown = JSON.parse(entry.content);
      assert.ok(isRecord(record));
      assert.equal(record['historyMode'], 'audit_only');
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test('W2: detached-cell callbacks use the same interactive approval path', async () => {
  const daemonContext = createTestDaemonContext();
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-w2-cell-'));
  const threadId = testThreadId(85_1);
  const events: AgentEvent[] = [];
  await startApprovalCheckpoint(daemonContext, threadId, 'run-w2-cell');

  await withWriteCallbackKnob('1', async () => {
    const result = await executeFunctionCall({
      functionCall: {
        id: 'fc-w2-cell',
        callId: 'call-execute-code::nested-w2-11',
        name: 'manage_files',
        arguments: JSON.stringify({ operation: 'create', path: 'cell.txt' }),
      },
      round: 0,
      toolArgs: { operation: 'create', path: 'cell.txt' },
      history: [],
      runtime: makeExecutionRuntime(daemonContext, {
        threadId,
        stateRoot: workspaceRoot,
        computerFileRoot: workspaceRoot,
        workingDirectory: workspaceRoot,
        runId: 'run-w2-cell',
        approvalContext: makeApprovalContext(),
        emit: makeApprovalResolvingEmitter(events, daemonContext, 'approved'),
      }),
      source: {
        ...makePtcWriteCallbackSource('runtime-w2-11'),
        cellId: 'ptc_cell_w2_test',
      },
      denialMode: 'code_visible',
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.ok, true);
    }
    assert.deepEqual(
      events.map((event) => event.type),
      ['approval_required'],
    );
    const created = await stat(join(workspaceRoot, 'cell.txt'));
    assert.equal(created.isFile(), true);
  });
});

void test('W2: callbacks that outlive the settled parent run fall back to a no-wait rejection', async () => {
  const daemonContext = createTestDaemonContext();
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-w2-postrun-'));
  const threadId = testThreadId(85_2);
  const events: AgentEvent[] = [];
  const runState = createRunState({
    runId: '00000000-0000-4000-8000-000000000052',
    runContext: makeRunContext({
      threadId,
      stateRoot: workspaceRoot,
    }),
  });
  completeRun(runState);

  await withWriteCallbackKnob('1', async () => {
    const result = await executeFunctionCall({
      functionCall: {
        id: 'fc-w2-postrun',
        callId: 'call-execute-code::nested-w2-12',
        name: 'manage_files',
        arguments: JSON.stringify({ operation: 'create', path: 'late.txt' }),
      },
      round: 0,
      toolArgs: { operation: 'create', path: 'late.txt' },
      history: [],
      runtime: makeExecutionRuntime(daemonContext, {
        threadId,
        stateRoot: workspaceRoot,
        computerFileRoot: workspaceRoot,
        workingDirectory: workspaceRoot,
        runId: '00000000-0000-4000-8000-000000000052',
        approvalContext: makeApprovalContext(),
        emit: makeEmitter(events),
        runState,
      }),
      source: {
        ...makePtcWriteCallbackSource('runtime-w2-12'),
        cellId: 'ptc_cell_w2_postrun',
      },
      denialMode: 'code_visible',
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.ok, false);
      assert.equal(result.value.errorCode, 'approval_required');
      assert.match(result.value.error ?? '', /already settled/u);
    }
    // No prompt is emitted and nothing waits: the settled run has no channel
    // left that could resolve it.
    assert.deepEqual(events, []);
    assert.equal(
      daemonContext.approvalGate.hasPendingApprovalEntry(
        'call-execute-code::nested-w2-12',
        '00000000-0000-4000-8000-000000000052',
        threadId,
      ),
      false,
    );
    await assert.rejects(() => stat(join(workspaceRoot, 'late.txt')));
  });
});

function makeArtifactFrameSource(runtimeToolCallId: string) {
  return {
    kind: 'artifact_frame' as const,
    scopeHandle: 'scope-artifact-frame-test',
    runtimeToolCallId,
    hostCallId: `artifact-frame-${runtimeToolCallId}`,
  };
}

void test('artifact_frame data_only dispatch runs an admitted read-only callback tool', async () => {
  const toolName = 'loop_tool_approval_artifact_frame_read_test_tool';
  const daemonContext = createTestDaemonContext();
  registerOnce(
    daemonContext,
    makeTestTool({
      name: toolName,
      description: 'artifact frame read-only test tool',
      sideEffectLevel: 'read',
      requiresApproval: false,
      exposure: {
        directHot: false,
        sdkVisible: true,
        inCellCallable: true,
        directOnly: false,
        effectClass: 'readOnly',
      },
      async executeParsed() {
        return { ok: true, output: 'frame-read-ok' };
      },
    }),
  );

  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-frame-read-'));
  const threadId = testThreadId(86_1);
  const events: AgentEvent[] = [];

  const result = await executeFunctionCall({
    functionCall: {
      id: 'fc-frame-read',
      callId: 'artifact-frame-rt-read-1',
      name: toolName,
      arguments: '{"path":"draft.md"}',
    },
    round: 0,
    toolArgs: { path: 'draft.md' },
    history: [],
    runtime: makeExecutionRuntime(daemonContext, {
      threadId,
      stateRoot: workspaceRoot,
      runId: 'run-frame-read',
      approvalContext: makeApprovalContext(),
      emit: makeEmitter(events),
    }),
    source: makeArtifactFrameSource('rt-read-1'),
    denialMode: 'data_only',
  });

  assert.deepEqual(result, {
    ok: true,
    value: { ok: true, output: 'frame-read-ok' },
  });
  assert.deepEqual(events, []);
});

void test('artifact_frame data_only rejects tools outside the shared callback surface as data', async () => {
  const toolName = 'loop_tool_approval_artifact_frame_reject_test_tool';
  const daemonContext = createTestDaemonContext();
  let executionCount = 0;
  registerOnce(
    daemonContext,
    makeTestTool({
      name: toolName,
      description: 'artifact frame non-admitted test tool',
      sideEffectLevel: 'read',
      requiresApproval: false,
      // exposure 없음 → sdkVisible 아님 → 공유 surface 밖
      async executeParsed() {
        executionCount += 1;
        return { ok: true, output: 'should-not-run' };
      },
    }),
  );

  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-frame-reject-'));
  const threadId = testThreadId(86_2);
  const events: AgentEvent[] = [];

  const result = await executeFunctionCall({
    functionCall: {
      id: 'fc-frame-reject',
      callId: 'artifact-frame-rt-reject-1',
      name: toolName,
      arguments: '{"path":"draft.md"}',
    },
    round: 0,
    toolArgs: { path: 'draft.md' },
    history: [],
    runtime: makeExecutionRuntime(daemonContext, {
      threadId,
      stateRoot: workspaceRoot,
      runId: 'run-frame-reject',
      approvalContext: makeApprovalContext(),
      emit: makeEmitter(events),
    }),
    source: makeArtifactFrameSource('rt-reject-1'),
    denialMode: 'data_only',
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.ok, false);
    assert.equal(result.value.errorCode, 'approval_required');
    assert.match(
      result.value.error ?? '',
      /outside the artifact frame callback surface/u,
    );
  }
  assert.equal(executionCount, 0);
  assert.deepEqual(events, []);
});

void test('artifact_frame source with terminal denialMode violates the dispatch invariant', async () => {
  const daemonContext = createTestDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-frame-invariant-'),
  );
  const threadId = testThreadId(86_3);
  const events: AgentEvent[] = [];

  await assert.rejects(
    () =>
      executeFunctionCall({
        functionCall: {
          id: 'fc-frame-invariant',
          callId: 'artifact-frame-rt-invariant-1',
          name: 'read_file',
          arguments: '{"path":"draft.md"}',
        },
        round: 0,
        toolArgs: { path: 'draft.md' },
        history: [],
        runtime: makeExecutionRuntime(daemonContext, {
          threadId,
          stateRoot: workspaceRoot,
          runId: 'run-frame-invariant',
          approvalContext: makeApprovalContext(),
          emit: makeEmitter(events),
        }),
        source: makeArtifactFrameSource('rt-invariant-1'),
        denialMode: 'terminal',
      }),
    /unsupported tool dispatch source\/denialMode combination/u,
  );
  assert.deepEqual(events, []);
});

void test('artifact_frame write callback: full_access auto-approves via the shared write allowlist', async () => {
  const daemonContext = createTestDaemonContext();
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-frame-write-'));
  const threadId = testThreadId(86_4);
  const events: AgentEvent[] = [];

  await withWriteCallbackKnob('1', async () => {
    const result = await executeFunctionCall({
      functionCall: {
        id: 'fc-frame-write',
        callId: 'artifact-frame-rt-write-1',
        name: 'manage_files',
        arguments: JSON.stringify({ operation: 'create', path: 'frame.txt' }),
      },
      round: 0,
      toolArgs: { operation: 'create', path: 'frame.txt' },
      history: [],
      runtime: makeExecutionRuntime(daemonContext, {
        threadId,
        stateRoot: workspaceRoot,
        computerFileRoot: workspaceRoot,
        workingDirectory: workspaceRoot,
        runId: 'run-frame-write',
        approvalContext: makeApprovalContext({ permissionMode: 'full_access' }),
        emit: makeEmitter(events),
      }),
      source: makeArtifactFrameSource('rt-write-1'),
      denialMode: 'data_only',
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.ok, true);
    }
    const created = await stat(join(workspaceRoot, 'frame.txt'));
    assert.equal(created.isFile(), true);
    assert.deepEqual(events, []);
  });
});

void test('artifact_frame write callback in basic mode returns approval_required without waiting', async () => {
  const daemonContext = createTestDaemonContext();
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-frame-basic-'));
  const threadId = testThreadId(86_5);
  const events: AgentEvent[] = [];

  await withWriteCallbackKnob('1', async () => {
    const result = await executeFunctionCall({
      functionCall: {
        id: 'fc-frame-basic-write',
        callId: 'artifact-frame-rt-write-2',
        name: 'manage_files',
        arguments: JSON.stringify({ operation: 'create', path: 'frame2.txt' }),
      },
      round: 0,
      toolArgs: { operation: 'create', path: 'frame2.txt' },
      history: [],
      runtime: makeExecutionRuntime(daemonContext, {
        threadId,
        stateRoot: workspaceRoot,
        computerFileRoot: workspaceRoot,
        workingDirectory: workspaceRoot,
        runId: 'run-frame-basic-write',
        approvalContext: makeApprovalContext(),
        emit: makeEmitter(events),
      }),
      source: makeArtifactFrameSource('rt-write-2'),
      denialMode: 'data_only',
    });

    // 프레임에는 승인 카드를 중계할 채널이 없다 — 대기 없이 데이터 거부로
    // 돌아오고 UI가 프롬프트(티어 B)로 강등한다.
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.ok, false);
      assert.equal(result.value.errorCode, 'approval_required');
      assert.match(result.value.error ?? '', /cannot resolve approvals/u);
    }
    assert.deepEqual(events, []);
    await assert.rejects(() => stat(join(workspaceRoot, 'frame2.txt')));
  });
});
