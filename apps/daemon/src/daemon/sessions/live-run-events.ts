import type { RunId, ThreadId } from './contract.js';
import type { AgentEvent, TerminalAgentEvent } from '../runtime-contracts.js';

interface LiveRunEventEnvelope {
  runId: RunId;
  threadId: ThreadId;
  seq: number;
  event: AgentEvent;
}

export type LiveRunEventSink = (envelope: LiveRunEventEnvelope) => boolean;

interface ReboundLiveRun {
  runId: RunId;
  threadId: ThreadId;
  previousOwnerId: string;
  terminal: boolean;
}

export interface LiveRunEventStore {
  hasRun(runId: RunId): boolean;
  startRun(args: {
    runId: RunId;
    threadId: ThreadId;
    ownerId: string;
    sink: LiveRunEventSink;
  }): void;
  publishRunEvent(
    runId: RunId,
    event: AgentEvent,
  ): { seq: number; delivery: 'delivered' | 'buffered' };
  commitTerminalRunEvent(args: {
    runId: RunId;
    event: TerminalAgentEvent;
    persist: (
      envelope: LiveRunEventEnvelope & { event: TerminalAgentEvent },
    ) => Promise<void>;
  }): Promise<{ seq: number; delivery: 'delivered' | 'buffered' }>;
  finishRun(runId: RunId): void;
  detachOwner(ownerId: string): void;
  bindDetachedRuns(args: {
    ownerId: string;
    sink: LiveRunEventSink;
  }): ReboundLiveRun[];
}

interface LiveRunEventEntry {
  runId: RunId;
  threadId: ThreadId;
  nextSeq: number;
  ownerId: string | undefined;
  detachedOwnerId: string;
  sink: LiveRunEventSink | undefined;
  buffered: LiveRunEventEnvelope[];
  terminal: boolean;
  terminalCommitPending: boolean;
}

export function createLiveRunEventStore(): LiveRunEventStore {
  const entries = new Map<RunId, LiveRunEventEntry>();

  return {
    hasRun(runId) {
      return entries.has(runId);
    },
    startRun({ runId, threadId, ownerId, sink }) {
      if (entries.has(runId)) {
        throw new Error(`live run event delivery already exists: ${runId}`);
      }
      entries.set(runId, {
        runId,
        threadId,
        nextSeq: 0,
        ownerId,
        detachedOwnerId: ownerId,
        sink,
        buffered: [],
        terminal: false,
        terminalCommitPending: false,
      });
    },
    publishRunEvent(runId, event) {
      const entry = readEntry(entries, runId);
      if (event.type === 'done' || event.type === 'error') {
        throw new Error('terminal run events require an atomic commit');
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

      if (deliver(entry.sink, envelope)) {
        return { seq: envelope.seq, delivery: 'delivered' };
      }

      entry.buffered.push(envelope);
      detachEntry(entry);
      return { seq: envelope.seq, delivery: 'buffered' };
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
        await persist(envelope);
      } catch (error: unknown) {
        entry.terminalCommitPending = false;
        throw error;
      }

      entry.nextSeq += 1;
      entry.terminalCommitPending = false;
      entry.terminal = true;
      if (deliver(entry.sink, envelope)) {
        return { seq: envelope.seq, delivery: 'delivered' };
      }
      entry.buffered.push(envelope);
      detachEntry(entry);
      return { seq: envelope.seq, delivery: 'buffered' };
    },
    finishRun(runId) {
      const entry = entries.get(runId);
      if (!entry) {
        return;
      }
      entry.terminal = true;
      if (entry.ownerId !== undefined && entry.buffered.length === 0) {
        entries.delete(runId);
      }
    },
    detachOwner(ownerId) {
      for (const entry of entries.values()) {
        if (entry.ownerId !== ownerId) {
          continue;
        }
        entry.detachedOwnerId = ownerId;
        detachEntry(entry);
      }
    },
    bindDetachedRuns({ ownerId, sink }) {
      const rebound: ReboundLiveRun[] = [];
      for (const entry of entries.values()) {
        if (entry.ownerId !== undefined) {
          continue;
        }

        const remaining = deliverBuffered(entry.buffered, sink);
        if (remaining.length > 0) {
          entry.buffered = remaining;
          continue;
        }

        const previousOwnerId = entry.detachedOwnerId;
        entry.buffered = [];
        entry.ownerId = ownerId;
        entry.detachedOwnerId = ownerId;
        entry.sink = sink;
        rebound.push({
          runId: entry.runId,
          threadId: entry.threadId,
          previousOwnerId,
          terminal: entry.terminal,
        });
        if (entry.terminal) {
          entries.delete(entry.runId);
        }
      }
      return rebound;
    },
  };
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

function deliverBuffered(
  buffered: LiveRunEventEnvelope[],
  sink: LiveRunEventSink,
): LiveRunEventEnvelope[] {
  for (let index = 0; index < buffered.length; index += 1) {
    const envelope = buffered[index];
    if (envelope === undefined || !deliver(sink, envelope)) {
      return buffered.slice(index);
    }
  }
  return [];
}

function detachEntry(entry: LiveRunEventEntry): void {
  entry.ownerId = undefined;
  entry.sink = undefined;
}
