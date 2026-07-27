import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';

import { assertRunId, assertThreadId } from '@geulbat/protocol/ids';
import { toApprovalClass } from '@geulbat/protocol/run-approval';
import { createToolCapabilityPolicy } from '@geulbat/tool-library/tool-capability-policy';

import { createRunCheckpointStore } from './run-checkpoint-store.js';

void test('a torn journal isolates its own thread instead of blocking every running run', async (t) => {
  // 데몬이 저널에 한 줄을 append하다 죽으면 그 줄이 반쪽으로 남는다. 반쪽
  // 기록으로 런을 이어가면 안 되므로 그 스레드의 저널은 거부되어야 한다.
  // 그러나 그 거부가 **다른 스레드의 복구까지 막으면** 손상 하나가 제품
  // 전체를 세운다 — 부팅 복구가 이 열거로 시작하기 때문이다.
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-torn-journal-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const store = createRunCheckpointStore({ stateRoot });

  const healthyRunId = assertRunId(randomUUID());
  const healthyThreadId = assertThreadId(randomUUID());
  const tornRunId = assertRunId(randomUUID());
  const tornThreadId = assertThreadId(randomUUID());

  for (const [runId, threadId] of [
    [healthyRunId, healthyThreadId],
    [tornRunId, tornThreadId],
  ] as const) {
    await store.startRun({
      runId,
      threadId,
      request: { workingDirectory: '/workspace', permissionMode: 'basic' },
    });
    await store.appendRunEvents({
      threadId,
      runId,
      events: [
        {
          seq: 0,
          event: { type: 'commentary_delta', payload: { text: 'progress' } },
        },
      ],
    });
  }

  // 한 스레드의 저널 마지막 줄을 잘라 크래시 중 append를 재현한다.
  const tornJournalPath = join(
    stateRoot,
    '.geulbat',
    'run-event-journals',
    tornThreadId,
    `${tornRunId}.jsonl`,
  );
  const tornJournal = await readFile(tornJournalPath, 'utf8');
  const tornLines = tornJournal.replace(/\n$/u, '').split('\n');
  const lastLine = tornLines[tornLines.length - 1] ?? '';
  assert.ok(lastLine.length > 10, '자를 마지막 배치 줄이 있어야 한다');
  tornLines[tornLines.length - 1] = lastLine.slice(
    0,
    Math.floor(lastLine.length / 2),
  );
  await writeFile(tornJournalPath, `${tornLines.join('\n')}\n`, 'utf8');

  const reloaded = createRunCheckpointStore({ stateRoot });

  // 손상된 스레드를 **명시적으로** 물으면 실패가 숨겨지지 않는다.
  await assert.rejects(
    reloaded.readThread(tornThreadId),
    /run event journal/u,
    '손상된 저널은 그 스레드를 물었을 때 거부되어야 한다',
  );

  // 그러나 열거는 손상되지 않은 런을 계속 돌려주어야 한다.
  const running = await reloaded.listRunning();
  assert.deepEqual(
    running.map((checkpoint) => checkpoint.runId),
    [healthyRunId],
    '한 스레드의 손상이 다른 스레드의 복구를 막아서는 안 된다',
  );
});

