import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';

import { testThreadId } from '../../test-support/thread-id.js';
import { assertSessionRunId } from './contract.js';
import {
  createRunEventJournalStore,
  type RunCheckpointEvent,
} from './run-event-journal.js';

void test('run event journal appends contiguous batches and survives recreation', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-run-events-'));
  const threadId = testThreadId(901);
  const runId = assertSessionRunId('run-event-journal-recreate');
  const store = createRunEventJournalStore({ stateRoot });

  assert.deepEqual(await store.read({ threadId, runId }), []);
  await store.append({
    threadId,
    runId,
    events: [
      {
        seq: 0,
        event: {
          type: 'commentary_delta',
          payload: { text: 'first' },
        },
      },
    ],
  });
  await store.append({
    threadId,
    runId,
    events: [
      {
        seq: 1,
        event: {
          type: 'commentary_delta',
          payload: { text: 'second' },
        },
      },
    ],
  });

  assert.deepEqual(
    await createRunEventJournalStore({ stateRoot }).read({ threadId, runId }),
    [
      {
        seq: 0,
        event: {
          type: 'commentary_delta',
          payload: { text: 'first' },
        },
      },
      {
        seq: 1,
        event: {
          type: 'commentary_delta',
          payload: { text: 'second' },
        },
      },
    ],
  );
});

void test('concurrent reads cannot rewind the append cursor', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-run-events-'));
  const threadId = testThreadId(906);
  const runId = assertSessionRunId('run-event-journal-concurrent-read');
  const store = createRunEventJournalStore({ stateRoot });
  const eventCount = 32;
  const payload = 'x'.repeat(32 * 1024);

  for (let seq = 0; seq < eventCount; seq += 1) {
    await Promise.all([
      store.append({
        threadId,
        runId,
        events: [
          {
            seq,
            event: {
              type: 'commentary_delta',
              payload: { text: payload },
            },
          },
        ],
      }),
      store.read({ threadId, runId }),
    ]);
  }

  assert.deepEqual(
    (await store.read({ threadId, runId })).map(({ seq }) => seq),
    Array.from({ length: eventCount }, (_, seq) => seq),
  );
});

void test('run event journal round-trips an offloaded agent_wait tool result', async () => {
  // 2026-07-21 S0 회귀 잠금 — emit 경로가 오프로드 슬림 raw로 기록한
  // agent_wait tool_result를 재독(재접속 복구)이 거부하면, 그 저널은 영구
  // 오염되고 run.auth가 매번 죽는다. 쓴 것은 반드시 다시 읽혀야 한다.
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-run-events-'));
  const threadId = testThreadId(904);
  const runId = assertSessionRunId('run-event-journal-offloaded-wait');
  const store = createRunEventJournalStore({ stateRoot });

  const offloadedWaitResult: RunCheckpointEvent = {
    seq: 0,
    event: {
      type: 'tool_result',
      payload: {
        callId: 'call-wait-1',
        step: 4,
        tool: 'agent_wait',
        ok: true,
        computerFilesMayHaveChanged: false,
        displayText: 'offloaded agent_wait result',
        raw: {
          ok: true,
          offloaded: true,
          tool: 'agent_wait',
          callId: 'call-wait-1',
          outputRef: `tool-output:${threadId}/${runId}/call-wait-1`,
          summary:
            'agent_wait returned 4 completed, 0 pending, and 0 blocked runs.',
          fullOutputBytes: 48067,
          fullOutputChars: 21556,
          recoveryTool: 'read_tool_output',
        },
      },
    },
  };
  await store.append({ threadId, runId, events: [offloadedWaitResult] });

  assert.deepEqual(
    await createRunEventJournalStore({ stateRoot }).read({ threadId, runId }),
    [offloadedWaitResult],
  );
});

void test('run event journal preserves provider auth and admission status for reconnect replay', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-run-events-'));
  const threadId = testThreadId(905);
  const runId = assertSessionRunId('run-event-journal-provider-admission');
  const store = createRunEventJournalStore({ stateRoot });
  const providerStatuses: RunCheckpointEvent[] = [
    {
      seq: 0,
      event: {
        type: 'provider_status',
        payload: {
          phase: 'auth_waiting',
          observedAt: '2026-07-23T10:59:59.000Z',
        },
      },
    },
    {
      seq: 1,
      event: {
        type: 'provider_status',
        payload: {
          phase: 'rate_limit_waiting',
          observedAt: '2026-07-23T11:00:00.000Z',
        },
      },
    },
  ];

  await store.append({ threadId, runId, events: providerStatuses });

  assert.deepEqual(
    await createRunEventJournalStore({ stateRoot }).read({ threadId, runId }),
    providerStatuses,
  );
});

void test('run event journal rejects a noncontiguous append', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-run-events-'));
  const threadId = testThreadId(902);
  const runId = assertSessionRunId('run-event-journal-sequence');
  const store = createRunEventJournalStore({ stateRoot });

  await assert.rejects(
    store.append({
      threadId,
      runId,
      events: [
        {
          seq: 1,
          event: {
            type: 'commentary_delta',
            payload: { text: 'skipped zero' },
          },
        },
      ],
    }),
    /append sequence conflict/u,
  );
});

void test('run event journal fails closed when an appended line is truncated', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-run-events-'));
  const threadId = testThreadId(903);
  const runId = assertSessionRunId('run-event-journal-truncated');
  const journalDirectory = join(
    stateRoot,
    '.geulbat',
    'run-event-journals',
    threadId,
  );
  await mkdir(journalDirectory, { recursive: true });
  await writeFile(
    join(journalDirectory, `${runId}.jsonl`),
    `${JSON.stringify({ schemaVersion: 1, runId, threadId })}\n{"events":[`,
    'utf8',
  );

  await assert.rejects(
    createRunEventJournalStore({ stateRoot }).read({ threadId, runId }),
    /invalid run event journal JSON/u,
  );
});
