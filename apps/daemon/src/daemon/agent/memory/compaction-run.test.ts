import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ProviderReplayScopeId } from '@geulbat/protocol/provider-auth';
import type { BudgetProfile, ThreadMessage } from '@geulbat/protocol/threads';

import {
  appendTranscriptEntry,
  readTranscriptEntries,
} from '../../sessions/transcript-log.js';
import {
  buildCompactionAwareHistory,
  type ContextCompactionTokenCounter,
} from './compaction-rebuild.js';
import {
  compactThreadContextForProviderTransition,
  compactThreadContextNative,
  compactThreadContext,
  type ContextCompactionSummarizer,
} from './compaction-run.js';
import type { HistoryItem } from '../../llm/provider/wire/types.js';
import { testThreadId } from '../../../test-support/thread-id.js';

const TEST_TIMESTAMP = '2026-07-16T00:00:00.000Z';
const TEST_REPLAY_SCOPE_ID = `sha256:${'d'.repeat(
  64,
)}` as ProviderReplayScopeId;
const TEST_BUDGET_PROFILE: BudgetProfile = {
  model: 'test-model',
  contextWindow: 100,
  reserveTokens: 10,
  thresholdTokens: 90,
  keepRecentTokens: 50,
  summaryBudgetTokens: 20,
  requestOverheadTokens: 10,
  requestProfileHash: 'test-profile',
  compactionVersion: 1,
};

void test('compaction appends one checkpoint without rewriting source entries', async () => {
  await withThread(async ({ workspaceRoot, threadId }) => {
    const old = await appendMessage(workspaceRoot, threadId, 'user', 'old');
    const kept = await appendMessage(
      workspaceRoot,
      threadId,
      'assistant',
      'kept',
    );
    const original = await readTranscriptEntries(workspaceRoot, threadId);

    const result = await compactThreadContext({
      workspaceRoot,
      threadId,
      currentRequestTokens: TEST_BUDGET_PROFILE.thresholdTokens,
      budgetProfile: TEST_BUDGET_PROFILE,
      tokenCounter: tokenCounter([
        [old.entryId, 60],
        [kept.entryId, 40],
      ]),
      summarizer: summaryReturning('summary', 'short summary', 15),
      forced: false,
      now: () => new Date(TEST_TIMESTAMP),
    });

    assert.equal(result.kind, 'compacted');
    const stored = await readTranscriptEntries(workspaceRoot, threadId);
    assert.deepEqual(stored.slice(0, 2), original);
    assert.equal(stored.length, 3);
    assert.equal(stored[2]?.role, 'compaction');
    const history = buildCompactionAwareHistory(stored, threadId);
    assert.equal(history[0]?.kind, 'user');
    if (history[0]?.kind === 'user') {
      assert.match(history[0].text, /summary/u);
    }
    assert.deepEqual(history.slice(1), [
      { kind: 'assistant', phase: 'final_answer', text: 'kept' },
    ]);
  });
});

void test('the summarizer receives the previous checkpoint summary on recompaction', async () => {
  await withThread(async ({ workspaceRoot, threadId }) => {
    const old = await appendMessage(workspaceRoot, threadId, 'user', 'old');
    const firstKept = await appendMessage(
      workspaceRoot,
      threadId,
      'assistant',
      'first kept',
    );
    await appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'compaction',
      content: '',
      timestamp: TEST_TIMESTAMP,
      compactionData: {
        summary: 'previous summary',
        shortSummary: 'previous',
        firstKeptEntryId: firstKept.entryId,
        tokensBefore: TEST_BUDGET_PROFILE.thresholdTokens,
        budgetProfile: TEST_BUDGET_PROFILE,
      },
    });
    const latest = await appendMessage(
      workspaceRoot,
      threadId,
      'user',
      'latest',
    );
    let receivedPreviousSummary: string | undefined;

    const result = await compactThreadContext({
      workspaceRoot,
      threadId,
      currentRequestTokens: TEST_BUDGET_PROFILE.thresholdTokens,
      budgetProfile: TEST_BUDGET_PROFILE,
      tokenCounter: tokenCounter([
        [old.entryId, 100],
        [firstKept.entryId, 60],
        [latest.entryId, 40],
      ]),
      summarizer: {
        async summarizeContext(request) {
          receivedPreviousSummary = request.previousSummary;
          return {
            summary: 'replacement summary',
            shortSummary: 'replacement',
            summaryTokens: 15,
          };
        },
      },
      forced: false,
    });

    assert.equal(result.kind, 'compacted');
    assert.equal(receivedPreviousSummary, 'previous summary');
  });
});

