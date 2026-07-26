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
      terminal: started.checkpoint.terminal,
    },
    {
      interjectSeq: 0,
      applyingInterject: null,
      pendingInterjects: [],
      approvals: [],
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
