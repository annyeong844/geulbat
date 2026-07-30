import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { toApprovalClass } from '@geulbat/protocol/run-approval';

import { createCallbackToolDispatcher } from './callback-tool-dispatcher.js';
import {
  createAgentEvent,
  type AgentEvent,
  type AgentEventEmitter,
} from './events.js';
import { executeFunctionCall } from './loop-tool-approval.js';
import { completeRun, createRunState } from './runtime/run-state.js';
import { isRecord } from '../runtime-json.js';
import { threadFilePath } from '../sessions/paths.js';
import { readTranscriptEntries } from '../sessions/transcript-log.js';
import type { ExecuteResult } from '../tools/types.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import { createSymlinkOrSkip } from '../../test-support/symlink-test.js';
import { makeRunContext } from '../../test-support/run-context.js';
import {
  createTestDaemonContext,
  makeApprovalResolvingEmitter,
  makeEmitter,
  makeExecutionRuntime,
  makePtcWriteCallbackSource,
  startApprovalCheckpoint,
  withWriteCallbackKnob,
} from '../../test-support/loop-tool-approval.js';
import { testThreadId } from '../../test-support/thread-id.js';

void test('W1: full_access auto-approves an admitted PTC write callback and mutates Computer files', async () => {
  const daemonContext = createTestDaemonContext();
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-w1-fullaccess-'));
  const threadId = testThreadId(84_1);
  const events: AgentEvent[] = [];
  await startApprovalCheckpoint(daemonContext, threadId, 'run-w1-full-access');

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

void test('W2: grants only auto-approve PTC write callbacks when the Computer-scoped class matches', async () => {
  const daemonContext = createTestDaemonContext();
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-w1-grant-'));
  const threadId = testThreadId(84_3);
  const events: AgentEvent[] = [];
  const approvalContext = makeApprovalContext();
  const grantContext = {
    runId: 'run-w1-class-grant',
    threadId,
    computerSessionId: approvalContext.computerSessionId,
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

    // 저장된 grant는 'manage_files:create'인데 런타임 클래스는
    // 'manage_files:create:computer'다 — 스코프가 다른 grant는 소비되지 않고
    // 콜백은 대화형 대기를 거치며 사용자의 거부가 유효하다.
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

void test('W2: an interactive grant is reused as auto-approval for the next PTC write callback', async () => {
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

    // Second callback in the same run/class: 승인은 세션 단위 (오너 결정
    // 2026-07-23, Q5=(a) 갱신) — 직접 승인에서 쌓인 run/session grant를 PTC
    // 중첩 콜백도 자동 승인 근거로 쓴다. 대기 없이 실행되고
    // approval_required가 다시 뜨지 않는다.
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
        emit: (type, payload) => {
          secondEvents.push(createAgentEvent(type, payload));
        },
      }),
      source: makePtcWriteCallbackSource('runtime-w2-9b'),
      denialMode: 'code_visible',
    });
    assert.equal(second.ok, true);
    if (second.ok) {
      assert.equal(second.value.ok, true);
    }
    assert.equal(
      secondEvents.some((event) => event.type === 'approval_required'),
      false,
    );
    await stat(join(workspaceRoot, 'second.txt'));
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

void test('W1: write tools outside the allowlist and destructive operations stay rejected in basic mode with the knob on', async () => {
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
      approvalContext: makeApprovalContext({ permissionMode: 'basic' }),
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

void test('W1: full_access admits outside-allowlist and destructive callbacks without prompts', async () => {
  // yolo (오너 결정 2026-07-23): full_access의 PTC 콜백은 표면 allowlist를
  // 우회한다 — 셀 코드는 모델 작성이라 agent-loop 직접 호출과 같은 신뢰
  // 등급이고, 모드가 이미 전면 위임이다.
  const daemonContext = createTestDaemonContext();
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-w1-yolo-'));
  const threadId = testThreadId(84_10);
  const events: AgentEvent[] = [];
  await startApprovalCheckpoint(daemonContext, threadId, 'run-w1-yolo');

  await withWriteCallbackKnob('1', async () => {
    const runtime = makeExecutionRuntime(daemonContext, {
      threadId,
      stateRoot: workspaceRoot,
      computerFileRoot: workspaceRoot,
      workingDirectory: workspaceRoot,
      runId: 'run-w1-yolo',
      approvalContext: makeApprovalContext({ permissionMode: 'full_access' }),
      emit: makeEmitter(events),
    });

    const written = await executeFunctionCall({
      functionCall: {
        id: 'fc-w1-yolo-write',
        callId: 'call-execute-code::nested-w1-10',
        name: 'write_file',
        arguments: JSON.stringify({ path: 'w1.txt', content: 'yolo' }),
      },
      round: 0,
      toolArgs: { path: 'w1.txt', content: 'yolo' },
      history: [],
      runtime,
      source: makePtcWriteCallbackSource('runtime-w1-10'),
      denialMode: 'code_visible',
    });
    assert.equal(written.ok, true);
    if (written.ok) {
      assert.equal(written.value.ok, true);
    }
    const created = await stat(join(workspaceRoot, 'w1.txt'));
    assert.equal(created.isFile(), true);

    const deleted = await executeFunctionCall({
      functionCall: {
        id: 'fc-w1-yolo-delete',
        callId: 'call-execute-code::nested-w1-11',
        name: 'manage_files',
        arguments: JSON.stringify({ operation: 'delete', path: 'w1.txt' }),
      },
      round: 0,
      toolArgs: { operation: 'delete', path: 'w1.txt' },
      history: [],
      runtime,
      source: makePtcWriteCallbackSource('runtime-w1-11'),
      denialMode: 'code_visible',
    });
    assert.equal(deleted.ok, true);
    if (deleted.ok) {
      assert.equal(deleted.value.ok, true);
    }
    await assert.rejects(() => stat(join(workspaceRoot, 'w1.txt')));
    assert.equal(
      events.some((event) => event.type === 'approval_required'),
      false,
    );
  });
});

void test('W1: full_access preserves host-wide Computer paths for PTC write callbacks', async () => {
  const daemonContext = createTestDaemonContext();
  const outerRoot = await mkdtemp(join(tmpdir(), 'geulbat-w1-boundary-'));
  const workspaceRoot = join(outerRoot, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  const threadId = testThreadId(84_5);
  const events: AgentEvent[] = [];
  await startApprovalCheckpoint(daemonContext, threadId, 'run-w1-boundary');

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

void test('PTC read_tool_output keeps character and item pages code-visible while audit records only their immutable ranges', async () => {
  const daemonContext = createTestDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-read-output-audit-'),
  );
  const threadId = testThreadId(84_7);
  const events: AgentEvent[] = [];
  const pageContent = `AUDIT_PAGE_CONTENT_MUST_NOT_REPEAT_${'x'.repeat(256)}`;
  const itemContent = `AUDIT_ITEM_CONTENT_MUST_NOT_REPEAT_${'y'.repeat(256)}`;
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
  const itemPageItems = [
    {
      path: 'evidence.ts',
      line: 7,
      text: itemContent,
    },
  ];
  const itemPageOutput = JSON.stringify({
    ok: true,
    outputRef,
    toolName: 'search_files',
    contentType: 'application/json',
    mode: 'items',
    itemField: 'results',
    offset: 7,
    limit: 1,
    endOffset: 8,
    totalItems: 20,
    hasMore: true,
    nextOffset: 8,
    items: itemPageItems,
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
  const dispatchedOutputs = [pageOutput, itemPageOutput];
  let dispatchIndex = 0;
  const dispatcher = createCallbackToolDispatcher({
    runtime,
    history: [],
    parentRound: 0,
    parentToolCallId: 'call-execute-code-read-output',
    dispatchFunctionCall: async () => {
      const output = dispatchedOutputs[dispatchIndex];
      dispatchIndex += 1;
      assert.ok(output);
      return {
        ok: true,
        value: { ok: true, output },
      };
    },
  });

  try {
    const cellResult = await dispatcher.dispatch({
      toolName: 'read_tool_output',
      args: { outputRef, offset: 0, limit: 4_000 },
      runtimeToolCallId: 'rt-read-output-1',
      signal: new AbortController().signal,
    });
    assert.deepEqual(cellResult, { ok: true, output: pageOutput });

    const itemCellResult = await dispatcher.dispatch({
      toolName: 'read_tool_output',
      args: { outputRef, mode: 'items', offset: 7, limit: 1 },
      runtimeToolCallId: 'rt-read-output-items-1',
      signal: new AbortController().signal,
    });
    assert.deepEqual(itemCellResult, { ok: true, output: itemPageOutput });

    const resultEvent = events.find(
      (event) =>
        event.type === 'tool_result' &&
        event.payload.tool === 'read_tool_output' &&
        isRecord(event.payload.raw) &&
        event.payload.raw['auditProjection'] === 'read_tool_output_page_ref_v1',
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

    const itemResultEvent = events.find(
      (event) =>
        event.type === 'tool_result' &&
        event.payload.tool === 'read_tool_output' &&
        isRecord(event.payload.raw) &&
        event.payload.raw['auditProjection'] ===
          'read_tool_output_item_page_ref_v1',
    );
    assert.ok(itemResultEvent?.type === 'tool_result');
    assert.ok(isRecord(itemResultEvent.payload.raw));
    assert.equal(itemResultEvent.payload.raw['items'], undefined);
    assert.equal(
      itemResultEvent.payload.raw['auditProjection'],
      'read_tool_output_item_page_ref_v1',
    );
    assert.equal(itemResultEvent.payload.raw['itemCount'], 1);
    const serializedItems = JSON.stringify(itemPageItems);
    assert.equal(
      itemResultEvent.payload.raw['itemsChars'],
      serializedItems.length,
    );
    assert.equal(
      itemResultEvent.payload.raw['itemsBytes'],
      Buffer.byteLength(serializedItems, 'utf8'),
    );
    assert.match(itemResultEvent.payload.displayText, /items omitted/u);
    assert.doesNotMatch(
      itemResultEvent.payload.displayText,
      /AUDIT_ITEM_CONTENT_MUST_NOT_REPEAT_/u,
    );

    const transcript = await readFile(
      threadFilePath(workspaceRoot, threadId),
      'utf8',
    );
    assert.doesNotMatch(transcript, /AUDIT_PAGE_CONTENT_MUST_NOT_REPEAT_/u);
    assert.doesNotMatch(transcript, /AUDIT_ITEM_CONTENT_MUST_NOT_REPEAT_/u);
    assert.match(transcript, /read_tool_output_page_ref_v1/u);
    assert.match(transcript, /read_tool_output_item_page_ref_v1/u);
    const transcriptEntries = await readTranscriptEntries(
      workspaceRoot,
      threadId,
    );
    assert.equal(transcriptEntries.length, 4);
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
