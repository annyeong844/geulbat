import { createLogger } from '@geulbat/structured-logger/logger';

import type { RunId, ThreadId } from './contract.js';
import type {
  AgentEvent,
  RunEventAgentEvent,
  TerminalAgentEvent,
  TransientAgentEvent,
} from '../runtime-contracts.js';
import type { RunCheckpointEvent } from './run-event-journal.js';

export interface LiveRunEventEnvelope {
  runId: RunId;
  threadId: ThreadId;
  seq: number;
  event: RunEventAgentEvent;
}

interface LiveRunTransientEventEnvelope {
  runId: RunId;
  threadId: ThreadId;
  event: TransientAgentEvent;
}

export interface LiveRunEventSink {
  (envelope: LiveRunEventEnvelope): boolean;
  transient?: (envelope: LiveRunTransientEventEnvelope) => boolean;
}

interface BoundLiveRun {
  runId: RunId;
  threadId: ThreadId;
  previousOwnerId?: string;
  terminal: boolean;
}

export interface LiveRunEventStore {
  hasRun(runId: RunId): boolean;
  startRun(args: {
    runId: RunId;
    threadId: ThreadId;
    ownerId: string;
    sink: LiveRunEventSink;
    eventHistory?: readonly RunCheckpointEvent[];
    persistRunEvents: (events: readonly RunCheckpointEvent[]) => Promise<void>;
    /**
     * 축출된 앞부분을 체크포인트에서 되읽는다. 없으면 축출하지 않는다 —
     * 되읽을 수단이 없는데 버리면 재연결 계약이 깨진다.
     */
    readPersistedRunEvents?: (
      throughSeq: number,
    ) => Promise<readonly RunCheckpointEvent[]>;
    replayAfterSeq?: number;
  }): void;
  publishRunEvent(
    runId: RunId,
    event: AgentEvent,
  ): { seq: number; delivery: 'delivered' | 'buffered' };
  publishTransientRunEvent(
    runId: RunId,
    event: TransientAgentEvent,
  ): { delivery: 'delivered' | 'dropped' };
  commitTerminalRunEvent(args: {
    runId: RunId;
    event: TerminalAgentEvent;
    persist: (
      envelope: LiveRunEventEnvelope & { event: TerminalAgentEvent },
    ) => Promise<void>;
  }): Promise<{ seq: number; delivery: 'delivered' | 'buffered' }>;
  flushRunEventHistory(runId: RunId): Promise<void>;
  finishRun(runId: RunId): void;
  detachOwner(ownerId: string): void;
  bindRuns(args: {
    ownerId: string;
    sink: LiveRunEventSink;
    afterSeqByRun?: ReadonlyMap<RunId, number>;
  }): Promise<BoundLiveRun[]>;
}

interface LiveRunEventEntry {
  runId: RunId;
  threadId: ThreadId;
  /**
   * 다음에 발행할 seq. 예전에는 history.length로 대신했으나, 앞부분을 축출하면
   * 둘이 어긋난다 — 발행 카운터는 상주 배열과 독립이어야 한다.
   */
  nextSeq: number;
  /** 메모리에 남아 있는 첫 이벤트의 seq. 축출하지 않으면 0. */
  firstResidentSeq: number;
  /**
   * 디스크(체크포인트)에 안착이 확인된 마지막 seq. 축출은 이 아래로만
   * 허용한다 — 저널링이 실패해 래치되면 메모리가 유일한 사본이 되므로,
   * 워터마크가 멈추면 축출도 자동으로 멈춘다.
   */
  persistedThroughSeq: number;
  approvalOwnerId: string;
  sinksByOwner: Map<string, LiveRunEventSink>;
  history: LiveRunEventEnvelope[];
  pendingHistoryPersistence: RunCheckpointEvent[];
  historyPersistenceTask: Promise<void> | undefined;
  historyPersistenceError: Error | undefined;
  persistRunEvents: (events: readonly RunCheckpointEvent[]) => Promise<void>;
  readPersistedRunEvents:
    | ((throughSeq: number) => Promise<readonly RunCheckpointEvent[]>)
    | undefined;
  terminal: boolean;
  terminalCommitPending: boolean;
}

const logger = createLogger('sessions/live-run-events');