void test('run checkpoints survive store recreation and settle monotonically', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-run-checkpoint-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const runId = assertRunId(randomUUID());
  const threadId = assertThreadId(randomUUID());
  const timestamps = ['2026-07-18T00:00:00.000Z', '2026-07-18T00:00:01.000Z'];
  const store = createRunCheckpointStore({
    stateRoot,
    now: () => timestamps.shift() ?? '2026-07-18T00:00:02.000Z',
  });
  const loopImplementation = {
    implementationId: 'test.agent-loop',
    contractVersion: '1',
  };
  const toolCapabilityPolicy = createToolCapabilityPolicy({
    directRegistryNames: ['list_files'],
    allowedRegistryNames: ['list_files', 'read_file'],
    callbackRegistryNames: ['read_file'],
    writeCallbackEnabled: false,
  });
  const toolLibraryProjectionIdentity = {
    sdkVersion: 'sdk-checkpoint-v1',
    sdkProjectionHash:
      'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    policyId: toolCapabilityPolicy.toolCapabilityPolicyId,
  } as const;

  const started = await store.startRun({
    runId,
    threadId,
    request: {
      workingDirectory: '/workspace',
      permissionMode: 'basic',
      ultraReasoning: true,
      loopImplementation,
      serviceTier: 'fast',
      providerModel: {
        providerId: 'openai_codex_direct',
        model: 'gpt-5.6-luna',
      },
      providerTransitionRecovery: {
        sourceModelId: 'grok-4.5',
        sourceReasoningEffort: 'high',
      },
      toolCapabilityPolicy,
      toolLibraryProjectionIdentity,
    },
  });
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  assert.deepEqual(
    {
      interjectSeq: started.checkpoint.interjectSeq,
      applyingInterject: started.checkpoint.applyingInterject,
      pendingInterjects: started.checkpoint.pendingInterjects,
      approvals: started.checkpoint.approvals,
      toolInvocations: started.checkpoint.toolInvocations,
      toolResultsReady: started.checkpoint.toolResultsReady,
      terminal: started.checkpoint.terminal,
    },
    {
      interjectSeq: 0,
      applyingInterject: null,
      pendingInterjects: [],
      approvals: [],
      toolInvocations: [],
      toolResultsReady: [],
      terminal: null,
    },
  );

  const reloaded = createRunCheckpointStore({ stateRoot });
  assert.deepEqual((await reloaded.readThread(threadId))?.request, {
    workingDirectory: '/workspace',
    permissionMode: 'basic',
    ultraReasoning: true,
    loopImplementation,
    serviceTier: 'fast',
    providerModel: {
      providerId: 'openai_codex_direct',
      model: 'gpt-5.6-luna',
    },
    providerTransitionRecovery: {
      sourceModelId: 'grok-4.5',
      sourceReasoningEffort: 'high',
    },
    toolCapabilityPolicy,
    toolLibraryProjectionIdentity,
  });
  assert.deepEqual(
    (await reloaded.listRunning()).map((checkpoint) => checkpoint.runId),
    [runId],
  );
  const terminal = await store.settleRun({
    threadId,
    runId,
    terminal: {
      eventCursor: 3,
      event: {
        type: 'done',
        payload: { answer: 'durable answer', ok: true },
      },
    },
  });
  assert.equal(terminal.status, 'terminal');
  assert.equal(terminal.revision, 2);
  assert.deepEqual(terminal.terminal, {
    eventCursor: 3,
    acknowledged: false,
    event: {
      type: 'done',
      payload: { answer: 'durable answer', ok: true },
    },
  });
  assert.deepEqual(await reloaded.listRunning(), []);
  assert.deepEqual(
    (await reloaded.listUnacknowledgedTerminal()).map(
      (checkpoint) => checkpoint.runId,
    ),
    [runId],
  );
  assert.deepEqual(
    await reloaded.acknowledgeTerminalEvent({
      threadId,
      runId,
      eventCursor: 2,
    }),
    { ok: false, code: 'cursor_conflict' },
  );
  const acknowledged = await reloaded.acknowledgeTerminalEvent({
    threadId,
    runId,
    eventCursor: 3,
  });
  assert.equal(acknowledged.ok && acknowledged.changed, true);
  const duplicate = await store.acknowledgeTerminalEvent({
    threadId,
    runId,
    eventCursor: 3,
  });
  assert.equal(duplicate.ok && !duplicate.changed, true);
  assert.deepEqual(await reloaded.listUnacknowledgedTerminal(), []);
});

void test('run checkpoints reject projection identity fields outside the observer-safe contract', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-run-checkpoint-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const runId = assertRunId(randomUUID());
  const threadId = assertThreadId(randomUUID());
  const root = join(stateRoot, '.geulbat', 'run-checkpoints');
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, `${threadId}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      status: 'running',
      runId,
      threadId,
      request: {
        workingDirectory: '/workspace',
        permissionMode: 'basic',
        toolLibraryProjectionIdentity: {
          sdkVersion: 'sdk-checkpoint-v1',
          sdkProjectionHash:
            'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          policyId: 'policy-checkpoint-v1',
          projectionRootPath: '/private/projection',
        },
      },
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
    })}\n`,
    'utf8',
  );

  await assert.rejects(
    createRunCheckpointStore({ stateRoot }).readThread(threadId),
    /invalid recoverable tool library projection identity/u,
  );
});

