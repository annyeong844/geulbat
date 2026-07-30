import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';

import { AGENT_LOOP_TERMINAL_SOURCES } from '@geulbat/agent-loop/kernel';
import { assertRunId, assertThreadId } from '@geulbat/protocol/ids';
import { toApprovalClass } from '@geulbat/protocol/run-approval';
import { createToolCapabilityPolicy } from '@geulbat/tool-library/tool-capability-policy';

import { RUN_CHECKPOINT_MODEL_SETTLEMENT_SOURCES } from './run-checkpoint-persistence.js';
import { createRunCheckpointStore } from './run-checkpoint-store.js';

void test('model settlement persistence accepts every kernel terminal source', () => {
  assert.deepEqual(
    RUN_CHECKPOINT_MODEL_SETTLEMENT_SOURCES,
    AGENT_LOOP_TERMINAL_SOURCES,
  );
});

void test('run checkpoints preserve a cwd-free chat run', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-chat-checkpoint-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const runId = assertRunId(randomUUID());
  const threadId = assertThreadId(randomUUID());
  const store = createRunCheckpointStore({ stateRoot });

  const started = await store.startRun({
    runId,
    threadId,
    request: { permissionMode: 'basic' },
  });

  assert.equal(started.ok, true);
  assert.deepEqual(
    (await createRunCheckpointStore({ stateRoot }).readThread(threadId))
      ?.request,
    { permissionMode: 'basic' },
  );
});

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
  const tornCheckpointPath = join(
    stateRoot,
    '.geulbat',
    'run-checkpoints',
    `${tornThreadId}.json`,
  );
  const checkpointBeforeRejectedMutation = await readFile(
    tornCheckpointPath,
    'utf8',
  );

  // 손상된 스레드를 **명시적으로** 물으면 실패가 숨겨지지 않는다.
  await assert.rejects(
    reloaded.readThread(tornThreadId),
    /run event journal/u,
    '손상된 저널은 그 스레드를 물었을 때 거부되어야 한다',
  );
  // 재시작 직후의 metadata mutation도 checkpoint 파일만 믿고 진행하면 안 된다.
  // 먼저 durable journal 전체를 검증하고, 손상 시 checkpoint는 한 바이트도
  // 바꾸지 않아야 이후 복구가 같은 사실을 관찰한다.
  await assert.rejects(
    reloaded.recordApprovalPending({
      threadId: tornThreadId,
      runId: tornRunId,
      callId: 'call-after-torn-journal',
      approvalClass: toApprovalClass('write_file:computer'),
    }),
    /run event journal/u,
    '재시작 뒤 mutation은 손상된 durable journal을 우회하면 안 된다',
  );
  assert.equal(
    await readFile(tornCheckpointPath, 'utf8'),
    checkpointBeforeRejectedMutation,
    '거부된 mutation은 checkpoint를 부분 갱신하면 안 된다',
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
  const runningRecoveryCandidates = await reloaded.listRecoveryCandidates();
  assert.deepEqual(
    {
      running: runningRecoveryCandidates.running.map(
        (checkpoint) => checkpoint.runId,
      ),
      unacknowledgedTerminal:
        runningRecoveryCandidates.unacknowledgedTerminal.map(
          (checkpoint) => checkpoint.runId,
        ),
    },
    { running: [runId], unacknowledgedTerminal: [] },
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
    await reloaded.listRecoveryCandidates().then((candidates) => ({
      running: candidates.running.map((checkpoint) => checkpoint.runId),
      unacknowledgedTerminal: candidates.unacknowledgedTerminal.map(
        (checkpoint) => checkpoint.runId,
      ),
    })),
    { running: [], unacknowledgedTerminal: [runId] },
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
  assert.deepEqual(await reloaded.listRecoveryCandidates(), {
    running: [],
    unacknowledgedTerminal: [],
  });
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

void test('terminal settlement atomically discards applying and pending interjects when explicitly requested', async (t) => {
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
  await store.enqueueInterject({
    threadId,
    runId,
    interject: { receivedSeq: 1, text: 'applying' },
  });
  await store.enqueueInterject({
    threadId,
    runId,
    interject: { receivedSeq: 2, text: 'pending' },
  });
  await store.claimInterject({ threadId, runId, receivedSeq: 1 });

  const checkpoint = await store.settleRun({
    threadId,
    runId,
    discardPendingInterjects: true,
    terminal: {
      eventCursor: 1,
      event: {
        type: 'error',
        payload: { code: 'aborted', message: 'run cancelled' },
      },
    },
  });

  assert.equal(checkpoint.status, 'terminal');
  assert.equal(checkpoint.applyingInterject, null);
  assert.deepEqual(checkpoint.pendingInterjects, []);
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

void test('approval abort durably settles a pending approval without recording a user grant', async (t) => {
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
  await store.recordApprovalPending({
    threadId,
    runId,
    callId: 'call-aborted-approval',
    approvalClass,
  });

  const aborted = await store.recordApprovalDecision({
    threadId,
    runId,
    callId: 'call-aborted-approval',
    decision: 'aborted',
  });
  assert.equal(aborted.ok && aborted.changed, true);
  const duplicateAbort = await store.recordApprovalDecision({
    threadId,
    runId,
    callId: 'call-aborted-approval',
    decision: 'aborted',
  });
  assert.equal(duplicateAbort.ok && !duplicateAbort.changed, true);
  assert.deepEqual(
    await store.recordApprovalDecision({
      threadId,
      runId,
      callId: 'call-aborted-approval',
      decision: 'approved',
      grantScope: 'once',
    }),
    { ok: false, code: 'approval_conflict' },
  );

  const reloaded = createRunCheckpointStore({ stateRoot });
  assert.deepEqual((await reloaded.readThread(threadId))?.approvals, [
    {
      status: 'decided',
      callId: 'call-aborted-approval',
      approvalClass,
      decision: 'aborted',
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

void test('run checkpoints persist fail-closed background child recovery ownership', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-child-run-checkpoint-'),
  );
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const runId = assertRunId(randomUUID());
  const threadId = assertThreadId(randomUUID());
  const parentRunId = assertRunId(randomUUID());
  const ownerThreadId = assertThreadId(randomUUID());
  const store = createRunCheckpointStore({ stateRoot });

  await store.startRun({
    runId,
    threadId,
    request: {
      workingDirectory: '/workspace',
      permissionMode: 'basic',
      backgroundChild: {
        parentRunId,
        ownerThreadId,
        computerSessionId: 'durable-computer-session',
        timeoutAt: '2026-07-28T01:02:03.000Z',
      },
    },
  });

  const reloaded = createRunCheckpointStore({ stateRoot });
  assert.deepEqual(
    (await reloaded.readThread(threadId))?.request.backgroundChild,
    {
      parentRunId,
      ownerThreadId,
      computerSessionId: 'durable-computer-session',
      timeoutAt: '2026-07-28T01:02:03.000Z',
    },
  );

  const checkpointPath = join(
    stateRoot,
    '.geulbat',
    'run-checkpoints',
    `${threadId}.json`,
  );
  const persisted = JSON.parse(await readFile(checkpointPath, 'utf8')) as {
    request: { backgroundChild: { timeoutAt: string } };
  };
  persisted.request.backgroundChild.timeoutAt = 'not-a-timestamp';
  await writeFile(checkpointPath, `${JSON.stringify(persisted)}\n`, 'utf8');

  await assert.rejects(
    createRunCheckpointStore({ stateRoot }).readThread(threadId),
    /invalid recoverable background child binding/u,
  );
});

void test('active model rounds survive restart and fence the stale execution claim', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-model-round-checkpoint-'),
  );
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const runId = assertRunId(randomUUID());
  const threadId = assertThreadId(randomUUID());
  const firstClaimId = randomUUID();
  const replacementClaimId = randomUUID();
  const providerRequestIdentity = 'a'.repeat(64);
  const logicalRequestIdentity = `sha256:${'e'.repeat(64)}` as const;
  const store = createRunCheckpointStore({ stateRoot });

  await store.startRun({
    runId,
    threadId,
    request: { workingDirectory: '/workspace', permissionMode: 'basic' },
  });
  assert.deepEqual((await store.readThread(threadId))?.modelRoundState, {
    nextRound: 0,
    active: null,
    settledUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    },
    continuation: null,
  });

  const prepared = await store.recordModelRoundPrepared?.({
    threadId,
    runId,
    active: {
      round: 0,
      claimId: firstClaimId,
      modelRoundAttempt: 0,
      providerRequestAttempt: 0,
      providerId: 'openai_codex_direct',
      model: 'gpt-5.6-sol',
      transportKind: 'websocket',
      providerRequestIdentity,
      contextDigest: `sha256:${'b'.repeat(64)}`,
      toolLibraryProjectionIdentity: {
        sdkVersion: 'sdk-model-round-v1',
        sdkProjectionHash: `sha256:${'c'.repeat(64)}`,
        policyId: 'sha256:model-round-policy',
      },
      responseFormat: null,
      providerReplayScopeId: `sha256:${'d'.repeat(64)}`,
      logicalRequestIdentity,
    },
  });
  assert.equal(prepared?.ok, true);

  const streaming = await store.markModelRoundPhase?.({
    threadId,
    runId,
    claimId: firstClaimId,
    providerRequestIdentity,
    phase: 'streaming',
  });
  assert.equal(streaming?.ok, true);

  const replacement = createRunCheckpointStore({ stateRoot });
  const claimed = await replacement.claimActiveModelRound?.({
    threadId,
    runId,
    claimId: replacementClaimId,
  });
  assert.equal(claimed?.ok, true);
  assert.equal(
    claimed?.ok
      ? claimed.checkpoint.modelRoundState?.active?.claimRevision
      : undefined,
    2,
  );

  const stale = await store.markModelRoundPhase?.({
    threadId,
    runId,
    claimId: firstClaimId,
    providerRequestIdentity,
    phase: 'terminal_observed',
  });
  assert.deepEqual(stale, {
    ok: false,
    code: 'model_round_claim_conflict',
  });

  const terminal = await replacement.markModelRoundPhase?.({
    threadId,
    runId,
    claimId: replacementClaimId,
    providerRequestIdentity,
    phase: 'terminal_observed',
  });
  assert.equal(terminal?.ok, true);
  const candidate = await replacement.recordModelRoundSettlementCandidate?.({
    threadId,
    runId,
    claimId: replacementClaimId,
    logicalRequestIdentity,
    providerRequestIdentity,
    candidateDigest: `sha256:${'f'.repeat(64)}`,
    usage: {
      inputTokens: 11,
      outputTokens: 7,
      cachedInputTokens: 3,
    },
  });
  assert.equal(candidate?.ok, true);
  const committed = await replacement.commitModelRoundSettlement?.({
    threadId,
    runId,
    claimId: replacementClaimId,
    logicalRequestIdentity,
    candidateDigest: `sha256:${'f'.repeat(64)}`,
    resultDigest: `sha256:${'0'.repeat(64)}`,
    result: {
      ok: true,
      finalProse: '',
      modelSettlementIdentity: logicalRequestIdentity,
    },
    disposition: 'continue',
    source: 'tool_completion',
    continuationHistoryText: 'continue with the settled model context',
  });
  assert.equal(committed?.ok, true);
  const completed = await replacement.completeModelRound?.({
    threadId,
    runId,
    claimId: replacementClaimId,
    logicalRequestIdentity,
    providerRequestIdentity,
  });
  assert.equal(completed?.ok, true);
  assert.deepEqual(
    completed?.ok ? completed.checkpoint.modelRoundState : undefined,
    {
      nextRound: 1,
      active: null,
      settledUsage: {
        inputTokens: 11,
        outputTokens: 7,
        cachedInputTokens: 3,
      },
      continuation: {
        round: 0,
        logicalRequestIdentity,
        historyText: 'continue with the settled model context',
      },
    },
  );
});

void test('a legacy active model round adopts its logical settlement identity', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-legacy-model-settlement-checkpoint-'),
  );
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const runId = assertRunId(randomUUID());
  const threadId = assertThreadId(randomUUID());
  const claimId = randomUUID();
  const logicalRequestIdentity = `sha256:${'6'.repeat(64)}` as const;
  const active = {
    round: 0,
    claimId,
    modelRoundAttempt: 0,
    providerRequestAttempt: 0,
    providerId: 'openai_codex_direct' as const,
    model: 'gpt-5.6-sol',
    transportKind: 'websocket' as const,
    providerRequestIdentity: '7'.repeat(64),
    contextDigest: `sha256:${'8'.repeat(64)}` as const,
    toolLibraryProjectionIdentity: {
      sdkVersion: 'sdk-legacy-model-round-v1',
      sdkProjectionHash: `sha256:${'9'.repeat(64)}` as const,
      policyId: 'sha256:legacy-model-round-policy',
    },
    responseFormat: null,
    providerReplayScopeId: null,
    logicalRequestIdentity,
  };
  const store = createRunCheckpointStore({ stateRoot });
  await store.startRun({
    runId,
    threadId,
    request: { permissionMode: 'basic' },
  });
  assert.equal(
    (
      await store.recordModelRoundPrepared?.({
        threadId,
        runId,
        active,
      })
    )?.ok,
    true,
  );

  const checkpointPath = join(
    stateRoot,
    '.geulbat',
    'run-checkpoints',
    `${threadId}.json`,
  );
  const persisted = JSON.parse(await readFile(checkpointPath, 'utf8')) as {
    modelRoundState: {
      active: {
        logicalRequestIdentity?: string;
        settlement?: unknown;
      };
      settledUsage?: unknown;
      continuation?: unknown;
    };
  };
  delete persisted.modelRoundState.active.logicalRequestIdentity;
  delete persisted.modelRoundState.active.settlement;
  delete persisted.modelRoundState.settledUsage;
  delete persisted.modelRoundState.continuation;
  await writeFile(checkpointPath, `${JSON.stringify(persisted)}\n`, 'utf8');

  const replacement = createRunCheckpointStore({ stateRoot });
  assert.deepEqual((await replacement.readThread(threadId))?.modelRoundState, {
    nextRound: 0,
    active: {
      ...active,
      logicalRequestIdentity: null,
      settlement: null,
      claimRevision: 1,
      phase: 'prepared',
    },
    settledUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    },
    continuation: null,
  });
  const migrated = await replacement.recordModelRoundPrepared?.({
    threadId,
    runId,
    active,
  });
  assert.equal(migrated?.ok && migrated.changed, true);
  assert.equal(
    migrated?.ok
      ? migrated.checkpoint.modelRoundState?.active?.logicalRequestIdentity
      : undefined,
    logicalRequestIdentity,
  );
});

void test('model settlement survives effect uncertainty and charges one logical result once', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-model-settlement-checkpoint-'),
  );
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const committedAt = '2026-07-29T15:00:00.000Z';
  const runId = assertRunId(randomUUID());
  const threadId = assertThreadId(randomUUID());
  const originalClaimId = randomUUID();
  const replacementClaimId = randomUUID();
  const providerRequestIdentity = 'a'.repeat(64);
  const logicalRequestIdentity = `sha256:${'1'.repeat(64)}` as const;
  const candidateDigest = `sha256:${'2'.repeat(64)}` as const;
  const usage = {
    inputTokens: 19,
    outputTokens: 5,
    cachedInputTokens: 11,
  };
  const store = createRunCheckpointStore({
    stateRoot,
    now: () => committedAt,
  });

  await store.startRun({
    runId,
    threadId,
    request: { permissionMode: 'basic' },
  });
  assert.equal(
    (
      await store.recordModelRoundPrepared?.({
        threadId,
        runId,
        active: {
          round: 0,
          claimId: originalClaimId,
          modelRoundAttempt: 0,
          providerRequestAttempt: 0,
          providerId: 'openai_codex_direct',
          model: 'gpt-5.6-sol',
          transportKind: 'websocket',
          providerRequestIdentity,
          contextDigest: `sha256:${'3'.repeat(64)}`,
          toolLibraryProjectionIdentity: {
            sdkVersion: 'sdk-model-settlement-v1',
            sdkProjectionHash: `sha256:${'4'.repeat(64)}`,
            policyId: 'sha256:model-settlement-policy',
          },
          responseFormat: null,
          providerReplayScopeId: null,
          logicalRequestIdentity,
        },
      })
    )?.ok,
    true,
  );
  assert.equal(
    (
      await store.markModelRoundPhase?.({
        threadId,
        runId,
        claimId: originalClaimId,
        providerRequestIdentity,
        phase: 'terminal_observed',
      })
    )?.ok,
    true,
  );

  const firstCandidate = await store.recordModelRoundSettlementCandidate?.({
    threadId,
    runId,
    claimId: originalClaimId,
    logicalRequestIdentity,
    providerRequestIdentity,
    candidateDigest,
    usage,
  });
  const replayedCandidate = await store.recordModelRoundSettlementCandidate?.({
    threadId,
    runId,
    claimId: originalClaimId,
    logicalRequestIdentity,
    providerRequestIdentity,
    candidateDigest,
    usage,
  });
  assert.equal(firstCandidate?.ok && firstCandidate.changed, true);
  assert.equal(replayedCandidate?.ok && replayedCandidate.changed, false);
  assert.deepEqual(
    await store.recordModelRoundSettlementCandidate?.({
      threadId,
      runId,
      claimId: originalClaimId,
      logicalRequestIdentity,
      providerRequestIdentity,
      candidateDigest,
      usage: { ...usage, outputTokens: usage.outputTokens + 1 },
    }),
    { ok: false, code: 'model_round_settlement_conflict' },
  );

  assert.equal(
    (
      await store.claimActiveModelRound?.({
        threadId,
        runId,
        claimId: replacementClaimId,
      })
    )?.ok,
    true,
  );
  assert.deepEqual(
    await store.beginModelRoundSettlementEffects?.({
      threadId,
      runId,
      claimId: originalClaimId,
      logicalRequestIdentity,
      candidateDigest,
    }),
    { ok: false, code: 'model_round_claim_conflict' },
  );
  const effectsStarted = await store.beginModelRoundSettlementEffects?.({
    threadId,
    runId,
    claimId: replacementClaimId,
    logicalRequestIdentity,
    candidateDigest,
  });
  assert.equal(effectsStarted?.ok && effectsStarted.changed, true);
  assert.equal(
    (await createRunCheckpointStore({ stateRoot }).readThread(threadId))
      ?.modelRoundState?.active?.settlement?.phase,
    'effects_started',
  );

  const result = {
    ok: true,
    finalProse: 'settled once',
    modelSettlementIdentity: logicalRequestIdentity,
  };
  const commitArgs = {
    threadId,
    runId,
    claimId: replacementClaimId,
    logicalRequestIdentity,
    candidateDigest,
    resultDigest: `sha256:${'5'.repeat(64)}` as const,
    result,
    disposition: 'terminal' as const,
    source: 'natural' as const,
    continuationHistoryText: null,
  };
  const committed = await store.commitModelRoundSettlement?.(commitArgs);
  const replayedCommit = await store.commitModelRoundSettlement?.(commitArgs);
  assert.equal(committed?.ok && committed.changed, true);
  assert.equal(replayedCommit?.ok && replayedCommit.changed, false);
  assert.deepEqual(
    replayedCommit?.ok
      ? replayedCommit.checkpoint.modelRoundState?.settledUsage
      : undefined,
    usage,
  );
  assert.equal(
    replayedCommit?.ok
      ? replayedCommit.checkpoint.modelRoundState?.active?.settlement
          ?.committedAt
      : undefined,
    committedAt,
  );
  assert.deepEqual(
    await store.commitModelRoundSettlement?.({
      ...commitArgs,
      result: { ...result, finalProse: 'divergent result' },
    }),
    { ok: false, code: 'model_round_settlement_conflict' },
  );

  const terminal = await store.settleRun({
    threadId,
    runId,
    terminal: {
      eventCursor: 1,
      event: {
        type: 'done',
        payload: { answer: result.finalProse, ok: true },
      },
      modelSettlementIdentity: logicalRequestIdentity,
    },
  });
  const replayedTerminal = await store.settleRun({
    threadId,
    runId,
    terminal: {
      eventCursor: 1,
      event: {
        type: 'done',
        payload: { answer: result.finalProse, ok: true },
      },
      modelSettlementIdentity: logicalRequestIdentity,
    },
  });
  assert.deepEqual(replayedTerminal, terminal);
  assert.equal(
    terminal.terminal?.modelSettlementIdentity,
    logicalRequestIdentity,
  );
});
