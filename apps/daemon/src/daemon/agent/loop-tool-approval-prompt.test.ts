import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { AgentEvent } from './events.js';
import { createAgentEvent } from './events.js';
import type { AgentEventEmitter } from './events.js';
import { resolveApprovalDecision } from './loop-tool-approval.js';
import { buildAgentToolExecutionContextBase } from './loop-tool-runtime.js';
import { createApprovalGate } from './runtime/approval-gate.js';
import { createRunState } from './runtime/run-state.js';
import { readTranscriptEntries } from '../sessions/transcript-log.js';
import { assertRunId as assertValidRunId } from '@geulbat/protocol/ids';
import { createApprovalGrantStore } from '../tools/approval-grants.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import { makeRunWorkspaceContext } from '../../test-support/run-workspace-context.js';
import { testProjectId } from '../../test-support/project-id.js';
import { testThreadId } from '../../test-support/thread-id.js';

function makeApprovalDecisionRuntime(args: {
  runId: string;
  runContext: ReturnType<typeof makeRunWorkspaceContext>;
  runState: ReturnType<typeof createRunState>;
  approvalContext: ReturnType<typeof makeApprovalContext>;
  approvalGate: ReturnType<typeof createApprovalGate>;
  signal: AbortSignal | undefined;
  emit: AgentEventEmitter;
}) {
  return {
    approvalContext: args.approvalContext,
    approvalGate: args.approvalGate,
    emit: args.emit,
    executionContextBase: buildAgentToolExecutionContextBase({
      runContext: args.runContext,
      runId: args.runId,
      approvalContext: args.approvalContext,
      emit: args.emit,
      currentFile: undefined,
      selection: undefined,
      signal: args.signal,
      runState: args.runState,
      memoryIndex: undefined,
      agentSpawnRuntime: undefined,
    }),
  };
}

