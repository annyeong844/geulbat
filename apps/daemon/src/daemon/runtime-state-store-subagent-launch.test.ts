import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { RunId, ThreadId } from '@geulbat/protocol/ids';
import type { SubagentLaunchPriorityClass } from '@geulbat/protocol/run-events';
import {
  DaemonRuntimeStateStoreError,
  createDaemonRuntimeStateStore,
} from './runtime-state-store.js';
import type { SubagentLaunchRequestInput } from './subagent-runtime-contracts.js';
import { makeLaunchRequest } from '../test-support/runtime-state-store.js';
import { testRunId } from '../test-support/run-id.js';
import { testThreadId } from '../test-support/thread-id.js';

void test('runtime-state store preserves a cwd-free subagent launch across restart', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const store = await createDaemonRuntimeStateStore({ homeStateRoot });
  const request = makeLaunchRequest(99, 'call-chat-child');
  const { workingDirectory: _omittedWorkingDirectory, ...cwdFreeRequest } =
    request;
  const restoredRequest = { ...cwdFreeRequest, ultraReasoning: false };

  try {
    const [accepted] = store.enqueueSubagentLaunchBatch([cwdFreeRequest]);
    assert.ok(accepted);
    assert.deepEqual(
      store.readSubagentLaunchInput(accepted.childRunId),
      restoredRequest,
    );

    store.close();
    const reopened = await createDaemonRuntimeStateStore({ homeStateRoot });
    try {
      assert.deepEqual(
        reopened.readSubagentLaunchInput(accepted.childRunId),
        restoredRequest,
      );
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state store atomically enqueues a same-round launch batch with stable identities', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const store = await createDaemonRuntimeStateStore({
    homeStateRoot,
    now: () => new Date('2026-07-23T00:00:00.000Z'),
  });
  const firstRequest = makeLaunchRequest(1, 'call-first');
  const secondRequest = makeLaunchRequest(1, 'call-second');

  try {
    const accepted = store.enqueueSubagentLaunchBatch([
      firstRequest,
      secondRequest,
    ]);
    assert.equal(accepted.length, 2);
    assert.equal(accepted[0]?.launchState, 'queued');
    assert.equal(accepted[1]?.launchState, 'queued');
    assert.equal(accepted[0]?.batchId, accepted[1]?.batchId);
    assert.equal(typeof accepted[0]?.batchId, 'string');
    assert.deepEqual(
      accepted.map((request) => request.batchPosition),
      [0, 1],
    );
    assert.deepEqual(
      accepted.map((request) => request.enqueueOrder),
      [1, 2],
    );

    const firstAccepted = accepted[0];
    const secondAccepted = accepted[1];
    assert.ok(firstAccepted);
    assert.ok(secondAccepted);
    store.markSubagentLaunchStarting(firstAccepted.childRunId);
    store.markSubagentLaunchStarted(firstAccepted.childRunId);
    store.recordSubagentRuntimeObservation({
      childRunId: firstAccepted.childRunId,
      runtime: {
        phase: 'tool_running',
        observedAt: '2026-07-23T00:00:01.000Z',
        lastTool: {
          name: 'read_file',
          callId: 'call-read-runtime',
          state: 'running',
        },
        partialOutputAvailable: true,
        providerRequest: {
          startedAt: '2026-07-23T00:00:00.000Z',
          lastEventAt: '2026-07-23T00:00:00.750Z',
          endedAt: '2026-07-23T00:00:01.000Z',
          durationMs: 1_000,
          attemptCount: 2,
          retry: {
            available: false,
            performed: true,
            outcome: 'recovered',
          },
        },
      },
    });
    store.markSubagentLaunchFailedToStart({
      childRunId: secondAccepted.childRunId,
      reason: 'child transcript persistence failed',
    });
    const started = store.readSubagentLaunchRequest({
      parentRunId: firstRequest.parentRunId,
      toolCallId: firstRequest.toolCallId,
    });
    assert.equal(started?.launchState, 'started');
    assert.deepEqual(started?.runtime, {
      phase: 'tool_running',
      observedAt: '2026-07-23T00:00:01.000Z',
      lastTool: {
        name: 'read_file',
        callId: 'call-read-runtime',
        state: 'running',
      },
      partialOutputAvailable: true,
      providerRequest: {
        startedAt: '2026-07-23T00:00:00.000Z',
        lastEventAt: '2026-07-23T00:00:00.750Z',
        endedAt: '2026-07-23T00:00:01.000Z',
        durationMs: 1_000,
        attemptCount: 2,
        retry: {
          available: false,
          performed: true,
          outcome: 'recovered',
        },
      },
    });
    assert.deepEqual(
      store.readSubagentLaunchRequest({
        parentRunId: secondRequest.parentRunId,
        toolCallId: secondRequest.toolCallId,
      }),
      {
        ...secondAccepted,
        launchState: 'failed_to_start',
        failureReason: 'child transcript persistence failed',
      },
    );

    store.close();
    const reopened = await createDaemonRuntimeStateStore({ homeStateRoot });
    try {
      assert.deepEqual(
        reopened.readSubagentLaunchRequest({
          parentRunId: firstRequest.parentRunId,
          toolCallId: firstRequest.toolCallId,
        })?.childRunId,
        firstAccepted.childRunId,
      );
      const interrupted = reopened.readSubagentLaunchRequest({
        parentRunId: firstRequest.parentRunId,
        toolCallId: firstRequest.toolCallId,
      });
      assert.equal(interrupted?.launchState, 'interrupted');
      assert.equal(interrupted?.failureReason, 'daemon_restart_interrupted');
      assert.deepEqual(interrupted?.runtime.providerRequest, {
        startedAt: '2026-07-23T00:00:00.000Z',
        lastEventAt: '2026-07-23T00:00:00.750Z',
        endedAt: '2026-07-23T00:00:01.000Z',
        durationMs: 1_000,
        attemptCount: 2,
        retry: {
          available: false,
          performed: true,
          outcome: 'recovered',
        },
      });
      assert.equal(
        reopened.readSubagentTerminalOutcomeByChildRunId(
          firstAccepted.childRunId,
        )?.result.terminalState,
        'failed',
      );
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state store persists provider admission phases used by reconnect diagnostics', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const store = await createDaemonRuntimeStateStore({ homeStateRoot });
  const [accepted] = store.enqueueSubagentLaunchBatch([
    makeLaunchRequest(3, 'call-provider-admission'),
  ]);

  try {
    assert.ok(accepted);
    store.markSubagentLaunchStarting(accepted.childRunId);
    store.markSubagentLaunchStarted(accepted.childRunId);
    store.recordSubagentRuntimeObservation({
      childRunId: accepted.childRunId,
      runtime: {
        phase: 'rate_limit_waiting',
        observedAt: '2026-07-23T00:00:01.000Z',
        partialOutputAvailable: false,
      },
    });

    assert.equal(
      store.readSubagentLaunchRequestByChildRunId(accepted.childRunId)?.runtime
        .phase,
      'rate_limit_waiting',
    );
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state store applies queued controls atomically without changing same-class order', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  let now = new Date('2026-07-23T03:00:00.000Z');
  const store = await createDaemonRuntimeStateStore({
    homeStateRoot,
    now: () => now,
  });
  const ownerThreadId = testThreadId(30);

  try {
    const [queued, starting] = store.enqueueSubagentLaunchBatch([
      makeLaunchRequest(30, 'call-queued-control'),
      makeLaunchRequest(30, 'call-starting-control'),
    ]);
    assert.ok(queued);
    assert.ok(starting);
    assert.deepEqual(
      store.readSubagentLaunchRequestByChildRunId(queued.childRunId),
      queued,
    );

    now = new Date('2026-07-23T03:01:00.000Z');
    const reprioritized = store.updateQueuedSubagentLaunchPriority({
      childRunId: queued.childRunId,
      ownerThreadId,
      priorityClass: 'high',
    });
    assert.equal(reprioritized.priorityClass, 'high');
    assert.equal(reprioritized.enqueueOrder, queued.enqueueOrder);
    assert.equal(reprioritized.createdAt, queued.createdAt);
    assert.equal(reprioritized.updatedAt, now.toISOString());

    now = new Date('2026-07-23T03:02:00.000Z');
    const unchanged = store.updateQueuedSubagentLaunchPriority({
      childRunId: queued.childRunId,
      ownerThreadId,
      priorityClass: 'high',
    });
    assert.equal(unchanged.updatedAt, reprioritized.updatedAt);

    assert.throws(
      () =>
        store.updateQueuedSubagentLaunchPriority({
          childRunId: queued.childRunId,
          ownerThreadId: testThreadId(31),
          priorityClass: 'low',
        }),
      (error: unknown) =>
        error instanceof DaemonRuntimeStateStoreError &&
        error.stage === 'operation',
    );
    assert.equal(
      store.readSubagentLaunchRequestByChildRunId(queued.childRunId)
        ?.priorityClass,
      'high',
    );

    const cancelled = store.cancelQueuedSubagentLaunchRequest({
      childRunId: queued.childRunId,
      ownerThreadId,
    });
    assert.equal(cancelled.launchState, 'cancelled');
    assert.equal(cancelled.enqueueOrder, queued.enqueueOrder);
    assert.throws(
      () => store.markSubagentLaunchStarting(queued.childRunId),
      (error: unknown) =>
        error instanceof DaemonRuntimeStateStoreError &&
        error.stage === 'operation',
    );

    store.markSubagentLaunchStarting(starting.childRunId);
    const nonQueuedPriority = store.updateQueuedSubagentLaunchPriority({
      childRunId: starting.childRunId,
      ownerThreadId,
      priorityClass: 'low',
    });
    assert.equal(nonQueuedPriority.launchState, 'starting');
    assert.equal(nonQueuedPriority.priorityClass, 'normal');
    const nonQueuedCancel = store.cancelQueuedSubagentLaunchRequest({
      childRunId: starting.childRunId,
      ownerThreadId,
    });
    assert.equal(nonQueuedCancel.launchState, 'starting');
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state store persists defer reasons and reads promotion order from durable priority', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const store = await createDaemonRuntimeStateStore({ homeStateRoot });
  const ownerThreadId = testThreadId(32);

  try {
    const [low, high] = store.enqueueSubagentLaunchBatch([
      makeLaunchRequest(32, 'call-defer-low'),
      makeLaunchRequest(32, 'call-defer-high'),
    ]);
    assert.ok(low);
    assert.ok(high);
    assert.deepEqual(store.readSubagentLaunchInput(low.childRunId), {
      ...makeLaunchRequest(32, 'call-defer-low'),
      ultraReasoning: false,
    });
    store.updateQueuedSubagentLaunchPriority({
      childRunId: low.childRunId,
      ownerThreadId,
      priorityClass: 'low',
    });
    store.updateQueuedSubagentLaunchPriority({
      childRunId: high.childRunId,
      ownerThreadId,
      priorityClass: 'high',
    });

    const deferred = store.markSubagentLaunchDeferredBatch({
      childRunIds: [low.childRunId, high.childRunId],
      deferReason: 'batch_group_wait',
    });
    assert.deepEqual(
      deferred.map((request) => request.deferReason),
      ['batch_group_wait', 'batch_group_wait'],
    );
    assert.deepEqual(
      store
        .readQueuedSubagentLaunchRequests()
        .map((request) => request.childRunId),
      [high.childRunId, low.childRunId],
    );

    store.markSubagentLaunchStarting(high.childRunId);
    assert.equal(
      store.readSubagentLaunchRequestByChildRunId(high.childRunId)?.deferReason,
      null,
    );
    const cancelled = store.cancelQueuedSubagentLaunchRequest({
      childRunId: low.childRunId,
      ownerThreadId,
    });
    assert.equal(cancelled.deferReason, null);

    const [starting, stillQueued] = store.enqueueSubagentLaunchBatch([
      makeLaunchRequest(32, 'call-defer-starting'),
      makeLaunchRequest(32, 'call-defer-still-queued'),
    ]);
    assert.ok(starting);
    assert.ok(stillQueued);
    store.markSubagentLaunchStarting(starting.childRunId);
    assert.throws(
      () =>
        store.markSubagentLaunchDeferredBatch({
          childRunIds: [starting.childRunId, stillQueued.childRunId],
          deferReason: 'configured_capacity',
        }),
      (error: unknown) =>
        error instanceof DaemonRuntimeStateStoreError &&
        error.stage === 'operation',
    );
    assert.equal(
      store.readSubagentLaunchRequestByChildRunId(stillQueued.childRunId)
        ?.deferReason,
      null,
    );
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state store rolls back the whole batch when one launch identity conflicts', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const store = await createDaemonRuntimeStateStore({ homeStateRoot });
  const existing = makeLaunchRequest(2, 'call-existing');
  const uncommitted = makeLaunchRequest(2, 'call-must-roll-back');

  try {
    store.enqueueSubagentLaunchBatch([existing]);
    assert.throws(
      () => store.enqueueSubagentLaunchBatch([uncommitted, existing]),
      (error: unknown) =>
        error instanceof DaemonRuntimeStateStoreError &&
        error.stage === 'operation',
    );
    assert.equal(
      store.readSubagentLaunchRequest({
        parentRunId: uncommitted.parentRunId,
        toolCallId: uncommitted.toolCallId,
      }),
      undefined,
    );
    assert.equal(
      store.readSubagentLaunchRequest({
        parentRunId: existing.parentRunId,
        toolCallId: existing.toolCallId,
      })?.launchState,
      'queued',
    );
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state retry creates one fresh child identity and preserves the interrupted attempt', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const ownerThreadId = testThreadId(70);
  let store = await createDaemonRuntimeStateStore({
    homeStateRoot,
    now: () => new Date('2026-07-23T07:00:00.000Z'),
  });

  try {
    const originalInput = makeLaunchRequest(70, 'call-original-attempt');
    const [original] = store.enqueueSubagentLaunchBatch([originalInput]);
    assert.ok(original);
    store.markSubagentLaunchStarting(original.childRunId);
    store.markSubagentLaunchStarted(original.childRunId);
    store.close();

    store = await createDaemonRuntimeStateStore({
      homeStateRoot,
      now: () => new Date('2026-07-23T07:01:00.000Z'),
    });
    assert.equal(
      store.readSubagentLaunchRequestByChildRunId(original.childRunId)
        ?.launchState,
      'interrupted',
    );
    const priorOutcome = store.readSubagentTerminalOutcomeByChildRunId(
      original.childRunId,
    );
    assert.ok(priorOutcome);

    const retryArgs = {
      previousChildRunId: original.childRunId,
      ownerThreadId,
      parentRunId: testRunId('retry-parent-70'),
      toolCallId: 'call-retry-attempt',
      stateRoot: '/tmp/retry-home-state',
      workingDirectory: '/tmp/retry-workspace',
      permissionMode: 'basic' as const,
    };
    const created = store.retryInterruptedSubagentLaunch(retryArgs);

    assert.equal(created.disposition, 'created');
    assert.notEqual(created.request.childRunId, original.childRunId);
    assert.notEqual(created.request.childThreadId, original.childThreadId);
    assert.equal(created.request.previousChildRunId, original.childRunId);
    assert.equal(created.request.launchState, 'queued');
    assert.deepEqual(created.request.runtime, {
      phase: 'queued',
      observedAt: '2026-07-23T07:01:00.000Z',
      partialOutputAvailable: false,
      previousChildRunId: original.childRunId,
    });
    assert.equal(created.input.task, originalInput.task);
    assert.equal(created.input.parentRunId, retryArgs.parentRunId);
    assert.equal(created.input.ownerThreadId, ownerThreadId);
    assert.equal(created.input.toolCallId, retryArgs.toolCallId);
    assert.equal(created.input.stateRoot, retryArgs.stateRoot);
    assert.equal(created.input.workingDirectory, retryArgs.workingDirectory);
    assert.equal(created.input.permissionMode, 'basic');
    assert.deepEqual(created.input.modelPin, originalInput.modelPin);
    assert.deepEqual(
      store.readSubagentTerminalOutcomeByChildRunId(original.childRunId),
      priorOutcome,
    );

    const sameCall = store.retryInterruptedSubagentLaunch(retryArgs);
    assert.equal(sameCall.disposition, 'same_call_replay');
    assert.equal(sameCall.request.childRunId, created.request.childRunId);

    const duplicate = store.retryInterruptedSubagentLaunch({
      ...retryArgs,
      toolCallId: 'call-competing-retry',
    });
    assert.equal(duplicate.disposition, 'already_retried');
    assert.equal(duplicate.request.childRunId, created.request.childRunId);
    assert.equal(
      store.readSubagentLaunchRequestByChildRunId(original.childRunId)
        ?.launchState,
      'interrupted',
    );
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state store refuses to retry a phantom, cross-thread, or non-interrupted launch', async (t) => {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-runtime-retry-guard-'),
  );
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const homeStateRoot = join(fixtureRoot, 'home-state');

  let store = await createDaemonRuntimeStateStore({ homeStateRoot });
  const startedRequest = makeLaunchRequest(40, 'call-retry-guard-started');
  const queuedRequest = makeLaunchRequest(40, 'call-retry-guard-queued');
  const [started, queued] = store.enqueueSubagentLaunchBatch([
    startedRequest,
    queuedRequest,
  ]);
  assert.ok(started);
  assert.ok(queued);
  store.markSubagentLaunchStarting(started.childRunId);
  store.markSubagentLaunchStarted(started.childRunId);
  store.close();

  // Reopening promotes the false-running child to `interrupted`; the queued one
  // is left untouched, so it remains a non-retryable launch state.
  store = await createDaemonRuntimeStateStore({ homeStateRoot });
  try {
    assert.equal(
      store.readSubagentLaunchRequestByChildRunId(started.childRunId)
        ?.launchState,
      'interrupted',
    );
    assert.equal(
      store.readSubagentLaunchRequestByChildRunId(queued.childRunId)
        ?.launchState,
      'queued',
    );

    const guardArgs = (previousChildRunId: RunId, ownerThreadId: ThreadId) => ({
      previousChildRunId,
      ownerThreadId,
      parentRunId: testRunId('parent-40'),
      toolCallId: 'call-retry-guard-new',
      stateRoot: '/tmp/geulbat-retry-state',
      workingDirectory: '/tmp/geulbat-retry-workspace',
    });

    // A retry that names a child the store never persisted must fail closed.
    assert.throws(
      () =>
        store.retryInterruptedSubagentLaunch(
          guardArgs(testRunId('phantom-child'), testThreadId(40)),
        ),
      expectStoreErrorCause(/does not exist/u),
    );

    // A retry requested by a different owner thread must not cross the boundary.
    assert.throws(
      () =>
        store.retryInterruptedSubagentLaunch(
          guardArgs(started.childRunId, testThreadId(999)),
        ),
      expectStoreErrorCause(/belongs to another owner thread/u),
    );

    // A launch that is still queued (live) cannot be retried.
    assert.throws(
      () =>
        store.retryInterruptedSubagentLaunch(
          guardArgs(queued.childRunId, testThreadId(40)),
        ),
      expectStoreErrorCause(/cannot be retried from queued/u),
    );
  } finally {
    store.close();
  }
});

void test('runtime-state store retry replays the same call, dedupes across calls, and rejects tool-call hijack', async (t) => {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-runtime-retry-dispose-'),
  );
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const homeStateRoot = join(fixtureRoot, 'home-state');

  let store = await createDaemonRuntimeStateStore({ homeStateRoot });
  const [childA, childB] = store.enqueueSubagentLaunchBatch([
    makeLaunchRequest(41, 'call-A'),
    makeLaunchRequest(41, 'call-B'),
  ]);
  assert.ok(childA);
  assert.ok(childB);
  for (const child of [childA, childB]) {
    store.markSubagentLaunchStarting(child.childRunId);
    store.markSubagentLaunchStarted(child.childRunId);
  }
  store.close();

  store = await createDaemonRuntimeStateStore({ homeStateRoot });
  try {
    const retryArgs = (previousChildRunId: RunId, toolCallId: string) => ({
      previousChildRunId,
      ownerThreadId: testThreadId(41),
      parentRunId: testRunId('parent-41'),
      toolCallId,
      stateRoot: '/tmp/geulbat-retry-state',
      workingDirectory: '/tmp/geulbat-retry-workspace',
    });

    const created = store.retryInterruptedSubagentLaunch(
      retryArgs(childA.childRunId, 'call-retry-A'),
    );
    assert.equal(created.disposition, 'created');
    assert.notEqual(created.request.childRunId, childA.childRunId);
    assert.equal(created.request.previousChildRunId, childA.childRunId);

    // Re-issuing the identical tool call replays the same durable retry request.
    const replay = store.retryInterruptedSubagentLaunch(
      retryArgs(childA.childRunId, 'call-retry-A'),
    );
    assert.equal(replay.disposition, 'same_call_replay');
    assert.equal(replay.request.childRunId, created.request.childRunId);

    // A fresh tool call for the same interrupted child returns the existing retry.
    const deduped = store.retryInterruptedSubagentLaunch(
      retryArgs(childA.childRunId, 'call-retry-A-again'),
    );
    assert.equal(deduped.disposition, 'already_retried');
    assert.equal(deduped.request.childRunId, created.request.childRunId);

    // A different interrupted child cannot claim a tool-call slot already owned
    // by another retry lineage.
    assert.throws(
      () =>
        store.retryInterruptedSubagentLaunch(
          retryArgs(childB.childRunId, 'call-retry-A'),
        ),
      expectStoreErrorCause(/conflicts with child run/u),
    );
  } finally {
    store.close();
  }
});

void test('runtime-state store launch controls enforce ownership, valid priority, and queued-only mutation', async (t) => {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-runtime-controls-'),
  );
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const store = await createDaemonRuntimeStateStore({
    homeStateRoot: join(fixtureRoot, 'home-state'),
  });
  try {
    const [queued] = store.enqueueSubagentLaunchBatch([
      makeLaunchRequest(42, 'call-control'),
    ]);
    assert.ok(queued);

    // Controls on a child the store never persisted must fail closed.
    assert.throws(
      () =>
        store.updateQueuedSubagentLaunchPriority({
          childRunId: testRunId('control-ghost'),
          ownerThreadId: testThreadId(42),
          priorityClass: 'high',
        }),
      expectStoreErrorCause(/does not exist/u),
    );

    // A control issued by a different owner thread must not cross the boundary.
    assert.throws(
      () =>
        store.cancelQueuedSubagentLaunchRequest({
          childRunId: queued.childRunId,
          ownerThreadId: testThreadId(777),
        }),
      expectStoreErrorCause(/does not belong to owner thread/u),
    );

    // An unrecognized priority class is rejected before any row is touched.
    assert.throws(
      () =>
        store.updateQueuedSubagentLaunchPriority({
          childRunId: queued.childRunId,
          ownerThreadId: testThreadId(42),
          priorityClass: 'urgent' as SubagentLaunchPriorityClass,
        }),
      expectStoreErrorCause(/invalid subagent launch priority/u),
    );

    // A valid priority change is applied while the launch is still queued.
    const raised = store.updateQueuedSubagentLaunchPriority({
      childRunId: queued.childRunId,
      ownerThreadId: testThreadId(42),
      priorityClass: 'high',
    });
    assert.equal(raised.launchState, 'queued');
    assert.equal(raised.priorityClass, 'high');

    // Re-applying the same priority is an idempotent no-op.
    const unchanged = store.updateQueuedSubagentLaunchPriority({
      childRunId: queued.childRunId,
      ownerThreadId: testThreadId(42),
      priorityClass: 'high',
    });
    assert.equal(unchanged.priorityClass, 'high');

    store.markSubagentLaunchStarting(queued.childRunId);
    store.markSubagentLaunchStarted(queued.childRunId);

    // Once a launch leaves the queue, priority and cancel controls are inert
    // no-ops that report the current durable state without mutating it.
    const afterStart = store.updateQueuedSubagentLaunchPriority({
      childRunId: queued.childRunId,
      ownerThreadId: testThreadId(42),
      priorityClass: 'low',
    });
    assert.equal(afterStart.launchState, 'started');
    assert.equal(afterStart.priorityClass, 'high');

    const cancelInert = store.cancelQueuedSubagentLaunchRequest({
      childRunId: queued.childRunId,
      ownerThreadId: testThreadId(42),
    });
    assert.equal(cancelInert.launchState, 'started');

    // Re-driving a started launch back through the starting transition is a
    // rejected state change, not a silent overwrite.
    assert.throws(
      () => store.markSubagentLaunchStarting(queued.childRunId),
      expectStoreErrorCause(/cannot transition from started to starting/u),
    );
  } finally {
    store.close();
  }
});

void test('runtime-state persists the isolated Qwen subagent model pin', async () => {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-runtime-state-qwen-'),
  );
  const homeStateRoot = join(fixtureRoot, 'home-state');
  let store = await createDaemonRuntimeStateStore({ homeStateRoot });

  try {
    const input: SubagentLaunchRequestInput = {
      ...makeLaunchRequest(96, 'call-qwen-model-pin'),
      modelPin: {
        modelId: 'qwen3.8-max-preview',
        providerRunSelection: {
          providerModel: {
            providerId: 'qwen_token_plan',
            model: 'qwen3.8-max-preview',
          },
          reasoningEffort: 'high',
        },
        selectionSource: 'user_fixed',
      },
    };
    const [queued] = store.enqueueSubagentLaunchBatch([input]);
    assert.ok(queued);
    store.markSubagentLaunchStarting(queued.childRunId);
    store.markSubagentLaunchStarted(queued.childRunId);
    store.close();

    store = await createDaemonRuntimeStateStore({ homeStateRoot });
    const retried = store.retryInterruptedSubagentLaunch({
      previousChildRunId: queued.childRunId,
      ownerThreadId: input.ownerThreadId,
      parentRunId: testRunId('qwen-retry-parent-96'),
      toolCallId: 'call-qwen-model-pin-retry',
      stateRoot: input.stateRoot,
      ...(input.workingDirectory === undefined
        ? {}
        : { workingDirectory: input.workingDirectory }),
      permissionMode: 'basic',
    });
    assert.equal(retried.disposition, 'created');
    assert.deepEqual(retried.input.modelPin, input.modelPin);
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

function expectStoreErrorCause(pattern: RegExp) {
  return (error: unknown): true => {
    assert.ok(
      error instanceof DaemonRuntimeStateStoreError,
      'retry failures surface as a typed runtime-state store error',
    );
    const cause = error.cause;
    assert.ok(
      cause instanceof Error,
      'the original guard error is preserved as the cause',
    );
    assert.match(cause.message, pattern);
    return true;
  };
}