void test('ready tool result refs survive restart and block terminal settlement until projected', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-run-checkpoint-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const runId = assertRunId(randomUUID());
  const threadId = assertThreadId(randomUUID());
  const store = createRunCheckpointStore({ stateRoot });
  await store.startRun({
    runId,
    threadId,
    request: { workingDirectory: '/workspace', permissionMode: 'basic' },
  });
  const ready = {
    callId: 'call-result-ready',
    toolName: 'write_file',
    resultRef: 'tool-output:thread/run/result-ready',
  };

  const recorded = await store.recordToolResultReady({
    threadId,
    runId,
    ready,
  });
  assert.equal(recorded.ok && recorded.changed, true);
  assert.deepEqual(
    (await createRunCheckpointStore({ stateRoot }).readThread(threadId))
      ?.toolResultsReady,
    [ready],
  );
  const duplicate = await store.recordToolResultReady({
    threadId,
    runId,
    ready,
  });
  assert.equal(duplicate.ok && !duplicate.changed, true);
  assert.deepEqual(
    await store.recordToolResultReady({
      threadId,
      runId,
      ready: { ...ready, resultRef: `${ready.resultRef}-conflict` },
    }),
    { ok: false, code: 'tool_result_conflict' },
  );
  await assert.rejects(
    store.settleRun({
      threadId,
      runId,
      terminal: {
        eventCursor: 1,
        event: {
          type: 'done',
          payload: { answer: 'must wait', ok: true },
        },
      },
    }),
    /still has ready tool results/,
  );

  const completed = await store.completeToolResultReady({
    threadId,
    runId,
    callId: ready.callId,
    resultRef: ready.resultRef,
  });
  assert.equal(completed.ok && completed.changed, true);
  const repeatedCompletion = await store.completeToolResultReady({
    threadId,
    runId,
    callId: ready.callId,
    resultRef: ready.resultRef,
  });
  assert.equal(repeatedCompletion.ok && !repeatedCompletion.changed, true);
  assert.deepEqual((await store.readThread(threadId))?.toolResultsReady, []);
});

void test('in-flight tool invocations survive restart and clear atomically with their projected result', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-run-checkpoint-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const runId = assertRunId(randomUUID());
  const threadId = assertThreadId(randomUUID());
  const store = createRunCheckpointStore({ stateRoot });
  await store.startRun({
    runId,
    threadId,
    request: { workingDirectory: '/workspace', permissionMode: 'full_access' },
  });
  const invocation = {
    callId: 'call-reconcile',
    toolName: 'manage_files',
    recoveryStrategy: 'reconcile_then_replay' as const,
    recoveryState: {
      operationId: 'call-reconcile',
      manifestHash: 'manifest-hash',
    },
  };

  const recorded = await store.recordToolInvocation({
    threadId,
    runId,
    invocation,
  });
  assert.equal(recorded.ok && recorded.changed, true);
  assert.deepEqual(
    (await createRunCheckpointStore({ stateRoot }).readThread(threadId))
      ?.toolInvocations,
    [{ status: 'in_flight', ...invocation }],
  );
  assert.deepEqual(
    await store.recordToolResultReady({
      threadId,
      runId,
      ready: {
        callId: invocation.callId,
        toolName: invocation.toolName,
        resultRef: 'tool-output:thread/run/reconcile',
      },
    }),
    { ok: false, code: 'tool_result_conflict' },
  );
  await assert.rejects(
    store.settleRun({
      threadId,
      runId,
      terminal: {
        eventCursor: 1,
        event: {
          type: 'done',
          payload: { answer: 'must reconcile', ok: true },
        },
      },
    }),
    /tool invocations/,
  );

  const result = { ok: true as const, output: '{"ok":true}' };
  const reconciled = await store.recordToolInvocationResult({
    threadId,
    runId,
    callId: invocation.callId,
    toolName: invocation.toolName,
    result,
  });
  assert.equal(reconciled.ok && reconciled.changed, true);
  assert.equal(
    (
      await store.recordToolInvocationResult({
        threadId,
        runId,
        callId: invocation.callId,
        toolName: invocation.toolName,
        result,
      })
    ).ok,
    true,
  );
  assert.deepEqual(
    await store.completeToolResultReady({
      threadId,
      runId,
      callId: invocation.callId,
      resultRef: 'tool-output:thread/run/not-ready',
    }),
    { ok: false, code: 'tool_result_conflict' },
  );

  const ready = {
    callId: invocation.callId,
    toolName: invocation.toolName,
    resultRef: 'tool-output:thread/run/reconcile',
  };
  const readyRecorded = await store.recordToolResultReady({
    threadId,
    runId,
    ready,
  });
  assert.equal(readyRecorded.ok && readyRecorded.changed, true);
  const completed = await store.completeToolResultReady({
    threadId,
    runId,
    callId: ready.callId,
    resultRef: ready.resultRef,
  });
  assert.equal(completed.ok && completed.changed, true);
  assert.deepEqual(
    {
      toolInvocations: (await store.readThread(threadId))?.toolInvocations,
      toolResultsReady: (await store.readThread(threadId))?.toolResultsReady,
    },
    { toolInvocations: [], toolResultsReady: [] },
  );
});