void test('a transcript append during summarization returns stale_snapshot without a checkpoint', async () => {
  await withThread(async ({ workspaceRoot, threadId }) => {
    const old = await appendMessage(workspaceRoot, threadId, 'user', 'old');
    const kept = await appendMessage(
      workspaceRoot,
      threadId,
      'assistant',
      'kept',
    );
    const summarizer: ContextCompactionSummarizer = {
      async summarizeContext() {
        await appendMessage(workspaceRoot, threadId, 'user', 'arrived');
        return {
          summary: 'summary',
          shortSummary: 'short',
          summaryTokens: 10,
        };
      },
    };

    const result = await compactThreadContext({
      workspaceRoot,
      threadId,
      currentRequestTokens: TEST_BUDGET_PROFILE.thresholdTokens,
      budgetProfile: TEST_BUDGET_PROFILE,
      tokenCounter: tokenCounter([
        [old.entryId, 60],
        [kept.entryId, 40],
      ]),
      summarizer,
      forced: false,
    });

    assert.equal(result.kind, 'stale_snapshot');
    const stored = await readTranscriptEntries(workspaceRoot, threadId);
    assert.deepEqual(
      stored.map((entry) => entry.role),
      ['user', 'assistant', 'user'],
    );
  });
});

void test('an invalid or failed summary leaves the transcript unchanged', async () => {
  await withThread(async ({ workspaceRoot, threadId }) => {
    const old = await appendMessage(workspaceRoot, threadId, 'user', 'old');
    const kept = await appendMessage(
      workspaceRoot,
      threadId,
      'assistant',
      'kept',
    );
    const before = await readTranscriptEntries(workspaceRoot, threadId);
    const common = {
      workspaceRoot,
      threadId,
      currentRequestTokens: TEST_BUDGET_PROFILE.thresholdTokens,
      budgetProfile: TEST_BUDGET_PROFILE,
      tokenCounter: tokenCounter([
        [old.entryId, 60],
        [kept.entryId, 40],
      ]),
      forced: false,
    } as const;

    const invalid = await compactThreadContext({
      ...common,
      summarizer: summaryReturning(
        'summary',
        'short',
        TEST_BUDGET_PROFILE.summaryBudgetTokens + 1,
      ),
    });
    assert.deepEqual(invalid, {
      kind: 'summary_invalid',
      reason: 'summary_exceeds_budget',
    });
    await assert.rejects(
      compactThreadContext({
        ...common,
        summarizer: {
          async summarizeContext() {
            throw new Error('provider unavailable');
          },
        },
      }),
      /provider unavailable/u,
    );
    assert.deepEqual(
      await readTranscriptEntries(workspaceRoot, threadId),
      before,
    );
  });
});

void test('provider transition appends a readable checkpoint without rewriting raw transcript entries', async () => {
  await withThread(async ({ workspaceRoot, threadId }) => {
    await appendMessage(workspaceRoot, threadId, 'user', 'old question');
    const covered = await appendMessage(
      workspaceRoot,
      threadId,
      'assistant',
      'old answer',
    );
    const original = await readTranscriptEntries(workspaceRoot, threadId);

    const result = await compactThreadContextForProviderTransition({
      workspaceRoot,
      threadId,
      sourceProviderId: 'grok_oauth',
      sourceModel: 'grok-4.5',
      targetProviderId: 'openai_codex_direct',
      targetModel: 'gpt-5.6-sol',
      summarizer: {
        async summarizeContext(request) {
          assert.equal(request.coveredThroughEntryId, covered.entryId);
          return { summary: 'portable handoff', inputTokens: 300_000 };
        },
      },
      now: () => new Date(TEST_TIMESTAMP),
    });

    assert.equal(result.kind, 'compacted');
    const stored = await readTranscriptEntries(workspaceRoot, threadId);
    assert.deepEqual(stored.slice(0, original.length), original);
    assert.equal(stored.length, original.length + 1);
    const checkpoint = stored.at(-1);
    assert.equal(checkpoint?.role, 'compaction');
    if (checkpoint?.role === 'compaction') {
      assert.deepEqual(checkpoint.compactionData, {
        kind: 'provider_transition',
        sourceProviderId: 'grok_oauth',
        sourceModel: 'grok-4.5',
        targetProviderId: 'openai_codex_direct',
        targetModel: 'gpt-5.6-sol',
        summary: 'portable handoff',
        coveredThroughEntryId: covered.entryId,
        inputTokens: 300_000,
      });
    }
  });
});

