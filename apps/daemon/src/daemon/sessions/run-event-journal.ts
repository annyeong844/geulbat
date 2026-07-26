import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  isRunId,
  isThreadId,
  type RunId,
  type ThreadId,
} from '@geulbat/protocol/ids';
import { isRunEvent } from '@geulbat/protocol/run-events';

import { isRecord } from '../runtime-json.js';
import type {
  RunEventAgentEvent,
  TerminalAgentEvent,
} from '../runtime-contracts.js';
import { writeTextFileAtomically } from '../utils/atomic-file.js';
import { createKeyedSerialRunner } from '../utils/keyed-serial.js';

const RUN_EVENT_JOURNAL_SCHEMA_VERSION = 1;
const EVENT_VALIDATION_TIMESTAMP = '1970-01-01T00:00:00.000Z';

export interface RunCheckpointEvent {
  seq: number;
  event: Exclude<RunEventAgentEvent, TerminalAgentEvent>;
}

interface RunEventJournalStore {
  read(args: {
    threadId: ThreadId;
    runId: RunId;
  }): Promise<RunCheckpointEvent[]>;
  readExisting(args: {
    threadId: ThreadId;
    runId: RunId;
  }): Promise<RunCheckpointEvent[] | undefined>;
  append(args: {
    threadId: ThreadId;
    runId: RunId;
    events: readonly RunCheckpointEvent[];
  }): Promise<void>;
}

interface RunEventJournalReadResult {
  exists: boolean;
  events: RunCheckpointEvent[];
}

export function createRunEventJournalStore(args: {
  stateRoot: string;
}): RunEventJournalStore {
  const root = join(args.stateRoot, '.geulbat', 'run-event-journals');
  const journalMutationSerial = createKeyedSerialRunner();
  const journalStateByPath = new Map<
    string,
    { exists: boolean; eventCount: number }
  >();

  async function readJournal(
    threadId: ThreadId,
    runId: RunId,
  ): Promise<RunEventJournalReadResult> {
    const path = journalPath(root, threadId, runId);
    try {
      return {
        exists: true,
        events: parseRunEventJournal(
          await readFile(path, 'utf8'),
          threadId,
          runId,
        ),
      };
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return { exists: false, events: [] };
      }
      throw error;
    }
  }

  return {
    async read({ threadId, runId }) {
      const path = journalPath(root, threadId, runId);
      return await journalMutationSerial(path, async () => {
        const journal = await readJournal(threadId, runId);
        journalStateByPath.set(path, {
          exists: journal.exists,
          eventCount: journal.events.length,
        });
        return journal.events;
      });
    },
    async readExisting({ threadId, runId }) {
      const journal = await readJournal(threadId, runId);
      return journal.exists ? journal.events : undefined;
    },
    async append({ threadId, runId, events }) {
      if (events.length === 0) {
        return;
      }
      const path = journalPath(root, threadId, runId);
      await journalMutationSerial(path, async () => {
        let previous = journalStateByPath.get(path);
        if (previous === undefined) {
          const journal = await readJournal(threadId, runId);
          previous = {
            exists: journal.exists,
            eventCount: journal.events.length,
          };
        }
        assertContiguousEventBatch(events, previous.eventCount);
        const batchLine = `${JSON.stringify({ events })}\n`;
        if (!previous.exists) {
          await writeTextFileAtomically(
            path,
            `${JSON.stringify({
              schemaVersion: RUN_EVENT_JOURNAL_SCHEMA_VERSION,
              runId,
              threadId,
            })}\n${batchLine}`,
            { mode: 0o600 },
          );
        } else {
          await appendFile(path, batchLine, { encoding: 'utf8', mode: 0o600 });
        }
        journalStateByPath.set(path, {
          exists: true,
          eventCount: previous.eventCount + events.length,
        });
      });
    },
  };
}

function journalPath(root: string, threadId: ThreadId, runId: RunId): string {
  return join(root, threadId, `${runId}.jsonl`);
}

function parseRunEventJournal(
  raw: string,
  expectedThreadId: ThreadId,
  expectedRunId: RunId,
): RunCheckpointEvent[] {
  const lines = raw.endsWith('\n')
    ? raw.slice(0, -1).split('\n')
    : raw.split('\n');
  const header = parseJsonLine(lines[0]);
  if (
    !isRecord(header) ||
    header.schemaVersion !== RUN_EVENT_JOURNAL_SCHEMA_VERSION ||
    typeof header.runId !== 'string' ||
    !isRunId(header.runId) ||
    typeof header.threadId !== 'string' ||
    !isThreadId(header.threadId) ||
    header.runId !== expectedRunId ||
    header.threadId !== expectedThreadId
  ) {
    throw new Error('invalid run event journal header');
  }

  const events: RunCheckpointEvent[] = [];
  for (const line of lines.slice(1)) {
    const batch = parseJsonLine(line);
    if (!isRecord(batch) || !Array.isArray(batch.events)) {
      throw new Error('invalid run event journal batch');
    }
    for (const value of batch.events) {
      const seq = events.length;
      if (
        !isRecord(value) ||
        value.seq !== seq ||
        !isCheckpointAgentEvent(
          value.event,
          expectedRunId,
          expectedThreadId,
          seq,
        ) ||
        !isJournaledAgentEvent(value.event)
      ) {
        throw new Error('invalid run event journal sequence');
      }
      events.push({ seq, event: value.event });
    }
  }
  return events;
}

function isJournaledAgentEvent(
  event: RunEventAgentEvent,
): event is Exclude<RunEventAgentEvent, TerminalAgentEvent> {
  return event.type !== 'done' && event.type !== 'error';
}

function parseJsonLine(line: string | undefined): unknown {
  if (line === undefined || line === '') {
    throw new Error('invalid empty run event journal record');
  }
  try {
    return JSON.parse(line);
  } catch {
    throw new Error('invalid run event journal JSON');
  }
}

function assertContiguousEventBatch(
  events: readonly RunCheckpointEvent[],
  expectedStartSeq: number,
): void {
  for (const [index, event] of events.entries()) {
    if (event.seq !== expectedStartSeq + index) {
      throw new Error('run event journal append sequence conflict');
    }
  }
}

function isCheckpointAgentEvent(
  value: unknown,
  runId: RunId,
  threadId: ThreadId,
  seq: number,
): value is RunEventAgentEvent {
  if (!isRecord(value)) {
    return false;
  }
  return isRunEvent({
    runId,
    threadId,
    seq,
    ts: EVENT_VALIDATION_TIMESTAMP,
    type: value.type,
    payload: value.payload,
  });
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