export function createLiveRunEventStore(): LiveRunEventStore {
  const entries = new Map<RunId, LiveRunEventEntry>();

  async function flushRunEventHistory(runId: RunId): Promise<void> {
    const entry = readEntry(entries, runId);
    while (entry.historyPersistenceTask !== undefined) {
      try {
        await entry.historyPersistenceTask;
      } catch {
        break;
      }
    }
    if (entry.historyPersistenceError !== undefined) {
      throw entry.historyPersistenceError;
    }
  }

  return {
    hasRun(runId) {
      return entries.has(runId);
    },
    startRun({
      runId,
      threadId,
      ownerId,
      sink,
      eventHistory = [],
      persistRunEvents,
      readPersistedRunEvents,
      replayAfterSeq,
    }) {
      if (entries.has(runId)) {
        throw new Error(`live run event delivery already exists: ${runId}`);
      }
      // 상주 구간은 연속이어야 한다. 시작점은 0이 아닐 수 있다(앞부분이
      // 축출된 뒤 다시 읽어 들인 경우) — 인덱스가 아니라 시작 seq 기준으로 센다.
      const firstResidentSeq = eventHistory[0]?.seq ?? 0;
      const history = eventHistory.map(({ seq, event }, index) => {
        if (seq !== firstResidentSeq + index) {
          throw new Error(`invalid live run event history: ${runId}`);
        }
        return { runId, threadId, seq, event } satisfies LiveRunEventEnvelope;
      });
      const entry: LiveRunEventEntry = {
        runId,
        threadId,
        nextSeq: firstResidentSeq + history.length,
        firstResidentSeq,
        persistedThroughSeq: firstResidentSeq + history.length - 1,
        approvalOwnerId: ownerId,
        sinksByOwner: new Map([[ownerId, sink]]),
        history,
        pendingHistoryPersistence: [],
        historyPersistenceTask: undefined,
        historyPersistenceError: undefined,
        persistRunEvents,
        readPersistedRunEvents,
        terminal: false,
        terminalCommitPending: false,
      };
      entries.set(runId, entry);
      const replayEvents = selectLiveRunReplayEvents(history, replayAfterSeq);
      if (replayEvents.length > 0 && !deliverEvents(replayEvents, sink)) {
        entry.sinksByOwner.delete(ownerId);
      }
    },
    publishRunEvent(runId, event) {
      const entry = readEntry(entries, runId);
      if (event.type === 'tool_output_delta') {
        throw new Error('transient run events require transient delivery');
      }
      if (!isJournaledAgentEvent(event)) {
        throw new Error('terminal run events require an atomic commit');
      }
      if (entry.historyPersistenceError !== undefined) {
        throw entry.historyPersistenceError;
      }
      if (entry.terminalCommitPending || entry.terminal) {
        throw new Error(`live run event delivery is terminal: ${runId}`);
      }
      const envelope: LiveRunEventEnvelope = {
        runId,
        threadId: entry.threadId,
        seq: entry.nextSeq,
        event,
      };
      entry.nextSeq += 1;
      entry.history.push(envelope);
      entry.pendingHistoryPersistence.push({
        seq: envelope.seq,
        event,
      });
      startHistoryPersistence(entry);

      if (deliverToSubscribers(entry, envelope)) {
        return { seq: envelope.seq, delivery: 'delivered' };
      }
      return { seq: envelope.seq, delivery: 'buffered' };
    },
    publishTransientRunEvent(runId, event) {
      const entry = readEntry(entries, runId);
      if (entry.terminalCommitPending || entry.terminal) {
        throw new Error(`live run event delivery is terminal: ${runId}`);
      }
      const envelope: LiveRunTransientEventEnvelope = {
        runId,
        threadId: entry.threadId,
        event,
      };
      return {
        delivery: deliverTransientToSubscribers(entry, envelope)
          ? 'delivered'
          : 'dropped',
      };
    },
    async commitTerminalRunEvent({ runId, event, persist }) {
      const entry = readEntry(entries, runId);
      if (entry.terminalCommitPending || entry.terminal) {
        throw new Error(`live run terminal event already committed: ${runId}`);
      }
      const envelope = {
        runId,
        threadId: entry.threadId,
        seq: entry.nextSeq,
        event,
      } satisfies LiveRunEventEnvelope & { event: TerminalAgentEvent };
      entry.terminalCommitPending = true;
      try {
        await flushRunEventHistory(runId);
        await persist(envelope);
      } catch (error: unknown) {
        entry.terminalCommitPending = false;
        throw error instanceof Error
          ? error
          : new Error('live run terminal persistence failed', { cause: error });
      }

      entry.nextSeq += 1;
      entry.terminalCommitPending = false;
      entry.terminal = true;
      entry.history.push(envelope);
      // 종단 이벤트는 persist가 끝난 뒤에 여기 온다 — 이미 안착했다.
      entry.persistedThroughSeq = envelope.seq;
      if (deliverToSubscribers(entry, envelope)) {
        return { seq: envelope.seq, delivery: 'delivered' };
      }
      return { seq: envelope.seq, delivery: 'buffered' };
    },
    flushRunEventHistory,
    finishRun(runId) {
      const entry = entries.get(runId);
      if (!entry) {
        return;
      }
      entry.terminal = true;
      if (entry.sinksByOwner.size > 0) {
        entries.delete(runId);
        return;
      }
      pruneDetachedTerminalHistory(entry);
    },
    detachOwner(ownerId) {
      for (const entry of entries.values()) {
        entry.sinksByOwner.delete(ownerId);
        pruneDetachedTerminalHistory(entry);
      }
    },
    async bindRuns({ ownerId, sink, afterSeqByRun }) {
      const bound: BoundLiveRun[] = [];
      for (const entry of entries.values()) {
        // 한 런의 복원 실패가 나머지 런의 재연결까지 막으면 안 된다. 실패한
        // 런만 건너뛰고 엔트리는 남긴다 — prune 뒤라 상주분은 종단 봉투
        // 하나뿐이라서 남겨도 비용이 없고, 다음 재연결이 다시 시도한다.
        let replayEvents: readonly LiveRunEventEnvelope[];
        try {
          replayEvents = await collectReplayEvents(
            entry,
            afterSeqByRun?.get(entry.runId),
          );
        } catch (error: unknown) {
          logger.warn('live run event replay could not be restored', {
            runId: entry.runId,
            threadId: entry.threadId,
            firstResidentSeq: entry.firstResidentSeq,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        if (!deliverEvents(replayEvents, sink)) {
          continue;
        }

        const wasDetached = entry.sinksByOwner.size === 0;
        const previousOwnerId = wasDetached ? entry.approvalOwnerId : undefined;
        entry.sinksByOwner.set(ownerId, sink);
        if (wasDetached) {
          entry.approvalOwnerId = ownerId;
        }
        bound.push({
          runId: entry.runId,
          threadId: entry.threadId,
          ...(previousOwnerId === undefined ? {} : { previousOwnerId }),
          terminal: entry.terminal,
        });
        if (entry.terminal) {
          entries.delete(entry.runId);
        }
      }
      return bound;
    },
  };
}

/**
 * 재연결 replay 구간을 만든다. 요청 구간이 상주 창 아래로 내려가면 축출된
 * 앞부분을 체크포인트에서 되읽어 메모리 꼬리 앞에 이어 붙인다. 되읽기가
 * 실패하거나 구간을 못 채우면 상주분만 보내지 않고 통째로 포기한다 —
 * 구멍 난 replay를 보내는 것보다 재연결을 실패시키는 편이 안전하다.
 */
async function collectReplayEvents(
  entry: LiveRunEventEntry,
  afterSeq: number | undefined,
): Promise<readonly LiveRunEventEnvelope[]> {
  const resident = selectLiveRunReplayEvents(entry.history, afterSeq);
  const neededFromSeq = afterSeq === undefined ? 0 : afterSeq + 1;
  if (neededFromSeq >= entry.firstResidentSeq) {
    return resident;
  }
  if (entry.readPersistedRunEvents === undefined) {
    throw new Error(
      `live run event history was evicted without a reader: ${entry.runId}`,
    );
  }
  const persisted = await entry.readPersistedRunEvents(
    entry.firstResidentSeq - 1,
  );
  const head = persisted
    .filter((record) => record.seq >= neededFromSeq)
    .map(
      ({ seq, event }) =>
        ({
          runId: entry.runId,
          threadId: entry.threadId,
          seq,
          event,
        }) satisfies LiveRunEventEnvelope,
    );
  const expected = entry.firstResidentSeq - neededFromSeq;
  if (head.length !== expected) {
    throw new Error(
      `live run event history could not be restored: ${entry.runId}`,
    );
  }
  return [...head, ...resident];
}

/**
 * 끝났는데 아무도 붙어 있지 않은 런의 상주 이력을 버린다.
 *
 * 이 스토어의 메모리는 크기보다 **보관 기간**이 문제였다 — terminal이 된 런은
 * 누군가 재연결해 bindRuns로 받아갈 때까지 엔트리가 남고, 만료도 축출도 없어서
 * 사용자가 탭을 닫고 돌아오지 않으면 데몬이 사는 동안 계속 들고 있었다.
 *
 * 임의의 상한 숫자를 두지 않는다. 버려도 되는 조건이 상태로 정해지기 때문이다:
 * 끝났고(더 안 늘어남), 아무도 안 보고 있고(즉시 필요 없음), 전부 안착했고,
 * 되읽을 수단이 있을 때.
 *
 * 다만 종단 봉투는 남긴다 — 저널 레코드 타입(RunCheckpointEvent)이 done/error를
 * 구조적으로 담지 못하므로(Exclude<…, TerminalAgentEvent>) 디스크에서 되읽을 수
 * 없다. 나머지 앞부분만 버리고, 재연결 때 collectReplayEvents가 저널에서 읽은
 * 앞부분과 상주 종단 봉투를 이어 붙인다.
 */
function pruneDetachedTerminalHistory(entry: LiveRunEventEntry): void {
  if (
    !entry.terminal ||
    entry.sinksByOwner.size > 0 ||
    entry.history.length === 0 ||
    entry.readPersistedRunEvents === undefined ||
    entry.historyPersistenceError !== undefined ||
    entry.persistedThroughSeq < entry.nextSeq - 1
  ) {
    return;
  }
  const terminalEnvelope = entry.history.at(-1);
  if (terminalEnvelope === undefined || entry.history.length === 1) {
    return;
  }
  entry.history.splice(0, entry.history.length - 1);
  entry.firstResidentSeq = terminalEnvelope.seq;
}

function readEntry(
  entries: Map<RunId, LiveRunEventEntry>,
  runId: RunId,
): LiveRunEventEntry {
  const entry = entries.get(runId);
  if (!entry) {
    throw new Error(`live run event delivery not found: ${runId}`);
  }
  return entry;
}

function deliver(
  sink: LiveRunEventSink | undefined,
  envelope: LiveRunEventEnvelope,
): boolean {
  if (!sink) {
    return false;
  }
  try {
    return sink(envelope);
  } catch {
    return false;
  }
}

function deliverTransient(
  sink: LiveRunEventSink | undefined,
  envelope: LiveRunTransientEventEnvelope,
): boolean {
  if (!sink?.transient) {
    return false;
  }
  try {
    return sink.transient(envelope);
  } catch {
    return false;
  }
}

function deliverEvents(
  events: readonly LiveRunEventEnvelope[],
  sink: LiveRunEventSink,
): boolean {
  for (const envelope of events) {
    if (!deliver(sink, envelope)) {
      return false;
    }
  }
  return true;
}

function deliverToSubscribers(
  entry: LiveRunEventEntry,
  envelope: LiveRunEventEnvelope,
): boolean {
  let delivered = false;
  for (const [ownerId, sink] of entry.sinksByOwner) {
    if (deliver(sink, envelope)) {
      delivered = true;
      continue;
    }
    entry.sinksByOwner.delete(ownerId);
  }
  return delivered;
}

function deliverTransientToSubscribers(
  entry: LiveRunEventEntry,
  envelope: LiveRunTransientEventEnvelope,
): boolean {
  let delivered = false;
  for (const [ownerId, sink] of entry.sinksByOwner) {
    if (sink.transient === undefined) {
      continue;
    }
    if (deliverTransient(sink, envelope)) {
      delivered = true;
      continue;
    }
    entry.sinksByOwner.delete(ownerId);
  }
  return delivered;
}

export function selectLiveRunReplayEvents(
  history: readonly LiveRunEventEnvelope[],
  afterSeq: number | undefined,
): readonly LiveRunEventEnvelope[] {
  if (afterSeq === undefined) {
    return history;
  }
  const latest = history.at(-1);
  if (latest !== undefined && afterSeq > latest.seq) {
    return history;
  }
  return history.filter((envelope) => envelope.seq > afterSeq);
}

function isJournaledAgentEvent(
  event: RunEventAgentEvent,
): event is Exclude<RunEventAgentEvent, TerminalAgentEvent> {
  return event.type !== 'done' && event.type !== 'error';
}

function startHistoryPersistence(entry: LiveRunEventEntry): void {
  if (
    entry.historyPersistenceTask !== undefined ||
    entry.historyPersistenceError !== undefined ||
    entry.pendingHistoryPersistence.length === 0
  ) {
    return;
  }
  const task = (async () => {
    while (entry.pendingHistoryPersistence.length > 0) {
      const batch = entry.pendingHistoryPersistence.splice(0);
      await entry.persistRunEvents(batch);
      // 안착이 확인된 뒤에만 워터마크를 올린다 — 실패하면 여기 못 오고,
      // historyPersistenceError가 래치되어 이후 축출도 멈춘다.
      const lastSeq = batch.at(-1)?.seq;
      if (lastSeq !== undefined && lastSeq > entry.persistedThroughSeq) {
        entry.persistedThroughSeq = lastSeq;
      }
    }
  })();
  entry.historyPersistenceTask = task;
  void task.then(
    () => {
      if (entry.historyPersistenceTask !== task) {
        return;
      }
      entry.historyPersistenceTask = undefined;
      startHistoryPersistence(entry);
    },
    (error: unknown) => {
      if (entry.historyPersistenceTask !== task) {
        return;
      }
      entry.historyPersistenceTask = undefined;
      entry.historyPersistenceError =
        error instanceof Error
          ? error
          : new Error('live run event history persistence failed', {
              cause: error,
            });
    },
  );
}