void test('provider transition refuses a stale snapshot and leaves raw entries intact', async () => {
  await withThread(async ({ workspaceRoot, threadId }) => {
    await appendMessage(workspaceRoot, threadId, 'user', 'old question');

    const result = await compactThreadContextForProviderTransition({
      workspaceRoot,
      threadId,
      sourceProviderId: 'grok_oauth',
      sourceModel: 'grok-4.5',
      targetProviderId: 'openai_codex_direct',
      targetModel: 'gpt-5.6-sol',
      summarizer: {
        async summarizeContext() {
          await appendMessage(workspaceRoot, threadId, 'user', 'arrived');
          return { summary: 'stale handoff' };
        },
      },
    });

    assert.equal(result.kind, 'stale_snapshot');
    const stored = await readTranscriptEntries(workspaceRoot, threadId);
    assert.deepEqual(
      stored.map((entry) => entry.role),
      ['user', 'user'],
    );
  });
});

void test('provider-native compaction appends an opaque checkpoint and replaces only active in-memory history', async () => {
  await withThread(async ({ workspaceRoot, threadId }) => {
    await appendMessage(workspaceRoot, threadId, 'user', 'old');
    await appendMessage(workspaceRoot, threadId, 'assistant', 'answer');
    const original = await readTranscriptEntries(workspaceRoot, threadId);
    const history: HistoryItem[] = [
      { kind: 'user', text: 'old' },
      { kind: 'assistant', phase: 'final_answer', text: 'answer' },
    ];

    const result = await compactThreadContextNative({
      workspaceRoot,
      threadId,
      history,
      providerId: 'openai_codex_direct',
      model: 'gpt-test',
      tokensBefore: 90,
      contextWindow: 100,
      thresholdTokens: 90,
      compactHistory: async () => ({
        providerReplayScopeId: TEST_REPLAY_SCOPE_ID,
        output: [
          {
            type: 'compaction',
            encrypted_content: 'opaque-checkpoint',
          },
        ],
      }),
      now: () => new Date(TEST_TIMESTAMP),
    });

    assert.equal(result.kind, 'compacted');
    const stored = await readTranscriptEntries(workspaceRoot, threadId);
    assert.deepEqual(stored.slice(0, original.length), original);
    assert.equal(stored.length, original.length + 1);
    assert.deepEqual(history, [
      {
        kind: 'provider_native_compaction',
        providerId: 'openai_codex_direct',
        model: 'gpt-test',
        providerReplayScopeId: TEST_REPLAY_SCOPE_ID,
        output: [
          {
            type: 'compaction',
            encrypted_content: 'opaque-checkpoint',
          },
        ],
      },
    ]);
  });
});

void test('provider-native compaction leaves in-memory history untouched when transcript CAS loses a race', async () => {
  await withThread(async ({ workspaceRoot, threadId }) => {
    await appendMessage(workspaceRoot, threadId, 'user', 'old');
    const history: HistoryItem[] = [{ kind: 'user', text: 'old' }];
    const before = structuredClone(history);

    const result = await compactThreadContextNative({
      workspaceRoot,
      threadId,
      history,
      providerId: 'openai_codex_direct',
      model: 'gpt-test',
      tokensBefore: 90,
      contextWindow: 100,
      thresholdTokens: 90,
      compactHistory: async () => {
        await appendMessage(workspaceRoot, threadId, 'user', 'arrived');
        return {
          providerReplayScopeId: TEST_REPLAY_SCOPE_ID,
          output: [
            {
              type: 'compaction',
              encrypted_content: 'unused-checkpoint',
            },
          ],
        };
      },
    });

    assert.equal(result.kind, 'stale_snapshot');
    assert.deepEqual(history, before);
    const stored = await readTranscriptEntries(workspaceRoot, threadId);
    assert.deepEqual(
      stored.map((entry) => entry.role),
      ['user', 'user'],
    );
  });
});

function tokenCounter(
  counts: ReadonlyArray<readonly [string, number]>,
): ContextCompactionTokenCounter {
  const countsByEntryId = new Map(counts);
  return {
    countTranscriptEntryTokens(entry) {
      return countsByEntryId.get(entry.entryId) ?? 1;
    },
  };
}

function summaryReturning(
  summary: string,
  shortSummary: string,
  summaryTokens: number,
): ContextCompactionSummarizer {
  return {
    async summarizeContext() {
      return { summary, shortSummary, summaryTokens };
    },
  };
}

async function appendMessage(
  workspaceRoot: string,
  threadId: string,
  role: 'user' | 'assistant',
  content: string,
): Promise<ThreadMessage> {
  return await appendTranscriptEntry(workspaceRoot, threadId, {
    role,
    content,
    timestamp: TEST_TIMESTAMP,
  });
}

async function withThread(
  run: (args: { workspaceRoot: string; threadId: string }) => Promise<void>,
): Promise<void> {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-compaction-run-'),
  );
  try {
    await run({ workspaceRoot, threadId: testThreadId(91) });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}
