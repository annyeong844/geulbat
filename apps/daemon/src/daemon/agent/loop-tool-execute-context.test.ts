import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentEvent, type AgentEvent } from './events.js';
import { executeResolvedFunctionCall } from './loop-tool-execute-context.js';
import {
  buildAgentToolExecutionContextBase,
  buildToolCallExecutionRuntime,
} from './loop-tool-runtime.js';
import { createRunState, markRunApprovalPending } from './runtime/run-state.js';
import { createApprovalGrantStore } from '../tools/approval-grants.js';
import { createToolRegistryStore } from '../tools/registry.js';
import type {
  AgentToolExecutionContext,
  AnyTool,
  ExecuteResult,
  ToolParseResult,
} from '../tools/types.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import { makeRunWorkspaceContext } from '../../test-support/run-workspace-context.js';
import { testProjectId } from '../../test-support/project-id.js';
import { testThreadId } from '../../test-support/thread-id.js';

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
  parseArgs?: (raw: unknown) => ToolParseResult<TArgs>;
  executeParsed: (
    parsedArgs: TArgs,
    ctx: AgentToolExecutionContext,
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
    timeoutMs: 1_000,
    requiresApproval: args.requiresApproval,
    parseArgs: args.parseArgs ?? parseObjectArgs,
    executeParsed: args.executeParsed,
  };
}

void test('executeResolvedFunctionCall builds canonical tool execution context and resets runState to running', async () => {
  const toolName = 'execute_context_test_tool';
  const store = createToolRegistryStore({ builtins: [] });
  let capturedArgs: Record<string, unknown> | undefined;
  let capturedContext: AgentToolExecutionContext | undefined;

  store.registerTool(
    makeTestTool({
      name: toolName,
      description: 'test tool for execute context',
      sideEffectLevel: 'write',
      requiresApproval: false,
      async executeParsed(args, ctx) {
        capturedArgs = args;
        capturedContext = ctx;
        ctx.emitAgentEvent?.(
          createAgentEvent('commentary_delta', { text: 'from-tool' }),
        );
        return {
          ok: true,
          output: 'tool-output',
        };
      },
    }),
  );

  const threadId = testThreadId(71);
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('project'),
    workspaceRoot: '/tmp/execute-context-workspace',
  });
  const runState = createRunState({
    runId: 'run-execute-context',
    runContext,
  });
  markRunApprovalPending(runState);
  const events: AgentEvent[] = [];
  const selection = {
    startLine: 1,
    endLine: 2,
    text: 'selected text',
  };
  const toolArgs = {
    path: 'draft.md',
  };

  const result = await executeResolvedFunctionCall({
    functionCall: {
      id: 'fc-execute-context',
      callId: 'call-execute-context',
      name: toolName,
      arguments: '{"path":"draft.md"}',
    },
    toolArgs,
    approvalGranted: true,
    runtime: buildToolCallExecutionRuntime({
      approvalContext: makeApprovalContext({
        sessionId: 'session-execute-context',
      }),
      emit: (type, payload) => {
        events.push(createAgentEvent(type, payload));
      },
      approvalGrants: createApprovalGrantStore(),
      toolRegistry: store,
      approvalGate: { waitForApproval: async () => 'approved' },
      executionContextBase: buildAgentToolExecutionContextBase({
        runId: 'run-execute-context',
        runContext,
        approvalContext: makeApprovalContext({
          sessionId: 'session-execute-context',
        }),
        currentFile: 'draft.md',
        selection,
        signal: undefined,
        runState,
        memoryIndex: undefined,
        agentSpawnRuntime: undefined,
        emit: (type, payload) => {
          events.push(createAgentEvent(type, payload));
        },
      }),
    }),
  });

  assert.deepEqual(result, { ok: true, output: 'tool-output' });
  assert.equal(runState.status, 'running');
  assert.deepEqual(capturedArgs, toolArgs);
  assert.ok(capturedContext);
  assert.equal(capturedContext.callId, 'call-execute-context');
  assert.ok(capturedContext.signal instanceof AbortSignal);
  assert.equal(capturedContext.runSignal, undefined);
  assert.equal(capturedContext.approvalGranted, true);
  assert.equal(capturedContext.approvalSessionId, 'session-execute-context');
  assert.equal(capturedContext.permissionMode, 'basic');
  assert.equal(capturedContext.workspaceRoot, runContext.workspaceRoot);
  assert.equal(capturedContext.threadId, threadId);
  assert.equal(capturedContext.runId, 'run-execute-context');
  assert.equal(capturedContext.projectId, runContext.projectId);
  assert.equal(capturedContext.currentFile, 'draft.md');
  assert.deepEqual(capturedContext.selection, selection);
  assert.equal(capturedContext.runState, runState);
  assert.equal(typeof capturedContext.emitAgentEvent, 'function');
  assert.deepEqual(events, [
    createAgentEvent('commentary_delta', { text: 'from-tool' }),
  ]);
});

void test('executeResolvedFunctionCall can use an injected registry for tools absent from the default store', async () => {
  const toolName = 'execute_context_local_registry_tool';
  const store = createToolRegistryStore({ builtins: [] });
  let seenCallId: string | undefined;
  store.registerTool(
    makeTestTool({
      name: toolName,
      description: 'test tool for local registry execution',
      sideEffectLevel: 'write',
      requiresApproval: false,
      async executeParsed(_, ctx) {
        seenCallId = ctx.callId;
        return {
          ok: true,
          output: 'local-registry-tool-output',
        };
      },
    }),
  );

  const threadId = testThreadId(72);
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('project'),
    workspaceRoot: '/tmp/execute-context-local-registry',
  });

  const result = await executeResolvedFunctionCall({
    functionCall: {
      id: 'fc-execute-context-local',
      callId: 'call-execute-context-local',
      name: toolName,
      arguments: '{"path":"draft.md"}',
    },
    toolArgs: { path: 'draft.md' },
    approvalGranted: false,
    runtime: buildToolCallExecutionRuntime({
      approvalContext: makeApprovalContext({
        sessionId: 'session-execute-context-local',
      }),
      emit: () => {},
      approvalGrants: createApprovalGrantStore(),
      toolRegistry: store,
      approvalGate: { waitForApproval: async () => 'approved' },
      executionContextBase: buildAgentToolExecutionContextBase({
        runId: 'run-execute-context-local',
        runContext,
        approvalContext: makeApprovalContext({
          sessionId: 'session-execute-context-local',
        }),
        emit: () => {},
        currentFile: undefined,
        selection: undefined,
        signal: undefined,
        runState: undefined,
        memoryIndex: undefined,
        agentSpawnRuntime: undefined,
      }),
    }),
  });

  assert.deepEqual(result, {
    ok: true,
    output: 'local-registry-tool-output',
  });
  assert.equal(seenCallId, 'call-execute-context-local');
});