void test('run checkpoints hydrate append-only event history without duplicating it in checkpoint JSON', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-run-checkpoint-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const store = createRunCheckpointStore({ stateRoot });
  const runId = assertRunId(randomUUID());
  const threadId = assertThreadId(randomUUID());
  await store.startRun({
    runId,
    threadId,
    request: { workingDirectory: '/workspace', permissionMode: 'basic' },
  });
  await store.appendRunEvents({
    threadId,
    runId,
    events: [
      {
        seq: 0,
        event: {
          type: 'commentary_delta',
          payload: { text: 'durable progress' },
        },
      },
    ],
  });

  const reloaded = createRunCheckpointStore({ stateRoot });
  assert.deepEqual((await reloaded.readThread(threadId))?.eventHistory, [
    {
      seq: 0,
      event: {
        type: 'commentary_delta',
        payload: { text: 'durable progress' },
      },
    },
  ]);
  await reloaded.appendRunEvents({
    threadId,
    runId,
    events: [
      {
        seq: 1,
        event: {
          type: 'commentary_delta',
          payload: { text: 'recovered progress' },
        },
      },
    ],
  });
  await reloaded.settleRun({
    threadId,
    runId,
    terminal: {
      eventCursor: 2,
      event: {
        type: 'done',
        payload: { answer: 'done', ok: true },
      },
    },
  });
  await assert.rejects(
    reloaded.appendRunEvents({
      threadId,
      runId,
      events: [
        {
          seq: 2,
          event: {
            type: 'commentary_delta',
            payload: { text: 'too late' },
          },
        },
      ],
    }),
    /run checkpoint is terminal/u,
  );
  const checkpointJson = JSON.parse(
    await readFile(
      join(stateRoot, '.geulbat', 'run-checkpoints', `${threadId}.json`),
      'utf8',
    ),
  ) as Record<string, unknown>;
  assert.equal('eventHistory' in checkpointJson, false);
});

