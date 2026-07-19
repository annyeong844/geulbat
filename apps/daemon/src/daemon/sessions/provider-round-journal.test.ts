import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { ProviderReplayScopeId } from '@geulbat/protocol/provider-auth';

import { testRunId } from '../../test-support/run-id.js';
import { testThreadId } from '../../test-support/thread-id.js';
import { loadExistingHistory } from '../agent/loop-history.js';
import { buildResponseWireInput } from '../llm/provider/transport/responses-wire-input.js';
import { appendTranscriptEntry } from './transcript-log.js';
import { branchThreadSession } from './branch-thread.js';
import { deleteThreadSession } from './delete-thread.js';
import {
  appendProviderRound,
  providerRoundJournalPath,
  readProviderRoundHistory,
} from './provider-round-journal.js';

const PROVIDER_TARGET = {
  providerId: 'openai_codex_direct' as const,
  model: 'gpt-provider-history-test',
  replayScopeId: `sha256:${'a'.repeat(64)}` as ProviderReplayScopeId,
};

void test('provider round journal appends exact private provider items', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-provider-round-'));
  const threadId = testThreadId(701);
  const runId = testRunId(701);
  const item = {
    id: 'reasoning-701',
    type: 'reasoning',
    encrypted_content: 'opaque-provider-state',
    summary: [],
  };

  try {
    const record = await appendProviderRound({
      stateRoot,
      threadId,
      runId,
      round: 0,
      ...PROVIDER_TARGET,
      precedingTranscriptEntryId: 'entry-before-round',
      items: [item],
      functionCalls: [],
      now: () => '2026-07-18T00:00:00.000Z',
    });

    assert.deepEqual(await readProviderRoundHistory(stateRoot, threadId), [
      record,
    ]);
    assert.equal(record.items[0], item);
    assert.equal(
      (await stat(providerRoundJournalPath(stateRoot, threadId))).mode & 0o777,
      0o600,
    );
    assert.equal(await deleteThreadSession(stateRoot, threadId), true);
    assert.deepEqual(await readProviderRoundHistory(stateRoot, threadId), []);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('provider round journal accepts a function-call-only provider batch', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-provider-round-'));

  try {
    const record = await appendProviderRound({
      stateRoot,
      threadId: testThreadId(705),
      runId: testRunId(705),
      round: 0,
      ...PROVIDER_TARGET,
      precedingTranscriptEntryId: null,
      items: [
        {
          id: 'function-call-705',
          type: 'function_call',
          call_id: 'call-705',
          name: 'lookup',
          arguments: '{"query":"continuity"}',
        },
      ],
      functionCalls: [
        {
          id: 'function-call-705',
          callId: 'call-705',
          name: 'lookup',
          arguments: '{"query":"continuity"}',
          replaySafe: true,
        },
      ],
    });

    assert.equal(record.functionCalls[0]?.callId, 'call-705');
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('history replay restores raw provider calls without duplicating normalized calls or final prose', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-provider-round-replay-'),
  );
  const threadId = testThreadId(702);
  const runId = testRunId(702);
  const reasoningItem = {
    id: 'reasoning-702',
    type: 'reasoning',
    encrypted_content: 'opaque-provider-state',
    summary: [],
  };
  const functionCallItem = {
    id: 'function-call-702',
    type: 'function_call',
    call_id: 'call-702',
    name: 'lookup',
    arguments: '{"query":"continuity"}',
    status: 'completed',
  };
  const finalMessageItem = {
    id: 'message-702',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'done' }],
  };

  try {
    const user = await appendTranscriptEntry(stateRoot, threadId, {
      role: 'user',
      content: 'look it up',
      timestamp: '2026-07-18T00:00:00.000Z',
    });
    await appendProviderRound({
      stateRoot,
      threadId,
      runId,
      round: 0,
      ...PROVIDER_TARGET,
      precedingTranscriptEntryId: user.entryId,
      items: [reasoningItem, functionCallItem],
      functionCalls: [
        {
          id: 'function-call-702',
          callId: 'call-702',
          name: 'lookup',
          arguments: '{"query":"continuity"}',
          replaySafe: true,
        },
      ],
    });
    await appendTranscriptEntry(stateRoot, threadId, {
      role: 'tool_call',
      content: JSON.stringify({
        id: 'function-call-702',
        callId: 'call-702',
        tool: 'lookup',
        args: { query: 'continuity' },
        round: 0,
      }),
      timestamp: '2026-07-18T00:00:01.000Z',
    });
    const toolResult = await appendTranscriptEntry(stateRoot, threadId, {
      role: 'tool_result',
      content: JSON.stringify({
        callId: 'call-702',
        tool: 'lookup',
        ok: true,
        output: { result: 'found' },
      }),
      timestamp: '2026-07-18T00:00:02.000Z',
    });
    await appendProviderRound({
      stateRoot,
      threadId,
      runId,
      round: 1,
      ...PROVIDER_TARGET,
      precedingTranscriptEntryId: toolResult.entryId,
      items: [finalMessageItem],
      functionCalls: [],
    });
    await appendTranscriptEntry(stateRoot, threadId, {
      role: 'assistant',
      content: 'done',
      metadata: { phase: 'final_answer', sourceRunId: runId },
      timestamp: '2026-07-18T00:00:03.000Z',
    });

    const history = await loadExistingHistory(
      stateRoot,
      threadId,
      PROVIDER_TARGET,
    );
    assert.deepEqual(history, [
      { kind: 'user', text: 'look it up' },
      {
        kind: 'backend_item',
        data: reasoningItem,
        providerReplayScopeId: PROVIDER_TARGET.replayScopeId,
      },
      {
        kind: 'backend_item',
        data: functionCallItem,
        providerReplayScopeId: PROVIDER_TARGET.replayScopeId,
      },
      {
        kind: 'function_call_output',
        callId: 'call-702',
        output: '{"result":"found"}',
      },
      {
        kind: 'backend_item',
        data: finalMessageItem,
        providerReplayScopeId: PROVIDER_TARGET.replayScopeId,
      },
    ]);
    assert.doesNotThrow(() =>
      buildResponseWireInput(history, {
        providerId: PROVIDER_TARGET.providerId,
        model: PROVIDER_TARGET.model,
        providerReplayScopeId: PROVIDER_TARGET.replayScopeId,
      }),
    );
    await assert.rejects(
      loadExistingHistory(stateRoot, threadId, {
        providerId: 'openai_codex_direct',
        model: 'different-model',
        replayScopeId: PROVIDER_TARGET.replayScopeId,
      }),
      /provider round history is incompatible/u,
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('thread branching copies reachable provider rounds without rewriting the source journal', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-provider-round-branch-'),
  );
  const threadId = testThreadId(703);
  const runId = testRunId(703);
  const finalMessageItem = {
    id: 'message-703',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'branched answer' }],
  };

  try {
    const user = await appendTranscriptEntry(stateRoot, threadId, {
      role: 'user',
      content: 'branch this turn',
      timestamp: '2026-07-18T00:00:00.000Z',
    });
    await appendProviderRound({
      stateRoot,
      threadId,
      runId,
      round: 0,
      ...PROVIDER_TARGET,
      precedingTranscriptEntryId: user.entryId,
      items: [finalMessageItem],
      functionCalls: [],
    });
    await appendTranscriptEntry(stateRoot, threadId, {
      role: 'assistant',
      content: 'branched answer',
      metadata: { phase: 'final_answer', sourceRunId: runId },
      timestamp: '2026-07-18T00:00:01.000Z',
    });

    const branched = await branchThreadSession({
      workspaceRoot: stateRoot,
      sourceThreadId: threadId,
    });
    assert.equal(branched.ok, true);
    if (!branched.ok) {
      return;
    }
    assert.deepEqual(
      await loadExistingHistory(stateRoot, branched.threadId, PROVIDER_TARGET),
      [
        { kind: 'user', text: 'branch this turn' },
        {
          kind: 'backend_item',
          data: finalMessageItem,
          providerReplayScopeId: PROVIDER_TARGET.replayScopeId,
        },
      ],
    );
    assert.equal(
      (await readProviderRoundHistory(stateRoot, threadId)).length,
      1,
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('legacy provider rounds remain readable but fail closed in a scoped replay', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-provider-round-legacy-'),
  );
  const threadId = testThreadId(704);
  const runId = testRunId(704);
  const message = {
    id: 'message-704',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'legacy answer' }],
  };

  try {
    const user = await appendTranscriptEntry(stateRoot, threadId, {
      role: 'user',
      content: 'legacy prompt',
      timestamp: '2026-07-18T00:00:00.000Z',
    });
    await appendTranscriptEntry(stateRoot, threadId, {
      role: 'assistant',
      content: 'legacy answer',
      metadata: { phase: 'final_answer', sourceRunId: runId },
      timestamp: '2026-07-18T00:00:01.000Z',
    });
    const journalPath = providerRoundJournalPath(stateRoot, threadId);
    await mkdir(dirname(journalPath), { recursive: true });
    await writeFile(
      journalPath,
      `${JSON.stringify({
        schemaVersion: 1,
        threadId,
        runId,
        round: 0,
        providerId: PROVIDER_TARGET.providerId,
        model: PROVIDER_TARGET.model,
        precedingTranscriptEntryId: user.entryId,
        items: [message],
        functionCalls: [],
        createdAt: '2026-07-18T00:00:00.500Z',
      })}\n`,
      'utf8',
    );

    const records = await readProviderRoundHistory(stateRoot, threadId);
    assert.equal(records[0]?.schemaVersion, 2);
    assert.equal(records[0]?.replayScopeId, null);
    await assert.rejects(
      loadExistingHistory(stateRoot, threadId, PROVIDER_TARGET),
      /different authentication scope/u,
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
