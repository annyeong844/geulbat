import { assertRunId, assertThreadId } from '@geulbat/protocol/ids';
import { sha256StableJson } from '@geulbat/content-identity/stable-json';

import {
  createRunEventJournalStore,
  type RunCheckpointEvent,
} from './daemon/sessions/run-event-journal.js';

export interface DurableRunEvidence {
  readonly schemaVersion: 1;
  readonly threadId: string;
  readonly runId: string;
  readonly evidenceDigest: string;
  readonly events: readonly RunCheckpointEvent[];
}

export interface DurableRunEvidenceReader {
  readRun(args: {
    readonly threadId: string;
    readonly runId: string;
  }): Promise<DurableRunEvidence | undefined>;
}

export function createDurableRunEvidenceReader(options: {
  readonly stateRoot: string;
}): DurableRunEvidenceReader {
  const journal = createRunEventJournalStore({ stateRoot: options.stateRoot });

  return Object.freeze({
    async readRun({
      threadId: rawThreadId,
      runId: rawRunId,
    }: {
      readonly threadId: string;
      readonly runId: string;
    }) {
      const threadId = assertThreadId(rawThreadId);
      const runId = assertRunId(rawRunId);
      const events = await journal.readExisting({ threadId, runId });
      if (events === undefined) {
        return undefined;
      }
      const evidenceBody = {
        schemaVersion: 1 as const,
        threadId,
        runId,
        events,
      };
      return Object.freeze({
        ...evidenceBody,
        evidenceDigest: `sha256:${sha256StableJson(evidenceBody)}`,
        events: Object.freeze(events),
      });
    },
  });
}
