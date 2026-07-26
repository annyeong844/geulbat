import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { testThreadId } from './test-support/thread-id.js';
import { assertSessionRunId } from './daemon/sessions/contract.js';
import { createRunEventJournalStore } from './daemon/sessions/run-event-journal.js';
import { createDurableRunEvidenceReader } from './run-evidence.js';

void test('reads one existing per-run journal without manufacturing missing evidence', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-run-evidence-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const threadId = testThreadId(941);
  const runId = assertSessionRunId('run-evidence-reader');
  const events = [
    {
      seq: 0,
      event: {
        type: 'tool_call' as const,
        payload: {
          callId: 'call-search-1',
          step: 0,
          tool: 'search_files',
          args: {
            pattern: '*.ts',
            type: 'filename',
            consistency: 'eventual_index',
            maxResults: 20,
          },
        },
      },
    },
  ];
  await createRunEventJournalStore({ stateRoot }).append({
    threadId,
    runId,
    events,
  });

  const reader = createDurableRunEvidenceReader({ stateRoot });
  const evidence = await reader.readRun({ threadId, runId });
  assert.ok(evidence);
  assert.match(evidence.evidenceDigest, /^sha256:[0-9a-f]{64}$/u);
  const { evidenceDigest: _, ...evidenceBody } = evidence;
  assert.deepEqual(evidenceBody, {
    schemaVersion: 1,
    threadId,
    runId,
    events,
  });
  await createRunEventJournalStore({ stateRoot }).append({
    threadId,
    runId,
    events: [
      {
        seq: 1,
        event: {
          type: 'commentary_delta',
          payload: { text: 'later durable event' },
        },
      },
    ],
  });
  const extendedEvidence = await reader.readRun({ threadId, runId });
  assert.ok(extendedEvidence);
  assert.notEqual(extendedEvidence.evidenceDigest, evidence.evidenceDigest);
  assert.equal(
    await reader.readRun({
      threadId,
      runId: assertSessionRunId('run-evidence-missing'),
    }),
    undefined,
  );
  await assert.rejects(
    reader.readRun({ threadId: '../escape', runId }),
    /invalid threadId/,
  );
});
