import test from 'node:test';
import assert from 'node:assert/strict';

import type { AgentEvent } from '../runtime-contracts.js';
import { createLiveRunEventStore } from './live-run-events.js';
import { testThreadId } from '../../test-support/thread-id.js';
import { assertSessionRunId } from './contract.js';

const startedEvent: AgentEvent = {
  type: 'commentary_delta',
  payload: { text: 'working' },
};

const doneEvent: AgentEvent = {
  type: 'done',
  payload: { answer: 'finished', ok: true },
};

void test('live run events commit one durable terminal envelope before delivery', async () => {
  const store = createLiveRunEventStore();
  const runId = assertSessionRunId('run-live-events-sequence');
  const delivered: number[] = [];
  const persisted: number[] = [];

  assert.equal(store.hasRun(runId), false);
  store.startRun({
    runId,
    threadId: testThreadId(301),
    ownerId: 'socket-session-a',
    sink: (envelope) => {
      delivered.push(envelope.seq);
      return true;
    },
  });
  assert.equal(store.hasRun(runId), true);

  assert.deepEqual(store.publishRunEvent(runId, startedEvent), {
    seq: 0,
    delivery: 'delivered',
  });
  assert.deepEqual(
    await store.commitTerminalRunEvent({
      runId,
      event: doneEvent,
      async persist(envelope) {
        persisted.push(envelope.seq);
        assert.deepEqual(delivered, [0]);
      },
    }),
    {
      seq: 1,
      delivery: 'delivered',
    },
  );
  assert.deepEqual(persisted, [1]);
  assert.deepEqual(delivered, [0, 1]);
  store.finishRun(runId);
  assert.equal(store.hasRun(runId), false);
});

void test('live run events replay only events produced while the owner was detached', async () => {
  const store = createLiveRunEventStore();
  const runId = assertSessionRunId('run-live-events-rebind');
  const threadId = testThreadId(302);
  const firstOwnerEvents: number[] = [];
  const replacementEvents: number[] = [];

  store.startRun({
    runId,
    threadId,
    ownerId: 'socket-session-a',
    sink: (envelope) => {
      firstOwnerEvents.push(envelope.seq);
      return true;
    },
  });
  store.publishRunEvent(runId, startedEvent);
  store.detachOwner('socket-session-a');
  await store.commitTerminalRunEvent({
    runId,
    event: doneEvent,
    async persist() {},
  });
  store.finishRun(runId);

  assert.deepEqual(
    store.bindDetachedRuns({
      ownerId: 'socket-session-b',
      sink: (envelope) => {
        replacementEvents.push(envelope.seq);
        return true;
      },
    }),
    [
      {
        runId,
        threadId,
        previousOwnerId: 'socket-session-a',
        terminal: true,
      },
    ],
  );
  assert.deepEqual(firstOwnerEvents, [0]);
  assert.deepEqual(replacementEvents, [1]);
  assert.deepEqual(
    store.bindDetachedRuns({
      ownerId: 'socket-session-c',
      sink: () => true,
    }),
    [],
  );
});

void test('live run events retain a frame when the current sink cannot deliver it', () => {
  const store = createLiveRunEventStore();
  const runId = assertSessionRunId('run-live-events-send-failure');
  const replayed: number[] = [];

  store.startRun({
    runId,
    threadId: testThreadId(303),
    ownerId: 'socket-session-a',
    sink: () => false,
  });

  assert.deepEqual(store.publishRunEvent(runId, startedEvent), {
    seq: 0,
    delivery: 'buffered',
  });
  assert.equal(
    store.bindDetachedRuns({
      ownerId: 'socket-session-b',
      sink: (envelope) => {
        replayed.push(envelope.seq);
        return true;
      },
    }).length,
    1,
  );
  assert.deepEqual(replayed, [0]);
});

void test('live run events reject duplicate delivery ownership for one run', () => {
  const store = createLiveRunEventStore();
  const runId = assertSessionRunId('run-live-events-duplicate');
  const args = {
    runId,
    threadId: testThreadId(304),
    ownerId: 'socket-session-a',
    sink: () => true,
  };

  store.startRun(args);
  assert.throws(
    () => store.startRun(args),
    /live run event delivery already exists/u,
  );
});

void test('failed terminal persistence consumes no cursor and emits no event', async () => {
  const store = createLiveRunEventStore();
  const runId = assertSessionRunId('run-live-events-terminal-rollback');
  const delivered: number[] = [];
  store.startRun({
    runId,
    threadId: testThreadId(305),
    ownerId: 'socket-session-a',
    sink: (envelope) => {
      delivered.push(envelope.seq);
      return true;
    },
  });

  await assert.rejects(
    store.commitTerminalRunEvent({
      runId,
      event: doneEvent,
      async persist() {
        throw new Error('disk unavailable');
      },
    }),
    /disk unavailable/u,
  );
  assert.deepEqual(delivered, []);
  assert.deepEqual(
    await store.commitTerminalRunEvent({
      runId,
      event: doneEvent,
      async persist() {},
    }),
    { seq: 0, delivery: 'delivered' },
  );
});
