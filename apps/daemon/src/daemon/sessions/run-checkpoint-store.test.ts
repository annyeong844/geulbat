import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';

import { assertRunId, assertThreadId } from '@geulbat/protocol/ids';
import { toApprovalClass } from '@geulbat/protocol/run-approval';

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

  const started = await store.startRun({
    runId,
    threadId,
    request: { workingDirectory: '/workspace', permissionMode: 'basic' },
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

void test('approval pending and decision survive recreation without downgrading or changing identity', async (t) => {
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
  });
  assert.equal(decided.ok && decided.changed, true);
  const duplicateDecision = await store.recordApprovalDecision({
    threadId,
    runId,
    callId: 'call-durable-approval',
    decision: 'approved',
    grantScope: 'run',
  });
  assert.equal(duplicateDecision.ok && !duplicateDecision.changed, true);
  assert.deepEqual(
    await store.recordApprovalDecision({
      threadId,
      runId,
      callId: 'call-durable-approval',
      decision: 'denied',
      grantScope: 'once',
    }),
    { ok: false, code: 'approval_conflict' },
  );
  assert.deepEqual((await store.readThread(threadId))?.approvals, [
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