void test('pending interjects survive recreation and claim wins against cancellation', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-run-checkpoint-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const store = createRunCheckpointStore({ stateRoot });
  const runId = assertRunId(randomUUID());
  const threadId = assertThreadId(randomUUID());
  await store.startRun({
    runId,
    threadId,
    request: { workingDirectory: '/workspace', permissionMode: 'basic' },
  });

  assert.equal(
    (
      await store.enqueueInterject({
        threadId,
        runId,
        interject: { receivedSeq: 1, text: 'first' },
      })
    ).ok,
    true,
  );
  await store.enqueueInterject({
    threadId,
    runId,
    interject: { receivedSeq: 2, text: 'second' },
  });
  await assert.rejects(
    store.settleRun({
      threadId,
      runId,
      terminal: {
        eventCursor: 1,
        event: { type: 'done', payload: { answer: '', ok: true } },
      },
    }),
    /still has pending interjects/u,
  );

  const reloaded = createRunCheckpointStore({ stateRoot });
  assert.deepEqual(
    await reloaded.readThread(threadId),
    await store.readThread(threadId),
  );
  const claimed = await reloaded.claimInterject({
    threadId,
    runId,
    receivedSeq: 1,
  });
  assert.equal(claimed.ok && claimed.changed, true);
  const applyingCancel = await reloaded.cancelInterject({
    threadId,
    runId,
    receivedSeq: 1,
  });
  assert.deepEqual(
    applyingCancel.ok
      ? { ok: applyingCancel.ok, changed: applyingCancel.changed }
      : applyingCancel,
    { ok: true, changed: false },
  );
  const pendingCancel = await reloaded.cancelInterject({
    threadId,
    runId,
    receivedSeq: 2,
  });
  assert.equal(pendingCancel.ok && pendingCancel.changed, true);
  const completed = await reloaded.completeInterject({
    threadId,
    runId,
    receivedSeq: 1,
  });
  assert.equal(completed.ok && completed.changed, true);
  assert.deepEqual(
    await reloaded
      .settleRun({
        threadId,
        runId,
        terminal: {
          eventCursor: 1,
          event: { type: 'done', payload: { answer: '', ok: true } },
        },
      })
      .then((checkpoint) => ({
        status: checkpoint.status,
        applyingInterject: checkpoint.applyingInterject,
        pendingInterjects: checkpoint.pendingInterjects,
      })),
    { status: 'terminal', applyingInterject: null, pendingInterjects: [] },
  );
});

void test('interject enqueue is idempotent but rejects sequence reuse with different text', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-run-checkpoint-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const store = createRunCheckpointStore({ stateRoot });
  const runId = assertRunId(randomUUID());
  const threadId = assertThreadId(randomUUID());
  await store.startRun({
    runId,
    threadId,
    request: { workingDirectory: '/workspace', permissionMode: 'basic' },
  });
  const interject = { receivedSeq: 1, text: 'same input' };

  assert.equal(
    (await store.enqueueInterject({ threadId, runId, interject })).ok,
    true,
  );
  const duplicate = await store.enqueueInterject({
    threadId,
    runId,
    interject,
  });
  assert.equal(duplicate.ok && !duplicate.changed, true);
  assert.deepEqual(
    await store.enqueueInterject({
      threadId,
      runId,
      interject: { receivedSeq: 1, text: 'different input' },
    }),
    { ok: false, code: 'sequence_conflict' },
  );
});

void test('a running checkpoint rejects replacement by a different run', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-run-checkpoint-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const store = createRunCheckpointStore({ stateRoot });
  const firstRunId = assertRunId(randomUUID());
  const threadId = assertThreadId(randomUUID());
  await store.startRun({
    runId: firstRunId,
    threadId,
    request: { workingDirectory: '/workspace', permissionMode: 'basic' },
  });

  assert.deepEqual(
    await store.startRun({
      runId: assertRunId(randomUUID()),
      threadId,
      request: { workingDirectory: '/other', permissionMode: 'full_access' },
    }),
    { ok: false, activeRunId: firstRunId },
  );
});

