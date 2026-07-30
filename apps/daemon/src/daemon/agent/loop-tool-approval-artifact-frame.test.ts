import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { toApprovalClass } from '@geulbat/protocol/run-approval';

import type { AgentEvent } from './events.js';
import { executeFunctionCall } from './loop-tool-approval.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import { registerOnce } from '../../test-support/loop-tool-execution-test-support.js';
import {
  createTestDaemonContext,
  makeEmitter,
  makeExecutionRuntime,
  makeTestTool,
  startApprovalCheckpoint,
  withWriteCallbackKnob,
} from '../../test-support/loop-tool-approval.js';
import { testThreadId } from '../../test-support/thread-id.js';

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

void test('artifact_frame data_only does not inherit the delegated external callback surface', async () => {
  const toolName = 'mcp_artifact_frame_reject_test_tool';
  const daemonContext = createTestDaemonContext();
  let executionCount = 0;
  registerOnce(
    daemonContext,
    makeTestTool({
      name: toolName,
      description: 'artifact frame delegated external test tool',
      sideEffectLevel: 'write',
      requiresApproval: true,
      approvalClass: toApprovalClass('mcp:artifact-frame-test-server'),
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
      approvalContext: makeApprovalContext({ permissionMode: 'full_access' }),
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
  await startApprovalCheckpoint(daemonContext, threadId, 'run-frame-write');

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
