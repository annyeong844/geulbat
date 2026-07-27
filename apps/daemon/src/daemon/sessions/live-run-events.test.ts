import test from 'node:test';
import assert from 'node:assert/strict';

import type { AgentEvent } from '../runtime-contracts.js';
import type { RunCheckpointEvent } from './run-checkpoint-store.js';
import {
  createLiveRunEventStore,
  type LiveRunEventSink,
} from './live-run-events.js';
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
    async persistRunEvents(events) {
      persisted.push(...events.map((event) => event.seq));
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
        assert.deepEqual(persisted, [0]);
        persisted.push(envelope.seq);
        assert.deepEqual(delivered, [0]);
      },
    }),
    {
      seq: 1,
      delivery: 'delivered',
    },
  );
  assert.deepEqual(persisted, [0, 1]);
  assert.deepEqual(delivered, [0, 1]);
  store.finishRun(runId);
  assert.equal(store.hasRun(runId), false);
});

void test('live run events replay only events after the reconnect cursor', async () => {
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
    async persistRunEvents() {},
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
    await store.bindRuns({
      ownerId: 'socket-session-b',
      afterSeqByRun: new Map([[runId, 0]]),
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
    await store.bindRuns({
      ownerId: 'socket-session-c',
      sink: () => true,
    }),
    [],
  );
});

void test('live run events deliver transient output without persistence or replay', async () => {
  const store = createLiveRunEventStore();
  const runId = assertSessionRunId('run-live-events-transient-output');
  const threadId = testThreadId(309);
  const firstOwnerText: string[] = [];
  const reboundOwnerText: string[] = [];
  const persisted: number[] = [];
  const firstSink: LiveRunEventSink = () => true;
  firstSink.transient = (envelope) => {
    firstOwnerText.push(envelope.event.payload.text);
    return true;
  };

  store.startRun({
    runId,
    threadId,
    ownerId: 'socket-session-a',
    sink: firstSink,
    async persistRunEvents(events) {
      persisted.push(...events.map((event) => event.seq));
    },
  });

  assert.deepEqual(
    store.publishTransientRunEvent(runId, {
      type: 'tool_output_delta',
      payload: {
        callId: 'call-exec',
        tool: 'exec_command',
        stream: 'stdout',
        text: 'first',
      },
    }),
    { delivery: 'delivered' },
  );
  assert.deepEqual(firstOwnerText, ['first']);
  assert.deepEqual(persisted, []);

  const reboundSink: LiveRunEventSink = () => true;
  reboundSink.transient = (envelope) => {
    reboundOwnerText.push(envelope.event.payload.text);
    return true;
  };
  assert.deepEqual(
    await store.bindRuns({
      ownerId: 'socket-session-b',
      sink: reboundSink,
    }),
    [{ runId, threadId, terminal: false }],
  );
  assert.deepEqual(reboundOwnerText, []);

  store.publishTransientRunEvent(runId, {
    type: 'tool_output_delta',
    payload: {
      callId: 'call-exec',
      tool: 'exec_command',
      stream: 'stderr',
      text: 'second',
    },
  });
  assert.deepEqual(firstOwnerText, ['first', 'second']);
  assert.deepEqual(reboundOwnerText, ['second']);
  assert.deepEqual(persisted, []);
});

void test('live run events replay complete active history after browser state is lost', async () => {
  const store = createLiveRunEventStore();
  const runId = assertSessionRunId('run-live-events-browser-reload');
  const replayed: number[] = [];

  store.startRun({
    runId,
    threadId: testThreadId(306),
    ownerId: 'socket-session-a',
    sink: () => true,
    async persistRunEvents() {},
  });
  store.publishRunEvent(runId, startedEvent);
  store.publishRunEvent(runId, {
    type: 'commentary_delta',
    payload: { text: 'still working' },
  });
  store.detachOwner('socket-session-a');

  assert.equal(
    (
      await store.bindRuns({
        ownerId: 'socket-session-b',
        sink: (envelope) => {
          replayed.push(envelope.seq);
          return true;
        },
      })
    ).length,
    1,
  );
  assert.deepEqual(replayed, [0, 1]);
});

void test('live run events broadcast one active run to concurrent socket subscribers', async () => {
  const store = createLiveRunEventStore();
  const runId = assertSessionRunId('run-live-events-multi-subscriber');
  const threadId = testThreadId(307);
  const firstOwnerEvents: number[] = [];
  const secondOwnerEvents: number[] = [];

  store.startRun({
    runId,
    threadId,
    ownerId: 'socket-session-a',
    sink: (envelope) => {
      firstOwnerEvents.push(envelope.seq);
      return true;
    },
    async persistRunEvents() {},
  });
  store.publishRunEvent(runId, startedEvent);

  assert.deepEqual(
    await store.bindRuns({
      ownerId: 'socket-session-b',
      sink: (envelope) => {
        secondOwnerEvents.push(envelope.seq);
        return true;
      },
    }),
    [{ runId, threadId, terminal: false }],
  );
  assert.deepEqual(firstOwnerEvents, [0]);
  assert.deepEqual(secondOwnerEvents, [0]);

  assert.deepEqual(
    store.publishRunEvent(runId, {
      type: 'commentary_delta',
      payload: { text: 'visible in both tabs' },
    }),
    { seq: 1, delivery: 'delivered' },
  );
  assert.deepEqual(firstOwnerEvents, [0, 1]);
  assert.deepEqual(secondOwnerEvents, [0, 1]);

  store.detachOwner('socket-session-a');
  assert.deepEqual(
    store.publishRunEvent(runId, {
      type: 'commentary_delta',
      payload: { text: 'second tab keeps receiving' },
    }),
    { seq: 2, delivery: 'delivered' },
  );
  assert.deepEqual(firstOwnerEvents, [0, 1]);
  assert.deepEqual(secondOwnerEvents, [0, 1, 2]);
});

void test('live run events retain a frame when the current sink cannot deliver it', async () => {
  const store = createLiveRunEventStore();
  const runId = assertSessionRunId('run-live-events-send-failure');
  const replayed: number[] = [];

  store.startRun({
    runId,
    threadId: testThreadId(303),
    ownerId: 'socket-session-a',
    sink: () => false,
    async persistRunEvents() {},
  });

  assert.deepEqual(store.publishRunEvent(runId, startedEvent), {
    seq: 0,
    delivery: 'buffered',
  });
  assert.equal(
    (
      await store.bindRuns({
        ownerId: 'socket-session-b',
        sink: (envelope) => {
          replayed.push(envelope.seq);
          return true;
        },
      })
    ).length,
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
    async persistRunEvents() {},
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
    async persistRunEvents() {},
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

void test('live run events hydrate durable history and continue its sequence', async () => {
  const store = createLiveRunEventStore();
  const runId = assertSessionRunId('run-live-events-durable-history');
  const replayed: number[] = [];
  const persisted: number[] = [];

  store.startRun({
    runId,
    threadId: testThreadId(307),
    ownerId: 'socket-session-a',
    sink: (envelope) => {
      replayed.push(envelope.seq);
      return true;
    },
    eventHistory: [{ seq: 0, event: startedEvent }],
    replayAfterSeq: 0,
    async persistRunEvents(events) {
      persisted.push(...events.map((event) => event.seq));
    },
  });

  assert.deepEqual(replayed, []);
  assert.deepEqual(persisted, []);
  assert.deepEqual(
    store.publishRunEvent(runId, {
      type: 'commentary_delta',
      payload: { text: 'resumed' },
    }),
    { seq: 1, delivery: 'delivered' },
  );
  await store.flushRunEventHistory(runId);
  assert.deepEqual(replayed, [1]);
  assert.deepEqual(persisted, [1]);
});

void test('live run events refuse a terminal commit after history persistence fails', async () => {
  const store = createLiveRunEventStore();
  const runId = assertSessionRunId('run-live-events-history-failure');
  let terminalPersisted = false;
  store.startRun({
    runId,
    threadId: testThreadId(308),
    ownerId: 'socket-session-a',
    sink: () => true,
    async persistRunEvents() {
      throw new Error('history disk unavailable');
    },
  });
  store.publishRunEvent(runId, startedEvent);

  await assert.rejects(
    store.commitTerminalRunEvent({
      runId,
      event: doneEvent,
      async persist() {
        terminalPersisted = true;
      },
    }),
    /history disk unavailable/u,
  );
  assert.equal(terminalPersisted, false);
});

void test('detached terminal history is evicted and replayed back from the journal', async () => {
  const store = createLiveRunEventStore();
  const runId = assertSessionRunId('run-live-events-evicted');
  const threadId = testThreadId(302);
  const journal: RunCheckpointEvent[] = [];
  let reads = 0;

  store.startRun({
    runId,
    threadId,
    ownerId: 'socket-session-a',
    sink: () => true,
    async persistRunEvents(events) {
      journal.push(...events);
    },
    async readPersistedRunEvents(throughSeq) {
      reads += 1;
      return journal.filter((record) => record.seq <= throughSeq);
    },
  });

  store.publishRunEvent(runId, startedEvent);
  await store.flushRunEventHistory(runId);
  await store.commitTerminalRunEvent({
    runId,
    event: doneEvent,
    async persist() {
      // 종단 이벤트는 저널 레코드 타입이 담지 못한다 — 체크포인트의 terminal
      // 스냅샷이 따로 갖고, 상주 이력에도 남는다.
    },
  });

  // 아무도 안 보고 있는 종료된 런은 상주 이력을 버린다 — 엔트리는 재연결을
  // 기다리며 남지만, 이벤트 본문은 저널에만 있다.
  store.detachOwner('socket-session-a');
  assert.equal(store.hasRun(runId), true);
  assert.equal(reads, 0);

  const replayed: number[] = [];
  const bound = await store.bindRuns({
    ownerId: 'socket-session-b',
    sink: (envelope) => {
      replayed.push(envelope.seq);
      return true;
    },
  });

  assert.equal(reads, 1, '버려진 앞부분은 저널에서 되읽어야 한다');
  assert.deepEqual(replayed, [0, 1], '재연결 replay는 여전히 전체 이력이다');
  assert.deepEqual(bound, [
    { runId, threadId, previousOwnerId: 'socket-session-a', terminal: true },
  ]);
  assert.equal(store.hasRun(runId), false);
});

void test('history is retained while the journal has not caught up', async () => {
  const store = createLiveRunEventStore();
  const runId = assertSessionRunId('run-live-events-unpersisted');
  let releasePersist: (() => void) | undefined;

  store.startRun({
    runId,
    threadId: testThreadId(303),
    ownerId: 'socket-session-a',
    sink: () => true,
    async persistRunEvents() {
      await new Promise<void>((resolve) => {
        releasePersist = resolve;
      });
    },
    async readPersistedRunEvents() {
      assert.fail('journal must not be read while it is behind memory');
    },
  });

  store.publishRunEvent(runId, startedEvent);
  // 소유자를 먼저 떼고 종료시켜야 "종료됐는데 아무도 안 보는" 상태가 된다 —
  // 붙어 있는 채로 끝나면 엔트리 자체가 즉시 사라진다.
  store.detachOwner('socket-session-a');
  store.finishRun(runId);

  // 안착 워터마크가 아직 못 따라왔으므로 메모리가 유일한 사본이다 — 버리면 안 된다.
  const replayed: number[] = [];
  await store.bindRuns({
    ownerId: 'socket-session-b',
    sink: (envelope) => {
      replayed.push(envelope.seq);
      return true;
    },
  });
  assert.deepEqual(replayed, [0]);
  releasePersist?.();
});

void test('one run that cannot be restored prevents partial replay and rebinding', async () => {
  const store = createLiveRunEventStore();
  const threadId = testThreadId(304);
  const brokenRunId = assertSessionRunId('run-live-events-broken');
  const healthyRunId = assertSessionRunId('run-live-events-healthy');
  const journal = new Map<string, RunCheckpointEvent[]>();

  const start = (runId: string, readable: boolean): void => {
    journal.set(runId, []);
    store.startRun({
      runId: assertSessionRunId(runId),
      threadId,
      ownerId: 'socket-session-a',
      sink: () => true,
      async persistRunEvents(events) {
        journal.get(runId)?.push(...events);
      },
      async readPersistedRunEvents(throughSeq) {
        // 스레드 체크포인트가 다른 런으로 덮인 상황 — 되읽어도 비어 있다.
        return readable
          ? (journal.get(runId) ?? []).filter((r) => r.seq <= throughSeq)
          : [];
      },
    });
  };

  start(brokenRunId, false);
  start(healthyRunId, true);
  for (const runId of [brokenRunId, healthyRunId]) {
    const id = assertSessionRunId(runId);
    store.publishRunEvent(id, startedEvent);
    await store.flushRunEventHistory(id);
    await store.commitTerminalRunEvent({
      runId: id,
      event: doneEvent,
      async persist() {},
    });
  }
  store.detachOwner('socket-session-a');

  const replayed: string[] = [];
  await assert.rejects(
    store.bindRuns({
      ownerId: 'socket-session-b',
      sink: (envelope) => {
        replayed.push(`${envelope.runId}:${envelope.seq}`);
        return true;
      },
    }),
    /live run event history could not be restored/u,
  );
  assert.deepEqual(
    replayed,
    [],
    '복원 사전 검사가 끝나기 전에는 전달하지 않는다',
  );
  assert.equal(store.hasRun(brokenRunId), true, '실패한 런은 남겨 재시도한다');
  assert.equal(store.hasRun(healthyRunId), true);
});