void test('approval decision atomically persists a current-run permission mode change', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-run-checkpoint-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const store = createRunCheckpointStore({ stateRoot });
  const runId = assertRunId(randomUUID());
  const threadId = assertThreadId(randomUUID());
  const approvalClass = toApprovalClass('write_file:computer');
  await store.startRun({
    runId,
    threadId,
    request: { workingDirectory: '/workspace', permissionMode: 'basic' },
  });

  const pending = await store.recordApprovalPending({
    threadId,
    runId,
    callId: 'call-durable-approval',
    approvalClass,
  });
  assert.equal(pending.ok && pending.changed, true);
  const duplicatePending = await store.recordApprovalPending({
    threadId,
    runId,
    callId: 'call-durable-approval',
    approvalClass,
  });
  assert.equal(duplicatePending.ok && !duplicatePending.changed, true);
  assert.deepEqual(
    await store.recordApprovalPending({
      threadId,
      runId,
      callId: 'call-durable-approval',
      approvalClass: toApprovalClass('execute_code'),
    }),
    { ok: false, code: 'approval_conflict' },
  );

  const reloaded = createRunCheckpointStore({ stateRoot });
  assert.deepEqual((await reloaded.readThread(threadId))?.approvals, [
    {
      status: 'pending',
      callId: 'call-durable-approval',
      approvalClass,
    },
  ]);
  const decided = await reloaded.recordApprovalDecision({
    threadId,
    runId,
    callId: 'call-durable-approval',
    decision: 'approved',
    grantScope: 'run',
    permissionMode: 'full_access',
  });
  assert.equal(decided.ok && decided.changed, true);
  const duplicateDecision = await store.recordApprovalDecision({
    threadId,
    runId,
    callId: 'call-durable-approval',
    decision: 'approved',
    grantScope: 'run',
    permissionMode: 'full_access',
  });
  assert.equal(duplicateDecision.ok && !duplicateDecision.changed, true);
  assert.deepEqual(
    await store.recordApprovalDecision({
      threadId,
      runId,
      callId: 'call-durable-approval',
      decision: 'approved',
      grantScope: 'run',
      permissionMode: 'basic',
    }),
    { ok: false, code: 'approval_conflict' },
  );
  const checkpoint = await store.readThread(threadId);
  assert.equal(checkpoint?.request.permissionMode, 'full_access');
  assert.deepEqual(checkpoint?.approvals, [
    {
      status: 'decided',
      callId: 'call-durable-approval',
      approvalClass,
      decision: 'approved',
      grantScope: 'run',
    },
  ]);
});

void test('approval decision fails closed when no matching pending identity exists', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-run-checkpoint-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const store = createRunCheckpointStore({ stateRoot });
  const runId = assertRunId(randomUUID());
  const threadId = assertThreadId(randomUUID());
  await store.startRun({
    runId,
    threadId,
    request: { workingDirectory: '/workspace', permissionMode: 'basic' },
  });

  assert.deepEqual(
    await store.recordApprovalDecision({
      threadId,
      runId,
      callId: 'call-never-pending',
      decision: 'approved',
      grantScope: 'once',
    }),
    { ok: false, code: 'approval_not_pending' },
  );
});

void test('legacy running checkpoints load with an empty durable interject queue', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-run-checkpoint-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const runId = assertRunId(randomUUID());
  const threadId = assertThreadId(randomUUID());
  const root = join(stateRoot, '.geulbat', 'run-checkpoints');
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, `${threadId}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      status: 'running',
      runId,
      threadId,
      request: { workingDirectory: '/workspace', permissionMode: 'basic' },
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
    })}\n`,
    'utf8',
  );

  const checkpoint = await createRunCheckpointStore({ stateRoot }).readThread(
    threadId,
  );
  assert.deepEqual(
    checkpoint === null
      ? null
      : {
          interjectSeq: checkpoint.interjectSeq,
          applyingInterject: checkpoint.applyingInterject,
          pendingInterjects: checkpoint.pendingInterjects,
          approvals: checkpoint.approvals,
          terminal: checkpoint.terminal,
        },
    {
      interjectSeq: 0,
      applyingInterject: null,
      pendingInterjects: [],
      approvals: [],
      terminal: null,
    },
  );
});

void test('persisted loop implementation identity fails closed when its contract version is blank', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-run-checkpoint-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const runId = assertRunId(randomUUID());
  const threadId = assertThreadId(randomUUID());
  const root = join(stateRoot, '.geulbat', 'run-checkpoints');
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, `${threadId}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      status: 'running',
      runId,
      threadId,
      request: {
        workingDirectory: '/workspace',
        permissionMode: 'basic',
        loopImplementation: {
          implementationId: 'test.loop',
          contractVersion: ' ',
        },
      },
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
    })}\n`,
    'utf8',
  );

  await assert.rejects(
    createRunCheckpointStore({ stateRoot }).readThread(threadId),
    /invalid recoverable agent loop implementation identity/u,
  );
});