void test('resolveApprovalDecision persists denial as tool_result before terminal failure', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-approval-'));
  const threadId = testThreadId(64);
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('project'),
    workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-approval-denied',
    runContext,
  });
  const approvalGate = createApprovalGate({
    approvalGrants: createApprovalGrantStore(),
  });
  const history: Array<{
    kind: 'function_call_output';
    callId: string;
    output: string;
  }> = [];
  const events: AgentEvent[] = [];

  const result = await resolveApprovalDecision({
    functionCall: {
      id: 'fc-denied',
      callId: 'call-denied-runtime',
      name: 'manage_files',
      arguments: '{"operation":"create","path":"draft.md"}',
    },
    round: 0,
    approvalTarget: {
      runId: 'run-approval-denied',
      threadId,
    },
    approvalClass: 'manage_files:create',
    runtimeSideEffectLevel: 'write',
    toolArgs: {
      operation: 'create',
      path: 'draft.md',
    },
    history,
    runtime: makeApprovalDecisionRuntime({
      runId: 'run-approval-denied',
      runContext,
      runState,
      approvalContext: makeApprovalContext({
        sessionId: 'session-approval-denied',
      }),
      signal: undefined,
      approvalGate,
      emit: (type, payload) => {
        const event: AgentEvent = createAgentEvent(type, payload);
        events.push(event);
        if (event.type === 'approval_required') {
          setTimeout(() => {
            approvalGate.resolveApproval(
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

  assert.notEqual(result, 'approved');
  if (result === 'approved') {
    throw new Error('expected denied approval to stop execution');
  }
  assert.equal(result.ok, false);
  assert.deepEqual(result.result, { ok: false, finalProse: '' });
  assert.equal(runState.status, 'failed');
  assert.deepEqual(
    events.map((event) => event.type),
    ['approval_required', 'tool_result', 'error'],
  );
  assert.equal(history.length, 1);
  assert.match(history[0]?.output ?? '', /approval_denied/);

  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.deepEqual(
    transcript.map((entry) => entry.role),
    ['tool_result'],
  );
  assert.match(transcript[0]?.content ?? '', /approval_denied/);
});

void test('resolveApprovalDecision marks the run cancelled when approval is aborted', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-approval-'));
  const threadId = testThreadId(65);
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('project'),
    workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-approval-aborted',
    runContext,
  });
  const approvalGate = createApprovalGate({
    approvalGrants: createApprovalGrantStore(),
  });
  const events: AgentEvent[] = [];
  const controller = new AbortController();

  const resultPromise = resolveApprovalDecision({
    functionCall: {
      id: 'fc-aborted',
      callId: 'call-aborted-runtime',
      name: 'manage_files',
      arguments: '{"operation":"create","path":"draft.md"}',
    },
    round: 0,
    approvalTarget: {
      runId: 'run-approval-aborted',
      threadId,
    },
    approvalClass: 'manage_files:create',
    runtimeSideEffectLevel: 'write',
    toolArgs: {
      operation: 'create',
      path: 'draft.md',
    },
    history: [],
    runtime: makeApprovalDecisionRuntime({
      runId: 'run-approval-aborted',
      runContext,
      runState,
      approvalContext: makeApprovalContext({
        sessionId: 'session-approval-aborted',
      }),
      signal: controller.signal,
      approvalGate,
      emit: (type, payload) => {
        const event: AgentEvent = createAgentEvent(type, payload);
        events.push(event);
        if (event.type === 'approval_required') {
          setTimeout(() => controller.abort(), 0);
        }
      },
    }),
  });

  const result = await resultPromise;
  assert.notEqual(result, 'approved');
  if (result === 'approved') {
    throw new Error('expected aborted approval to stop execution');
  }
  assert.equal(result.ok, false);
  assert.deepEqual(result.result, { ok: false, finalProse: '' });
  assert.equal(runState.status, 'cancelled');
  assert.deepEqual(events, [
    createAgentEvent('approval_required', {
      callId: 'call-aborted-runtime',
      runId: assertValidRunId('run-approval-aborted'),
      threadId,
      toolName: 'manage_files',
      approvalClass: 'manage_files:create',
      permissionMode: 'basic',
      argumentsPreview: {
        operation: 'create',
        path: 'draft.md',
      },
      sideEffectLevel: 'write',
    }),
    createAgentEvent('error', {
      code: 'aborted',
      message: 'approval aborted',
    }),
  ]);
});

void test('resolveApprovalDecision can use an injected approval gate without relying on the default runtime gate', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-approval-'));
  const threadId = testThreadId(66);
  const runContext = makeRunWorkspaceContext({
    threadId,
    projectId: testProjectId('project'),
    workspaceRoot,
  });
  const runState = createRunState({
    runId: 'run-approval-local-gate',
    runContext,
  });
  const approvalGate = createApprovalGate({
    approvalGrants: createApprovalGrantStore(),
  });

  const result = await resolveApprovalDecision({
    functionCall: {
      id: 'fc-local-gate',
      callId: 'call-local-gate',
      name: 'manage_files',
      arguments: '{"operation":"create","path":"draft.md"}',
    },
    round: 0,
    approvalTarget: {
      runId: 'run-approval-local-gate',
      threadId,
    },
    approvalClass: 'manage_files:create',
    runtimeSideEffectLevel: 'write',
    toolArgs: {
      operation: 'create',
      path: 'draft.md',
    },
    history: [],
    runtime: makeApprovalDecisionRuntime({
      runId: 'run-approval-local-gate',
      runContext,
      runState,
      approvalContext: makeApprovalContext({
        sessionId: 'session-approval-local-gate',
      }),
      signal: undefined,
      approvalGate,
      emit: (type, payload) => {
        const event: AgentEvent = createAgentEvent(type, payload);
        if (event.type === 'approval_required') {
          setTimeout(() => {
            approvalGate.resolveApproval(
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

  assert.equal(result, 'approved');
});
