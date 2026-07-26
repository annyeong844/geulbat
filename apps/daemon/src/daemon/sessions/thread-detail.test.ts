import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { assertRunId, assertThreadId } from '@geulbat/protocol/ids';

import { appendProviderRound } from './provider-round-journal.js';
import { createRunCheckpointStore } from './run-checkpoint-store.js';
import { loadThreadDetailSnapshot } from './thread-detail.js';
import { appendTranscriptEntry } from './transcript-log.js';

void test('thread detail restores only a catalog model owned by the recorded provider', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-thread-detail-'));
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const threadId = assertThreadId(randomUUID());
  const mismatchedThreadId = assertThreadId(randomUUID());
  const journalOnlyThreadId = assertThreadId(randomUUID());
  const store = createRunCheckpointStore({ stateRoot });

  await store.startRun({
    runId: assertRunId(randomUUID()),
    threadId,
    request: {
      workingDirectory: '/workspace',
      permissionMode: 'full_access',
      providerModel: { providerId: 'grok_oauth', model: 'grok-4.5' },
      reasoningEffort: 'high',
      serviceTier: 'standard',
      subagentModelRouting: {
        mode: 'fixed',
        choice: {
          modelId: 'gpt-5.6-terra',
          reasoningEffort: 'medium',
        },
      },
    },
  });
  await appendProviderRound({
    stateRoot,
    threadId: journalOnlyThreadId,
    runId: assertRunId(randomUUID()),
    round: 0,
    providerId: 'grok_oauth',
    model: 'grok-4.5',
    replayScopeId: null,
    precedingTranscriptEntryId: null,
    items: [{ type: 'message', role: 'assistant', content: [] }],
    functionCalls: [],
  });
  await store.startRun({
    runId: assertRunId(randomUUID()),
    threadId: mismatchedThreadId,
    request: {
      workingDirectory: '/workspace',
      permissionMode: 'basic',
      providerModel: {
        providerId: 'openai_codex_direct',
        model: 'grok-4.5',
      },
    },
  });

  const detail = await loadThreadDetailSnapshot({
    workspaceRoot: stateRoot,
    threadId,
  });
  const mismatchedDetail = await loadThreadDetailSnapshot({
    workspaceRoot: stateRoot,
    threadId: mismatchedThreadId,
  });
  const journalOnlyDetail = await loadThreadDetailSnapshot({
    workspaceRoot: stateRoot,
    threadId: journalOnlyThreadId,
  });

  assert.equal(detail.activeModelId, 'grok-4.5');
  assert.deepEqual(detail.runPreferences, {
    workingDirectory: '/workspace',
    permissionMode: 'full_access',
    reasoningEffort: 'high',
    serviceTier: 'standard',
    subagentModelRouting: {
      mode: 'fixed',
      choice: {
        modelId: 'gpt-5.6-terra',
        reasoningEffort: 'medium',
      },
    },
  });
  assert.equal(mismatchedDetail.activeModelId, undefined);
  assert.equal(journalOnlyDetail.activeModelId, 'grok-4.5');
  assert.equal('providerModel' in detail, false);
});

void test('thread detail projects durable Qwen commentary for dedicated reasoning UI', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-thread-detail-qwen-'),
  );
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  const initialUser = await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'Please think carefully.',
    timestamp: '2026-07-26T00:00:00.000Z',
  });

  await appendProviderRound({
    stateRoot,
    threadId,
    runId,
    round: 0,
    providerId: 'qwen_token_plan',
    model: 'qwen3.8-max-preview',
    replayScopeId: null,
    precedingTranscriptEntryId: initialUser.entryId,
    items: [
      {
        type: 'message',
        id: 'qwen-reasoning-visible',
        role: 'assistant',
        status: 'completed',
        phase: 'commentary',
        content: [
          {
            type: 'output_text',
            text: 'Visible Qwen reasoning.',
            annotations: [],
          },
        ],
      },
      {
        type: 'reasoning',
        encrypted_content: 'opaque-provider-state-must-not-surface',
      },
      {
        type: 'message',
        id: 'qwen-answer-visible',
        role: 'assistant',
        status: 'completed',
        phase: 'final_answer',
        content: [
          { type: 'output_text', text: 'Settled answer.', annotations: [] },
        ],
      },
    ],
    functionCalls: [],
    now: () => '2026-07-26T00:00:01.000Z',
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'assistant',
    content: 'Settled answer.',
    timestamp: '2026-07-26T00:00:02.000Z',
    metadata: { phase: 'final_answer', sourceRunId: runId },
  });

  const detail = await loadThreadDetailSnapshot({
    workspaceRoot: stateRoot,
    threadId,
  });
  const reloaded = await loadThreadDetailSnapshot({
    workspaceRoot: stateRoot,
    threadId,
  });

  assert.deepEqual(
    detail.messages.map((message) => [
      message.role,
      message.content,
      message.metadata?.phase,
    ]),
    [
      ['user', 'Please think carefully.', undefined],
      ['assistant', 'Visible Qwen reasoning.', 'commentary'],
      ['assistant', 'Settled answer.', 'final_answer'],
    ],
  );
  const reasoning = detail.messages[1];
  assert.equal(reasoning?.metadata?.sourceRunId, runId);
  assert.match(reasoning?.entryId ?? '', /provider-commentary/u);
  assert.equal(reloaded.messages[1]?.entryId, reasoning?.entryId);
  assert.equal(
    detail.messages.some((message) =>
      message.content.includes('opaque-provider-state-must-not-surface'),
    ),
    false,
  );
});

void test('thread detail leaves an active run commentary to the live reasoning owner', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-thread-detail-qwen-live-'),
  );
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const threadId = assertThreadId(randomUUID());
  const runId = assertRunId(randomUUID());
  const store = createRunCheckpointStore({ stateRoot });
  const initialUser = await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: 'Keep the live thought in one place.',
    timestamp: '2026-07-26T00:01:00.000Z',
  });
  await store.startRun({
    runId,
    threadId,
    request: {
      workingDirectory: '/workspace',
      permissionMode: 'basic',
      providerModel: {
        providerId: 'qwen_token_plan',
        model: 'qwen3.8-max-preview',
      },
    },
  });
  await appendProviderRound({
    stateRoot,
    threadId,
    runId,
    round: 0,
    providerId: 'qwen_token_plan',
    model: 'qwen3.8-max-preview',
    replayScopeId: null,
    precedingTranscriptEntryId: initialUser.entryId,
    items: [
      {
        type: 'message',
        id: 'qwen-live-reasoning',
        role: 'assistant',
        status: 'completed',
        phase: 'commentary',
        content: [
          {
            type: 'output_text',
            text: 'Live reasoning must not be projected twice.',
            annotations: [],
          },
        ],
      },
    ],
    functionCalls: [],
    now: () => '2026-07-26T00:01:01.000Z',
  });

  const reconnectDetail = await loadThreadDetailSnapshot({
    workspaceRoot: stateRoot,
    threadId,
  });
  const settleDetail = await loadThreadDetailSnapshot({
    workspaceRoot: stateRoot,
    threadId,
    includeActiveRunCommentary: true,
  });

  assert.deepEqual(
    reconnectDetail.messages.map((message) => [message.role, message.content]),
    [['user', 'Keep the live thought in one place.']],
  );
  assert.deepEqual(
    settleDetail.messages.map((message) => [message.role, message.content]),
    [
      ['user', 'Keep the live thought in one place.'],
      ['assistant', 'Live reasoning must not be projected twice.'],
    ],
  );
  assert.equal(settleDetail.messages[1]?.metadata?.phase, 'commentary');
});