void test('persisted provider transition recovery fails closed without a cross-provider target', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-run-checkpoint-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const runId = assertRunId(randomUUID());
  const threadId = assertThreadId(randomUUID());
  const root = join(stateRoot, '.geulbat', 'run-checkpoints');
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, `${threadId}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      status: 'running',
      runId,
      threadId,
      request: {
        workingDirectory: '/workspace',
        permissionMode: 'basic',
        providerModel: {
          providerId: 'openai_codex_direct',
          model: 'gpt-5.6-luna',
        },
        providerTransitionRecovery: {
          sourceModelId: 'gpt-5.6-sol',
          sourceReasoningEffort: 'high',
        },
      },
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
    })}\n`,
    'utf8',
  );

  await assert.rejects(
    createRunCheckpointStore({ stateRoot }).readThread(threadId),
    /invalid recoverable provider transition recovery/u,
  );
});

void test('persisted Fast tier fails closed for a non-OpenAI provider', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-run-checkpoint-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const runId = assertRunId(randomUUID());
  const threadId = assertThreadId(randomUUID());
  const root = join(stateRoot, '.geulbat', 'run-checkpoints');
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, `${threadId}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      status: 'running',
      runId,
      threadId,
      request: {
        workingDirectory: '/workspace',
        permissionMode: 'basic',
        providerModel: {
          providerId: 'grok_oauth',
          model: 'grok-4.5',
        },
        serviceTier: 'fast',
      },
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
    })}\n`,
    'utf8',
  );

  await assert.rejects(
    createRunCheckpointStore({ stateRoot }).readThread(threadId),
    /invalid recoverable run request/u,
  );
});

void test('recoverable checkpoints reject ambiguous legacy and explicit tool policy state', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-run-checkpoint-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const runId = assertRunId(randomUUID());
  const threadId = assertThreadId(randomUUID());
  const root = join(stateRoot, '.geulbat', 'run-checkpoints');
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, `${threadId}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      status: 'running',
      runId,
      threadId,
      request: {
        workingDirectory: '/workspace',
        permissionMode: 'basic',
        toolSurface: {
          directRegistryNames: ['list_files'],
          allowedRegistryNames: ['list_files', 'read_file'],
        },
        toolCapabilityPolicy: createToolCapabilityPolicy({
          directRegistryNames: ['list_files'],
          allowedRegistryNames: ['list_files', 'read_file'],
          callbackRegistryNames: ['read_file'],
          writeCallbackEnabled: false,
        }),
      },
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
    })}\n`,
    'utf8',
  );

  await assert.rejects(
    createRunCheckpointStore({ stateRoot }).readThread(threadId),
    /cannot contain both toolSurface and toolCapabilityPolicy/u,
  );
});

void test('corrupt checkpoint bytes fail closed instead of disappearing', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-run-checkpoint-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const threadId = assertThreadId(randomUUID());
  const root = join(stateRoot, '.geulbat', 'run-checkpoints');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, `${threadId}.json`), '{', 'utf8');
  const store = createRunCheckpointStore({ stateRoot });
  await assert.rejects(store.readThread(threadId), SyntaxError);
});

void test('run checkpoints persist the isolated Qwen provider model pin', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-run-checkpoint-qwen-'),
  );
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const runId = assertRunId(randomUUID());
  const threadId = assertThreadId(randomUUID());
  const store = createRunCheckpointStore({ stateRoot });

  const started = await store.startRun({
    runId,
    threadId,
    request: {
      workingDirectory: '/workspace',
      permissionMode: 'basic',
      providerModel: {
        providerId: 'qwen_token_plan',
        model: 'qwen3.8-max-preview',
      },
      reasoningEffort: 'high',
      serviceTier: 'standard',
    },
  });
  assert.equal(started.ok, true);
  assert.deepEqual(
    (await createRunCheckpointStore({ stateRoot }).readThread(threadId))
      ?.request.providerModel,
    {
      providerId: 'qwen_token_plan',
      model: 'qwen3.8-max-preview',
    },
  );
});
